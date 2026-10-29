// Stable "Student 12" labels, per course, across restarts.
//
// The numbers used to come from an in-memory counter in allocation order, so
// they moved whenever the order did: a build that happened to read the grading
// queue first numbered students one way, and a build that read the roster
// first numbered them another. A teacher who wrote "Student 7 needs a retake"
// in their notes had no way to find Student 7 again, which makes a pseudonym
// worse than useless — it reads like a stable identifier and isn't one.
//
// So the mapping is written to disk and only ever appended to. A student who
// already has a number keeps it; a new enrolment takes the next unused number
// rather than renumbering anybody.
//
// WHAT IS STORED: course id, user id, and an integer. No names, no emails,
// nothing that identifies a student to someone who reads the file. Re-identifying
// anyone from it requires the Canvas access that the ids are useless without.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface CourseScope {
  next: number;
  users: Record<string, number>;
}
interface Store {
  version: 1;
  courses: Record<string, CourseScope>;
}

// Submissions that arrive with no course context share one scope, so they are
// at least stable with each other.
const NO_COURSE = '_';

let store: Store | null = null;
let storePath: string | null = null;
let readOnlyReason: string | null = null;

function defaultDir(): string {
  const configured = process.env.CANVAS_MCP_STATE_DIR;
  if (configured && configured.trim()) return configured.trim();
  return path.join(os.homedir(), '.canvas-mcp');
}

function resolvePath(): string {
  return storePath ?? (storePath = path.join(defaultDir(), 'pseudonyms.json'));
}

function load(): Store {
  if (store) return store;
  try {
    const raw = fs.readFileSync(resolvePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed.courses && typeof parsed.courses === 'object') {
      store = parsed as Store;
      return store;
    }
    // A file we don't understand is not a file we may overwrite blind.
    readOnlyReason = `${resolvePath()} is not a pseudonym map this version understands`;
  } catch (e: any) {
    // A missing file is the normal first run, not a problem worth reporting.
    if (e?.code !== 'ENOENT') readOnlyReason = `${resolvePath()} could not be read (${e?.message ?? e})`;
  }
  store = { version: 1, courses: {} };
  return store;
}

function persist(): void {
  if (readOnlyReason) return;
  const target = resolvePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written then renamed, so a crash mid-write cannot leave a half file that
    // would renumber a whole class on the next run.
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e: any) {
    readOnlyReason = `${target} could not be written (${e?.message ?? e}); pseudonyms will be stable only for this session`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
  }
}

/** The stable number for this student in this course, allocating on first use. */
export function pseudonymNumber(courseId: unknown, userId: unknown): number {
  const data = load();
  const course = String(courseId ?? NO_COURSE);
  const user = String(userId);
  let scope = data.courses[course];
  if (!scope) data.courses[course] = scope = { next: 1, users: {} };
  const existing = scope.users[user];
  if (existing !== undefined) return existing;
  // Next UNUSED number, not next by position: a store edited by hand, or one
  // written by a newer version, must not hand out a number twice.
  const used = new Set(Object.values(scope.users));
  while (used.has(scope.next)) scope.next++;
  scope.users[user] = scope.next;
  scope.next++;
  persist();
  return scope.users[user];
}

export function pseudonymFor(courseId: unknown, userId: unknown): string {
  return `Student ${pseudonymNumber(courseId, userId)}`;
}

/** Why the mapping is session-only, when it is. Null when all is well. */
export function pseudonymStoreWarning(): string | null {
  load();
  return readOnlyReason;
}

export function pseudonymStorePath(): string {
  return resolvePath();
}

/** Drop in-memory state so the next call re-reads the file. For tests. */
export function resetPseudonyms(): void {
  store = null;
  storePath = null;
  readOnlyReason = null;
}
