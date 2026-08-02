import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// Assignment overrides — differentiated due dates, and the mechanism behind
// every IEP/504 date accommodation. A New Quiz is backed by an assignment, so
// its overrides come through these same endpoints; Classic Quizzes have their
// own parallel set under /quizzes/:id/overrides.
//
// Two things make this the highest-stakes surface on this server:
//
//   1. A dropped override is a missed accommodation. Canvas answers 200 to
//      writes it has quietly not applied (three times on this branch already),
//      so every write here reads back and diffs what actually landed.
//   2. Creating the first override on an assignment can hide it from everyone
//      else, if only_visible_to_overrides is set. That is reported loudly.

function describeTarget(override: any): string {
  if (override.student_ids?.length) {
    return `${override.student_ids.length} student(s): ${override.student_ids.join(', ')}`;
  }
  if (override.course_section_id) return `section ${override.course_section_id}`;
  if (override.group_id) return `group ${override.group_id}`;
  return 'unknown target';
}

function summarize(override: any) {
  return {
    id: override.id,
    title: override.title,
    applies_to: describeTarget(override),
    student_ids: override.student_ids ?? undefined,
    course_section_id: override.course_section_id ?? undefined,
    due_at: override.due_at ?? null,
    unlock_at: override.unlock_at ?? null,
    lock_at: override.lock_at ?? null,
  };
}

