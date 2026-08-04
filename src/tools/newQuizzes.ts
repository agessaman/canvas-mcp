import { z } from "zod";
import { jsonObjectParam } from "../jsonObjectParam.js";
import {
  NEW_QUIZ_SETTING_PARAMS, buildQuizSettings, validateSettings, touchesSettings, formatQuizSettings,
} from "../newQuizSettings.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { buildItemEntry, InteractionType } from "../newQuizItemBuilder.js";

// New Quizzes live at /api/quiz/v1, a different API root from Classic Quizzes
// (/api/v1/courses/:id/quizzes). A New Quiz is backed by an Assignment, so the
// id used throughout this file is an assignment_id — and that same id is what
// grade-submission takes when hand-grading essay responses.

const INTERACTION_TYPES = ['choice', 'true-false', 'multi-answer', 'essay', 'numeric', 'matching', 'rich-fill-blank', 'ordering', 'categorization', 'hot-spot'] as const;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `stimulus_quiz_entry_id` is READ-ONLY through the public API. Proven live on
 * 2026-08-03 against a genuine UI-authored stimulus (item 9307 in quiz 371872):
 * it was rejected in four different ways and stored "" every time — on create
 * and on update, as JSON and as form-encoded params, using both the stimulus's
 * quiz_entry ID (9307) and its entry ID (196).
 *
 * It is absent from the POST and PATCH parameter lists in the instance's own
 * API spec, which is the documentary half of the same fact: the field appears
 * on the QuizItem *response* model only.
 *
 * The Canvas UI does the attach against a different service entirely
 * (quiz-api-*.instructure.com/api/quizzes/:internal_id/quiz_entries), on an ID
 * space the public API never exposes. So this is not a payload to get right —
 * refuse it and name the one route that works.
 */
function stimulusAttachRefusal(itemId?: string): string {
  return 'stimulusQuizEntryId cannot be set through the Canvas API — the field is read-only there, and a '
    + 'write is accepted with a 200 and silently stored as empty, so a question would look attached and '
    + 'stand alone.\n\nAttach it in the Canvas UI instead: open the quiz, find the stimulus, and add or drag '
    + 'the question into its block. '
    + (itemId ? `The question (item ${itemId}) already exists, so it only needs moving. ` : '')
    + 'get-new-quiz-item and list-new-quiz-items DO read the association back, so you can confirm it '
    + 'afterwards — an attached question reports stimulus_quiz_entry_id set to the stimulus\'s item ID.';
}

