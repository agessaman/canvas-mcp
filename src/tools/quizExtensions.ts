import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// Extra TIME on a timed quiz — the accommodation extend-due-date deliberately
// does not cover. A due date says when work is handed in; extra time says how
// long the clock runs once a student starts. They are different endpoints, and
// giving a student a later due date when what they need is a longer clock is a
// missed accommodation that looks like a granted one.
//
// The awkward part is that the two quiz engines share nothing here:
//
//   Classic  POST /api/v1/courses/:id/quizzes/:id/extensions
//            body { quiz_extensions: [{ user_id, extra_time, ... }] }
//   New      POST /api/quiz/v1/courses/:id/quizzes/:assignment_id/accommodations
//            body [{ user_id, extra_time, ... }]   <- a bare array
//
// so the engine has to be established before anything is written. A teacher
// should not have to know which engine backs their quiz, so these tools work it
// out; see resolveEngine for why that means probing both.

// Canvas's own ceiling on extra time, in both engines: 10080 minutes = 1 week.
const MAX_EXTRA_MINUTES = 10080;

const EXTRA_MINUTES = z.number().int().min(0).max(MAX_EXTRA_MINUTES)
  .describe(
    "Extra minutes on the clock, added to the quiz's time limit for these students "
    + "(e.g. 30 turns a 60-minute quiz into 90 for them). This is an absolute value, not "
    + "a top-up: calling it again replaces the previous grant rather than adding to it. "
    + "0 removes an extension."
  );

interface Target { ids: string[]; note: string; }

/**
 * Turn the caller's target into the list of user IDs Canvas actually wants.
 *
 * Neither engine has a section-level extension, so a section has to be expanded
 * to its students here. That expansion is a snapshot, which matters enough to
 * say out loud: a student added to an "Extra Time" section next week does not
 * inherit anything granted today.
 */
async function resolveTargets(
  canvas: CanvasClient,
  args: { studentIds?: string[]; sectionId?: string }
): Promise<Target> {
  const hasStudents = (args.studentIds?.length ?? 0) > 0;
  if (hasStudents === !!args.sectionId) {
    throw new Error('Target exactly one of studentIds or sectionId.');
  }

  if (hasStudents) {
    return { ids: args.studentIds!.map(String), note: '' };
  }

  const enrollments = await canvas.listSectionEnrollments(args.sectionId!, {
    type: ['StudentEnrollment'],
    state: ['active', 'invited'],
    per_page: 100,
  });
  const ids = [...new Set(enrollments.map((e: any) => String(e.user_id)))];
  if (ids.length === 0) {
    throw new Error(
      `Section ${args.sectionId} has no currently-enrolled students, so nothing would be granted. `
      + `Check the section ID with list-sections.`
    );
  }
  return {
    ids,
    note: `\n\nTargeted section ${args.sectionId} by expanding it to its ${ids.length} currently-enrolled `
      + `student(s) — Canvas has no section-level quiz extension. This is a snapshot: students added to that `
      + `section later will NOT get this extension, and it must be granted to them separately.`,
  };
}

/**
 * Canvas wants integer user IDs, and the New Quizzes service takes raw JSON
 * rather than form-encoded params, so a string ID is not reliably coerced.
 * Refuse anything non-numeric rather than send a payload Canvas may accept and
 * quietly ignore.
 */
function numericIds(ids: string[]): number[] {
  const bad = ids.filter(id => !/^\d+$/.test(id));
  if (bad.length > 0) {
    throw new Error(
      `Student IDs must be numeric Canvas user IDs; got ${bad.join(', ')}. `
      + `Resolve names or SIS IDs to Canvas user IDs with list-students first.`
    );
  }
  return ids.map(Number);
}

type Engine = { kind: 'classic' | 'new'; quiz: any };

/**
 * Decide which engine backs this ID.
 *
 * Both engines are probed, because their ID spaces are independent — a Classic
 * quiz ID is a quiz row, a New Quiz's ID is its assignment row — so the same
 * number can name a real quiz under each. Guessing there would write an
 * accommodation onto the wrong quiz and report success, so an ambiguous ID is
 * refused and the caller names the engine.
 */
