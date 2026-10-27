import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { Course } from "../types.js";

export function registerCourseTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-courses
  server.tool(
    "list-courses",
    "List the authenticated user's courses. Defaults to published, currently-active courses. Set includeUnpublished to find course shells you are still building, includeConcluded for past terms, and searchTerm to filter by name or course code.",
    {
      includeUnpublished: z.boolean().default(false).describe("Include unpublished course shells (not yet visible to students)"),
      includeConcluded: z.boolean().default(false).describe("Include concluded courses from past terms"),
      searchTerm: z.string().optional().describe("Case-insensitive filter on course name or course code"),
      enrollmentType: z.enum(['teacher', 'ta', 'student', 'designer', 'observer']).optional().describe("Only courses where you hold this role")
    },
    { readOnlyHint: true },
    async ({ includeUnpublished = false, includeConcluded = false, searchTerm, enrollmentType }: { includeUnpublished?: boolean; includeConcluded?: boolean; searchTerm?: string; enrollmentType?: string }) => {
      try {
        const state = ['available'];
        if (includeUnpublished) state.push('unpublished');
        if (includeConcluded) state.push('completed');

        const params: any = { state, per_page: 100, include: ['term'] };
        // Restricting enrollment_state to 'active' hides concluded enrollments,
        // so only apply it when the caller isn't asking for past terms.
        if (!includeConcluded) params.enrollment_state = 'active';
        if (enrollmentType) params.enrollment_type = enrollmentType;

        let courses = (await canvas.listCourses(params) as any) as Course[];

        // Canvas has no search_term on this endpoint, so filter client-side.
        if (searchTerm) {
          const needle = searchTerm.toLowerCase();
          courses = courses.filter(c =>
            c.name?.toLowerCase().includes(needle) ||
            c.course_code?.toLowerCase().includes(needle)
          );
        }

        const formattedCourses = courses
          .map((course: Course) => {
            const termInfo = course.term ? ` (${course.term.name})` : '';
            const status = course.workflow_state === 'available'
              ? 'Published'
              : course.workflow_state === 'unpublished' ? 'Unpublished' : course.workflow_state;
            return `Course: ${course.name}${termInfo}\nID: ${course.id}\nCode: ${course.course_code}\nStatus: ${status}\n---`;
          })
          .join('\n');

        const scope = [
          includeUnpublished ? 'unpublished' : null,
          includeConcluded ? 'concluded' : null,
        ].filter(Boolean);
        const scopeNote = scope.length ? ` (including ${scope.join(' and ')})` : '';

        return {
          content: [
            {
              type: "text",
              text: formattedCourses
                ? `Courses${scopeNote}:\n\n${formattedCourses}`
                : searchTerm
                  ? `No courses matched "${searchTerm}"${scopeNote}. Try includeUnpublished or includeConcluded to widen the search.`
                  : "No courses found. Try includeUnpublished or includeConcluded to widen the search.",
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch courses: ${error.message}`);
        }
        throw new Error('Failed to fetch courses: Unknown error');
      }
    }
  );

  // Tool: get-course
  server.tool(
    "get-course",
    "Fetch a single course by ID, including unpublished ones that don't appear in list-courses. Use this when you already know the course ID (for example from a Canvas URL).",
    {
      courseId: z.string().describe("The ID of the course"),
      includeSyllabus: z.boolean().default(false).describe("Include the syllabus body in the response")
    },
    { readOnlyHint: true },
    async ({ courseId, includeSyllabus = false }: { courseId: string; includeSyllabus?: boolean }) => {
      try {
        const include = ['term'];
        if (includeSyllabus) include.push('syllabus_body');
        const course = await canvas.getCourse(courseId, { include }) as any;

        const parts = [
          `Course: ${course.name}`,
          `ID: ${course.id}`,
          `Code: ${course.course_code}`,
          `Status: ${course.workflow_state}`,
          `Term: ${course.term?.name ?? 'N/A'}`,
          `Start: ${course.start_at ?? 'N/A'}`,
          `End: ${course.end_at ?? 'N/A'}`,
        ];
        if (includeSyllabus) {
          parts.push(`\nSyllabus:\n${course.syllabus_body || '(empty)'}`);
        }

        return { content: [{ type: "text", text: parts.join('\n') }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch course ${courseId}: ${error.message}`);
        }
        throw new Error('Failed to fetch course: Unknown error');
      }
    }
  );

  // Tool: post-announcement
  server.tool(
    "post-announcement",
    "Post an announcement to a specific course",
    {
      courseId: z.string().describe("The ID of the course"),
      title: z.string().describe("The title of the announcement"),
      message: z.string().describe("The content of the announcement")
    },
    { destructiveHint: false },
    async ({ courseId, title, message }: { courseId: string; title: string; message: string }) => {
      try {
        await canvas.postAnnouncement(courseId, {
          title,
          message,
          is_announcement: true,
        });
        return {
          content: [
            {
              type: "text",
              text: `Successfully posted announcement "${title}" to course ${courseId}`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to post announcement: ${error.message}`);
        }
        throw new Error('Failed to post announcement: Unknown error');
      }
    }
  );
} 