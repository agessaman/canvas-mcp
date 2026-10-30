// The teacher's own grading practices, remembered between sessions.
//
// NOTHING IN THIS FILE IS A GRADING PREFERENCE. It holds a catalogue of the
// questions a grader has to settle before it can score anything, and a store
// for whatever the teacher answered. The distinction matters: a server that
// ships "feedback is 2–3 sentences" has encoded one teacher's habit as every
// teacher's rule, and the next teacher never gets asked. So the catalogue has
// questions and example phrasings, and no defaults — an unanswered question is
// asked, not guessed.
//
// WHAT IS STORED: the teacher's answers, as they wrote them, plus the course
// id when an answer is scoped to one course. No student data, no roster, no
// school identifiers unless the teacher types one into an answer themselves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PreferenceQuestion {
  key: string;
  /** What to ask the teacher, in their words, when this is unanswered. */
  question: string;
  /** When the answer starts to matter, so it can be asked at the right time. */
  needed_when: string;
  /** Phrasings other teachers have used. Examples to offer, never defaults. */
  examples: string[];
  /**
   * True where the answer belongs to one assignment rather than to the
   * teacher. Whether classmates' work should be compared turns on what the
   * assignment was — partner research, an individual essay, a lab everyone
   * ran the same way — so an answer given once is the wrong shape for it.
   */
  per_assignment?: boolean;
}

// Each entry exists because this decision came up during grading and had no
// answer on file. They are ordered by when they bite: setup first, then
// scoring, then what students see.
export const PREFERENCE_QUESTIONS: PreferenceQuestion[] = [
  {
    key: 'feedback',
    question: 'Do you want written feedback on this kind of assignment, or scores only?',
    needed_when: 'Before drafting anything for the first student.',
    examples: ['scores only', 'a comment for every student', 'comments only where something went wrong'],
  },
  {
    key: 'comment_shape',
    question: 'When you do write a comment, what should it contain and how long should it run?',
    needed_when: 'Before drafting the first comment.',
    examples: [
      'two or three sentences: one strength, the problem named, one next step',
      'a paragraph tied to each rubric criterion',
      'one line naming the next step only',
    ],
  },
  {
    key: 'revision_wording',
    question: 'When work falls short, do you point students at a revision or at next time?',
    needed_when: 'Before drafting the first comment; it depends on whether resubmissions are open.',
    examples: ['"Revise ..." when resubmissions are open, "Next time ..." otherwise', 'always "Next time ..."'],
  },
  {
    key: 'copied_work',
    question: 'How do you score work copied from a source?',
    needed_when: 'As soon as a source match or a match between two students turns up.',
    examples: [
      'no credit for the copied part, credit for the rest',
      'zero on the assignment, as the assignment says',
      'flag it for me and let me decide each one',
    ],
  },
  {
    key: 'copy_threshold',
    question: 'How long does a run of words taken from a source have to be before you call it copying?',
    needed_when: 'Before a source check is reported, so the report is cut at your line and not an arbitrary one.',
    examples: ['about ten consecutive words', 'a full sentence', 'report every run and let me judge'],
  },
  {
    key: 'off_topic',
    question: 'How do you score an answer that is accurate but does not answer the question asked?',
    needed_when: 'The first time an answer is on the wrong subject.',
    examples: ['no credit for that part', 'partial credit', 'flag it for me, do not score it'],
  },
  {
    key: 'partial_credit',
    question: 'Within one criterion, how do you handle work that is partly right or partly the student\'s own?',
    needed_when: 'Before scoring a criterion that covers several questions or boxes.',
    examples: [
      'scale the criterion by the share of parts that earned credit',
      'score the criterion whole, on the overall impression',
    ],
  },
  {
    key: 'cross_check',
    question: 'Should this assignment\'s submissions be compared against each other for passages two students share?',
    needed_when: 'Before the queue is read, because the comparison reads every submission — one download each.',
    examples: [
      'yes, check this one',
      'no, they worked in groups and shared text is expected',
      'no, individual work with a set answer; matching text means nothing here',
    ],
    per_assignment: true,
  },
  {
    key: 'shared_work',
    question: 'How do you treat students who handed in the same work — and does it change when they are in different class periods?',
    needed_when: 'As soon as two students\' work matches.',
    examples: [
      'partners in the same period share a grade; across periods neither gets credit',
      'the same rule either way',
      'show me each pair and I will decide',
    ],
  },
  {
    key: 'below_lowest_rating',
    question: 'May a criterion be scored below its lowest rating — a zero where the lowest rating is worth a point?',
    needed_when: 'Before writing a score under a criterion\'s lowest rating.',
    examples: ['yes, zero is allowed', 'no, never below the lowest rating', 'ask me each time'],
  },
  {
    key: 'late_handling',
    question: 'What should happen to a late marker while grading — keep the deduction, or clear it?',
    needed_when: 'Before the first grade on a submission Canvas has marked late.',
    examples: ['keep the policy deduction', 'clear the late marker before grading', 'ask me per assignment'],
  },
  {
    key: 'posting',
    question: 'Should grades be held and released together, or go live as they are written?',
    needed_when: 'Before the first grade is written on an assignment that posts automatically.',
    examples: ['hold them and release the whole class at once', 'let them post as they are written'],
  },
];

