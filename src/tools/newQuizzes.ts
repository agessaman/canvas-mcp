import { z } from "zod";
import { jsonObjectParam } from "../jsonObjectParam.js";
import {
  NEW_QUIZ_SETTING_PARAMS, buildQuizSettings, validateSettings, touchesSettings, formatQuizSettings,
} from "../newQuizSettings.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import type { NewQuizzesLtiClient } from "../newQuizzesLti.js";
import { buildItemEntry, InteractionType } from "../newQuizItemBuilder.js";
import { itemBanksEnabled } from "../types.js";
import { DataAnonymizer } from "../anonymizer.js";
import { stripHtml } from "../html.js";

// New Quizzes live at /api/quiz/v1, a different API root from Classic Quizzes
// (/api/v1/courses/:id/quizzes). A New Quiz is backed by an Assignment, so the
// id used throughout this file is an assignment_id — and that same id is what
// grade-submission takes when hand-grading essay responses.

const INTERACTION_TYPES = ['choice', 'true-false', 'multi-answer', 'essay', 'numeric', 'matching', 'rich-fill-blank', 'ordering', 'categorization', 'hot-spot'] as const;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A New Quiz item_analysis row per question. The interesting numbers are the
 * same for every question type, but the response breakdown is not: choice and
 * true-false carry `choices`, matching carries a `questions` map of prompt to
 * answer counts, and an essay carries a score distribution instead — a summary
 * that only read `choices` would report those questions as unanswered.
 */
function summariseItemAnalysis(items: any[], full: boolean): any[] {
  const bodyLength = full ? 2000 : 200;
  const answerLength = full ? 500 : 120;
  return items.map((item, index) => {
    const meta = item?.metadata ?? {};
    const scores = item?.scores ?? {};
    const answers = item?.answer_summary ?? {};
    const aggregate = answers.aggregate ?? {};
    const row: any = {
      position: index + 1,
      item_id: meta.item_id,
      interaction_type: meta.interaction_type,
      question: stripHtml(meta.item_body, bodyLength),
      points_possible: scores.points_possible,
      mean: scores.mean,
      median: scores.median,
      difficulty_index: scores.difficulty_index,
      discrimination_index: scores.discrimination_index,
      pearson_correlation: scores.pearson_correlation,
      correct: aggregate.correct?.count,
      incorrect: aggregate.incorrect?.count,
      no_answer: answers.no_answer?.count,
    };
    if (Array.isArray(answers.choices)) {
      row.choices = answers.choices.map((choice: any) => ({
        text: stripHtml(choice?.body, answerLength),
        count: choice?.count,
        percentage: choice?.percentage,
        correct: !!choice?.correct,
      }));
    }
    if (answers.questions && typeof answers.questions === 'object') {
      row.pairs = Object.entries(answers.questions).map(([id, sub]: [string, any]) => ({
        id,
        prompt: stripHtml(sub?.body, answerLength),
        answers: Object.values(sub?.answers ?? {}).map((answer: any) => ({
          text: stripHtml(answer?.body, answerLength),
          count: answer?.count,
          correct: !!answer?.correct,
        })),
      }));
    }
    if (Array.isArray(answers.score_distribution)) {
      row.score_distribution = answers.score_distribution.map((bucket: any) => ({
        score: bucket?.score, count: bucket?.count,
      }));
    }
    if (answers.graded) row.graded = answers.graded.count;
    return row;
  });
}

/**
 * A New Quiz student_analysis row per student. The report carries name, SIS id
 * and section for every one of them, so the identifying fields go only when
 * the caller asked for them.
 */
function summariseStudentAnalysis(rows: any[], anonymous: boolean, full: boolean): any[] {
  return rows.map(row => {
    const student = row?.student_data ?? {};
    const responses: any[] = Array.isArray(row?.item_responses) ? row.item_responses : [];
    const scored = responses.filter(r => typeof r?.score === 'number');
    const out: any = {
      user_id: student.id,
      student: anonymous ? DataAnonymizer.pseudonymFor(student.id) : student.name,
      ...(anonymous ? {} : { sis_id: student.sis_id }),
      sections: student.section_info?.section_names,
      submitted_at: student.submitted_at,
      elapsed_time: student.elapsed_time,
      attempt: student.attempt,
      score: round2(scored.reduce((total, r) => total + r.score, 0)),
      answered: responses.filter(r => r?.answer !== null && r?.answer !== undefined && r?.answer !== '').length,
      questions: responses.length,
    };
    if (full) {
      out.responses = responses.map(r => ({
        item_id: r?.item_id,
        item_type: r?.item_type,
        score: r?.score,
        answer: typeof r?.answer === 'string' ? stripHtml(r.answer, 500) : r?.answer,
      }));
    }
    return out;
  });
}

/**
 * Stimuli and attaching questions to them.
 *
 * The public API cannot do either: `stimulus_quiz_entry_id` is read-only there
 * (written four ways on 2026-08-03, stored "" every time, 200 each time) and
 * entry_type "Stimulus" is refused with a bare 400. The Canvas quiz editor does
 * both on quiz-api with a quiz.build token, and so do these tools when the
 * private New Quizzes tools are switched on (NewQuizzesLtiClient):
 *
 *   POST /api/quizzes/:q/stimuli        { stimulus: {...} }       -> the passage
 *   POST /api/quizzes/:q/quiz_entries   { quiz_entry: { entry_type: "Stimulus", entry_id } }
 *   PATCH /api/quizzes/:q/quiz_entries/:itemId { quiz_entry: { stimulus_quiz_entry_id } }
 *
 * quiz_entry IDs on quiz-api are the item IDs /api/quiz/v1 reports, so a
 * stimulus created here is the stimulusQuizEntryId the public API reads back.
 * Verified end to end on assignment 371872, 2026-10-27.
 */
