import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

export function registerStudentTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-students
  server.tool(
    "list-students",
    "Get a complete list of all students enrolled in a specific course",
    {
      courseId: z.string().describe("The ID of the course"),
      includeEmail: z.boolean().default(false).describe("Whether to include student email addresses"),
      includeInactive: z.boolean().default(false).describe("Include inactive and concluded enrollments (they are labelled in the output)"),
      anonymous: z.boolean().default(true).describe("Whether to anonymize student names and emails (default: true for privacy)")
    },
    { readOnlyHint: true },
    async ({ courseId, includeEmail, includeInactive = false, anonymous = true }: { courseId: string; includeEmail?: boolean; includeInactive?: boolean; anonymous?: boolean }) => {
      try {
        // listStudents fetches every page internally; only request email when asked for.
        // enrollments is included so each student's status can be reported —
        // /courses/:id/users filters on enrollment_state but never returns it.
        const include: string[] = ['avatar_url', 'enrollments'];
        if (includeEmail) include.push('email');
        const params: any = {
          enrollment_type: ['student'],
          per_page: 100,
          include,
          enrollment_state: includeInactive
            ? ['active', 'invited', 'inactive', 'completed']
            : ['active', 'invited']
        };
        const students = (await canvas.listStudents(courseId, params, { anonymous }) as any[]);
        const formattedStudents = students
          .map(student => {
            // A student cross-listed into two sections has multiple
            // enrollments; an active one is the meaningful status.
            const states = (student.enrollments ?? []).map((e: any) => e.enrollment_state);
            const status = states.find((s: string) => s === 'active' || s === 'invited')
              ?? states[0]
              ?? 'unknown';
            const parts = [
              `Name: ${student.name}`,
              `ID: ${student.id}`,
              `Status: ${status}`,
              `SIS ID: ${student.sis_user_id || 'N/A'}`,
              `Avatar URL: ${student.avatar_url || 'N/A'}`
            ];
            if (includeEmail && student.email) {
              parts.push(`Email: ${student.email}`);
            }
            return parts.join('\n');
          })
          .join('\n---\n');
        return {
          content: [
            {
              type: "text",
              text: students.length > 0 
                ? `Students in course ${courseId}:\n\n${formattedStudents}\n\nTotal students: ${students.length}`
                : "No students found in this course.",
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch students: ${error.message}`);
        }
        throw new Error('Failed to fetch students: Unknown error');
      }
    }
  );
} 