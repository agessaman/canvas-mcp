import { CanvasClient } from './canvasClient.js';

// Who an accommodation is being granted to.
//
// Shared by the quiz-time and assignment-attempt extension tools, which have the
// same problem: Canvas has no section-level extension in either API, so a
// section has to be expanded to its students before anything is written, and
// both want integer user IDs.
//
// This lives outside either tool because the two must not drift. The expansion
// being a snapshot is the sort of caveat that gets stated in one tool and
// forgotten in the other, and a teacher who reads it once will reasonably assume
// it holds everywhere.

export interface Target { ids: string[]; note: string; }

/**
 * Turn the caller's target into the list of user IDs Canvas actually wants.
 *
 * `what` names the thing being granted, so the snapshot note reads correctly in
 * whichever tool called this.
 */
export async function resolveTargets(
  canvas: CanvasClient,
  args: { studentIds?: string[]; sectionId?: string },
  what: string = 'quiz extension'
): Promise<Target> {
  const hasStudents = (args.studentIds?.length ?? 0) > 0;
  if (hasStudents === !!args.sectionId) {
    throw new Error('Target exactly one of studentIds or sectionId.');
  }

  if (hasStudents) {
    return { ids: args.studentIds!.map(String), note: '' };
  }

  const enrollments = await canvas.listSectionEnrollments(args.sectionId!, {
    type: ['StudentEnrollment'],
    state: ['active', 'invited'],
    per_page: 100,
  });
  const ids = [...new Set(enrollments.map((e: any) => String(e.user_id)))];
  if (ids.length === 0) {
    throw new Error(
      `Section ${args.sectionId} has no currently-enrolled students, so nothing would be granted. `
      + `Check the section ID with list-sections.`
    );
  }
  return {
    ids,
    note: `\n\nTargeted section ${args.sectionId} by expanding it to its ${ids.length} currently-enrolled `
      + `student(s) — Canvas has no section-level ${what}. This is a snapshot: students added to that `
      + `section later will NOT get this extension, and it must be granted to them separately.`,
  };
}

/**
 * Canvas wants integer user IDs, and some of these endpoints take raw JSON
 * rather than form-encoded params, so a string ID is not reliably coerced.
 * Refuse anything non-numeric rather than send a payload Canvas may accept and
 * quietly ignore.
 */
export function numericIds(ids: string[]): number[] {
  const bad = ids.filter(id => !/^\d+$/.test(id));
  if (bad.length > 0) {
    throw new Error(
      `Student IDs must be numeric Canvas user IDs; got ${bad.join(', ')}. `
      + `Resolve names or SIS IDs to Canvas user IDs with list-students first.`
    );
  }
  return ids.map(Number);
}