function privateApiRequired(what: string): string {
  return `${what} needs the private New Quizzes API, which is switched off. Canvas's public API cannot do it (it `
    + `accepts stimulus_quiz_entry_id and silently stores nothing). Turn on CANVAS_ENABLE_ITEM_BANKS (the "Enable `
    + `New Quizzes item bank tools" setting in the desktop extension), or do it in the Canvas UI: Insert Content > `
    + `Stimulus, then add the questions inside its block.`;
}

/** Fetch an item fresh and check it is a stimulus in this quiz. */
async function requireStimulus(canvas: CanvasClient, courseId: string, assignmentId: string, stimulusId: string) {
  let stimulus: any;
  try {
    stimulus = await canvas.getNewQuizItem(courseId, assignmentId, stimulusId);
  } catch (error: any) {
    throw new Error(`Stimulus ${stimulusId} was not found in quiz ${assignmentId}: ${error?.message ?? 'unknown error'}`);
  }
  if (stimulus?.entry_type !== 'Stimulus') {
    throw new Error(
      `Item ${stimulusId} in quiz ${assignmentId} is not a stimulus (its entry_type is `
      + `${stimulus?.entry_type ?? 'missing'}), so questions can't be attached to it. list-new-quiz-items shows `
      + `each item's entry_type.`
    );
  }
  return stimulus;
}

/**
 * Attach a question to a stimulus (or detach it with null) and read the result
 * back through the public API, which is what students' quiz is built from.
 * Returns a sentence for the tool's reply.
 */
async function setStimulus(
  canvas: CanvasClient, quizApi: NewQuizzesLtiClient,
  courseId: string, assignmentId: string, itemId: string, stimulusId: string | null,
): Promise<string> {
  await quizApi.quiz(courseId, assignmentId, 'patch', `/quiz_entries/${itemId}`, {
    quiz_entry: { stimulus_quiz_entry_id: stimulusId },
  });
  canvas.invalidateNewQuiz(courseId, assignmentId);
  const stored = String((await canvas.getNewQuizItem(courseId, assignmentId, itemId) as any)?.stimulus_quiz_entry_id ?? '');
  const wanted = stimulusId ?? '';
  if (stored !== wanted) {
    return `WARNING — quiz-api accepted the change, but the public API reads item ${itemId}'s stimulus as `
      + `"${stored}" rather than "${wanted}". Check the quiz in Canvas.`;
  }
  return stimulusId ? `Attached to stimulus ${stimulusId}.` : 'Detached from its stimulus.';
}

/**
 * Two of the four entry types a New Quiz item can have involve a bank, and they
 * are NOT the same thing. Both were being run through an Item-shaped summary
 * that read `entry.interaction_type_slug`, `entry.title` and `entry.item_body`
 * — fields neither of them has at that level — so both rendered as a row of
 * nulls, indistinguishable from a broken question. That is why a quiz built on
 * banks looked empty here. Shapes captured live on 2026-09-17:
 *
 * "Bank" — a RANDOM DRAW. One item stands for the whole draw:
 *   { properties: { sample_num: "1" },            <- how many it pulls
 *     entry: { id: "151", title: "...",           <- the bank
 *              entry_count: 2, item_entry_count: 2 } }   <- how many it can pull from
 *   The questions themselves are NOT in this payload and not anywhere in the
 *   Canvas API — see bankPoolNote.
 *
 * "BankEntry" — ONE question that happens to live in a bank, linked into the
 * quiz. The whole question, answer key included, IS here, one level deeper:
 *   { entry: { bank_id: "134", entry_type: "Item",
 *              entry: { interaction_type_slug: "choice", item_body, ... } } }
 *   So it needs unwrapping, not a warning: nothing about it is unreadable.
 */
function unwrapQuestion(entry: any): any {
  // A BankEntry nests the real question one level down; everything else is it.
  return entry?.entry_type === 'Item' && entry?.entry ? entry.entry : entry;
}

// Only a random draw hides its questions. A BankEntry is fully readable, so
// warning about it would send the reader off to the Canvas UI for something
// that is already on the screen.
function isBankDraw(item: any): boolean {
  return item?.entry_type === 'Bank';
}

function summariseItem(i: any): Record<string, any> {
  const base = {
    id: i.id,
    position: i.position,
    points_possible: i.points_possible,
    entry_type: i.entry_type,
  };

  if (isBankDraw(i)) {
    return {
      ...base,
      bank_id: i.entry?.id ?? null,
      bank_title: i.entry?.title ?? null,
      // sample_num arrives as a string ("1"); reported as Canvas spells it
      // rather than coerced, so a missing value stays visibly missing.
      draws_questions: i.properties?.sample_num ?? null,
      pool_size: i.entry?.item_entry_count ?? i.entry?.entry_count ?? null,
    };
  }

  const q = unwrapQuestion(i.entry);
  if (!q?.interaction_type_slug) {
    // Not a question and not a draw — an entry type added since this was
    // written. Pass it through whole rather than projecting a shape onto it,
    // which is the mistake this function exists to undo.
    return { ...base, entry: i.entry ?? null };
  }
  return {
    ...base,
    type: q.interaction_type_slug,
    title: q.title,
    item_body: q.item_body,
    // Which bank this question is linked from, when it is linked from one.
    ...(i.entry?.bank_id ? { bank_id: i.entry.bank_id } : {}),
    // Present when this question hangs off a stimulus (reading passage).
    ...(i.stimulus_quiz_entry_id ? { stimulus_quiz_entry_id: i.stimulus_quiz_entry_id } : {}),
  };
}

