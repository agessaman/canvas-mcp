// Two things a grader can't see from extracted text alone.
//
// Integrity signals are prompts to look closer, never findings. Each heuristic
// here was picked because it fires on an artefact of how text was produced —
// a footnote marker that survived a copy/paste, wiki chrome, an answer that
// names its own subject — rather than on how it reads. They are deliberately
// narrow; a signal that fires on ordinary student writing is worse than no
// signal at all, because it trains the teacher to ignore the field.
//
// The template fingerprint exists because worksheet templates get revised
// between class periods, and the rubric's meaning depends on which version a
// student had. The first table's header row identifies the version.
import { createHash } from 'node:crypto';

export interface IntegritySignal {
  excerpt: string;
  reason: string;
}

const MAX_EXCERPT = 40;
const MAX_SIGNALS = 8;

function excerptAround(text: string, index: number, length: number): string {
  // Snap outwards to whitespace: an excerpt cut mid-word ("ncis is most like
  // Sir Fra") reads as a bug rather than as a quotation.
  let start = Math.max(0, index - 8);
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = Math.min(text.length, start + Math.max(length + 16, 24));
  while (end < text.length && !/\s/.test(text[end])) end++;
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (raw.length <= MAX_EXCERPT) return raw;
  const cut = raw.slice(0, MAX_EXCERPT - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > MAX_EXCERPT / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

// "France.12 Now" — a footnote number that came along with the sentence.
// Requires the digits to be followed by a space or a capital, so version
// numbers ("v1.2 release") and decimals don't fire.
const FOOTNOTE_RESIDUE = /\p{Ll}\.\d{1,3}(?=\s|\p{Lu})/gu;

const WEB_RESIDUE: { re: RegExp; reason: string }[] = [
  { re: /\[edit\]/gi, reason: 'Wikipedia section "[edit]" link text' },
  { re: /\[citation needed\]/gi, reason: 'Wikipedia "[citation needed]" marker' },
  { re: /Retrieved from/g, reason: 'Reference-list boilerplate ("Retrieved from")' },
  { re: /^\^ /gm, reason: 'Wikipedia reference back-link ("^ ")' },
];

// A comparison that answers itself. Three shapes, because a worksheet asks the
// question in the stem on one and leaves it implicit on another:
//
//   "Which of these is most like the printing press? The printing press ..."
//   "Drake Francis is most like Sir Francis Drake from Part 1."
//   "Explorer's name: Francis Drake" ... "most like Sir Francis Drake"
//
// The second and third only show up if word ORDER is ignored — a student who
// has flipped the name round is the signal, not a different answer — so names
// are compared as sets with titles dropped.
const COMPARISON_QUESTION = /which\b[^?\n]*?\bmost\s+(?:like|similar\s+to)\s+([^?\n]{3,60})\?/gi;
const MOST_LIKE = /\bmost\s+(?:like|similar\s+to)\b/gi;
// A labelled answer naming the thing the rest of the sheet is about.
const SUBJECT_FIELD = /\b(?:explorer|person|figure|inventor|leader)(?:['’]s)?\s+name\s*[:\-]\s*([^\n.;]{3,60})/gi;

const SELF_REFERENTIAL = 'Comparison answer names the same thing the question asked about';

// Dropped before comparing names: honorifics, the words a worksheet uses to
// point at its own parts, and anything too short to identify anybody.
const NAME_NOISE = new Set([
  'sir', 'prince', 'princess', 'king', 'queen', 'captain', 'lord', 'lady', 'saint', 'don',
  'mr', 'mrs', 'ms', 'dr', 'the', 'and', 'from', 'part', 'page', 'section', 'number',
  'explorer', 'person', 'figure', 'mine', 'yours', 'above', 'below', 'answer', 'question',
]);

/** A phrase reduced to the words that identify it, for a substring check. */
function normalizeEntity(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameWordSet(phrase: string): Set<string> {
  return new Set(
    phrase
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !NAME_NOISE.has(w) && !/^\d+$/.test(w)),
  );
}

function sameName(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

/** The clause a comparison is about, reading backwards from "most like". */
function subjectBefore(text: string, at: number): string {
  const window = text.slice(Math.max(0, at - 140), at);
  const clause = window.split(/[.?!\n]/).pop() ?? '';
  // Drop the copula that joins the subject to the comparison.
  return clause.replace(/\s+(?:is|are|was|were|seems?|feels?|looks?|would\s+be)\s*$/i, '').trim();
}

/** The phrase a comparison names, reading forwards from "most like". */
function answerAfter(text: string, at: number): string {
  const window = text.slice(at, at + 140);
  const clause = window.split(/[.?!\n;,]/)[0] ?? '';
  // "Sir Francis Drake from Part 1" — the trailing phrase points at the
  // worksheet, not at another person.
  return clause.replace(/\s+\b(?:from|in|on|at|during|because|since|due|as|who|which|that)\b[\s\S]*$/i, '').trim();
}

/**
 * Scan extracted text for signals worth a second look. Never a verdict: each
 * entry is a short excerpt and the reason it was flagged.
 */
export function findIntegritySignals(text: string): IntegritySignal[] {
  if (!text) return [];
  const signals: IntegritySignal[] = [];
  const seen = new Set<string>();
  const add = (excerpt: string, reason: string) => {
    const key = `${reason}\0${excerpt}`;
    if (seen.has(key) || signals.length >= MAX_SIGNALS) return;
    seen.add(key);
    signals.push({ excerpt, reason });
  };

  for (const m of text.matchAll(FOOTNOTE_RESIDUE)) {
    add(excerptAround(text, m.index ?? 0, m[0].length), 'Footnote number left in the sentence, as copied text carries');
  }
  for (const { re, reason } of WEB_RESIDUE) {
    for (const m of text.matchAll(re)) add(excerptAround(text, m.index ?? 0, m[0].length), reason);
  }
  // Shape 1: the stem names the thing, and the answer names it straight back.
  for (const m of text.matchAll(COMPARISON_QUESTION)) {
    const subject = normalizeEntity(m[1]);
    if (subject.length < 4) continue;
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 400);
    if (normalizeEntity(after).includes(subject)) {
      add(excerptAround(text, m.index ?? 0, m[0].length), SELF_REFERENTIAL);
    }
  }

  // Shapes 2 and 3: the subject is in the same sentence, or in a labelled
  // answer earlier on the sheet. Either way the names match as sets.
  const subjects = [...text.matchAll(SUBJECT_FIELD)].map(m => nameWordSet(m[1]));
  for (const m of text.matchAll(MOST_LIKE)) {
    const at = m.index ?? 0;
    const answer = nameWordSet(answerAfter(text, at + m[0].length));
    if (answer.size === 0) continue;
    const own = nameWordSet(subjectBefore(text, at));
    const matchesSubject = sameName(own, answer) || subjects.some(sub => sameName(sub, answer));
    if (matchesSubject) add(excerptAround(text, at, m[0].length), SELF_REFERENTIAL);
  }

  return signals;
}

export interface TemplateFingerprint {
  template_fingerprint: string;
  template_headers: string;
}

/**
 * Identify a worksheet version by its first table's header row, normalized to
 * lowercase with whitespace collapsed. Only documents that keep table markup
 * (HTML, and .docx converted to HTML) carry one; a PDF's text layer has no
 * table structure to read, so those get no fingerprint.
 */
/** Hash a normalized header string into the pair callers report. */
export function makeFingerprint(headers: string): TemplateFingerprint | undefined {
  const normalized = headers.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < 8) return undefined;
  return {
    template_fingerprint: createHash('sha1').update(normalized).digest('hex').slice(0, 8),
    template_headers: normalized,
  };
}

// A page's lines, normalized for comparison across pages.
function pageLines(page: string): string[] {
  return page
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

// A repeated block longer than this is page furniture, not a header row.
const MAX_REPEATED_BLOCK = 12;

/**
 * A PDF's text layer has no table markup, so the header row has to be inferred.
 * Google Docs — which is what these worksheets are exported from — repeats a
 * table's header row at the top of every page it spans, so the longest run of
 * consecutive lines that also appears on another page is that header. Per-page
 * furniture ("Page 2 of 3") differs page to page and so never qualifies.
 */
export function fingerprintFromRepeatedLines(pages: string[]): TemplateFingerprint | undefined {
  if (!pages || pages.length < 2) return undefined;
  const normalized = pages.map(pageLines);
  const elsewhere = new Set<string>();
  for (let i = 1; i < normalized.length; i++) for (const line of normalized[i]) elsewhere.add(line);

  let best: string[] = [];
  let run: string[] = [];
  for (const line of normalized[0]) {
    if (elsewhere.has(line)) {
      run.push(line);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  if (best.length === 0) return undefined;
  return makeFingerprint(best.slice(0, MAX_REPEATED_BLOCK).join(' | '));
}

export function fingerprintFromHtml(html: string): TemplateFingerprint | undefined {
  if (!html) return undefined;
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return undefined;
  const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(table[1]);
  if (!row) return undefined;
  const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
  if (cells.length === 0) return undefined;
  const headers = cells.join(' | ');
  return {
    template_fingerprint: createHash('sha1').update(headers).digest('hex').slice(0, 8),
    template_headers: headers,
  };
}

// Which template each student's work used, gathered as submissions are read.
// Fingerprinting every student up front would mean downloading every file,
// which is the cost this round of work is trying to remove — so the registry
// fills in as the grader goes, and says so.
const registry = new Map<string, Map<string, { headers: string; students: Set<string> }>>();

export function recordTemplateVariant(assignmentId: string, student: string, fp: TemplateFingerprint): void {
  let byAssignment = registry.get(String(assignmentId));
  if (!byAssignment) registry.set(String(assignmentId), (byAssignment = new Map()));
  let entry = byAssignment.get(fp.template_fingerprint);
  if (!entry) byAssignment.set(fp.template_fingerprint, (entry = { headers: fp.template_headers, students: new Set() }));
  entry.students.add(student);
}

export function templateVariants(assignmentId: string) {
  const byAssignment = registry.get(String(assignmentId));
  if (!byAssignment || byAssignment.size === 0) return undefined;
  return [...byAssignment.entries()].map(([fingerprint, entry]) => ({
    template_fingerprint: fingerprint,
    template_headers: entry.headers,
    students: [...entry.students],
  }));
}

export function clearTemplateVariants(): void {
  registry.clear();
  scanned.clear();
}

// One scan result per (assignment, student, attempt). A submission that has
// not been resubmitted cannot have changed template, so rescanning it would
// re-download every file for nothing.
const scanned = new Map<string, TemplateFingerprint | null>();

export function scanKey(assignmentId: string, userId: string, attempt: unknown): string {
  return `${assignmentId}:${userId}:${attempt ?? 0}`;
}

export function cachedScan(key: string): TemplateFingerprint | null | undefined {
  return scanned.get(key);
}

export function rememberScan(key: string, fp: TemplateFingerprint | null): void {
  scanned.set(key, fp);
}
