import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

export function registerTodoTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-grading-todo
  server.tool(
    "list-grading-todo",
    "Get the instructor's grading queue: every assignment with submissions waiting to be graded, across all courses or a filtered set. Returns course, assignment, how many submissions need grading, and the due date.",
    {
      courseIds: z.array(z.string()).optional().describe("Optional: restrict to these course IDs"),
      includeUngradedQuizzes: z.boolean().default(true).describe("Include ungraded surveys/quizzes in the queue"),
      minNeedsGrading: z.number().default(1).describe("Only return assignments with at least this many submissions awaiting grading")
    },
    { readOnlyHint: true },
    async ({ courseIds, includeUngradedQuizzes = true, minNeedsGrading = 1 }: { courseIds?: string[]; includeUngradedQuizzes?: boolean; minNeedsGrading?: number }) => {
      try {
        const include = ['grading_counts'];
        if (includeUngradedQuizzes) include.push('ungraded_quizzes');

        const params: any = { include, per_page: 100 };
        if (courseIds?.length) params.course_ids = courseIds;

        const items = (await canvas.listTodo(params) as any[]) ?? [];

        // The to-do feed mixes the instructor's own "submitting" items in with
        // grading work; only the grading side is a teaching task.
        const grading = items
          .filter(item => item.type === 'grading')
          .map(item => {
            const target = item.assignment ?? item.quiz ?? {};
            return {
              course_id: item.course_id ?? item.context_id,
              assignment_id: target.id,
              title: target.name ?? target.title,
              needs_grading_count: item.needs_grading_count ?? 0,
              due_at: target.due_at ?? null,
              points_possible: target.points_possible,
              html_url: item.html_url,
            };
          })
          .filter(item => item.needs_grading_count >= minNeedsGrading)
          .sort((a, b) => b.needs_grading_count - a.needs_grading_count);

        const total = grading.reduce((sum, item) => sum + item.needs_grading_count, 0);

        return {
          content: [{
            type: "text",
            text: grading.length > 0
              ? `${total} submission(s) awaiting grading across ${grading.length} assignment(s):\n\n${JSON.stringify(grading, null, 2)}`
              : "Nothing awaiting grading."
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch grading to-do list: ${error.message}`);
        }
        throw new Error('Failed to fetch grading to-do list: Unknown error');
      }
    }
  );

  // Tool: get-todo-counts
  server.tool(
    "get-todo-counts",
    "Get a fast count of how many submissions need grading, without listing them. Useful as a quick status check.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const counts = await canvas.getTodoItemCount({ include: ['ungraded_quizzes'] }) as any;
        return {
          content: [{
            type: "text",
            text: `Submissions needing grading: ${counts.needs_grading_count ?? 0}\nAssignments needing submitting: ${counts.assignments_needing_submitting ?? 0}`
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch to-do counts: ${error.message}`);
        }
        throw new Error('Failed to fetch to-do counts: Unknown error');
      }
    }
  );
}
