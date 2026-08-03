import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { resolveTargets, numericIds } from "../extensionTargets.js";

// Extra ATTEMPTS on an assignment — a retake, for a student who needs one.
//
//   POST /api/v1/courses/:id/assignments/:id/extensions
//   body { assignment_extensions: [{ user_id, extra_attempts }] }
//
// Three tools now grant three different accommodations, and picking the wrong
// one produces an accommodation that looks granted and does nothing:
//
//   extend-due-date            a later deadline
//   extend-quiz-time           a longer clock on a timed quiz
//   extend-assignment-attempts another try at an assignment   <- this one
//
// The trap specific to this endpoint is that extra attempts are meaningless
// unless the assignment LIMITS attempts in the first place. Canvas stores the
// grant either way and answers 200, so an unlimited-attempts assignment gives
// back a perfectly successful-looking response for an accommodation the student
// already had.

export function registerAssignmentExtensionTools(server: McpServer, canvas: CanvasClient) {
  // Tool: extend-assignment-attempts
  server.tool(
    "extend-assignment-attempts",
    "Give students extra ATTEMPTS at an assignment — another try at a submission, for a retake or a technical "
    + "failure. This is not a deadline and not a clock: use extend-due-date to move a due date, and "
    + "extend-quiz-time for extra minutes on a timed quiz. Only meaningful on an assignment that limits attempts; "
    + "if attempts are unlimited the student already has as many as they want. Target either studentIds or a "
    + "sectionId.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      studentIds: z.array(z.string()).optional().describe(
        "Canvas user IDs of the students getting extra attempts. Mutually exclusive with sectionId."
      ),
      sectionId: z.string().optional().describe(
        "Grant to every currently-enrolled student in this section. Mutually exclusive with studentIds."
      ),
      extraAttempts: z.number().int().min(0).max(100).describe(
        "Extra attempts beyond the assignment's limit, e.g. 1 to allow one resubmission. This is an absolute "
        + "value, not a top-up: calling it again replaces the grant rather than adding to it, and 0 removes it."
      )
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        // Read the assignment first, both to name it and to find out whether
        // extra attempts mean anything on it.
        const assignment: any = await canvas.getAssignment(args.courseId, args.assignmentId);

        const target = await resolveTargets(canvas, args, 'assignment extension');
        const ids = numericIds(target.ids);

        const extensions = ids.map(user_id => ({ user_id, extra_attempts: args.extraAttempts }));
        await canvas.setAssignmentExtensions(args.courseId, args.assignmentId, extensions);

        // allowed_attempts is -1 (or absent) when Canvas permits unlimited
        // submissions, which is the default. Granting extra attempts there is
        // accepted and does nothing, so say so rather than let a 200 read as a
        // granted accommodation.
        const allowed = Number(assignment?.allowed_attempts ?? -1);
        const limitNote = allowed > 0
          ? `\n\nThe assignment allows ${allowed} attempt(s), so these students now have `
            + `${allowed + args.extraAttempts}.`
          : `\n\nWARNING — this assignment does not limit attempts (allowed_attempts: `
            + `${assignment?.allowed_attempts ?? 'not set'}), so students may already submit as many times as `
            + `they like and this grant changes nothing. Canvas accepted it anyway. If the intent was to allow a `
            + `resubmission, no accommodation was needed; if it was to cap attempts, set the assignment's attempt `
            + `limit first with update-assignment.`;

        // Canvas records the grant on the SUBMISSION, which is the only way to
        // read it back. Verified per student rather than trusted, since the
        // write's response says nothing useful.
        const problems: string[] = [];
        for (const userId of ids) {
          try {
            const submission: any = await canvas.getSubmission(
              args.courseId, args.assignmentId, String(userId)
            );
            const got = Number(submission?.extra_attempts ?? 0);
            if (got !== args.extraAttempts) {
              problems.push(`student ${userId}: asked for ${args.extraAttempts}, Canvas stored ${got}`);
            }
          } catch (error: any) {
            problems.push(`student ${userId}: could not be read back (${error?.message ?? 'unknown error'})`);
          }
        }
        const verification = problems.length > 0
          ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
          : '';

        const label = args.extraAttempts === 0
          ? `Removed extra attempts for ${ids.length} student(s)`
          : `Gave ${ids.length} student(s) ${args.extraAttempts} extra attempt(s)`;

        return {
          content: [{
            type: "text",
            text: `${label} on "${assignment?.name ?? args.assignmentId}" (${args.assignmentId}): `
              + `${ids.join(', ')}.`
              + limitNote
              + target.note
              + verification
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to extend assignment attempts: ${error?.message ?? 'Unknown error'}`);
      }
    }
  );
}