export function registerOverrideTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-assignment-overrides
  server.tool(
    "list-assignment-overrides",
    "Show the differentiated due dates on an assignment or New Quiz — who has a different due date, unlock or lock date from the rest of the class. Use this before granting an extension so you can see what accommodations already exist. Also works for a New Quiz: pass its assignment ID.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The assignment ID (a New Quiz's ID is its assignment ID)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId }: { courseId: string; assignmentId: string }) => {
      try {
        // include[]=all_dates is essential, not a nicety. An assignment's own
        // due_at is documented as "the due date as it applies to the user
        // requesting information from the API" — with overrides in play it is
        // NOT the base date. Observed live: after setting one student's
        // override to Aug 15, the assignment reported due_at Aug 15, so
        // reporting it as the everyone-else date would have been a lie about
        // when the rest of the class is due. all_dates carries an entry flagged
        // base: true, which is the real everyone-else date.
        const [overrides, assignment] = await Promise.all([
          canvas.listAssignmentOverrides(courseId, assignmentId),
          canvas.getAssignment(courseId, assignmentId, { 'include[]': 'all_dates' }) as Promise<any>,
        ]);
        const baseDate = (assignment?.all_dates ?? []).find((entry: any) => entry.base);
        const baseDue = baseDate ? (baseDate.due_at ?? 'none set') : 'unknown';

        if (overrides.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No overrides on "${assignment?.name ?? assignmentId}". Everyone gets the base due date `
                + `(${baseDue}).`
            }]
          };
        }

        // Whether the base date still applies to anyone is the question a
        // teacher actually has, and it is easy to get wrong: with
        // only_visible_to_overrides set, students outside every override cannot
        // see the assignment at all.
        const base = assignment?.only_visible_to_overrides
          ? `WARNING: "only visible to overrides" is ON for this assignment. Students not covered by an `
            + `override above cannot see it at all — they are not merely on the base due date.`
          : `Everyone not listed above gets the base due date (${baseDue}).`;

        return {
          content: [{
            type: "text",
            text: `Overrides on "${assignment?.name ?? assignmentId}":\n\n`
              + `${JSON.stringify(overrides.map(summarize), null, 2)}\n\n${base}\n`
              + `Student IDs can be resolved to names with list-students.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list assignment overrides: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: create-assignment-override
  server.tool(
    "create-assignment-override",
    "Give a different due date (or unlock/lock date) to specific students or to a whole section — the mechanism behind date accommodations and differentiated assignments. Target EITHER studentIds OR sectionId, not both. For simply extending a deadline for some students, prefer extend-due-date, which reuses an existing override instead of stacking a second one on the same student. NOTE: this changes dates only. Extra TIME on a timed quiz is a different thing entirely and is not set here.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The assignment ID (a New Quiz's ID is its assignment ID)"),
      studentIds: z.array(z.string()).optional().describe("Canvas user IDs to target. Mutually exclusive with sectionId."),
      sectionId: z.string().optional().describe("A course section ID to target. Mutually exclusive with studentIds."),
      title: z.string().optional().describe("Label shown in Canvas, e.g. \"Extended - IEP\". Required by Canvas for student-targeted overrides; defaulted if omitted."),
      dueAt: z.string().optional().describe("Overridden due date (ISO 8601)"),
      unlockAt: z.string().optional().describe("Overridden unlock date (ISO 8601)"),
      lockAt: z.string().optional().describe("Overridden lock date (ISO 8601)")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const hasStudents = args.studentIds?.length > 0;
        if (hasStudents === !!args.sectionId) {
          throw new Error(
            'Target exactly one of studentIds or sectionId. Canvas accepts both but silently uses only the '
            + 'most specific, so the other target would be dropped without warning.'
          );
        }
        if (!args.dueAt && !args.unlockAt && !args.lockAt) {
          throw new Error('An override needs at least one of dueAt, unlockAt or lockAt — otherwise it changes nothing.');
        }

        const payload: any = {};
        if (hasStudents) {
          payload.student_ids = args.studentIds;
          // Canvas rejects a student-targeted override with no title.
          payload.title = args.title ?? 'Extended deadline';
        } else {
          payload.course_section_id = args.sectionId;
          if (args.title) payload.title = args.title;
        }
        if (args.dueAt !== undefined) payload.due_at = args.dueAt;
        if (args.unlockAt !== undefined) payload.unlock_at = args.unlockAt;
        if (args.lockAt !== undefined) payload.lock_at = args.lockAt;

        const created: any = await canvas.createAssignmentOverride(args.courseId, args.assignmentId, payload);

        return {
          content: [{
            type: "text",
            text: `Created override ${created?.id} on assignment ${args.assignmentId}, applying to `
              + `${describeTarget(created)}.\n${JSON.stringify(summarize(created), null, 2)}`
              + verifyApplied(payload, created)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create assignment override: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-assignment-override
  server.tool(
    "update-assignment-override",
    "Change the dates or the membership of an existing override. Get the override ID from list-assignment-overrides.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The assignment ID"),
      overrideId: z.string().describe("The override's ID"),
      studentIds: z.array(z.string()).optional().describe("Replaces the whole student list — students left out lose the override"),
      title: z.string().optional(),
      dueAt: z.string().optional().describe("New due date (ISO 8601)"),
      unlockAt: z.string().optional(),
      lockAt: z.string().optional()
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const payload: any = {};
        if (args.studentIds !== undefined) payload.student_ids = args.studentIds;
        if (args.title !== undefined) payload.title = args.title;
        if (args.dueAt !== undefined) payload.due_at = args.dueAt;
        if (args.unlockAt !== undefined) payload.unlock_at = args.unlockAt;
        if (args.lockAt !== undefined) payload.lock_at = args.lockAt;

        if (Object.keys(payload).length === 0) {
          return { content: [{ type: "text", text: "No fields provided; nothing was changed." }] };
        }

        const updated: any = await canvas.updateAssignmentOverride(
          args.courseId, args.assignmentId, args.overrideId, payload
        );
        return {
          content: [{
            type: "text",
            text: `Updated override ${args.overrideId}.\n${JSON.stringify(summarize(updated), null, 2)}`
              + verifyApplied(payload, updated)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update assignment override: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: delete-assignment-override
  server.tool(
    "delete-assignment-override",
    "Remove an override, returning the students or section it covered to the assignment's base dates. If the assignment is set to \"only visible to overrides\", removing their only override hides the assignment from those students entirely.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The assignment ID"),
      overrideId: z.string().describe("The override's ID")
    },
    { destructiveHint: true },
    async ({ courseId, assignmentId, overrideId }: { courseId: string; assignmentId: string; overrideId: string }) => {
      try {
        const removed: any = await canvas.deleteAssignmentOverride(courseId, assignmentId, overrideId);
        return {
          content: [{
            type: "text",
            text: `Deleted override ${overrideId} (was applying to ${describeTarget(removed ?? {})}). `
              + `Those students are back on the assignment's base dates.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to delete assignment override: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: extend-due-date
  server.tool(
    "extend-due-date",
    "Give specific students more time on an assignment or New Quiz — the everyday accommodation. Reuses an existing student override where one already covers exactly those students, instead of stacking a second override on the same student, and refuses to quietly change the date for students you did not name. NOTE: this moves the DUE DATE. It does not grant extra minutes on a timed quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The assignment ID (a New Quiz's ID is its assignment ID)"),
      studentIds: z.array(z.string()).min(1).describe("Canvas user IDs of the students getting more time"),
      dueAt: z.string().describe("The new due date for those students (ISO 8601)"),
      title: z.string().optional().describe("Label for a newly created override (default: \"Extended deadline\")")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const existing = await canvas.listAssignmentOverrides(args.courseId, args.assignmentId);
        const wanted = args.studentIds.map(String);

        // An override covering some of these students plus others cannot be
        // edited without moving the deadline for people who were not named.
        // That is a silent side effect on someone else's accommodation, so stop.
        const entangled = existing.filter((override: any) => {
          const ids = (override.student_ids ?? []).map(String);
          return ids.some((id: string) => wanted.includes(id)) && ids.some((id: string) => !wanted.includes(id));
        });
        if (entangled.length > 0) {
          const detail = entangled.map((o: any) => `override ${o.id} ("${o.title}") covers ${o.student_ids.join(', ')}`).join('; ');
          throw new Error(
            `Some of these students already share an override with students you did not name: ${detail}. `
            + `Changing it would move the deadline for those others too. Use update-assignment-override to edit it `
            + `deliberately, or remove the students first.`
          );
        }

        const exact = existing.find((override: any) => {
          const ids = (override.student_ids ?? []).map(String);
          return ids.length > 0 && ids.length === wanted.length
            && wanted.every((id: string) => ids.includes(id));
        });

        if (exact) {
          const updated: any = await canvas.updateAssignmentOverride(
            args.courseId, args.assignmentId, String(exact.id), { due_at: args.dueAt }
          );
          return {
            content: [{
              type: "text",
              text: `Reused override ${exact.id} ("${exact.title}") — it already covered exactly these students. `
                + `Due date is now ${updated?.due_at}.`
                + verifyApplied({ due_at: args.dueAt }, updated)
                + sectionNote(existing, wanted)
            }]
          };
        }

        const created: any = await canvas.createAssignmentOverride(args.courseId, args.assignmentId, {
          student_ids: wanted,
          title: args.title ?? 'Extended deadline',
          due_at: args.dueAt,
        });
        return {
          content: [{
            type: "text",
            text: `Created override ${created?.id} giving ${wanted.length} student(s) until ${created?.due_at}.`
              + verifyApplied({ student_ids: wanted, due_at: args.dueAt }, created)
              + sectionNote(existing, wanted)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to extend due date: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}

/**
 * Canvas returns 200 on writes it has silently not applied. For an override
 * that means a missed accommodation, so compare what was asked for against
 * what came back and say so rather than reporting success.
 */
function verifyApplied(requested: any, stored: any): string {
  const problems: string[] = [];

  for (const field of ['due_at', 'unlock_at', 'lock_at'] as const) {
    if (requested[field] === undefined) continue;
    const wanted = new Date(requested[field]).getTime();
    const got = stored?.[field] ? new Date(stored[field]).getTime() : NaN;
    if (Number.isNaN(got) || wanted !== got) {
      problems.push(`${field}: asked for ${requested[field]}, Canvas stored ${stored?.[field] ?? 'nothing'}`);
    }
  }

  if (requested.student_ids) {
    const stored_ids = (stored?.student_ids ?? []).map(String);
    const missing = requested.student_ids
      .map((id: any) => String(id))
      .filter((id: string) => !stored_ids.includes(id));
    if (missing.length > 0) {
      problems.push(
        `these students were dropped and have NO accommodation: ${missing.join(', ')} `
        + `(most likely they are not enrolled in this course)`
      );
    }
  }

  if (requested.course_section_id && String(stored?.course_section_id ?? '') !== String(requested.course_section_id)) {
    problems.push(`section: asked for ${requested.course_section_id}, Canvas stored ${stored?.course_section_id ?? 'nothing'}`);
  }

  return problems.length > 0
    ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
    : '';
}

/**
 * A student can be covered by both a section override and their own. Canvas
 * resolves that in the student's favour, but a teacher setting an individual
 * date should know a section-wide one is also in play.
 */
function sectionNote(existing: any[], studentIds: string[]): string {
  const sections = existing.filter(override => override.course_section_id);
  if (sections.length === 0) return '';
  return `\n\nNote: this assignment also has ${sections.length} section-wide override(s) `
    + `(${sections.map(s => `section ${s.course_section_id} due ${s.due_at ?? 'n/a'}`).join('; ')}). `
    + `If any of these students are in those sections, they now have two overrides; Canvas gives the student the `
    + `more generous date. Check with list-assignment-overrides if that matters.`;
}
