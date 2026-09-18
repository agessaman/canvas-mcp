import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { DataAnonymizer } from "../anonymizer.js";

/** Canvas question/answer text is HTML; flatten it so results stay readable. */
function stripHtml(html: any, maxLength = 300): string {
  if (typeof html !== 'string') return '';
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Minimal RFC 4180 parser — quiz reports arrive as CSV and we have no csv dep. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop a trailing blank line
  return rows.filter(r => r.length > 1 || (r[0] ?? '').trim() !== '');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The questions one attempt was actually shown. The quiz's current question
 * list is the wrong join for two common cases: a question group drawing from a
 * bank (the drawn questions are not quiz questions at all, so every one came
 * back with no text and no correct answer), and a quiz edited after the
 * student took it. Canvas returns the attempt's own set when given the quiz
 * submission id and attempt; the current list is only the fallback.
 */
async function questionsAsPresented(
  canvas: CanvasClient, courseId: string, quizId: string, userId: string, attempt: number | undefined
): Promise<any[]> {
  const url = `/api/v1/courses/${courseId}/quizzes/${quizId}/questions`;
  if (attempt !== undefined) {
    try {
      const envelope = await canvas.listQuizSubmissions(courseId, quizId);
      const quizSubmission = (envelope.quiz_submissions ?? []).find((qs: any) => String(qs.user_id) === String(userId));
      if (quizSubmission) {
        const presented = await canvas.fetchAllPages<any>(url, {
          quiz_submission_id: quizSubmission.id,
          quiz_submission_attempt: attempt,
        });
        if (presented.length > 0) return presented;
      }
    } catch {
      // Fall through to the quiz's current questions.
    }
  }
  return canvas.fetchAllPages<any>(url);
}

export function registerQuizResultTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-quiz-submissions
  server.tool(
    "list-quiz-submissions",
    "List every student's attempt on a Classic quiz with score, timing and state. Start here when analysing a Classic quiz; use get-quiz-submission-answers for per-question detail. Classic Quizzes only (list-quizzes) — for a New Quiz, use list-assignment-submissions with its assignment ID.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      anonymous: z.boolean().default(true).describe("Whether to replace student identity with a stable pseudonym (default: true for privacy)"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, anonymous = true }: { courseId: string; quizId: string; anonymous?: boolean }) => {
      try {
        // A quiz submission carries only user_id. Names come from a sibling
        // `users` array, which is only worth asking for when they will be shown.
        const envelope = await canvas.listQuizSubmissions(
          courseId,
          quizId,
          anonymous ? { per_page: 100 } : { per_page: 100, include: ['user'] }
        );
        const raw = envelope.quiz_submissions ?? [];
        const nameById = new Map<string, string>(
          (envelope.users ?? []).map((u: any) => [String(u.id), u.name])
        );
        const labelled = anonymous
          ? DataAnonymizer.anonymizeQuizSubmissions(raw)
          : raw.map((s: any) => ({ ...s, student: nameById.get(String(s.user_id)) }));
        const submissions = labelled.map((s: any) => ({
          id: s.id,
          user_id: s.user_id,
          ...(s.student ? { student: s.student } : {}),
          attempt: s.attempt,
          workflow_state: s.workflow_state,
          score: s.score,
          kept_score: s.kept_score,
          score_before_regrade: s.score_before_regrade,
          fudge_points: s.fudge_points,
          started_at: s.started_at,
          finished_at: s.finished_at,
          time_spent: s.time_spent,
          extra_attempts: s.extra_attempts,
          extra_time: s.extra_time,
          overdue_and_needs_submission: s.overdue_and_needs_submission,
        }));

        // Granting an extension to a student who has not started creates a
        // "settings_only" submission: a row that holds extra time or attempts
        // and no attempt at all. It stays in the list, where the extension is
        // worth seeing, but is not counted as a submission.
        const attempted = submissions.filter((s: any) => s.workflow_state !== 'settings_only');
        const graded = attempted.filter((s: any) => typeof s.kept_score === 'number');
        const scores = graded.map((s: any) => s.kept_score as number);
        const summary = scores.length
          ? {
              submissions: attempted.length,
              graded: scores.length,
              average: Number((scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(2)),
              high: Math.max(...scores),
              low: Math.min(...scores),
            }
          : { submissions: attempted.length, graded: 0 };

        return {
          content: [{ type: "text", text: JSON.stringify({ summary, submissions }) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz submissions: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz submissions: Unknown error');
      }
    }
  );

  // Tool: get-quiz-statistics
  server.tool(
    "get-quiz-statistics",
    "Get aggregate item analysis for a Classic quiz: per-question response distribution across answer choices, difficulty index, and point-biserial correlation per distractor. Aggregate only — no per-student data. For a New Quiz, use get-new-quiz-report.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      allVersions: z.boolean().default(false).describe("Include all attempts rather than only the most recent one per student"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, allVersions = false }: { courseId: string; quizId: string; allVersions?: boolean }) => {
      try {
        const stats = await canvas.getEnvelope<any>(
          `/api/v1/courses/${courseId}/quizzes/${quizId}/statistics`,
          'quiz_statistics',
          { all_versions: allVersions }
        );
        if (stats.length === 0) {
          return { content: [{ type: "text", text: "No statistics available for this quiz (it may have no submissions yet)." }] };
        }
        const s = stats[0];
        const sub = s.submission_statistics ?? {};

        const questions = (s.question_statistics ?? []).map((q: any) => {
          const biserialByAnswer = new Map<any, any>();
          for (const pb of q.point_biserials ?? []) biserialByAnswer.set(pb.answer_id, pb);
          return {
            id: q.id,
            question_type: q.question_type,
            question_text: stripHtml(q.question_text),
            points_possible: q.points_possible,
            responses: q.responses,
            difficulty_index: q.difficulty_index,
            alpha: q.alpha,
            ...(q.top_student_count !== undefined ? {
              brackets: {
                top: q.top_student_count,
                middle: q.middle_student_count,
                bottom: q.bottom_student_count,
              }
            } : {}),
            answers: (q.answers ?? []).map((a: any) => {
              const pb = biserialByAnswer.get(a.id);
              return {
                id: a.id,
                text: stripHtml(a.text, 150),
                correct: a.correct,
                responses: a.responses,
                ...(pb ? { point_biserial: pb.point_biserial } : {}),
              };
            }),
            // Essay/file-upload questions report these instead of answer buckets
            ...(q.full_credit !== undefined ? { full_credit: q.full_credit } : {}),
            ...(q.point_distribution ? { point_distribution: q.point_distribution } : {}),
          };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              quiz_id: s.quiz_id,
              generated_at: s.generated_at,
              includes_all_versions: s.includes_all_versions,
              multiple_attempts_exist: s.multiple_attempts_exist,
              submission_statistics: {
                unique_count: sub.unique_count,
                score_average: sub.score_average,
                score_high: sub.score_high,
                score_low: sub.score_low,
                score_stdev: sub.score_stdev,
                correct_count_average: sub.correct_count_average,
                incorrect_count_average: sub.incorrect_count_average,
                duration_average: sub.duration_average,
                scores: sub.scores,
              },
              question_statistics: questions,
            })
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz statistics: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz statistics: Unknown error');
      }
    }
  );

  // Tool: get-quiz-submission-answers
  server.tool(
    "get-quiz-submission-answers",
    "Get one student's actual answer to every question in a Classic quiz, joined against the question text and the correct answer as that attempt was shown them. Use list-quiz-submissions first to find user IDs.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      userId: z.string().describe("The ID of the student/user"),
      attempt: z.number().optional().describe("Which attempt to read (default: the most recent)"),
      anonymous: z.boolean().default(true).describe("Whether to replace student identity with a stable pseudonym (default: true for privacy)"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, userId, attempt, anonymous = true }: {
      courseId: string; quizId: string; userId: string; attempt?: number; anonymous?: boolean;
    }) => {
      try {
        const quiz = await canvas.getClassicQuiz(courseId, quizId) as any;
        if (!quiz.assignment_id) {
          throw new Error(`Quiz ${quizId} has no backing assignment (practice quizzes and ungraded surveys expose no per-question answers through this route).`);
        }

        const submission = await canvas.getSubmission(
          courseId,
          String(quiz.assignment_id),
          userId,
          { include: anonymous ? ['submission_history'] : ['submission_history', 'user'] }
        ) as any;

        const history: any[] = Array.isArray(submission.submission_history) ? submission.submission_history : [];
        const candidates = history
          .filter(h => Array.isArray(h.submission_data))
          .sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
        if (candidates.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No recorded answers for user ${userId} on quiz ${quizId} (workflow_state: ${submission.workflow_state}). The student may not have submitted an attempt.`
            }]
          };
        }
        const chosen = attempt !== undefined
          ? candidates.find(h => h.attempt === attempt)
          : candidates[candidates.length - 1];
        if (!chosen) {
          throw new Error(`Attempt ${attempt} not found. Available attempts: ${candidates.map(c => c.attempt).join(', ')}`);
        }

        const questions = await questionsAsPresented(canvas, courseId, quizId, userId, chosen.attempt);
        const questionById = new Map<any, any>(questions.map(q => [q.id, q]));

        const answers = (chosen.submission_data ?? []).map((d: any) => {
          const q = questionById.get(d.question_id);
          const options: any[] = q?.answers ?? [];
          const chosenOption = d.answer_id !== undefined && d.answer_id !== null
            ? options.find((a: any) => a.id === d.answer_id || String(a.id) === String(d.answer_id))
            : undefined;
          const correctOptions = options.filter((a: any) => (a.weight ?? 0) > 0);
          // Multi-answer / fill-in-multiple-blanks record answer_<id> keys rather
          // than a single answer_id, so pass those through untouched.
          const extraKeys = Object.keys(d).filter(k => /^answer_/.test(k) && k !== 'answer_id');
          return {
            question_id: d.question_id,
            question_name: q?.question_name,
            question_type: q?.question_type,
            question_text: stripHtml(q?.question_text),
            points_possible: q?.points_possible,
            points_earned: d.points,
            correct: d.correct,
            given_answer_id: d.answer_id ?? null,
            given_answer: chosenOption ? stripHtml(chosenOption.text, 200) : (d.text ? stripHtml(d.text, 500) : null),
            ...(extraKeys.length ? { given_answer_parts: Object.fromEntries(extraKeys.map(k => [k, d[k]])) } : {}),
            correct_answers: correctOptions.map((a: any) => stripHtml(a.text, 200)),
            ...(d.more_comments ? { grader_comment: d.more_comments } : {}),
          };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              student: anonymous ? DataAnonymizer.pseudonymFor(userId) : submission.user?.name ?? null,
              user_id: userId,
              quiz_id: quizId,
              attempt: chosen.attempt,
              available_attempts: candidates.map(c => c.attempt),
              submitted_at: chosen.submitted_at,
              score: chosen.score,
              points_possible: quiz.points_possible,
              answers,
            })
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz submission answers: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz submission answers: Unknown error');
      }
    }
  );

  // Tool: get-quiz-report
  server.tool(
    "get-quiz-report",
    "Generate (or reuse) a Classic quiz report and return its parsed contents. 'student_analysis' gives the whole-class student x question answer matrix; 'item_analysis' gives per-question difficulty and discrimination. Generation is asynchronous: this polls for up to waitSeconds, and if the report is not ready by then, calling again picks up the same report rather than starting another. For a New Quiz use get-new-quiz-report.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      reportType: z.enum(["student_analysis", "item_analysis"]).default("student_analysis").describe("Which report to produce"),
      allVersions: z.boolean().default(false).describe("Include every attempt rather than only the most recent one per student"),
      format: z.enum(["summary", "full"]).default("summary").describe("'summary' aggregates per question and per student; 'full' returns every cell (can be large)"),
      regenerate: z.boolean().default(false).describe("Ask Canvas for a new report instead of reusing the last one. Canvas still returns the existing report when no submissions have arrived since it was generated."),
      waitSeconds: z.number().min(0).max(50).default(30).describe("How long to wait for a report that is still generating before returning (default 30; clients commonly give up on a tool call after 60)"),
      anonymous: z.boolean().default(true).describe("Whether to replace student identity with a stable pseudonym (default: true for privacy)"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, reportType = "student_analysis", allVersions = false, format = "summary", regenerate = false, waitSeconds = 30, anonymous = true }: {
      courseId: string; quizId: string; reportType?: string; allVersions?: boolean; format?: string; regenerate?: boolean; waitSeconds?: number; anonymous?: boolean;
    }) => {
      const base = `/api/v1/courses/${courseId}/quizzes/${quizId}/reports`;
      try {
        const matches = (r: any) => r.report_type === reportType && !!r.includes_all_versions === allVersions;

        const findExisting = async () => {
          const existing = await canvas.get(base, { includes_all_versions: allVersions, include: ['file', 'progress'] }) as any[];
          return (Array.isArray(existing) ? existing : []).find(matches);
        };

        let report: any;
        if (!regenerate) report = await findExisting();

        if (!report || regenerate || !report.file) {
          try {
            report = await canvas.post(base, {
              quiz_report: { report_type: reportType, includes_all_versions: allVersions },
              include: ['file', 'progress'],
            });
          } catch (error: any) {
            // Canvas answers 409 while the same report is already generating;
            // pick that one up and wait on it instead.
            report = await findExisting();
            if (!report) throw error;
          }
        }

        // Poll until the file materialises (Canvas generates reports out of band).
        // A failed job never grows a file, so it is checked on every pass rather
        // than left to run out the clock and be reported as "still generating".
        const deadline = Date.now() + waitSeconds * 1000;
        while (!report?.file?.url) {
          if (report?.progress?.workflow_state === 'failed') {
            throw new Error(`Canvas could not generate the ${reportType} report: ${report.progress.message ?? 'no detail provided'}`);
          }
          if (Date.now() >= deadline) break;
          await sleep(2000);
          report = await canvas.get(`${base}/${report.id}`, { include: ['file', 'progress'] });
        }
        if (!report?.file?.url) {
          const done = report?.progress?.completion;
          return {
            content: [{
              type: "text",
              text: `Report ${report?.id} (${reportType}) is still generating${typeof done === 'number' ? ` (${done}% complete)` : ''}. `
                + `Call get-quiz-report again with the same arguments to pick up the finished file.`
            }]
          };
        }

        const csv = await canvas.downloadText(report.file.url);
        const rows = parseCsv(csv);
        if (rows.length < 2) {
          return { content: [{ type: "text", text: `Report ${reportType} generated but contains no data rows (the quiz may have no submissions).` }] };
        }

        const header = rows[0].map(h => h.trim());
        const body = rows.slice(1);
        const meta = { report_id: report.id, report_type: reportType, includes_all_versions: report.includes_all_versions, generated_at: report.created_at, rows: body.length };

        // Identity columns in student_analysis; blanked or pseudonymised when anonymous.
        const idIndex = header.findIndex(h => h.trim().toLowerCase() === 'id');
        const nameIndex = header.findIndex(h => h.trim().toLowerCase() === 'name');
        const redactIndexes = header.reduce<number[]>((acc, h, i) => {
          if (/^(sis[ _]?id|sis[ _]?login[ _]?id|login[ _]?id|section|section[ _]?id|section[ _]?sis[ _]?id)$/i.test(h.trim())) acc.push(i);
          return acc;
        }, []);

        const cleaned = body.map(r => {
          const row = [...r];
          if (anonymous) {
            if (nameIndex >= 0) row[nameIndex] = idIndex >= 0 ? DataAnonymizer.pseudonymFor(r[idIndex]) : 'Student';
            for (const i of redactIndexes) row[i] = '';
          }
          return row;
        });

        // In student_analysis each question is two columns: "<id>: <text>" for
        // the answer, then its points, headed by the question's points possible
        // ("1.0"). Every points column can carry the same header, so they are
        // renamed after their question before headers become object keys —
        // otherwise each question's points overwrote the last one's.
        const questionCols: { label: string; pointsIndex: number; pointsPossible: number | null }[] = [];
        const columns = [...header];
        for (let i = 0; i < header.length - 1; i++) {
          if (/^\d+:/.test(header[i]) && !/^\d+:/.test(header[i + 1])) {
            const possible = header[i + 1] === '' ? NaN : Number(header[i + 1]);
            questionCols.push({ label: header[i], pointsIndex: i + 1, pointsPossible: Number.isFinite(possible) ? possible : null });
            columns[i + 1] = `${header[i].split(':')[0]}: points`;
          }
        }

        if (reportType === 'item_analysis' || format === 'full') {
          const objects = cleaned.map(r => Object.fromEntries(columns.map((h, i) => [h, r[i] ?? ''])));
          return { content: [{ type: "text", text: JSON.stringify({ ...meta, columns, rows: objects }) }] };
        }

        // A blank cell is a question the student was never shown or skipped,
        // not a zero — Number('') is 0, which would count it as a wrong answer.
        const numeric = (cell: string | undefined) => (cell ?? '').trim() === '' ? NaN : Number(cell);

        const questionStats = questionCols.map(({ label, pointsIndex, pointsPossible }) => {
          const points = cleaned
            .map(r => numeric(r[pointsIndex]))
            .filter(n => Number.isFinite(n));
          const max = points.length ? Math.max(...points) : 0;
          const full = pointsPossible ?? max;
          const fullCredit = points.filter(p => full > 0 && p >= full).length;
          return {
            question: label.length > 160 ? `${label.slice(0, 160)}…` : label,
            points_possible: pointsPossible,
            responses: points.length,
            mean_points: points.length ? Number((points.reduce((a, b) => a + b, 0) / points.length).toFixed(2)) : null,
            max_points_observed: max,
            full_credit_count: fullCredit,
            full_credit_rate: points.length ? Number((fullCredit / points.length).toFixed(2)) : null,
          };
        });

        const scoreIndex = header.findIndex(h => h.toLowerCase() === 'score');
        const students = cleaned.map(r => {
          const score = scoreIndex >= 0 ? numeric(r[scoreIndex]) : NaN;
          return {
            student: nameIndex >= 0 ? r[nameIndex] : null,
            user_id: idIndex >= 0 ? r[idIndex] : null,
            score: Number.isFinite(score) ? score : null,
          };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...meta,
              note: "format='summary'; call again with format='full' for the complete answer matrix.",
              question_statistics: questionStats,
              students,
            })
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to get quiz report: ${error.message}`);
        }
        throw new Error('Failed to get quiz report: Unknown error');
      }
    }
  );

  // Tool: get-quiz-submission-events
  server.tool(
    "get-quiz-submission-events",
    "Get the event trail for one Classic quiz attempt: how answers changed over time, and when the student left or returned to the quiz page. Requires Canvas's Quiz Log Auditing feature. Use the submission id from list-quiz-submissions.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      submissionId: z.string().describe("The ID of the quiz submission (not the user ID)"),
      attempt: z.number().optional().describe("Which attempt to read (default: the most recent)"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, submissionId, attempt }: { courseId: string; quizId: string; submissionId: string; attempt?: number }) => {
      try {
        const params: any = { per_page: 100 };
        if (attempt !== undefined) params.attempt = attempt;
        const envelope = await canvas.fetchAllPagesEnvelope(
          `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}/events`,
          params
        );
        const events = envelope.quiz_submission_events ?? [];
        if (events.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No events recorded for quiz submission ${submissionId}${attempt !== undefined ? ` (attempt ${attempt})` : ''}. `
                + `Canvas only records them while the "Quiz Log Auditing" feature is enabled for the course, and only from `
                + `the moment it was turned on — so an empty log is not evidence that the student never left the page.`
            }]
          };
        }

        const counts: Record<string, number> = {};
        for (const e of events) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;

        const timeline = events.map((e: any) => {
          if (e.event_type === 'question_answered') {
            return {
              at: e.created_at,
              event: e.event_type,
              answers: (e.event_data ?? []).map((d: any) => ({ question_id: d.quiz_question_id, answer: d.answer })),
            };
          }
          return { at: e.created_at, event: e.event_type, ...(e.event_data ? { data: e.event_data } : {}) };
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              submission_id: submissionId,
              attempt: attempt ?? 'latest',
              event_counts: counts,
              page_left_count: counts['page_blurred'] ?? 0,
              timeline,
            })
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz submission events: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz submission events: Unknown error');
      }
    }
  );

  // Tool: update-quiz-submission-score
  server.tool(
    "update-quiz-submission-score",
    "Regrade a Classic quiz attempt: override the score on individual questions and/or set fudge points on the total. Use the submission id from list-quiz-submissions.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      submissionId: z.string().describe("The ID of the quiz submission (not the user ID)"),
      attempt: z.number().describe("Which attempt to regrade"),
      fudgePoints: z.number().optional().describe("Fudge points for the attempt, added to (or, if negative, subtracted from) its total. This SETS the attempt's fudge points, replacing any already there — it does not add to them."),
      questions: z.record(z.object({
        score: z.number().optional(),
        comment: z.string().optional(),
      })).optional().describe("Per-question overrides keyed by question ID, e.g. { \"1234\": { \"score\": 2, \"comment\": \"Accepted alternative phrasing\" } }"),
    },
    { idempotentHint: true },
    async ({ courseId, quizId, submissionId, attempt, fudgePoints, questions }: {
      courseId: string; quizId: string; submissionId: string; attempt: number; fudgePoints?: number; questions?: Record<string, { score?: number; comment?: string }>;
    }) => {
      if (fudgePoints === undefined && !questions) {
        throw new Error('Provide fudgePoints, questions, or both — nothing to update.');
      }
      try {
        const entry: any = { attempt };
        if (fudgePoints !== undefined) entry.fudge_points = fudgePoints;
        if (questions) entry.questions = questions;

        const result = await canvas.put(
          `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}`,
          { quiz_submissions: [entry] }
        ) as any;
        const updated = result?.quiz_submissions?.[0] ?? result;

        return {
          content: [{
            type: "text",
            text: `Quiz submission ${submissionId} regraded (attempt ${attempt}): score ${updated?.score}, kept_score ${updated?.kept_score}, fudge_points ${updated?.fudge_points}.`
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to update quiz submission score: ${error.message}`);
        }
        throw new Error('Failed to update quiz submission score: Unknown error');
      }
    }
  );
}
