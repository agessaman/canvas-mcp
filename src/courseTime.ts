// Canvas returns every timestamp in UTC. "2026-10-27T05:00:00Z" is 10pm on the
// 26th in Los Angeles, which reads as the wrong day at a glance — and the day
// is exactly what decides whether a submission was late or a revision window
// has closed. Every date a grading tool returns therefore gets a _local twin,
// formatted in the course's own time zone.
import { CanvasClient } from './canvasClient.js';

export interface CourseZone {
  timeZone: string;
  source: 'course' | 'account' | 'default';
}

const FALLBACK_ZONE = 'UTC';
const zoneCache = new Map<string, CourseZone>();

function usable(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The course's time zone, falling back to its account's and then to UTC.
 * Cached per course for the life of the process: a course's time zone is not
 * something that changes during a grading session.
 */
export async function resolveCourseZone(canvas: CanvasClient, courseId: string): Promise<CourseZone> {
  const cached = zoneCache.get(courseId);
  if (cached) return cached;

  let resolved: CourseZone = { timeZone: FALLBACK_ZONE, source: 'default' };
  try {
    const course: any = await canvas.getCourse(courseId);
    if (usable(course?.time_zone)) {
      resolved = { timeZone: course.time_zone, source: 'course' };
    } else if (course?.account_id !== undefined && course?.account_id !== null) {
      const account: any = await canvas.getAccount(String(course.account_id)).catch(() => null);
      if (usable(account?.default_time_zone)) {
        resolved = { timeZone: account.default_time_zone, source: 'account' };
      }
    }
  } catch {
    // A course we can't read is not a reason to fail a grading packet.
  }
  zoneCache.set(courseId, resolved);
  return resolved;
}

/** For tests, and for a client that switches Canvas instances mid-process. */
export function clearCourseZoneCache(): void {
  zoneCache.clear();
}

/** "2026-10-26 22:00 PDT" — the form a teacher can read without converting. */
export function formatInZone(iso: unknown, timeZone: string): string | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  const zone = get('timeZoneName');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}${zone ? ` ${zone}` : ''}`;
}