async function resolveEngine(
  canvas: CanvasClient,
  courseId: string,
  quizId: string,
  requested?: 'classic' | 'new'
): Promise<Engine> {
  const probe = await canvas.probeQuizEngines(courseId, quizId);

  // Some instances surface New Quizzes through the Classic index as a shim.
  // It answers to the Classic endpoint but not to Classic extensions.
  const classic = probe.classic && probe.classic.quiz_type !== 'quizzes.next' ? probe.classic : null;
  const newQuiz = probe.newQuiz;

  if (requested === 'classic' && classic) return { kind: 'classic', quiz: classic };
  if (requested === 'new' && newQuiz) return { kind: 'new', quiz: newQuiz };
  if (requested) {
    throw new Error(
      `No ${requested === 'new' ? 'New Quiz' : 'Classic quiz'} with ID ${quizId} in course ${courseId}. `
      + `Canvas said: ${(requested === 'new' ? probe.errors.newQuiz : probe.errors.classic) ?? 'nothing'}`
    );
  }

  if (classic && newQuiz) {
    throw new Error(
      `ID ${quizId} names both a Classic quiz ("${classic.title}") and a New Quiz ("${newQuiz.title}") in `
      + `course ${courseId} — the two use separate ID spaces, so this is ambiguous. Pass engine: "classic" or `
      + `engine: "new" to say which one you mean.`
    );
  }
  if (classic) return { kind: 'classic', quiz: classic };
  if (newQuiz) return { kind: 'new', quiz: newQuiz };

  throw new Error(
    `No quiz with ID ${quizId} in course ${courseId} under either engine. `
    + `Classic said: ${probe.errors.classic ?? 'nothing'}. New Quizzes said: ${probe.errors.newQuiz ?? 'nothing'}.`
  );
}

/**
 * Extra minutes on an untimed quiz change nothing at all — the student already
 * has unlimited time. Canvas stores the extension happily and says nothing, so
 * this is exactly the shape of failure this server exists to catch: an
 * accommodation that reports success and does not exist.
 */
function timeLimitNote(engine: Engine, extraMinutes: number): string {
  if (extraMinutes === 0) return '';

  if (engine.kind === 'classic') {
    const limit = engine.quiz?.time_limit;
    if (!limit) {
      return `\n\nWARNING: "${engine.quiz?.title}" has no time limit, so extra minutes change nothing — `
        + `these students already have unlimited time. The extension is stored and will apply if a time limit `
        + `is set later. If what they need is a later DEADLINE, use extend-due-date instead.`;
    }
    return `\n\nThe quiz's time limit is ${limit} minutes, so these students get ${limit + extraMinutes}.`;
  }

  const settings = engine.quiz?.quiz_settings ?? {};
  const seconds = settings.session_time_limit_in_seconds ?? 0;
  if (!settings.has_time_limit || !seconds) {
    return `\n\nWARNING: "${engine.quiz?.title}" has no time limit, so extra minutes change nothing — `
      + `these students already have unlimited time. The accommodation is stored and will apply if a time limit `
      + `is set later. If what they need is a later DEADLINE, use extend-due-date instead.`;
  }
  const limit = Math.round(seconds / 60);
  return `\n\nThe quiz's time limit is ${limit} minutes, so these students get ${limit + extraMinutes}.`;
}

/**
 * Classic echoes the stored extension back, so what landed can be compared
 * against what was asked for — the same readback discipline the override tools
 * use, and for the same reason: Canvas answers 200 to writes it did not apply.
 */
function verifyClassic(requested: any[], response: any): string {
  const stored: any[] = response?.quiz_extensions ?? [];
  const problems: string[] = [];

  for (const want of requested) {
    const got = stored.find((e: any) => String(e.user_id) === String(want.user_id));
    if (!got) {
      problems.push(
        `student ${want.user_id} is missing from Canvas's response and has NO extension `
        + `(most likely they are not enrolled in this course)`
      );
      continue;
    }
    if (Number(got.extra_time ?? 0) !== Number(want.extra_time)) {
      problems.push(`student ${want.user_id}: asked for ${want.extra_time} extra minutes, Canvas stored ${got.extra_time ?? 0}`);
    }
    if (want.extra_attempts !== undefined && Number(got.extra_attempts ?? 0) !== Number(want.extra_attempts)) {
      problems.push(`student ${want.user_id}: asked for ${want.extra_attempts} extra attempts, Canvas stored ${got.extra_attempts ?? 0}`);
    }
  }

  return problems.length > 0
    ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
    : '';
}

