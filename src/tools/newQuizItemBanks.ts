import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NewQuizzesLtiClient } from "../newQuizzesLti.js";
import { buildItemEntry, InteractionType } from "../newQuizItemBuilder.js";
import { jsonObjectParam } from "../jsonObjectParam.js";

/**
 * New Quizzes ITEM BANKS — opt-in, and reached through a private Instructure
 * API. See src/newQuizzesLti.ts for the handshake and why there is no public
 * endpoint.
 *
 * Not to be confused with src/tools/questionBanks.ts, which reads CLASSIC
 * `AssessmentQuestionBank`s through documented `/api/v1` routes. The two stores
 * are separate: a New Quizzes bank never appears in list-question-banks, and a
 * Classic bank never appears here.
 *
 * SCOPE, which is the thing most likely to surprise: the bank list is scoped to
 * the USER, not the course. Launching from two different courses returns the
 * same banks (verified live — 290 both times). courseId is required because the
 * LTI launch needs a context, not because it filters anything.
 */

const INTERACTION_TYPES = ['choice', 'true-false', 'multi-answer', 'essay', 'numeric', 'matching', 'rich-fill-blank', 'ordering', 'categorization', 'hot-spot'] as const;

const PRIVATE_API_NOTE =
  "Opt-in tool (CANVAS_ENABLE_ITEM_BANKS): it reaches New Quizzes item banks through an undocumented "
  + "Instructure service, not the Canvas API, and Instructure can change or remove it without notice.";

// Teacher-shaped question parameters, shared by create and update. Identical to
// create-new-quiz-item's, minus pointsPossible and position: a bank item has
// neither. Points are set on the QUIZ item that draws from the bank, so the same
// bank question can be worth different amounts in different quizzes.
const QUESTION_PARAMS = {
  interactionType: z.enum(INTERACTION_TYPES).optional().describe("Question type. Omit only when supplying rawEntry."),
  body: z.string().optional().describe("The question text (HTML allowed)"),
  title: z.string().optional().describe("Optional short label for the question"),
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
  imageUrl: z.string().optional().describe("For hot-spot: the image students click on. A Canvas Files URL works — upload with upload-course-file, and make sure it is published, or students get a broken image where you see a working one."),
  imagePixelWidth: z.number().optional().describe("For hot-spot: the image's width in pixels. Give this WITH imagePixelHeight to specify the hotspot in PIXELS instead of fractions. Both or neither."),
  imagePixelHeight: z.number().optional().describe("For hot-spot: the image's height in pixels. See imagePixelWidth."),
  hotspotRect: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number()
  }).optional().describe("For hot-spot: the correct region as a rectangle, measured from the top-left. FRACTIONS of the image (0-1) by default, or PIXELS if imagePixelWidth/Height are given."),
  hotspotOval: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number()
  }).optional().describe("For hot-spot: the correct region as an ELLIPSE, given by its bounding box (same fields as hotspotRect)."),
  hotspotPolygon: z.array(z.object({ x: z.number(), y: z.number() }))
    .optional().describe("For hot-spot: the correct region as 3+ points, FRACTIONS of the image (0-1) by default, or PIXELS if imagePixelWidth/Height are given."),
  feedback: z.object({
    neutral: z.string().optional(),
    correct: z.string().optional(),
    incorrect: z.string().optional()
  }).optional().describe("Feedback shown to students after submitting"),
  rawEntry: jsonObjectParam(
    "Escape hatch: a complete question object for types the builder doesn't cover (formula, file-upload). "
    + "Same shape as a New Quiz item's `entry` — the `entry` field of what list-item-bank-questions returns."
  ).optional(),
};

