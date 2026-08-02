import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// These tools exist to answer "who needs help, and with what?" — so they
// default to real names. Anonymized output can't be acted on. Pass
// anonymous: true when sharing output or reasoning about the class in aggregate.
const ANON = z.boolean().default(false)
  .describe("Anonymize student names (default: false — intervention planning needs real names)");

const INCLUDE_INACTIVE = z.boolean().default(false)
  .describe("Include inactive and concluded enrollments. Off by default: a student who dropped the course shouldn't land on an outreach list.");

// Enrollment states considered "currently enrolled".
const CURRENT_STATES = new Set(['active', 'invited']);

interface RosterEntry { name: string; state: string; }

// Build a user_id -> { name, state } map for the whole course.
//
// Reads the enrollments endpoint rather than the users endpoint because it
// carries enrollment_state directly — /courses/:id/users only filters by state,
// it doesn't report it back. Every state is fetched so callers can label rows
// accurately; deciding what to *show* is left to each tool's includeInactive.
async function buildRoster(
  canvas: CanvasClient,
  courseId: string,
  anonymous: boolean,
  includeInactive: boolean
): Promise<Map<string, RosterEntry>> {
  // Only widen the state filter when the caller actually wants the extra
  // students. Anyone missing from the map is reported as state "unknown" and
  // filtered out by default anyway, so the narrow query loses nothing — and it
  // keeps the common path on a filter combination that is known to work.
  const enrollments = await canvas.listCourseEnrollments(
    courseId,
    {
      type: ['StudentEnrollment'],
      state: includeInactive
        ? ['active', 'invited', 'inactive', 'completed']
        : ['active', 'invited'],
      per_page: 100
    },
    { anonymous }
  );

  const roster = new Map<string, RosterEntry>();
  for (const e of enrollments) {
    const key = String(e.user_id);
    const existing = roster.get(key);
    // A student enrolled in two sections has two enrollments; an active one
    // wins so cross-listed students aren't mislabelled as concluded.
    if (existing && CURRENT_STATES.has(existing.state)) continue;
    roster.set(key, { name: e.user?.name ?? 'Unknown', state: e.enrollment_state });
  }
  return roster;
}

export function registerGradeTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-course-grades
  server.tool(
    "get-course-grades",
    "Get the current grade for every student in a course, sorted lowest first. Use belowScore to surface only students under a threshold. This is the course-wide gradebook view.",
    {
      courseId: z.string().describe("The ID of the course"),
      belowScore: z.number().optional().describe("Only return students whose current score is below this percentage (e.g. 70)"),
      includeInactive: INCLUDE_INACTIVE,
      limit: z.number().default(0).describe("Return only the N lowest-scoring students (0 = all). Large courses return a lot of rows."),
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, belowScore, includeInactive = false, limit = 0, anonymous = false }: { courseId: string; belowScore?: number; includeInactive?: boolean; limit?: number; anonymous?: boolean }) => {
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
          // Distinguishes "scored 0%" from "nothing has been graded at all" —
          // both show a low score but they need different follow-up.
          has_graded_work: e.grades?.current_score !== null && e.grades?.current_score !== undefined,
          final_score: e.grades?.final_score ?? null,
          current_points: e.grades?.current_points ?? null,
          // What the grade would be if every hidden/unposted grade were released.
          unposted_current_score: e.grades?.unposted_current_score ?? null,
          last_activity_at: e.last_activity_at ?? null,
        }));

        // A student with nothing graded has earned nothing, so they belong in
        // any "below X%" result. Excluding them hid the students who were
        // furthest behind from the exact filter meant to surface them.
        if (belowScore !== undefined) {
          rows = rows.filter(r => r.current_score === null || r.current_score < belowScore);
        }

        rows.sort((a, b) => {
          const aNull = a.current_score === null;
          const bNull = b.current_score === null;
          if (aNull && bNull) return 0;
          if (aNull || bNull) {
            // When hunting for at-risk students, nothing graded is the worst
            // case and sorts first. In an unfiltered listing it sorts last,
            // since a student with nothing graded yet isn't meaningfully
            // "the lowest score" — they may simply have nothing due.
            const nullFirst = belowScore !== undefined;
            if (aNull) return nullFirst ? -1 : 1;
            return nullFirst ? 1 : -1;
          }
          return (a.current_score as number) - (b.current_score as number);
        });

        const shown = limit && limit > 0 ? rows.slice(0, limit) : rows;
        const truncated = shown.length < rows.length
          ? ` (showing the ${shown.length} lowest of ${rows.length})`
          : '';
        const header = belowScore !== undefined
          ? `${rows.length} student(s) below ${belowScore}% in course ${courseId}${truncated}`
          : `Grades for ${rows.length} student(s) in course ${courseId}${truncated}`;

        return {
          content: [{ type: "text", text: `${header}:\n\n${JSON.stringify(shown, null, 2)}` }]
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
      includeInactive: INCLUDE_INACTIVE,
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, includeLate = false, studentIds, includeInactive = false, anonymous = false }: { courseId: string; includeLate?: boolean; studentIds?: string[]; includeInactive?: boolean; anonymous?: boolean }) => {
      try {
        // include[]=user is deliberately NOT requested here: it inflates an
        // already-large payload, and names are joined from the roster instead.
        const params: any = {
          student_ids: studentIds?.length ? studentIds : ['all'],
          per_page: 100
        };
        const submissions = await canvas.listCourseStudentSubmissions(courseId, params, { anonymous: false });
        const roster = await buildRoster(canvas, courseId, anonymous, includeInactive);

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
          const rosterEntry = roster.get(key);
          const state = rosterEntry?.state ?? 'unknown';
          // Don't put dropped or concluded students on an outreach list
          // unless they were explicitly asked for.
          if (!includeInactive && !CURRENT_STATES.has(state)) continue;
          if (!byStudent.has(key)) {
            byStudent.set(key, {
              user_id: sub.user_id,
              name: rosterEntry?.name ?? 'Unknown',
              state,
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
      limit: z.number().default(0).describe("Return only the N least-engaged students (0 = all). Large courses return a lot of rows."),
      includeInactive: INCLUDE_INACTIVE,
      anonymous: ANON
    },
    { readOnlyHint: true },
    async ({ courseId, limit = 0, includeInactive = false, anonymous = false }: { courseId: string; limit?: number; includeInactive?: boolean; anonymous?: boolean }) => {
      try {
        const summaries = await canvas.getStudentSummaries(courseId, { per_page: 100 });

        // student_summaries is keyed by user id only; join the roster for names.
        const roster = await buildRoster(canvas, courseId, anonymous, includeInactive);

        const rows = summaries.map((s: any) => ({
          user_id: s.id,
          name: roster.get(String(s.id))?.name ?? 'Unknown',
          state: roster.get(String(s.id))?.state ?? 'unknown',
          page_views: s.page_views ?? 0,
          participations: s.participations ?? 0,
          on_time: s.tardiness_breakdown?.on_time ?? 0,
          late: s.tardiness_breakdown?.late ?? 0,
          missing: s.tardiness_breakdown?.missing ?? 0,
        }))
          .filter((r: any) => includeInactive || CURRENT_STATES.has(r.state))
          .sort((a: any, b: any) => a.participations - b.participations);

        const shown = limit && limit > 0 ? rows.slice(0, limit) : rows;
        const truncated = shown.length < rows.length
          ? ` (showing the ${shown.length} least engaged of ${rows.length})`
          : '';

        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `Engagement in course ${courseId}, least engaged first${truncated}:\n\n${JSON.stringify(shown, null, 2)}`
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