/**
 * New Quizzes reports per-student outcomes in successful/failed arrays instead
 * of echoing the stored record, and offers no way to read accommodations back
 * afterwards. That response is therefore the only evidence the accommodation
 * exists, so a partial failure has to be surfaced rather than summarized.
 */
function verifyNewQuiz(requested: any[], response: any): string {
  const problems: string[] = [];
  const failed: any[] = Array.isArray(response?.failed) ? response.failed : [];
  const succeeded: any[] = Array.isArray(response?.successful) ? response.successful : [];

  if (failed.length > 0) {
    problems.push(`Canvas rejected these: ${JSON.stringify(failed)}`);
  }

  // Only treat a short success list as a problem when Canvas actually returned
  // one; an instance that answers with just a message is not evidence of failure.
  if (succeeded.length > 0 && succeeded.length < requested.length) {
    const named = new Set(succeeded.map((entry: any) => String(entry?.user_id ?? entry)));
    const missing = requested
      .map(r => String(r.user_id))
      .filter(id => !named.has(id));
    if (missing.length > 0) {
      problems.push(`these students are in neither list and have NO accommodation: ${missing.join(', ')}`);
    }
  }

  const caveat = `\n\nNote: Canvas exposes no endpoint for reading New Quizzes accommodations back, so this `
    + `response is the only confirmation available. To see it in Canvas, open the quiz and use Moderate.`;

  return (problems.length > 0
    ? `\n\nWARNING — Canvas did not apply all of this:\n- ${problems.join('\n- ')}`
    : '') + caveat;
}

/**
 * The New Quizzes service keeps its own user records, and rejects a student
 * Canvas itself knows perfectly well.
 *
 * Observed live in course 18473: user 6199 is an active student enrollment, has
 * an assignment override, and takes a Classic quiz extension without complaint —
 * but both accommodations endpoints answer
 * `404 {"error":"Users with IDs 6199 were not found"}`. The course-level call
 * fails identically, so it is the user that cannot be resolved, not the quiz.
 * Canvas's own docs say a 404 here means the course or assignment was not
 * found, which sends you looking in exactly the wrong place.
 *
 * Publishing the course was tried and changed nothing, so that is not it. The
 * remaining explanation is that the service only learns about a student when
 * they launch a New Quiz, and this one never has (`last_activity_at: null`).
 * Unconfirmed, so the message says what was observed rather than asserting the
 * mechanism.
 */
function explainNewQuizUserError(error: any, ids: number[]): never {
  const message = String(error?.message ?? '');
  if (!/were not found/i.test(message)) throw error;

  throw new Error(
    `${message}\n\n`
    + `Canvas's New Quizzes service keeps its own record of users, separate from the course roster, and it does `
    + `not know these students: ${ids.join(', ')}. An active enrollment is not enough — this same ID can be `
    + `enrolled, hold an assignment override, and accept a Classic quiz extension while the New Quizzes service `
    + `still reports it as missing. (Canvas documents this 404 as a missing course or assignment, which it is not.)\n\n`
    + `The service appears to learn about a student only once they have opened a New Quiz, so this usually means `
    + `the student has never launched one. Publishing the course does NOT fix it — that was tried. Have the `
    + `student open a New Quiz once, then grant the accommodation. Date accommodations (extend-due-date) and `
    + `Classic quiz extensions are unaffected and work now.`
  );
}