function buildQuestion(args: any): Record<string, any> {
  if (args.rawEntry) return args.rawEntry;
  if (!args.interactionType || !args.body) {
    throw new Error('interactionType and body are required unless rawEntry is supplied');
  }
  return buildItemEntry({
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

/**
 * Translate a New Quizzes `entry` into a quiz-api `item`.
 *
 * The two APIs describe the same question differently: `/api/quiz/v1` takes an
 * `interaction_type_slug` ("choice"), quiz-api takes a numeric
 * `interaction_type_id` ("1"), and the ids are instance data rather than
 * constants — hence the lookup rather than a table baked in here.
 */
function toBankItem(entry: Record<string, any>, types: Map<string, { id: string; userResponseType?: string }>): Record<string, any> {
  const slug = entry.interaction_type_slug ?? entry.interaction_type?.slug;
  const type = slug ? types.get(slug) : undefined;
  if (!type) {
    throw new Error(
      `Unknown question type ${slug ? `"${slug}"` : '(none given)'}. Known types: ${[...types.keys()].join(', ')}.`
    );
  }
  return {
    interaction_type_id: type.id,
    item_body: entry.item_body,
    title: entry.title ?? null,
    interaction_data: entry.interaction_data ?? {},
    scoring_data: entry.scoring_data ?? {},
    scoring_algorithm: entry.scoring_algorithm,
    properties: entry.properties ?? {},
    feedback: entry.feedback ?? {},
    answer_feedback: entry.answer_feedback ?? {},
    calculator_type: entry.calculator_type ?? 'none',
    user_response_type: entry.user_response_type ?? type.userResponseType,
    stimulus_id: entry.stimulus_id ?? '',
  };
}

// The same fields quiz-api's own editor sends on a save. interaction_type_id is
// absent on purpose: a question's type cannot be changed after it is created,
// and including it is silently ignored rather than honoured.
function toBankItemUpdate(entry: Record<string, any>): Record<string, any> {
  return {
    item_body: entry.item_body,
    title: entry.title ?? null,
    interaction_data: entry.interaction_data ?? {},
    scoring_data: entry.scoring_data ?? {},
    scoring_algorithm: entry.scoring_algorithm,
    properties: entry.properties ?? {},
    feedback: entry.feedback ?? {},
    answer_feedback: entry.answer_feedback ?? {},
    calculator_type: entry.calculator_type ?? 'none',
  };
}

function summariseBank(b: any): Record<string, any> {
  return {
    id: b.id,
    title: b.title,
    question_count: b.entry_count ?? b.item_entry_count,
    shared_with_count: b.shared_count,
    permission: b.permission,
    archived: b.archived,
    last_used: b.last_used,
    updated_at: b.updated_at,
  };
}

// Two ids come back per question and they are not interchangeable: the ENTRY id
// is the link between a bank and a question (what delete takes), the ITEM id is
// the question itself (what update takes). Every summary carries both, labelled,
// because getting them the wrong way round returns a confusing 404 from a
// private API rather than a useful error.
function summariseEntry(e: any): Record<string, any> {
  const q = e.entry ?? {};
  return {
    entryId: e.id,
    itemId: q.id,
    interaction_type: q.interaction_type?.slug,
    title: q.title,
    item_body: q.item_body,
    status: q.status,
    updated_at: e.updated_at,
  };
}

export function registerNewQuizItemBankTools(server: McpServer, banks: NewQuizzesLtiClient) {
  // Tool: list-item-banks
  server.tool(
    "list-item-banks",
    "List the NEW QUIZZES item banks you can see — the pools a New Quiz draws random questions from. "
    + "These are a different store from Classic question banks (list-question-banks), and are what "
    + "list-new-quiz-items reports when a quiz item draws from a bank. "
    + "The list is scoped to YOU, not to the course: courseId only supplies the launch context the "
    + "underlying service needs, so every bank you have access to comes back regardless of which course you pass. "
    + "Use search to narrow by title. " + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context. Does not filter the results."),
      search: z.string().optional().describe("Filter banks by title (server-side substring match)"),
      page: z.number().default(1).describe("1-based page number"),
      perPage: z.number().default(50).describe("Banks per page (the service's own default is 50)")
    },
    { readOnlyHint: true },
    async ({ courseId, search, page = 1, perPage = 50 }: { courseId: string; search?: string; page?: number; perPage?: number }) => {
      try {
        const params: any = { page, per_page: perPage };
        if (search) params.search = search;
        const { items, total } = await banks.getPage<any>(courseId, '/api/banks', params);
        const rows = items.map(summariseBank);
        const shown = `${rows.length} of ${total ?? rows.length} bank(s)`;
        const more = total !== undefined && page * perPage < total
          ? ` — pass page ${page + 1} for more.`
          : '';
        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `${shown}${search ? ` matching "${search}"` : ''}:\n\n${JSON.stringify(rows, null, 2)}${more}`
              : search
                ? `No item banks match "${search}".`
                : `No New Quizzes item banks are visible to this account.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list item banks: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-item-bank
  server.tool(
    "get-item-bank",
    "Fetch one New Quizzes item bank — its title, how many questions it holds, how many places it is shared to, "
    + "and whether it is archived. Use list-item-bank-questions to see what is inside it. " + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context"),
      bankId: z.string().describe("The item bank's ID, as reported by list-item-banks")
    },
    { readOnlyHint: true },
    async ({ courseId, bankId }: { courseId: string; bankId: string }) => {
      try {
        const bank = await banks.get<any>(courseId, `/api/banks/${bankId}`);
        return { content: [{ type: "text", text: JSON.stringify(bank, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to fetch item bank ${bankId}: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-item-bank-questions
  server.tool(
    "list-item-bank-questions",
    "List the questions inside a New Quizzes item bank — the actual pool a randomising quiz draws from. "
    + "Returns a summary per question by default; pass full to get answer keys and feedback too. "
    + "Each question has TWO ids and they are not interchangeable: entryId is its membership in this bank "
    + "(pass it to delete-item-bank-question) and itemId is the question itself (pass it to "
    + "update-item-bank-question). A question whose status is \"immutable\" has been seen by a student and "
    + "can no longer be edited. " + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context"),
      bankId: z.string().describe("The item bank's ID"),
      full: z.boolean().default(false).describe("Return each question's complete payload, including the answer key and feedback, rather than a summary"),
      text: z.string().optional().describe("Filter by question title or tag. Note it does NOT search question bodies — a word you can see in a question may still match nothing."),
      interactionType: z.enum(INTERACTION_TYPES).optional().describe("Only questions of this type"),
      page: z.number().default(1).describe("1-based page number"),
      perPage: z.number().default(50).describe("Questions per page")
    },
    { readOnlyHint: true },
    async (args: any) => {
      const { courseId, bankId, full = false, text, interactionType, page = 1, perPage = 50 } = args;
      try {
        const params: any = { page, per_page: perPage };
        if (text) params.text = text;
        if (interactionType) {
          const types = await banks.interactionTypeMap(courseId);
          const type = types.get(interactionType);
          if (!type) throw new Error(`This instance does not offer question type "${interactionType}".`);
          params['interaction_type_ids[]'] = type.id;
        }
        const result = await banks.get<any>(courseId, `/api/banks/${bankId}/bank_entries/search`, params);
        const entries: any[] = result?.entries ?? [];
        const total: number = result?.total ?? entries.length;
        const payload = full ? entries : entries.map(summariseEntry);
        const more = page * perPage < total ? ` — pass page ${page + 1} for more.` : '';
        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? `${entries.length} of ${total} question(s) in bank ${bankId}:\n\n${JSON.stringify(payload, null, 2)}${more}`
              : total > 0
                ? `Page ${page} of bank ${bankId} is empty (${total} question(s) in total).`
                : `Bank ${bankId} has no questions${text || interactionType ? ' matching that filter' : ''}.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list questions in item bank ${bankId}: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: create-item-bank-question
  server.tool(
    "create-item-bank-question",
    "Add a question to a New Quizzes item bank. Takes the same question parameters as create-new-quiz-item — "
    + "give the question text, the choices, and which one is correct, and the answer IDs and scoring rules are "
    + "generated for you. There is no pointsPossible: a bank question carries no points, because the points are "
    + "set on the quiz item that draws from the bank, so the same question can be worth different amounts in "
    + "different quizzes. The bank must already exist (create one in the Canvas UI under Item Banks). "
    + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context"),
      bankId: z.string().describe("The item bank to add the question to"),
      ...QUESTION_PARAMS
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const entry = buildQuestion(args);
        const types = await banks.interactionTypeMap(args.courseId);
        const item = toBankItem(entry, types);

        // Two calls, because the service separates the question from its
        // membership in a bank: POST .../items stores the question and returns
        // its id, and it is NOT in the bank until a bank_entry links it there.
        // Skipping the second call leaves a question that exists and is
        // unreachable (verified live: the bank still reports 0 entries).
        const created = await banks.post<any>(args.courseId, `/api/banks/${args.bankId}/items`, { item });
        let link: any;
        try {
          link = await banks.post<any>(args.courseId, `/api/banks/${args.bankId}/bank_entries`, {
            bank_entry: { bank_id: args.bankId, entry_type: 'Item', entry_id: created.id },
          });
        } catch (error: any) {
          throw new Error(
            `the question was created (item ID ${created.id}) but could not be added to bank ${args.bankId}, so it `
            + `is not in any bank: ${error.message ?? 'Unknown error'}`
          );
        }

        const slug = entry.interaction_type_slug ?? args.interactionType ?? 'item';
        return {
          content: [{
            type: "text",
            text: `Added ${slug} question to item bank ${args.bankId} (entryId ${link.id}, itemId ${created.id}). `
              + `Edit it with update-item-bank-question using itemId ${created.id}; remove it with `
              + `delete-item-bank-question using entryId ${link.id}.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create item bank question: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-item-bank-question
  server.tool(
    "update-item-bank-question",
    "Replace a question in a New Quizzes item bank. This is a WHOLE-question update, not a patch: pass the same "
    + "parameters you would to create it, or rawEntry to supply the payload directly (read the current one with "
    + "list-item-bank-questions full=true first). Takes the itemId, not the entryId. "
    + "A question's TYPE cannot be changed after creation — to switch a multiple-choice question to an essay, "
    + "delete it and create a new one. A question a student has already seen is immutable and the service will "
    + "refuse the edit. Bank questions are TEMPLATES: a quiz built from the bank holds its own copy, so editing "
    + "the bank does not change quizzes already built from it. " + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context"),
      bankId: z.string().describe("The item bank the question is in"),
      itemId: z.string().describe("The QUESTION's ID — `itemId` from list-item-bank-questions, not `entryId`"),
      ...QUESTION_PARAMS
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const entry = buildQuestion(args);
        const updated = await banks.patch<any>(
          args.courseId,
          `/api/banks/${args.bankId}/items/${args.itemId}`,
          { item: toBankItemUpdate(entry) },
        );
        return {
          content: [{
            type: "text",
            text: `Updated question ${args.itemId} in item bank ${args.bankId}`
              + (updated?.title ? ` ("${updated.title}")` : '') + '.'
          }]
        };
      } catch (error: any) {
        const detail = String(error.message ?? 'Unknown error');
        const immutable = /immutable/i.test(detail)
          ? ' This question has been seen by a student, so it can no longer be edited — add a replacement instead.'
          : '';
        throw new Error(`Failed to update item bank question ${args.itemId}: ${detail}${immutable}`);
      }
    }
  );

  // Tool: delete-item-bank-question
  server.tool(
    "delete-item-bank-question",
    "Remove a question from a New Quizzes item bank. Takes the entryId (the question's membership in the bank), "
    + "not the itemId — both are reported by list-item-bank-questions. Quizzes already built from this bank keep "
    + "their own copies of the question and are not affected. " + PRIVATE_API_NOTE,
    {
      courseId: z.string().describe("A course you teach, used as the launch context"),
      bankId: z.string().describe("The item bank the question is in"),
      entryId: z.string().describe("The BANK ENTRY's ID — `entryId` from list-item-bank-questions, not `itemId`")
    },
    { destructiveHint: true },
    async ({ courseId, bankId, entryId }: { courseId: string; bankId: string; entryId: string }) => {
      try {
        await banks.delete(courseId, `/api/banks/${bankId}/bank_entries/${entryId}`);
        return {
          content: [{ type: "text", text: `Removed question ${entryId} from item bank ${bankId}.` }]
        };
      } catch (error: any) {
        throw new Error(`Failed to remove question ${entryId} from item bank ${bankId}: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