const QUESTION_BY_KEY = new Map(PREFERENCE_QUESTIONS.map(q => [q.key, q]));

export const PREFERENCE_KEYS = PREFERENCE_QUESTIONS.map(q => q.key);

export interface PreferenceEntry {
  /** The teacher's answer, in their own words. */
  value: string;
  /** When it was recorded, so a stale answer can be spotted. */
  recorded_at: string;
}

type Scope = Record<string, PreferenceEntry>;

interface Store {
  version: 1;
  defaults: Scope;
  courses: Record<string, Scope>;
  /** Keyed "<courseId>:<assignmentId>", for answers that are one assignment's. */
  assignments?: Record<string, Scope>;
}

export const assignmentKey = (courseId: unknown, assignmentId: unknown) =>
  `${String(courseId)}:${String(assignmentId)}`;

let store: Store | null = null;
let storePath: string | null = null;
let readOnlyReason: string | null = null;

function defaultDir(): string {
  const configured = process.env.CANVAS_MCP_STATE_DIR;
  if (configured && configured.trim()) return configured.trim();
  return path.join(os.homedir(), '.canvas-mcp');
}

function resolvePath(): string {
  return storePath ?? (storePath = path.join(defaultDir(), 'grading-preferences.json'));
}

function empty(): Store {
  return { version: 1, defaults: {}, courses: {}, assignments: {} };
}

function load(): Store {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePath(), 'utf-8'));
    if (parsed?.version === 1 && parsed.defaults && parsed.courses) {
      // A file written before assignment answers existed is still one this
      // version understands; it simply has none.
      parsed.assignments ??= {};
      store = parsed as Store;
      return store;
    }
    // A file this version does not understand is not a file it may overwrite:
    // the teacher's answers are not recoverable from anywhere else.
    readOnlyReason = `${resolvePath()} is not a preferences file this version understands`;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') readOnlyReason = `${resolvePath()} could not be read (${e?.message ?? e})`;
  }
  store = empty();
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
    readOnlyReason = `${target} could not be written (${e?.message ?? e}); answers will last only for this session`;
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

export interface ResolvedPreference {
  key: string;
  question: string;
  needed_when: string;
  /** The teacher's answer, or undefined when it has never been asked. */
  answer?: string;
  /** Where the answer came from, when there is one. */
  scope?: 'assignment' | 'course' | 'default';
  recorded_at?: string;
  /** Phrasings to offer when asking. Examples, not defaults. */
  examples?: string[];
  /** True where this is decided per assignment rather than once. */
  per_assignment?: boolean;
}