/**
 * Named after the boundary rather than after a failure, because nothing failed:
 * the draw is reported faithfully, and its pool simply is not in Canvas. New
 * Quizzes item banks are held by a separate Instructure service (AMS), which
 * Canvas reaches only through an LTI launch — `ItemBanksController#show`
 * renders an empty container and hands the browser that service's own api_url.
 * Probed live on 2026-09-17: every plausible spelling under /api/quiz/v1
 * (/banks, /banks/:id/entries, /item_banks, /courses/:id/banks, and the same
 * under /api/v1) returns Canvas's 404 page. So no Canvas API token reaches the
 * pool, and a caller not told this will keep trying tools that cannot work.
 */
function bankPoolNote(draws: any[]): string {
  if (draws.length === 0) return '';
  const which = draws
    .map(i => `item ${i.id} draws ${i.properties?.sample_num ?? '?'} of ${i.entry?.item_entry_count ?? '?'} from bank ${i.entry?.id ?? '?'} (${i.entry?.title ?? 'untitled'})`)
    .join('; ');
  const common = `\n\nNOTE — ${draws.length} item(s) pull questions at random from an item bank: ${which}. `
    + `Which questions a student sees is decided at attempt time. `;
  const classic = `(list-question-banks reads CLASSIC quiz banks — a different store, which will not contain these, `
    + `though a course whose quizzes were imported from QTI often has both.)`;

  // Two wordings, because the honest answer changes with the flag. With the
  // item bank tools registered the pool IS readable, and sending the reader to
  // the Canvas UI would be wrong; without them it is not reachable at all, and
  // naming a tool that does not exist would be worse.
  return itemBanksEnabled()
    ? common
      + `The pool itself is not in this payload, but list-item-bank-questions can read it — pass the bank id above. `
      + classic
    : common
      + `The bank's contents are NOT readable through the Canvas API: New Quizzes item banks live in a separate `
      + `Instructure service that Canvas only reaches through an LTI launch. To see or edit the pool, open Item `
      + `Banks in the Canvas course navigation. ` + classic;
}

