import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

/**
 * Classic question banks — the AssessmentQuestionBank store, shared by every
 * Classic quiz in a course or account. A Classic quiz that draws random
 * questions does it through a question GROUP (list-quiz-question-groups) whose
 * `assessment_question_bank_id` points at one of these banks, so the group tells
 * you WHICH bank and how many it pulls, and these tools tell you what is in it.
 *
 * NEW QUIZZES ITEM BANKS ARE NOT HERE, and this is the single most important
 * thing to know about this file. They live in a separate Instructure service
 * (AMS — the "Assessment Management Service"), not in Canvas's database:
 * `ItemBanksController#show` renders an empty `<div id="ams_container">` and
 * hands the browser a launch URL and an `api_url` read from `Services::Ams`,
 * which is configured per-region and is not part of Canvas. Canvas's own
 * open-source tree has no route that reads or writes an item bank, so no
 * Canvas API token can reach one. `/api/v1/question_banks` returns Classic
 * banks only, and returns them for a course that has New Quizzes too — which
 * is exactly how this looks like a bug rather than a boundary.
 *
 * READ-ONLY, and that is Canvas's limit rather than a choice made here.
 * `config/routes.rb` exposes three GETs under `/api/v1` and nothing else:
 *
 *   GET /api/v1/question_banks                 (context_type + context_id)
 *   GET /api/v1/question_banks/:id
 *   GET /api/v1/question_banks/:id/questions
 *
 * Creating a bank or adding a question to one exists only on the non-API HTML
 * routes (`/courses/:id/question_banks/...`, which nest `assessment_questions`)
 * that the Canvas UI posts to with a session cookie. Those are outside
 * `/api/v1`, so a Bearer token is not accepted there.
 */

// index is NOT server-paginated — the controller renders
// `@context.assessment_question_banks.active` whole, with no Api.paginate — but
// /questions is. fetchAllPages covers both: with no Link header it returns the
// single response it got.
const BANK_CONTEXT_HELP =
  "Give exactly one of courseId or accountId. Account-level banks are the ones shared across courses; "
  + "a course's own banks are not returned by an account query, or the reverse.";

function contextParams(courseId?: string, accountId?: string) {
  if ((courseId ? 1 : 0) + (accountId ? 1 : 0) !== 1) {
    throw new Error('Give exactly one of courseId or accountId — Canvas resolves the bank list from a single context.');
  }
  return courseId
    ? { context_type: 'Course', context_id: courseId }
    : { context_type: 'Account', context_id: accountId };
}

export function registerQuestionBankTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-question-banks
  server.tool(
    "list-question-banks",
    "List the CLASSIC quiz question banks in a course or account, with how many questions each holds. "
    + "These are the pools a Classic quiz draws random questions from: a quiz's question group "
    + "(list-quiz-question-groups) names one by assessment_question_bank_id. "
    + "NEW QUIZZES ITEM BANKS ARE NOT LISTED HERE and cannot be — they are stored in a separate Instructure "
    + "service that Canvas only reaches through an LTI launch, and no Canvas API token can read or write one. "
    + "An empty result for a course that visibly has banks in New Quizzes means exactly that, not a permissions "
    + "problem. Read-only: Canvas publishes no API for creating a bank or adding questions to one.",
    {
      courseId: z.string().optional().describe("The ID of the course whose banks to list. " + BANK_CONTEXT_HELP),
      accountId: z.string().optional().describe("The ID of the account whose banks to list, instead of a course. " + BANK_CONTEXT_HELP)
    },
    { readOnlyHint: true },
    async ({ courseId, accountId }: { courseId?: string; accountId?: string }) => {
      try {
        const banks: any[] = await canvas.fetchAllPages('/api/v1/question_banks', {
          ...contextParams(courseId, accountId),
          include_question_count: true,
          per_page: 100,
        });
        const rows = banks.map(b => ({
          id: b.id,
          title: b.title,
          question_count: b.assessment_question_count,
          context: b.context_code,
          updated_at: b.updated_at,
        }));
        const where = courseId ? `course ${courseId}` : `account ${accountId}`;
        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `Classic question banks in ${where}:\n\n${JSON.stringify(rows, null, 2)}`
              : `No Classic question banks in ${where}. If this course's banks were built in New Quizzes, they are `
                + `held in Instructure's separate item-bank service and no Canvas API can reach them — open `
                + `Item Banks in the Canvas course navigation instead.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list question banks: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-question-bank
  server.tool(
    "get-question-bank",
    "Fetch one Classic question bank by ID — its title, context, and question count. Classic banks only; "
    + "a New Quizzes item bank ID will not resolve here.",
    {
      bankId: z.string().describe("The question bank's ID, as reported by list-question-banks or by a quiz question group's assessment_question_bank_id")
    },
    { readOnlyHint: true },
    async ({ bankId }: { bankId: string }) => {
      try {
        const bank = await canvas.get(`/api/v1/question_banks/${bankId}`, { include_question_count: true });
        return { content: [{ type: "text", text: JSON.stringify(bank, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to fetch question bank ${bankId}: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-question-bank-questions
  server.tool(
    "list-question-bank-questions",
    "List the questions inside a Classic question bank — the actual pool a randomising quiz draws from. "
    + "Returns a summary per question by default; pass full to get answer keys and feedback as well. "
    + "Read-only: Canvas has no API for editing a bank question or adding one, so changes have to be made in "
    + "the Canvas UI. A bank question is a TEMPLATE — a quiz that pulls it holds its own copy, so editing the "
    + "bank does not change quizzes already built from it.",
    {
      bankId: z.string().describe("The question bank's ID"),
      full: z.boolean().default(false).describe("Return each question's complete payload, including the answer key and feedback, rather than a summary")
    },
    { readOnlyHint: true },
    async ({ bankId, full = false }: { bankId: string; full?: boolean }) => {
      try {
        // The answer key always comes back — verified live 2026-09-17: the
        // response is byte-identical with and without `include[]=answers`, so
        // asking for it would only suggest it were optional. `full` therefore
        // controls what is SHOWN, not what is fetched.
        const questions: any[] = await canvas.fetchAllPages(
          `/api/v1/question_banks/${bankId}/questions`,
          { per_page: 100 }
        );
        const payload = full ? questions : questions.map(q => ({
          id: q.id,
          position: q.position,
          question_name: q.question_name,
          question_type: q.question_type,
          question_text: q.question_text,
          points_possible: q.points_possible,
        }));
        return {
          content: [{
            type: "text",
            text: questions.length > 0
              ? `${questions.length} question(s) in bank ${bankId}:\n\n${JSON.stringify(payload, null, 2)}`
              : `Bank ${bankId} has no questions.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list questions in bank ${bankId}: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