/**
 * Every question, with the teacher's answer where one exists. The narrowest
 * answer wins — this assignment's over this course's over the default — and a
 * question with none is returned unanswered so the caller can see what is
 * still open rather than inventing it.
 *
 * A per-assignment question only counts as answered when the answer is THIS
 * assignment's. A teacher who said yes to comparing one worksheet's
 * submissions has not said yes to every assignment they will ever set, and
 * treating it that way is the same mistake as shipping a default.
 */
export function resolvePreferences(courseId?: string, assignmentId?: string): ResolvedPreference[] {
  const data = load();
  const course = courseId ? (data.courses[String(courseId)] ?? {}) : {};
  const assignment = (courseId && assignmentId)
    ? ((data.assignments ?? {})[assignmentKey(courseId, assignmentId)] ?? {})
    : {};
  const keys = [...new Set([
    ...PREFERENCE_KEYS,
    ...Object.keys(data.defaults),
    ...Object.keys(course),
    ...Object.keys(assignment),
  ])];
  return keys.map(key => {
    const q = QUESTION_BY_KEY.get(key);
    const perAssignment = !!q?.per_assignment;
    const hit = perAssignment
      ? assignment[key]
      : (assignment[key] ?? course[key] ?? data.defaults[key]);
    const scope: ResolvedPreference['scope'] | undefined = hit
      ? (assignment[key] === hit ? 'assignment' : (course[key] === hit ? 'course' : 'default'))
      : undefined;
    return {
      key,
      question: q?.question ?? `A practice recorded under "${key}".`,
      needed_when: q?.needed_when ?? 'Whenever it applies.',
      ...(perAssignment ? { per_assignment: true } : {}),
      ...(hit ? { answer: hit.value, scope, recorded_at: hit.recorded_at } : {}),
      ...(hit ? {} : { examples: q?.examples ?? [] }),
    };
  });
}

export function unansweredPreferences(courseId?: string, assignmentId?: string): ResolvedPreference[] {
  return resolvePreferences(courseId, assignmentId).filter(p => p.answer === undefined);
}

/** Yes, no, or nothing said — for a question whose answer is a decision. */
export function decisionOf(answer: string | undefined): boolean | undefined {
  if (!answer) return undefined;
  const text = answer.trim().toLowerCase();
  if (/^(no|n|never|skip|don'?t|do not|off|false)\b/.test(text)) return false;
  if (/^(yes|y|sure|ok|okay|please|do|run|on|true)\b/.test(text)) return true;
  // Anything else is the teacher saying something this code should not be
  // reducing to a boolean — report it and let the grader read it.
  return undefined;
}

/** Record answers. A blank value forgets that answer rather than storing one. */
export function setPreferences(
  answers: Record<string, string>,
  courseId?: string,
  assignmentId?: string,
): { saved: string[]; cleared: string[]; warning?: string } {
  const data = load();
  const scope: Scope = (courseId && assignmentId)
    ? ((data.assignments ??= {})[assignmentKey(courseId, assignmentId)] ??= {})
    : courseId
      ? (data.courses[String(courseId)] ??= {})
      : data.defaults;
  const saved: string[] = [];
  const cleared: string[] = [];
  const now = new Date().toISOString();
  for (const [key, raw] of Object.entries(answers)) {
    const value = String(raw ?? '').trim();
    if (!value) {
      if (scope[key]) cleared.push(key);
      delete scope[key];
      continue;
    }
    scope[key] = { value, recorded_at: now };
    saved.push(key);
  }
  persist();
  return { saved, cleared, ...(readOnlyReason ? { warning: readOnlyReason } : {}) };
}

export function forgetPreferences(courseId?: string, assignmentId?: string): void {
  const data = load();
  if (courseId && assignmentId) delete (data.assignments ?? {})[assignmentKey(courseId, assignmentId)];
  else if (courseId) delete data.courses[String(courseId)];
  else data.defaults = {};
  persist();
}

export function preferencesStorePath(): string {
  return resolvePath();
}

export function preferencesStoreWarning(): string | null {
  load();
  return readOnlyReason;
}

/** Drop in-memory state so the next call re-reads the file. For tests. */
export function resetPreferences(): void {
  store = null;
  storePath = null;
  readOnlyReason = null;
}