export function registerQuizExtensionTools(server: McpServer, canvas: CanvasClient) {
  // Tool: extend-quiz-time
  server.tool(
    "extend-quiz-time",
    "Give students extra MINUTES on a timed quiz — the clock accommodation (e.g. time-and-a-half on a 60-minute "
    + "quiz). This is not a due date: use extend-due-date for a later deadline, and this tool for a longer clock. "
    + "Works with both Classic Quizzes and New Quizzes; the engine is detected from the ID. Target either "
    + "studentIds or a sectionId (which is expanded to its students, since Canvas has no section-level extension).",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("A Classic quiz ID, or a New Quiz's assignment ID. Both engines are checked."),
      studentIds: z.array(z.string()).optional().describe("Canvas user IDs of the students getting extra time. Mutually exclusive with sectionId."),
      sectionId: z.string().optional().describe("Grant to every currently-enrolled student in this section. Mutually exclusive with studentIds."),
      extraMinutes: EXTRA_MINUTES,
      extraAttempts: z.number().int().min(0).optional().describe("Extra attempts beyond the quiz's limit, if retakes are part of the accommodation"),
      reduceChoices: z.boolean().optional().describe("New Quizzes only: remove one wrong answer from multiple-choice questions with 4+ options"),
      manuallyUnlocked: z.boolean().optional().describe("Classic Quizzes only: let these students take the quiz even while it is locked for everyone else"),
      engine: z.enum(["classic", "new"]).optional().describe("Only needed if the ID is ambiguous (it can name a quiz under both engines)")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const engine = await resolveEngine(canvas, args.courseId, args.quizId, args.engine);

        // Refuse engine-specific options aimed at the wrong engine rather than
        // dropping them: Canvas ignores parameters it does not support without
        // complaint, so a silently discarded option reads as a granted one.
        if (engine.kind === 'classic' && args.reduceChoices !== undefined) {
          throw new Error('reduceChoices is a New Quizzes accommodation; Classic Quizzes has no equivalent and would ignore it.');
        }
        if (engine.kind === 'new' && args.manuallyUnlocked !== undefined) {
          throw new Error('manuallyUnlocked is a Classic Quizzes extension; the New Quizzes accommodations API has no equivalent and would ignore it.');
        }

        const target = await resolveTargets(canvas, args);
        const ids = numericIds(target.ids);
        const label = args.extraMinutes === 0
          ? `Removed extra time for ${ids.length} student(s)`
          : `Gave ${ids.length} student(s) ${args.extraMinutes} extra minute(s)`;

        if (engine.kind === 'classic') {
          const extensions = ids.map(user_id => {
            const entry: any = { user_id, extra_time: args.extraMinutes };
            if (args.extraAttempts !== undefined) entry.extra_attempts = args.extraAttempts;
            if (args.manuallyUnlocked !== undefined) entry.manually_unlocked = args.manuallyUnlocked;
            return entry;
          });
          const response: any = await canvas.setQuizExtensions(args.courseId, args.quizId, extensions);
          return {
            content: [{
              type: "text",
              text: `${label} on Classic quiz "${engine.quiz?.title}" (${args.quizId}): ${ids.join(', ')}.`
                + timeLimitNote(engine, args.extraMinutes)
                + target.note
                + verifyClassic(extensions, response)
            }]
          };
        }

        const accommodations = ids.map(user_id => {
          const entry: any = { user_id, extra_time: args.extraMinutes };
          if (args.extraAttempts !== undefined) entry.extra_attempts = args.extraAttempts;
          if (args.reduceChoices !== undefined) entry.reduce_choices_enabled = args.reduceChoices;
          return entry;
        });
        const response: any = await canvas
          .setNewQuizAccommodations(args.courseId, args.quizId, accommodations)
          .catch((error: any) => explainNewQuizUserError(error, ids));
        return {
          content: [{
            type: "text",
            text: `${label} on New Quiz "${engine.quiz?.title}" (${args.quizId}): ${ids.join(', ')}.`
              + timeLimitNote(engine, args.extraMinutes)
              + target.note
              + verifyNewQuiz(accommodations, response)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to extend quiz time: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-quiz-extensions
  server.tool(
    "list-quiz-extensions",
    "Show who already has extra time or extra attempts on a quiz, before granting more. Classic Quizzes only — "
    + "Canvas's New Quizzes accommodations API is write-only, and this tool says so rather than reporting an "
    + "empty list that would read as \"nobody has an accommodation\".",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("A Classic quiz ID, or a New Quiz's assignment ID"),
      engine: z.enum(["classic", "new"]).optional().describe("Only needed if the ID is ambiguous")
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, engine: requested }: { courseId: string; quizId: string; engine?: 'classic' | 'new' }) => {
      try {
        const engine = await resolveEngine(canvas, courseId, quizId, requested);

        if (engine.kind === 'new') {
          return {
            content: [{
              type: "text",
              text: `"${engine.quiz?.title}" is a New Quiz, and Canvas provides no endpoint for reading its `
                + `accommodations back — they can only be written. Existing extra time for this quiz cannot be `
                + `listed here; open the quiz in Canvas and use Moderate to see it. Granting extra time still `
                + `works: extend-quiz-time.`
            }]
          };
        }

        const response: any = await canvas.listQuizSubmissions(courseId, quizId);
        const submissions: any[] = response?.quiz_submissions ?? [];
        const withExtension = submissions.filter(s =>
          Number(s.extra_time ?? 0) > 0 || Number(s.extra_attempts ?? 0) > 0 || s.manually_unlocked
        );

        const limit = engine.quiz?.time_limit;
        const limitNote = limit
          ? `The quiz's time limit is ${limit} minutes.`
          : `NOTE: this quiz has no time limit, so extra minutes have no effect on it.`;

        if (withExtension.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No student has an extension on "${engine.quiz?.title}". ${limitNote}\n\n`
                + `Caveat: Canvas records extensions on a student's quiz submission, so a student who has never `
                + `opened the quiz and has no extension will not appear here at all.`
            }]
          };
        }

        const rows = withExtension.map(s => ({
          user_id: s.user_id,
          extra_time: s.extra_time ?? 0,
          extra_attempts: s.extra_attempts ?? 0,
          manually_unlocked: !!s.manually_unlocked,
        }));

        return {
          content: [{
            type: "text",
            text: `Extensions on "${engine.quiz?.title}":\n\n${JSON.stringify(rows, null, 2)}\n\n`
              + `${limitNote} Student IDs can be resolved to names with list-students.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list quiz extensions: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: set-course-quiz-accommodations
  server.tool(
    "set-course-quiz-accommodations",
    "Give students extra time on EVERY New Quiz in a course at once — the standing IEP/504 accommodation, rather "
    + "than a per-quiz grant. New Quizzes only: Classic Quizzes has no course-level equivalent, so a student's "
    + "Classic quizzes must still be handled one at a time with extend-quiz-time.",
    {
      courseId: z.string().describe("The ID of the course"),
      studentIds: z.array(z.string()).optional().describe("Canvas user IDs. Mutually exclusive with sectionId."),
      sectionId: z.string().optional().describe("Grant to every currently-enrolled student in this section. Mutually exclusive with studentIds."),
      extraMinutes: EXTRA_MINUTES,
      reduceChoices: z.boolean().optional().describe("Remove one wrong answer from multiple-choice questions with 4+ options"),
      applyToInProgressSessions: z.boolean().optional().describe("Also apply to quiz attempts that are open right now, not just future ones")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const target = await resolveTargets(canvas, args);
        const ids = numericIds(target.ids);

        const accommodations = ids.map(user_id => {
          const entry: any = { user_id, extra_time: args.extraMinutes };
          if (args.reduceChoices !== undefined) entry.reduce_choices_enabled = args.reduceChoices;
          if (args.applyToInProgressSessions !== undefined) {
            entry.apply_to_in_progress_quiz_sessions = args.applyToInProgressSessions;
          }
          return entry;
        });

        const response: any = await canvas
          .setCourseQuizAccommodations(args.courseId, accommodations)
          .catch((error: any) => explainNewQuizUserError(error, ids));
        const label = args.extraMinutes === 0
          ? `Removed the course-wide extra time for ${ids.length} student(s)`
          : `Gave ${ids.length} student(s) ${args.extraMinutes} extra minute(s) on every New Quiz`;

        return {
          content: [{
            type: "text",
            text: `${label} in course ${args.courseId}: ${ids.join(', ')}.`
              + `\n\nThis covers New Quizzes only. Any Classic quizzes in this course are unaffected and need `
              + `extend-quiz-time per quiz.`
              + target.note
              + verifyNewQuiz(accommodations, response)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set course quiz accommodations: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
