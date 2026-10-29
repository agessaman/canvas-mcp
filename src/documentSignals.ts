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
  const start = Math.max(0, index - 8);
  const raw = text.slice(start, start + Math.max(length + 16, 24)).replace(/\s+/g, ' ').trim();
  return raw.length > MAX_EXCERPT ? `${raw.slice(0, MAX_EXCERPT - 1)}…` : raw;
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

// "Which of these is most like the printing press?" followed by an answer that
// says "the printing press". A chatbot restating the subject as the answer.
const COMPARISON_QUESTION = /which\b[^?\n]*?\bmost\s+(?:like|similar\s+to)\s+([^?\n]{3,60})\?/gi;

function normalizeEntity(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  for (const m of text.matchAll(COMPARISON_QUESTION)) {
    const subject = normalizeEntity(m[1]);
    if (subject.length < 4) continue;
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 400);
    if (normalizeEntity(after).includes(subject)) {
      add(excerptAround(text, m.index ?? 0, m[0].length), 'Comparison answer names the same thing the question asked about');
    }
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
}
