// A grading plan that outlives the session that made it.
//
// Grading a class runs over several sittings, and the plan — who gets what on
// which criterion, with which comment and which flags — used to live in a
// markdown file the assistant wrote for itself. A later session could not
// always open that file, and rebuilt the plan from a transcript. So the plan
// lives here instead: written by the session that drafts it, read back by the
// one that posts it, and marked as posted once Canvas has it.
//
// WHAT IS STORED: course and assignment ids, Canvas user ids, the points and
// comment text the teacher approved, and flags the grader raised. Comments are
// the teacher's own words about a student's work, so the file is written
// user-readable only (0600) and never leaves the machine. No names: students
// are the pseudonyms the rest of this server uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PlanRubricScore {
  criterionId: string;
  ratingId?: string;
  points?: number;
  comments?: string;
}

export interface PlanEntry {
  user_id: string;
  student?: string;
  rubric?: PlanRubricScore[];
  score?: number;
  posted_grade?: string;
  comment?: string;
  late_policy_status?: 'none' | 'late' | 'missing' | 'extended';
  excused?: boolean;
  flags?: string[];
  /** Set once this entry has been written to Canvas. */
  posted_at?: string;
  post_error?: string;
}

export interface GradingPlan {
  course_id: string;
  assignment_id: string;
  assignment_name?: string;
  note?: string;
  created_at: string;
  updated_at: string;
  /** The late policy the plan was built against, so a change can be spotted. */
  late_policy_snapshot?: any;
  /** The grading standard the plan's letters came from. */
  grading_standard?: string;
  entries: Record<string, PlanEntry>;
}

interface Store {
  version: 1;
  plans: Record<string, GradingPlan>;
}

let store: Store | null = null;
let storePath: string | null = null;
let readOnlyReason: string | null = null;

function defaultDir(): string {
  const configured = process.env.CANVAS_MCP_STATE_DIR;
  if (configured && configured.trim()) return configured.trim();
  return path.join(os.homedir(), '.canvas-mcp');
}

function resolvePath(): string {
  return storePath ?? (storePath = path.join(defaultDir(), 'grading-plans.json'));
}

function load(): Store {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePath(), 'utf-8'));
    if (parsed?.version === 1 && parsed.plans) {
      store = parsed as Store;
      return store;
    }
    readOnlyReason = `${resolvePath()} is not a grading-plan file this version understands`;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') readOnlyReason = `${resolvePath()} could not be read (${e?.message ?? e})`;
  }
  store = { version: 1, plans: {} };
  return store;
}

function persist(): void {
  if (readOnlyReason) return;
  const target = resolvePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e: any) {
    readOnlyReason = `${target} could not be written (${e?.message ?? e}); the plan will last only for this session`;
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

const keyOf = (courseId: string, assignmentId: string) => `${courseId}:${assignmentId}`;

export function getPlan(courseId: string, assignmentId: string): GradingPlan | undefined {
  return load().plans[keyOf(courseId, assignmentId)];
}

export function listPlans(courseId?: string): GradingPlan[] {
  return Object.values(load().plans)
    .filter(p => !courseId || p.course_id === String(courseId))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface SavePlanInput {
  courseId: string;
  assignmentId: string;
  assignmentName?: string;
  note?: string;
  entries: PlanEntry[];
  latePolicySnapshot?: any;
  gradingStandard?: string;
  /** Drop entries not named in this call, instead of merging into them. */
  replace?: boolean;
}

/**
 * Write entries into the plan, merging by user id. Merging rather than
 * replacing is what lets a teacher change one student's score three sittings
 * later without resending the other thirty-four.
 */
export function savePlan(input: SavePlanInput): { plan: GradingPlan; saved: number; warning?: string } {
  const data = load();
  const key = keyOf(String(input.courseId), String(input.assignmentId));
  const now = new Date().toISOString();
  const existing = data.plans[key];
  const plan: GradingPlan = existing ?? {
    course_id: String(input.courseId),
    assignment_id: String(input.assignmentId),
    created_at: now,
    updated_at: now,
    entries: {},
  };
  if (input.assignmentName) plan.assignment_name = input.assignmentName;
  if (input.note !== undefined) plan.note = input.note;
  if (input.latePolicySnapshot !== undefined) plan.late_policy_snapshot = input.latePolicySnapshot;
  if (input.gradingStandard !== undefined) plan.grading_standard = input.gradingStandard;
  if (input.replace) plan.entries = {};

  for (const entry of input.entries) {
    const id = String(entry.user_id);
    const before = plan.entries[id];
    const merged: PlanEntry = { ...before, ...entry, user_id: id };
    // A changed score is a new decision: it has not been posted, whatever the
    // entry it replaced said.
    if (before?.posted_at && changesGrade(before, entry)) {
      delete merged.posted_at;
      delete merged.post_error;
      merged.flags = [...new Set([...(merged.flags ?? []), 'changed after posting'])];
    }
    plan.entries[id] = merged;
  }
  plan.updated_at = now;
  data.plans[key] = plan;
  persist();
  return { plan, saved: input.entries.length, ...(readOnlyReason ? { warning: readOnlyReason } : {}) };
}

function changesGrade(before: PlanEntry, after: PlanEntry): boolean {
  const shape = (e: PlanEntry) => JSON.stringify([e.rubric ?? null, e.score ?? null, e.posted_grade ?? null, e.comment ?? null, e.late_policy_status ?? null, e.excused ?? null]);
  return shape({ ...before, ...after }) !== shape(before);
}

export function markPosted(courseId: string, assignmentId: string, userId: string, error?: string): void {
  const plan = getPlan(courseId, assignmentId);
  const entry = plan?.entries?.[String(userId)];
  if (!entry) return;
  if (error) {
    entry.post_error = error;
    delete entry.posted_at;
  } else {
    entry.posted_at = new Date().toISOString();
    delete entry.post_error;
  }
  plan!.updated_at = new Date().toISOString();
  persist();
}

export function deletePlan(courseId: string, assignmentId: string): boolean {
  const data = load();
  const key = keyOf(String(courseId), String(assignmentId));
  if (!data.plans[key]) return false;
  delete data.plans[key];
  persist();
  return true;
}

export function plansStorePath(): string {
  return resolvePath();
}

export function plansStoreWarning(): string | null {
  load();
  return readOnlyReason;
}

/** Drop in-memory state so the next call re-reads the file. For tests. */
export function resetPlans(): void {
  store = null;
  storePath = null;
  readOnlyReason = null;
}