export function registerNewQuizTools(server: McpServer, canvas: CanvasClient, quizApi?: NewQuizzesLtiClient) {
  // Tool: list-new-quizzes
  server.tool(
    "list-new-quizzes",
    "List New Quizzes in a course. New Quizzes are separate from Classic Quizzes (list-quizzes) and use a different API. Each quiz's ID is also its assignment ID — pass it to list-assignment-submissions or grade-submission to grade.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const quizzes = await canvas.listNewQuizzes(courseId);
        const rows = quizzes.map((q: any) => ({
          id: q.id,
          title: q.title,
          points_possible: q.points_possible,
          due_at: q.due_at ?? null,
          published: q.published,
          grading_type: q.grading_type,
        }));
        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `New Quizzes in course ${courseId}:\n\n${JSON.stringify(rows, null, 2)}`
              : "No New Quizzes found in this course. (Classic Quizzes are listed by list-quizzes.)"
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list New Quizzes: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-new-quiz
  server.tool(
    "get-new-quiz",
    "Fetch a single New Quiz, including its settings (time limit, attempts, shuffle, result visibility).",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId }: { courseId: string; assignmentId: string }) => {
      try {
        const quiz = await canvas.getNewQuiz(courseId, assignmentId);
        return { content: [{ type: "text", text: JSON.stringify(quiz, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to fetch New Quiz: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: create-new-quiz
  server.tool(
    "create-new-quiz",
    "Create a New Quiz in a course. Returns the new quiz's assignment ID, which you then pass to create-new-quiz-item to add questions.",
    {
      courseId: z.string().describe("The ID of the course"),
      title: z.string().describe("Quiz title"),
      instructions: z.string().optional().describe("Quiz instructions (HTML allowed)"),
      assignmentGroupId: z.string().optional().describe("Assignment group to file the quiz under"),
      pointsPossible: z.number().optional().describe("Total points (usually computed from items if omitted)"),
      gradingType: z.enum(['points', 'percent', 'letter_grade', 'gpa_scale', 'pass_fail']).optional(),
      dueAt: z.string().optional().describe("Due date (ISO 8601)"),
      unlockAt: z.string().optional().describe("Unlock date (ISO 8601)"),
      lockAt: z.string().optional().describe("Lock date (ISO 8601)"),
      ...NEW_QUIZ_SETTING_PARAMS,
      quizSettings: jsonObjectParam(
        "Escape hatch for settings without a parameter of their own — IP filtering especially. Merged over "
        + "everything above, so it wins on conflict."
      ).optional()
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        validateSettings(args);
        // No `current` on create: there is nothing to merge the nested groups into.
        const settings: any = buildQuizSettings(args);
        Object.assign(settings, args.quizSettings ?? {});

        const quiz: any = { title: args.title };
        if (args.instructions !== undefined) quiz.instructions = args.instructions;
        if (args.assignmentGroupId !== undefined) quiz.assignment_group_id = args.assignmentGroupId;
        if (args.pointsPossible !== undefined) quiz.points_possible = args.pointsPossible;
        if (args.gradingType !== undefined) quiz.grading_type = args.gradingType;
        if (args.dueAt !== undefined) quiz.due_at = args.dueAt;
        if (args.unlockAt !== undefined) quiz.unlock_at = args.unlockAt;
        if (args.lockAt !== undefined) quiz.lock_at = args.lockAt;
        if (Object.keys(settings).length > 0) quiz.quiz_settings = settings;

        const created = await canvas.createNewQuiz(args.courseId, quiz) as any;
        return {
          content: [{
            type: "text",
            text: `Created New Quiz "${created.title}" (assignment ID ${created.id}) in course ${args.courseId}. Add questions with create-new-quiz-item using assignmentId ${created.id}.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create New Quiz: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-new-quiz
  server.tool(
    "update-new-quiz",
    "Update an existing New Quiz's title, instructions, dates, or settings. Only the fields you pass are changed.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      title: z.string().optional(),
      instructions: z.string().optional(),
      pointsPossible: z.number().optional(),
      gradingType: z.enum(['points', 'percent', 'letter_grade', 'gpa_scale', 'pass_fail']).optional(),
      dueAt: z.string().optional().describe("Due date (ISO 8601)"),
      unlockAt: z.string().optional().describe("Unlock date (ISO 8601)"),
      lockAt: z.string().optional().describe("Lock date (ISO 8601)"),
      published: z.boolean().optional().describe(
        "Publish or unpublish the quiz. A New Quiz is published through its assignment rather than the quiz "
        + "API, which this handles for you."
      ),
      ...NEW_QUIZ_SETTING_PARAMS,
      quizSettings: jsonObjectParam(
        "Escape hatch for settings without a parameter of their own — IP filtering especially. Merged over "
        + "everything above, so it wins on conflict."
      ).optional()
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        validateSettings(args);

        const quiz: any = {};
        if (args.title !== undefined) quiz.title = args.title;
        if (args.instructions !== undefined) quiz.instructions = args.instructions;
        if (args.pointsPossible !== undefined) quiz.points_possible = args.pointsPossible;
        if (args.gradingType !== undefined) quiz.grading_type = args.gradingType;
        if (args.dueAt !== undefined) quiz.due_at = args.dueAt;
        if (args.unlockAt !== undefined) quiz.unlock_at = args.unlockAt;
        if (args.lockAt !== undefined) quiz.lock_at = args.lockAt;

        // The nested settings groups (multiple_attempts, result_view_settings)
        // are merged into what the quiz already has, so changing one field
        // cannot drop the ones beside it. That is correct whether or not Canvas
        // merges them itself, which is why it does not depend on knowing.
        if (touchesSettings(args) || args.quizSettings !== undefined) {
          let current: any = {};
          if (touchesSettings(args)) {
            try {
              const existing: any = await canvas.getNewQuiz(args.courseId, args.assignmentId);
              current = existing?.quiz_settings ?? {};
            } catch (error: any) {
              throw new Error(
                `Could not read New Quiz ${args.assignmentId} before updating its settings, so nothing was `
                + `changed. The attempt and result-view settings are nested groups that have to be merged into `
                + `what is already there; writing without reading could drop settings this call never mentions. `
                + `Canvas said: ${error?.message ?? 'unknown error'}`
              );
            }
          }
          const settings = buildQuizSettings(args, current);
          Object.assign(settings, args.quizSettings ?? {});
          if (Object.keys(settings).length > 0) quiz.quiz_settings = settings;
        }

        const publishing = args.published !== undefined;
        if (Object.keys(quiz).length === 0 && !publishing) {
          return { content: [{ type: "text", text: "No fields provided; nothing was changed." }] };
        }

        let updated: any = null;
        if (Object.keys(quiz).length > 0) {
          updated = await canvas.updateNewQuiz(args.courseId, args.assignmentId, quiz);
        }

        // Publishing is an ASSIGNMENT field. The New Quizzes API does not carry
        // it, and a New Quiz's ID is its assignment ID, so this routes there
        // rather than making the caller know that.
        let publishNote = '';
        if (publishing) {
          await canvas.updateAssignment(args.courseId, args.assignmentId, {
            assignment: { published: args.published },
          });
          publishNote = `\n\n${args.published ? 'Published' : 'Unpublished'} — done through the quiz's `
            + `assignment, which is where Canvas keeps that flag.`;
        }

        // Re-read rather than trust the write's echo, and show the settings the
        // way a teacher reads them.
        let settingsNote = '';
        try {
          const after: any = await canvas.getNewQuiz(args.courseId, args.assignmentId);
          settingsNote = `\n\n${formatQuizSettings(after?.quiz_settings)}`;
        } catch {
          settingsNote = '\n\n(The quiz could not be read back, so its stored settings are unconfirmed.)';
        }

        return {
          content: [{
            type: "text",
            text: `Updated New Quiz "${updated?.title ?? args.assignmentId}" (assignment ID ${args.assignmentId}).`
              + publishNote
              + settingsNote
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update New Quiz: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: delete-new-quiz
  server.tool(
    "delete-new-quiz",
    "Delete a New Quiz from a course. This removes the quiz and its underlying assignment.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID")
    },
    { destructiveHint: true },
    async ({ courseId, assignmentId }: { courseId: string; assignmentId: string }) => {
      try {
        await canvas.deleteNewQuiz(courseId, assignmentId);
        return { content: [{ type: "text", text: `Deleted New Quiz ${assignmentId} from course ${courseId}.` }] };
      } catch (error: any) {
        throw new Error(`Failed to delete New Quiz: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-new-quiz-items
  server.tool(
    "list-new-quiz-items",
    "List all questions (items) in a New Quiz, with their type, points, and position. An item that draws random "
    + "questions from an item bank is listed too, with the bank it pulls from — but the bank's own contents are "
    + "not readable through any Canvas API, and the answer says so rather than showing an empty question.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      full: z.boolean().default(false).describe("Return the complete item payload including answer keys, rather than a summary")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, full = false }: { courseId: string; assignmentId: string; full?: boolean }) => {
      try {
        const items = await canvas.listNewQuizItems(courseId, assignmentId);
        const payload = full ? items : items.map(summariseItem);
        const draws = items.filter(isBankDraw);
        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? JSON.stringify(payload, null, 2) + bankPoolNote(draws)
              : "This quiz has no questions yet."
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list New Quiz items: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-new-quiz-item
  server.tool(
    "get-new-quiz-item",
    "Fetch a single New Quiz question with its full payload, including the answer key.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      itemId: z.string().describe("The item (question) ID")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, itemId }: { courseId: string; assignmentId: string; itemId: string }) => {
      try {
        const item = await canvas.getNewQuizItem(courseId, assignmentId, itemId);
        return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to fetch New Quiz item: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: create-new-quiz-item
  server.tool(
    "create-new-quiz-item",
    "Add a question to a New Quiz. Give the question text, the choices, and which choice is correct — answer IDs and scoring rules are generated for you. Supports choice, multi-answer, true-false, essay, numeric, matching, rich-fill-blank (fill in the blank), ordering, categorization, and hot-spot; use rawEntry for formula and file-upload. HOT SPOT: pass imageUrl plus exactly one of hotspotRect (rectangle), hotspotOval (ellipse) or hotspotPolygon — the same three shapes the Canvas editor offers. Coordinates are FRACTIONS of the image (0-1); pass imagePixelWidth and imagePixelHeight to give them in pixels instead, which is usually easier and is how to get placement right. The image can be a Canvas Files URL (upload it with upload-course-file first) - it must be published and student-visible, or it will render for you and 403 for them. FILL IN THE BLANK: mark each blank by putting backticks around the correct answer in the body, e.g. \"The capital of France is `Paris`.\" — one blank per backticked run. STIMULUS (shared reading passage with several questions hanging off it): create the passage with create-new-quiz-stimulus, then add each question with stimulusQuizEntryId set to the stimulus's item ID; create them in order after the stimulus so they sit under it. This uses the private New Quizzes API and needs CANVAS_ENABLE_ITEM_BANKS on. list-new-quiz-items and get-new-quiz-item report the association as stimulus_quiz_entry_id.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      entryType: z.enum(['Item', 'Stimulus', 'Bank', 'BankEntry']).optional().describe("Item kind. Only 'Item' (the default) can be created here; for a stimulus use create-new-quiz-stimulus. The others exist so the value can be recognised when reading, and are refused."),
      stimulusQuizEntryId: z.string().optional().describe("Attach the new question to this stimulus (its item ID from create-new-quiz-stimulus or list-new-quiz-items). Needs the private New Quizzes API (CANVAS_ENABLE_ITEM_BANKS)."),
      interactionType: z.enum(INTERACTION_TYPES).optional().describe("Question type. Omit only when supplying rawEntry."),
      body: z.string().optional().describe("The question text (HTML allowed)"),
      title: z.string().optional().describe("Optional short label for the question"),
      pointsPossible: z.number().default(1).describe("Points this question is worth"),
      position: z.number().optional().describe("Position in the quiz (appended if omitted)"),
      choices: z.array(z.string()).optional().describe("Answer options, for choice and multi-answer"),
      correctChoiceIndex: z.number().optional().describe("0-based index of the correct option (choice)"),
      correctChoiceIndexes: z.array(z.number()).optional().describe("0-based indexes of correct options (multi-answer)"),
      partialCredit: z.boolean().optional().describe("Award partial credit on multi-answer (default: all-or-nothing)"),
      correctBoolean: z.boolean().optional().describe("The correct answer for true-false"),
      numericAnswer: z.number().optional().describe("The correct value for numeric"),
      numericMargin: z.number().optional().describe("Accepted margin of error for numeric"),
      numericMarginType: z.enum(['absolute', 'percent']).optional().describe("How numericMargin is interpreted"),
      gradingNotes: z.string().optional().describe("Grading guidance shown to the grader (essay)"),
      matchPairs: z.array(z.object({
        left: z.string().describe("The prompt shown on the left"),
        right: z.string().describe("The answer it should be matched to")
      })).optional().describe("Correct pairings, for matching"),
      distractors: z.array(z.string()).optional().describe("Extra options that belong to no answer — unmatched right-hand options for matching, uncategorized items for categorization"),
      blankMatching: z.enum(['contains', 'exact', 'close-enough', 'regex']).optional().describe("How fill-in-the-blank answers are matched (default: contains, which is what the Canvas UI uses)"),
      orderItems: z.array(z.string()).optional().describe("For ordering: the items in their CORRECT order — Canvas shuffles them for students"),
      topLabel: z.string().optional().describe("For ordering: label shown above the list, e.g. \"Earliest\""),
      bottomLabel: z.string().optional().describe("For ordering: label shown below the list, e.g. \"Latest\""),
      categories: z.array(z.object({
        name: z.string(),
        items: z.array(z.string())
      })).optional().describe("For categorization: each category and the items belonging in it"),
      imageUrl: z.string().optional().describe("For hot-spot: the image students click on. A Canvas Files URL works (verified live) — upload with upload-course-file, and make sure it is published, or students get a broken image where you see a working one."),
      imagePixelWidth: z.number().optional().describe("For hot-spot: the image's width in pixels. Give this WITH imagePixelHeight to specify the hotspot in PIXELS instead of fractions — far easier, since pixel positions can be read off any image viewer. Both or neither."),
      imagePixelHeight: z.number().optional().describe("For hot-spot: the image's height in pixels. See imagePixelWidth."),
      hotspotRect: z.object({
        x: z.number(), y: z.number(), width: z.number(), height: z.number()
      }).optional().describe("For hot-spot: the correct region as a rectangle, measured from the top-left. FRACTIONS of the image (0-1) by default, or PIXELS if imagePixelWidth/Height are given. Mutually exclusive with hotspotPolygon."),
      hotspotOval: z.object({
        x: z.number(), y: z.number(), width: z.number(), height: z.number()
      }).optional().describe("For hot-spot: the correct region as an ELLIPSE, given by its bounding box (same fields as hotspotRect). Mutually exclusive with the other shapes."),
      hotspotPolygon: z.array(z.object({ x: z.number(), y: z.number() }))
        .optional().describe("For hot-spot: the correct region as 3+ points, FRACTIONS of the image (0-1) by default, or PIXELS if imagePixelWidth/Height are given. Use for non-rectangular areas. Mutually exclusive with hotspotRect."),
      feedback: z.object({
        neutral: z.string().optional(),
        correct: z.string().optional(),
        incorrect: z.string().optional()
      }).optional().describe("Feedback shown to students after submitting"),
      rawEntry: jsonObjectParam("Escape hatch: a complete `entry` object for types the builder doesn't cover (formula, file-upload)").optional()
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        let entry: Record<string, any>;
        if (args.rawEntry) {
          entry = args.rawEntry;
        } else {
          if (!args.interactionType || !args.body) {
            throw new Error('interactionType and body are required unless rawEntry is supplied');
          }
          entry = buildItemEntry({
            interactionType: args.interactionType as InteractionType,
            title: args.title,
            body: args.body,
            choices: args.choices,
            correctChoiceIndex: args.correctChoiceIndex,
            correctChoiceIndexes: args.correctChoiceIndexes,
            correctBoolean: args.correctBoolean,
            numericAnswer: args.numericAnswer,
            numericMargin: args.numericMargin,
            numericMarginType: args.numericMarginType,
            gradingNotes: args.gradingNotes,
            partialCredit: args.partialCredit,
            matchPairs: args.matchPairs,
            distractors: args.distractors,
            blankMatching: args.blankMatching,
            orderItems: args.orderItems,
            topLabel: args.topLabel,
            bottomLabel: args.bottomLabel,
            categories: args.categories,
            imageUrl: args.imageUrl,
            imagePixelWidth: args.imagePixelWidth,
            imagePixelHeight: args.imagePixelHeight,
            hotspotRect: args.hotspotRect,
            hotspotOval: args.hotspotOval,
            hotspotPolygon: args.hotspotPolygon,
            feedback: args.feedback,
          });
        }

        // Canvas takes only entry_type "Item" here. Anything else comes back as
        // a bare 400 with a plain-text "Bad Request" and no hint (verified live
        // on Stimulus and BankEntry, 2026-08-03), so refuse it with a reason
        // rather than forwarding a request that cannot succeed.
        const entryType = args.entryType ?? 'Item';
        if (entryType !== 'Item') {
          throw new Error(
            `entry_type "${entryType}" cannot be created through the API — Canvas accepts only "Item" on this `
            + `endpoint and rejects the rest with an unexplained 400.`
            + (entryType === 'Stimulus'
              ? ` Use create-new-quiz-stimulus for a stimulus.`
              : ` Question banks are managed in the Canvas UI.`)
          );
        }

        // Checked before the question exists, so a bad stimulus ID can't leave
        // an unattached question behind.
        if (args.stimulusQuizEntryId !== undefined) {
          if (!quizApi) throw new Error(privateApiRequired('Attaching a question to a stimulus'));
          await requireStimulus(canvas, args.courseId, args.assignmentId, args.stimulusQuizEntryId);
        }

        const item: any = {
          entry_type: entryType,
          points_possible: args.pointsPossible ?? 1,
          entry,
        };
        if (args.position !== undefined) item.position = args.position;

        const created = await canvas.createNewQuizItem(args.courseId, args.assignmentId, item) as any;
        let text = `Added ${entry.interaction_type_slug ?? 'item'} question (item ID ${created.id}, ${created.points_possible} pts) to quiz ${args.assignmentId}.`;
        if (args.stimulusQuizEntryId !== undefined) {
          try {
            text += ' ' + await setStimulus(canvas, quizApi!, args.courseId, args.assignmentId, String(created.id), args.stimulusQuizEntryId);
          } catch (error: any) {
            text += `\n\nWARNING — the question was created but NOT attached to stimulus ${args.stimulusQuizEntryId}: `
              + `${error?.message ?? 'unknown error'}. Retry with update-new-quiz-item (itemId ${created.id}).`;
          }
        }
        return { content: [{ type: "text", text }] };
      } catch (error: any) {
        throw new Error(`Failed to create New Quiz item: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-new-quiz-item
  server.tool(
    "update-new-quiz-item",
    "Update a New Quiz question. Pass pointsPossible or position to adjust those, or rawEntry to replace the question content and answer key wholesale (fetch it first with get-new-quiz-item).",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      itemId: z.string().describe("The item (question) ID"),
      pointsPossible: z.number().optional().describe("New point value"),
      position: z.number().optional().describe("New position in the quiz"),
      stimulusQuizEntryId: z.string().nullable().optional().describe("Attach the question to this stimulus (its item ID), or null to detach it. Needs the private New Quizzes API (CANVAS_ENABLE_ITEM_BANKS)."),
      rawEntry: jsonObjectParam("Complete replacement `entry` object").optional()
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const attach = args.stimulusQuizEntryId !== undefined;
        if (attach) {
          if (!quizApi) throw new Error(privateApiRequired('Attaching a question to a stimulus'));
          if (args.stimulusQuizEntryId) {
            await requireStimulus(canvas, args.courseId, args.assignmentId, args.stimulusQuizEntryId);
          }
        }

        const item: any = {};
        if (args.pointsPossible !== undefined) item.points_possible = args.pointsPossible;
        if (args.position !== undefined) item.position = args.position;
        if (args.rawEntry !== undefined) item.entry = args.rawEntry;

        if (Object.keys(item).length === 0 && !attach) {
          return { content: [{ type: "text", text: "No fields provided; nothing was changed." }] };
        }

        const lines: string[] = [];
        if (Object.keys(item).length > 0) {
          const updated = await canvas.updateNewQuizItem(args.courseId, args.assignmentId, args.itemId, item) as any;
          lines.push(`Updated item ${updated.id} in quiz ${args.assignmentId}.`);
        }
        if (attach) {
          lines.push(`Item ${args.itemId}: ` + await setStimulus(
            canvas, quizApi!, args.courseId, args.assignmentId, args.itemId, args.stimulusQuizEntryId || null,
          ));
        }
        return { content: [{ type: "text", text: lines.join(' ') }] };
      } catch (error: any) {
        throw new Error(`Failed to update New Quiz item: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: delete-new-quiz-item
  server.tool(
    "delete-new-quiz-item",
    "Delete a question from a New Quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      itemId: z.string().describe("The item (question) ID")
    },
    { destructiveHint: true },
    async ({ courseId, assignmentId, itemId }: { courseId: string; assignmentId: string; itemId: string }) => {
      try {
        await canvas.deleteNewQuizItem(courseId, assignmentId, itemId);
        return { content: [{ type: "text", text: `Deleted item ${itemId} from quiz ${assignmentId}.` }] };
      } catch (error: any) {
        throw new Error(`Failed to delete New Quiz item: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-new-quiz-report
  server.tool(
    "get-new-quiz-report",
    "Read a New Quiz report. 'item_analysis' gives per-question difficulty, discrimination and how the class spread across the answer choices; 'student_analysis' gives each student's answer and score per question. Generation is asynchronous: this queues the report, polls for up to waitSeconds, then downloads and parses it. If it is not ready in time, call again with the progressId it hands back — that picks up the same job instead of queueing another.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      reportType: z.enum(['item_analysis', 'student_analysis']).default('item_analysis'),
      format: z.enum(['summary', 'full']).default('summary').describe("'summary' trims question and answer text; 'full' adds every student's per-question responses (can be large)"),
      waitSeconds: z.number().min(0).max(50).default(30).describe("How long to wait for a report that is still generating before returning (default 30; clients commonly give up on a tool call after 60)"),
      progressId: z.string().optional().describe("Resume the job from an earlier call that returned before the report was ready, rather than generating a new one"),
      anonymous: z.boolean().default(true).describe("Whether to replace student identity with a stable pseudonym (default: true for privacy). student_analysis only."),
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, reportType = 'item_analysis', format = 'summary', waitSeconds = 30, progressId, anonymous = true }: {
      courseId: string; assignmentId: string; reportType?: string; format?: string; waitSeconds?: number; progressId?: string; anonymous?: boolean;
    }) => {
      try {
        let latest: any;
        if (progressId) {
          latest = await canvas.getProgress(String(progressId));
        } else {
          let created: any;
          try {
            created = await canvas.createNewQuizReport(courseId, assignmentId, reportType, 'json');
          } catch (error: any) {
            if (String(error.message).includes('409')) {
              throw new Error('A report for this quiz is already being generated. Wait a moment and try again.');
            }
            throw error;
          }
          // Canvas answers with the Progress nested under `progress`. Reading
          // `created.id` instead finds nothing, and the caller is handed a
          // queued job it can only re-queue — the loop this guards against.
          latest = created?.progress ?? created;
        }

        const id = latest?.id;
        if (!id) {
          throw new Error(`Canvas did not return a progress job for the ${reportType} report: ${JSON.stringify(latest)}`);
        }

        const deadline = Date.now() + waitSeconds * 1000;
        while (latest?.workflow_state !== 'completed' && latest?.workflow_state !== 'failed') {
          if (Date.now() >= deadline) break;
          await sleep(2000);
          latest = await canvas.getProgress(String(id)) as any;
        }

        if (latest?.workflow_state === 'failed') {
          throw new Error(`Canvas could not generate the ${reportType} report: ${latest.message ?? 'no detail provided'}`);
        }
        if (latest?.workflow_state !== 'completed') {
          return {
            content: [{
              type: "text",
              text: `Report ${reportType} is still generating (${latest?.completion ?? 0}% complete). `
                + `Call get-new-quiz-report again with progressId "${id}" to pick up this same job — calling without it queues another one.`
            }]
          };
        }

        const url = latest?.results?.url;
        if (!url) {
          throw new Error(`The ${reportType} report finished but Canvas returned no download URL: ${JSON.stringify(latest.results ?? latest)}`);
        }

        let text: string;
        try {
          text = await canvas.downloadText(url);
        } catch (error: any) {
          // Canvas signs these links for a single download, so a spent link
          // cannot be retried — only a fresh report can.
          throw new Error(`The finished ${reportType} report could not be downloaded (${error.message ?? 'unknown error'}). `
            + `Canvas signs the download link for one use only, so run this tool again without progressId to generate a fresh report.`);
        }

        let payload: any;
        try {
          payload = JSON.parse(text);
        } catch {
          return { content: [{ type: "text", text: `${reportType} report (unparsed):\n\n${text.slice(0, 20000)}` }] };
        }

        const rows: any[] = Array.isArray(payload) ? payload : [];
        if (rows.length === 0) {
          return { content: [{ type: "text", text: `The ${reportType} report generated but contains no rows (the quiz may have no submissions yet).` }] };
        }

        const body = reportType === 'student_analysis'
          ? {
            report_type: reportType,
            assignment_id: assignmentId,
            students: rows.length,
            student_analysis: summariseStudentAnalysis(rows, anonymous, format === 'full'),
          }
          : {
            report_type: reportType,
            assignment_id: assignmentId,
            items: rows.length,
            item_analysis: summariseItemAnalysis(rows, format === 'full'),
          };

        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      } catch (error: any) {
        throw new Error(`Failed to get New Quiz report: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // The stimulus tools only exist with the private API switched on: without it
  // there is no way to do what they say, and a tool that always fails is worse
  // than one that isn't listed.
  if (!quizApi) return;

  // Tool: create-new-quiz-stimulus
  server.tool(
    "create-new-quiz-stimulus",
    "Add a stimulus to a New Quiz: a reading passage, image, source or data set that several questions share. Then add its questions with create-new-quiz-item, passing stimulusQuizEntryId set to the item ID this returns (or attach existing questions with update-new-quiz-item). Remove it with delete-new-quiz-item. Uses the private New Quizzes API, as the Canvas quiz editor does.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      title: z.string().min(1).describe("The stimulus's title, e.g. \"Source A: Federalist No. 10\""),
      body: z.string().min(1).describe("The stimulus content as HTML: the passage, an <img>, a table"),
      instructions: z.string().optional().describe("Instructions shown with the stimulus, e.g. \"Read the passage, then answer questions 1-4\""),
      orientation: z.enum(['left', 'top']).default('left').describe("Where the stimulus sits relative to its questions: 'left' (side by side) or 'top' (above)"),
      passage: z.boolean().default(false).describe("Treat the stimulus as a text passage"),
      sourceUrl: z.string().optional().describe("Where the material came from; shown to teachers, not students"),
      position: z.number().int().min(1).optional().describe("Position in the quiz; omit to add it at the end"),
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const stimulus: any = await quizApi.quiz(args.courseId, args.assignmentId, 'post', '/stimuli', {
          stimulus: {
            title: args.title,
            body: args.body,
            instructions: args.instructions ?? '',
            orientation: args.orientation,
            passage: args.passage,
            source_url: args.sourceUrl ?? '',
            stimulus_type: 'text',
            parent_stimulus_id: null,
          },
        });
        if (!stimulus?.id) throw new Error('quiz-api created no stimulus (no id in its response).');

        const quizEntry: any = { entry_type: 'Stimulus', entry_id: stimulus.id, points_possible: 0, properties: {} };
        if (args.position !== undefined) quizEntry.position = args.position;
        const placed: any = await quizApi.quiz(args.courseId, args.assignmentId, 'post', '/quiz_entries', {
          quiz_entry: quizEntry,
        });
        canvas.invalidateNewQuiz(args.courseId, args.assignmentId);

        let check = '';
        try {
          const readBack: any = await canvas.getNewQuizItem(args.courseId, args.assignmentId, String(placed.id));
          if (readBack?.entry_type !== 'Stimulus') {
            check = `\n\nWARNING — the public API reads item ${placed.id} as ${readBack?.entry_type ?? 'nothing'}, not a stimulus.`;
          }
        } catch (error: any) {
          check = `\n\nWARNING — the stimulus was created but could not be read back: ${error?.message ?? 'unknown error'}`;
        }

        return {
          content: [{
            type: "text",
            text: `Added stimulus "${args.title}" to quiz ${args.assignmentId} as item ${placed.id}`
              + `${placed.position !== undefined ? ` (position ${placed.position})` : ''}. Attach questions to it with `
              + `stimulusQuizEntryId "${placed.id}".${check}`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create stimulus: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-new-quiz-stimulus
  server.tool(
    "update-new-quiz-stimulus",
    "Change a New Quiz stimulus's title, content, instructions, layout or source. Fields you leave out keep their current values. Uses the private New Quizzes API, as the Canvas quiz editor does.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      stimulusItemId: z.string().describe("The stimulus's item ID (from list-new-quiz-items or create-new-quiz-stimulus)"),
      title: z.string().min(1).optional(),
      body: z.string().min(1).optional().describe("New content as HTML"),
      instructions: z.string().optional(),
      orientation: z.enum(['left', 'top']).optional(),
      sourceUrl: z.string().optional(),
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const current = await requireStimulus(canvas, args.courseId, args.assignmentId, args.stimulusItemId);
        const entry = current.entry ?? {};
        if (!entry.id) throw new Error(`Item ${args.stimulusItemId} has no stimulus record to edit.`);

        // The editor always sends all five, so do the same and fill the gaps
        // from what is stored rather than risk a blank being written.
        const stimulus = {
          title: args.title ?? entry.title,
          body: args.body ?? entry.body,
          instructions: args.instructions ?? entry.instructions ?? '',
          orientation: args.orientation ?? entry.orientation,
          source_url: args.sourceUrl ?? entry.source_url ?? '',
        };
        await quizApi.quiz(args.courseId, args.assignmentId, 'patch', `/stimuli/${entry.id}`, { stimulus });
        canvas.invalidateNewQuiz(args.courseId, args.assignmentId);

        const stored: any = (await canvas.getNewQuizItem(args.courseId, args.assignmentId, args.stimulusItemId) as any)?.entry ?? {};
        const differs = (['title', 'body', 'instructions', 'orientation', 'source_url'] as const)
          .filter(k => (stored[k] ?? '') !== (stimulus[k] ?? ''));
        const check = differs.length > 0
          ? `\n\nWARNING — the public API reads back different values for: ${differs.join(', ')}. Check the quiz in Canvas.`
          : '';
        return { content: [{ type: "text", text: `Updated stimulus ${args.stimulusItemId} in quiz ${args.assignmentId}.${check}` }] };
      } catch (error: any) {
        throw new Error(`Failed to update stimulus: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
