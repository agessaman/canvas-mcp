import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { getPeerReviewReport, PeerReviewOptions } from "../peerReviews.js";

export function registerPeerReviewTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-peer-reviews
  server.tool(
    "get-peer-reviews",
    "Read the peer reviews on an assignment: who reviewed whom (assessor_id is the reviewer's Canvas user ID, kept "
    + "even when names are anonymized), each reviewer's comments and rubric scores (a points array in the order of "
    + "assignment.rubric.criteria, which lists each criterion and its ratings once), and per-review checks (criteria "
    + "scored, comment count and word count). Canvas's \"completed\" only means the reviewer did something, so to "
    + "grade peer reviews pass the teacher's success rules (requireRubric, requireComment, minCommentWords, "
    + "maxDifferencePct, rejectUniformRatings): each review is then marked successful or not with the unmet rules, "
    + "and by_student counts each reviewer's successful reviews — the number to grade on with grade-submission. "
    + "Accuracy signals: a review with every criterion at the top or bottom rating, a reviewer who gives every paper "
    + "the same scores, each reviewer's average disagreement with the other reviewers of the same papers, and — once "
    + "the teacher has scored papers with the rubric — the difference from the teacher's score. Use detail: "
    + "\"summary\" when tallying for a grade. "
    + "Ask the teacher for their rules rather than choosing them; get-grading-preferences may have them on file "
    + "(peer_review_success). Pass userId for the feedback one student received, or assessorId for the reviews one "
    + "student wrote. The teacher's own comments are in list-assignment-submissions.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().optional().describe("Only reviews OF this student's submission (the feedback they received)"),
      assessorId: z.string().optional().describe("Only reviews written BY this student"),
      requireRubric: z.boolean().optional().describe("Success rule: every rubric criterion must be scored"),
      requireComment: z.boolean().optional().describe("Success rule: the reviewer must leave a comment"),
      minCommentWords: z.number().int().min(1).optional().describe("Success rule: the reviewer's comments must total at least this many words"),
      countRubricComments: z.boolean().optional().describe("Whether comments typed into the rubric count toward requireComment and minCommentWords (default: true)"),
      maxDifferencePct: z.number().min(0).max(100).optional().describe("Success rule: the review's total must be within this percentage of the rubric's points of the teacher's own rubric score for the same paper. Only applies to papers the teacher has scored with the rubric"),
      rejectUniformRatings: z.boolean().optional().describe("Success rule: a review with every criterion at its top rating, or every one at its bottom, does not count — unless the teacher's score of that paper agrees (within maxDifferencePct, or exactly when that is unset)"),
      detail: z.enum(["full", "summary"]).optional().describe("\"full\" (default) includes each review's comment text and per-criterion rubric scores. \"summary\" leaves those out and keeps each review's total, checks, flags and successful/unmet — use it when tallying reviews for a grade; it is about a third of the size"),
      anonymous: z.boolean().default(true).describe("Replace reviewers' and reviewees' names with pseudonyms, including names written inside review comments. User IDs are kept. Pseudonyms are per course and stable across sessions: the same student keeps the same number. (default: true)"),
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, ...options }: { courseId: string; assignmentId: string } & PeerReviewOptions) => {
      try {
        const report = await getPeerReviewReport(canvas, courseId, assignmentId, options);
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch peer reviews: ${error.message}`);
        }
        throw new Error('Failed to fetch peer reviews: Unknown error');
      }
    }
  );
}