export function registerNewQuizTools(server: McpServer, canvas: CanvasClient) {
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
    "List all questions (items) in a New Quiz, with their type, points, and position.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      full: z.boolean().default(false).describe("Return the complete item payload including answer keys, rather than a summary")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, full = false }: { courseId: string; assignmentId: string; full?: boolean }) => {
      try {
        const items = await canvas.listNewQuizItems(courseId, assignmentId);
        const payload = full ? items : items.map((i: any) => ({
          id: i.id,
          position: i.position,
          points_possible: i.points_possible,
          entry_type: i.entry_type,
          type: i.entry?.interaction_type_slug,
          title: i.entry?.title,
          item_body: i.entry?.item_body,
          // Present when this question hangs off a stimulus (reading passage).
          // Read-only: Canvas will not accept this field on a write, so a
          // question is attached to a stimulus in the Canvas UI only.
          ...(i.stimulus_quiz_entry_id ? { stimulus_quiz_entry_id: i.stimulus_quiz_entry_id } : {}),
        }));
        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? JSON.stringify(payload, null, 2)
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
    "Add a question to a New Quiz. Give the question text, the choices, and which choice is correct — answer IDs and scoring rules are generated for you. Supports choice, multi-answer, true-false, essay, numeric, matching, rich-fill-blank (fill in the blank), ordering, categorization, and hot-spot; use rawEntry for formula and file-upload. HOT SPOT: pass imageUrl plus either hotspotRect or hotspotPolygon. Coordinates are FRACTIONS of the image (0-1); pass imagePixelWidth and imagePixelHeight to give them in pixels instead, which is usually easier and is how to get placement right. The image can be a Canvas Files URL (upload it with upload-course-file first) - it must be published and student-visible, or it will render for you and 403 for them. FILL IN THE BLANK: mark each blank by putting backticks around the correct answer in the body, e.g. \"The capital of France is `Paris`.\" — one blank per backticked run. STIMULUS (shared reading passage with several questions hanging off it): Canvas allows NEITHER creating a stimulus nor attaching a question to one through its API — both must be done in the Canvas UI (Insert Content > Stimulus, then add the questions inside its block). Verified against a live instance. The association can be READ back here: list-new-quiz-items and get-new-quiz-item report stimulus_quiz_entry_id.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      entryType: z.enum(['Item', 'Stimulus', 'Bank', 'BankEntry']).optional().describe("Item kind. Only 'Item' (the default) can be created through the API; the others exist so the value can be recognised when reading, and are refused here."),
      stimulusQuizEntryId: z.string().optional().describe("NOT WRITABLE — Canvas accepts this and silently stores nothing, so it is refused here with the UI steps. Attaching a question to a stimulus can only be done in the Canvas UI."),
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
              ? ` A stimulus must be built in the Canvas UI (Insert Content > Stimulus), and its questions added `
                + `inside its block there too — the attach is not writable through the API either. `
                + `list-new-quiz-items then reads the association back.`
              : ` Question banks are managed in the Canvas UI.`)
          );
        }

        if (args.stimulusQuizEntryId !== undefined) {
          throw new Error(stimulusAttachRefusal());
        }

        const item: any = {
          entry_type: entryType,
          points_possible: args.pointsPossible ?? 1,
          entry,
        };
        if (args.position !== undefined) item.position = args.position;

        const created = await canvas.createNewQuizItem(args.courseId, args.assignmentId, item) as any;
        const text = `Added ${entry.interaction_type_slug ?? 'item'} question (item ID ${created.id}, ${created.points_possible} pts) to quiz ${args.assignmentId}.`;
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
      stimulusQuizEntryId: z.string().optional().describe("NOT WRITABLE — refused here. Attaching a question to a stimulus can only be done in the Canvas UI."),
      rawEntry: jsonObjectParam("Complete replacement `entry` object").optional()
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        if (args.stimulusQuizEntryId !== undefined) {
          throw new Error(stimulusAttachRefusal(args.itemId));
        }

        const item: any = {};
        if (args.pointsPossible !== undefined) item.points_possible = args.pointsPossible;
        if (args.position !== undefined) item.position = args.position;
        if (args.rawEntry !== undefined) item.entry = args.rawEntry;

        if (Object.keys(item).length === 0) {
          return { content: [{ type: "text", text: "No fields provided; nothing was changed." }] };
        }

        const updated = await canvas.updateNewQuizItem(args.courseId, args.assignmentId, args.itemId, item) as any;
        return { content: [{ type: "text", text: `Updated item ${updated.id} in quiz ${args.assignmentId}.` }] };
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
    "Generate and retrieve a New Quiz report. 'item_analysis' shows how the class performed per question (which questions were hardest); 'student_analysis' shows per-student responses. Report generation is async — this polls until ready and returns a download URL.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The quiz's assignment ID"),
      reportType: z.enum(['item_analysis', 'student_analysis']).default('item_analysis'),
      format: z.enum(['json', 'csv']).default('json'),
      waitSeconds: z.number().default(30).describe("How long to poll for the report before returning the progress ID")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, reportType = 'item_analysis', format = 'json', waitSeconds = 30 }: { courseId: string; assignmentId: string; reportType?: string; format?: string; waitSeconds?: number }) => {
      try {
        let progress: any;
        try {
          progress = await canvas.createNewQuizReport(courseId, assignmentId, reportType, format);
        } catch (error: any) {
          if (String(error.message).includes('409')) {
            throw new Error('A report for this quiz is already being generated. Wait a moment and try again.');
          }
          throw error;
        }

        const progressId = progress?.id;
        if (!progressId) {
          return { content: [{ type: "text", text: JSON.stringify(progress, null, 2) }] };
        }

        const deadline = Date.now() + waitSeconds * 1000;
        let latest = progress;
        while (Date.now() < deadline) {
          if (latest.workflow_state === 'completed' || latest.workflow_state === 'failed') break;
          await sleep(2000);
          latest = await canvas.getProgress(String(progressId)) as any;
        }

        if (latest.workflow_state === 'completed') {
          return {
            content: [{
              type: "text",
              text: `${reportType} report ready:\n\n${JSON.stringify(latest.results ?? latest, null, 2)}`
            }]
          };
        }
        if (latest.workflow_state === 'failed') {
          throw new Error(`Report generation failed: ${latest.message ?? 'no detail provided'}`);
        }
        return {
          content: [{
            type: "text",
            text: `Report still generating (${latest.completion ?? 0}% complete). Progress ID ${progressId} — re-run this tool or check back shortly.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to get New Quiz report: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
