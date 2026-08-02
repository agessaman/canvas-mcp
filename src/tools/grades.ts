import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// These tools exist to answer "who needs help, and with what?" — so they
// default to real names. Anonymized output can't be acted on. Pass
// anonymous: true when sharing output or reasoning about the class in aggregate.
const ANON = z.boolean().default(false)
  .describe("Anonymize student names (default: false — intervention planning needs real names)");

export function registerGradeTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-course-grades
  server.tool(
    "get-course-grades",
    "Get the current grade for every student in a course, sorted lowest first. Use belowScore to surface only students under a threshold. This is the course-wide gradebook view.",
    {
      courseId: z.string().describe("The ID of the course"),
      belowScore: z.number().optional().describe("Only return students whose current score is below this percentage (e.g. 70)"),
      includeInactive: z.boolean().default(false).describe("Include inactive and concluded enrollments"),
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, belowScore, includeInactive = false, anonymous = false }: { courseId: string; belowScore?: number; includeInactive?: boolean; anonymous?: boolean }) => {
      try {
        const params: any = {
          type: ['StudentEnrollment'],
          state: includeInactive ? ['active', 'invited', 'inactive', 'completed'] : ['active', 'invited'],
          include: ['current_points'],
          per_page: 100
        };
        const enrollments = await canvas.listCourseEnrollments(courseId, params, { anonymous });

        let rows = enrollments.map((e: any) => ({
          user_id: e.user_id,
          name: e.user?.name ?? 'Unknown',
          section_id: e.course_section_id,
          state: e.enrollment_state,
          current_score: e.grades?.current_score ?? null,
          current_grade: e.grades?.current_grade ?? null,
          final_score: e.grades?.final_score ?? null,
          current_points: e.grades?.current_points ?? null,
          // What the grade would be if every hidden/unposted grade were released.
          unposted_current_score: e.grades?.unposted_current_score ?? null,
          last_activity_at: e.last_activity_at ?? null,
        }));

        if (belowScore !== undefined) {
          rows = rows.filter(r => r.current_score !== null && r.current_score < belowScore);
        }

        // Nulls last: a student with no graded work yet isn't "the lowest score".
        rows.sort((a, b) => {
          if (a.current_score === null) return 1;
          if (b.current_score === null) return -1;
          return a.current_score - b.current_score;
        });

        const header = belowScore !== undefined
          ? `${rows.length} student(s) below ${belowScore}% in course ${courseId}`
          : `Grades for ${rows.length} student(s) in course ${courseId}`;

        return {
          content: [{ type: "text", text: `${header}:\n\n${JSON.stringify(rows, null, 2)}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch course grades: ${error.message}`);
        }
        throw new Error('Failed to fetch course grades: Unknown error');
      }
    }
  );

  // Tool: list-missing-submissions
  server.tool(
    "list-missing-submissions",
    "List every missing (and optionally late) submission in a course, grouped by student. Answers 'who is behind and on what?' in a single call.",
    {
      courseId: z.string().describe("The ID of the course"),
      includeLate: z.boolean().default(false).describe("Also include submitted-but-late work"),
      studentIds: z.array(z.string()).optional().describe("Optional: restrict to these student IDs"),
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, includeLate = false, studentIds, anonymous = false }: { courseId: string; includeLate?: boolean; studentIds?: string[]; anonymous?: boolean }) => {
      try {
        const params: any = {
          student_ids: studentIds?.length ? studentIds : ['all'],
          include: ['user'],
          per_page: 100
        };
        const submissions = await canvas.listCourseStudentSubmissions(courseId, params, { anonymous });

        // Join assignment titles in separately — including them on every
        // submission would balloon the payload for a large course.
        const assignments = await canvas.fetchAllPages<any>(
          `/api/v1/courses/${courseId}/assignments`,
          { per_page: 100 }
        );
        const assignmentById = new Map<number, any>(assignments.map(a => [a.id, a]));

        const flagged = submissions.filter((s: any) => s.missing || (includeLate && s.late));

        const byStudent = new Map<string, any>();
        for (const sub of flagged) {
          const key = String(sub.user_id);
          if (!byStudent.has(key)) {
            byStudent.set(key, {
              user_id: sub.user_id,
              name: sub.user?.name ?? 'Unknown',
              missing_count: 0,
              late_count: 0,
              items: [] as any[],
            });
          }
          const entry = byStudent.get(key);
          const assignment = assignmentById.get(sub.assignment_id);
          if (sub.missing) entry.missing_count += 1;
          else entry.late_count += 1;
          entry.items.push({
            assignment_id: sub.assignment_id,
            title: assignment?.name ?? `Assignment ${sub.assignment_id}`,
            due_at: assignment?.due_at ?? null,
            points_possible: assignment?.points_possible ?? null,
            status: sub.missing ? 'missing' : 'late',
            score: sub.score ?? null,
          });
        }

        const rows = [...byStudent.values()].sort(
          (a, b) => (b.missing_count + b.late_count) - (a.missing_count + a.late_count)
        );

        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `${rows.length} student(s) with outstanding work in course ${courseId}:\n\n${JSON.stringify(rows, null, 2)}`
              : "No missing work found."
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch missing submissions: ${error.message}`);
        }
        throw new Error('Failed to fetch missing submissions: Unknown error');
      }
    }
  );

  // Tool: get-student-engagement
  server.tool(
    "get-student-engagement",
    "Get per-student engagement data for a course: page views, participations, and a breakdown of on-time/late/missing work. Complements grades when deciding who needs outreach.",
    {
      courseId: z.string().describe("The ID of the course"),
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, anonymous = false }: { courseId: string; anonymous?: boolean }) => {
      try {
        const summaries = await canvas.getStudentSummaries(courseId, { per_page: 100 });

        // student_summaries is keyed by user id only; join the roster for names.
        const roster = await canvas.listStudents(
          courseId,
          { enrollment_type: ['student'], enrollment_state: ['active', 'invited'], per_page: 100 },
          { anonymous }
        ) as any[];
        const nameById = new Map<string, string>(roster.map(u => [String(u.id), u.name]));

        const rows = summaries.map((s: any) => ({
          user_id: s.id,
          name: nameById.get(String(s.id)) ?? 'Unknown',
          page_views: s.page_views ?? 0,
          participations: s.participations ?? 0,
          on_time: s.tardiness_breakdown?.on_time ?? 0,
          late: s.tardiness_breakdown?.late ?? 0,
          missing: s.tardiness_breakdown?.missing ?? 0,
        })).sort((a: any, b: any) => a.participations - b.participations);

        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `Engagement for ${rows.length} student(s) in course ${courseId} (least engaged first):\n\n${JSON.stringify(rows, null, 2)}`
              : "No analytics data available for this course. Analytics may be disabled by your Canvas admin."
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch student engagement: ${error.message}`);
        }
        throw new Error('Failed to fetch student engagement: Unknown error');
      }
    }
  );
}
