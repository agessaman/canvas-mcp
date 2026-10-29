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
  /** The directions above the table, hashed separately. */
  directions_fingerprint?: string;
  /** How many characters went into that hash. Zero means nothing was found. */
  directions_chars?: number;
}

/**
 * Reduce header text to the thing that identifies the template, not the
 * format it arrived in. A PDF's header row comes back as "question evidence
 * analysis" and the same table in HTML as "question | evidence | analysis" —
 * the same worksheet, which must not split into two variants. Everything that
 * is not a letter or a digit goes.
 */
function hashable(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // Strictly [a-z0-9]. A bullet glyph does not survive a PDF export intact
    // — "\u25cf" came back as a caron — and anything left of it would put the
    // same template under two fingerprints depending on the file format.
    .replace(/[^a-z0-9]+/g, '');
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/**
 * Identify a worksheet version by its first table's header row, normalized to
 * lowercase with whitespace collapsed. Only documents that keep table markup
 * (HTML, and .docx converted to HTML) carry one; a PDF's text layer has no
 * table structure to read, so those get no fingerprint.
 */
/** Hash a normalized header string into the pair callers report. */
export function makeFingerprint(headers: string, directions?: { text: string; chars: number }): TemplateFingerprint | undefined {
  const readable = headers.replace(/\s+/g, ' ').trim().toLowerCase();
  const key = hashable(readable);
  if (key.length < 8) return undefined;
  const directionsKey = directions ? hashable(directions.text) : '';
  return {
    template_fingerprint: shortHash(key),
    template_headers: readable,
    // Teachers edit the directions without touching the table, and the rubric
    // can turn on that edit, so it is tracked as its own hash rather than
    // folded into the template's.
    // directions_chars says how much was actually hashed, so a region that
    // collapsed to nothing is visible rather than silently constant.
    ...(directions ? { directions_chars: directionsKey.length } : {}),
    ...(directionsKey.length >= 16 ? { directions_fingerprint: shortHash(directionsKey) } : {}),
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

// The name line, and the labels that sit beside it. The directions start
// after whichever of these comes last near the top of the sheet.
const HEADER_LABEL = /^.*\b(?:(?:student\s+)?names?|partners?|period|date|class|hour|block)\s*[:\-].*$/gim;
// Only the top of the document can hold the header; a "Date:" inside a
// student's answer must not push the directions region past the directions.
const HEADER_SEARCH_CHARS = 1200;

/**
 * The teacher's directions: everything between the name/period line and the
 * table header, normalized to letters and digits.
 *
 * It was previously anchored on a literal "Part 1", which most sheets do not
 * have, so it hashed either nothing or the whole document — every PDF came
 * back with the same fingerprint, which is the giveaway that it was hashing an
 * empty region. The region is now bounded by two things every worksheet has.
 * Student-entered text is below the table header, so none of it is included.
 */
export function directionsBlock(text: string, headerLine?: string): { text: string; chars: number } | undefined {
  if (!text) return undefined;
  let from = 0;
  HEADER_LABEL.lastIndex = 0;
  for (let m = HEADER_LABEL.exec(text); m; m = HEADER_LABEL.exec(text)) {
    if (m.index > HEADER_SEARCH_CHARS) break;
    from = m.index + m[0].length;
  }
  // Without a located table header there is no end to the directions, and
  // running to the end of the document would hash the student's own answers —
  // and, in a cross-check, treat their whole submission as worksheet text.
  let to = -1;
  const headerKey = headerLine ? hashable(headerLine) : '';
  if (headerKey.length >= 8) {
    // Matched as a whole LINE, not as a substring: "Answer every question in
    // complete sentences" contains the first header cell, and searching for
    // that cut the directions off in the middle of themselves. The header
    // repeats on every page of a PDF, so the first occurrence is the end.
    let cursor = from;
    for (const line of text.slice(from).split('\n')) {
      const key = hashable(line);
      if (key.length >= 8 && (key.startsWith(headerKey) || headerKey.startsWith(key))) {
        to = cursor;
        break;
      }
      cursor += line.length + 1;
    }
  }
  if (to < 0) return undefined;
  const block = text.slice(from, to);
  const chars = hashable(block).length;
  return chars > 0 ? { text: block, chars } : undefined;
}

export function fingerprintFromRepeatedLines(pages: string[], directions?: { text: string; chars: number }): TemplateFingerprint | undefined {
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
  return makeFingerprint(best.slice(0, MAX_REPEATED_BLOCK).join(' | '), directions);
}

export function fingerprintFromHtml(html: string, directions?: { text: string; chars: number }): TemplateFingerprint | undefined {
  if (!html) return undefined;
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return undefined;
  const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(table[1]);
  if (!row) return undefined;
  const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
  if (cells.length === 0) return undefined;
  return makeFingerprint(cells.join(' | '), directions);
}

// Which template each student's work used, gathered as submissions are read.
// Fingerprinting every student up front would mean downloading every file,
// which is the cost this round of work is trying to remove — so the registry
// fills in as the grader goes, and says so.
const registry = new Map<string, Map<string, { fingerprint: string; directions?: string; headers: string; students: Set<string> }>>();

// A variant is the pair: the same table under revised directions is a
// different thing to grade, and a teacher needs to see which students had it.
function variantKey(fp: TemplateFingerprint): string {
  return `${fp.template_fingerprint}/${fp.directions_fingerprint ?? '-'}`;
}

export function recordTemplateVariant(assignmentId: string, student: string, fp: TemplateFingerprint): void {
  let byAssignment = registry.get(String(assignmentId));
  if (!byAssignment) registry.set(String(assignmentId), (byAssignment = new Map()));
  const key = variantKey(fp);
  let entry = byAssignment.get(key);
  if (!entry) {
    byAssignment.set(key, (entry = {
      fingerprint: fp.template_fingerprint,
      directions: fp.directions_fingerprint,
      headers: fp.template_headers,
      students: new Set(),
    }));
  }
  entry.students.add(student);
}

export function templateVariants(assignmentId: string) {
  const byAssignment = registry.get(String(assignmentId));
  if (!byAssignment || byAssignment.size === 0) return undefined;
  return [...byAssignment.values()].map(entry => ({
    template_fingerprint: entry.fingerprint,
    ...(entry.directions ? { directions_fingerprint: entry.directions } : {}),
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

// --- Text shared between submissions ---

// Short sentences are shared by coincidence; long ones are not. Twelve words
// is long enough that two students writing it independently is implausible,
// and short enough to catch a single pasted line.
const MIN_SENTENCE_WORDS = 12;
// A sentence this common across the class came off the worksheet, not a source.
const TEMPLATE_SHARE = 0.5;

export const SHARED_TEXT_REASON =
  "Same sentence appears in another student's work (often a shared web source)";

export interface SubmissionText {
  student: string;
  text: string;
  /** Pseudonyms this student named as partners; shared text with them is expected. */
  partners: Set<string>;
  /** The directions region, so the worksheet's own words are not flagged. */
  directions?: string;
}

export interface SharedTextSignal {
  students: string[];
  excerpt: string;
  reason: string;
}

/** Sentences of at least MIN_SENTENCE_WORDS, as hash -> first excerpt seen. */
function sentenceHashes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!text) return found;
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length < MIN_SENTENCE_WORDS) continue;
    const key = hashable(sentence);
    if (key.length < 40) continue;
    if (!found.has(key)) {
      const flat = sentence.replace(/\s+/g, ' ');
      found.set(key, flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT - 1)}…` : flat);
    }
  }
  return found;
}

/**
 * Sentences that turn up in two students' work where neither named the other
 * as a partner.
 *
 * This is a prompt, never a finding: the usual explanation is that both
 * students used the same web page, which is not misconduct and may not even be
 * discouraged. Two things are excluded so it stays quiet — anything in the
 * worksheet's own directions, and anything more than half the class wrote,
 * which is the signature of text copied off the assignment itself.
 */
export function sharedTextSignals(submissions: SubmissionText[]): SharedTextSignal[] {
  if (submissions.length < 2) return [];
  const perStudent = submissions.map(s => ({
    student: s.student,
    partners: s.partners,
    sentences: sentenceHashes(s.text),
  }));
  const fromTemplate = new Set<string>();
  for (const s of submissions) {
    if (!s.directions) continue;
    for (const key of sentenceHashes(s.directions).keys()) fromTemplate.add(key);
  }

  const byHash = new Map<string, { students: string[]; excerpt: string }>();
  for (const entry of perStudent) {
    for (const [key, excerpt] of entry.sentences) {
      if (fromTemplate.has(key)) continue;
      const seen = byHash.get(key);
      if (seen) seen.students.push(entry.student);
      else byHash.set(key, { students: [entry.student], excerpt });
    }
  }

  const partnersOf = new Map(perStudent.map(e => [e.student, e.partners]));
  const signals: SharedTextSignal[] = [];
  for (const { students, excerpt } of byHash.values()) {
    if (students.length < 2) continue;
    // Off the worksheet, not off a source.
    if (students.length / submissions.length > TEMPLATE_SHARE) continue;
    for (let i = 0; i < students.length; i++) {
      for (let j = i + 1; j < students.length; j++) {
        const [a, b] = [students[i], students[j]];
        if (partnersOf.get(a)?.has(b) || partnersOf.get(b)?.has(a)) continue;
        signals.push({ students: [a, b], excerpt, reason: SHARED_TEXT_REASON });
      }
    }
  }
  return signals;
}
