// Keeping student names out of anonymized submission text.
//
// The old scrubber only knew the submitting student's name as Canvas spells
// it, so a worksheet's "Names:" line kept leaking: a partner's first name, a
// lowercase name wedged against a run of underscores, a first name joined by
// "and". Two things fix that. The name line gets its own pass, because every
// token on it is a name by definition and anything unrecognised there can be
// blanked outright. And matching runs against the whole course roster, so a
// partner resolves to the same pseudonym they carry everywhere else.
//
// Body text is treated the opposite way: only full first+last matches are
// redacted, because course content is full of words that are also student
// names. A student called Henry must not erase "Prince Henry" from a history
// passage.
import { DataAnonymizer } from './anonymizer.js';

export interface RosterMember {
  userId: string;
  pseudonym: string;
  /** Lowercase single tokens: first, last, preferred and sortable parts. */
  tokens: string[];
  /** Lowercase "first last" variants, both orders. */
  fullNames: string[];
  /** Given and family name, for the "first name plus last initial" shape. */
  first?: string;
  last?: string;
  /** Section ids, so a fuzzy guess can be confined to the submitter's class. */
  sectionIds: string[];
}

export interface RedactionCounts {
  nameLine: number;
  body: number;
  unmatched: number;
}

export interface RedactorOptions {
  roster: RosterMember[];
  /** The submitting student, whose own name parts are scrubbed in body text too. */
  submitterId?: string | number;
  /** Redact bare first names from the roster in body text (default: false). */
  scrubFirstNamesInBody?: boolean;
  /**
   * Guess an informal partner name ("Jordan T", "casey") against the
   * submitter's own sections, where a first name is usually unique. Only
   * applied when exactly one classmate fits (default: true).
   */
  fuzzyPartners?: boolean;
}

export interface PartnerMatch {
  member: RosterMember;
  /** 'exact' from a roster name, 'fuzzy' from a unique first-name guess. */
  match: 'exact' | 'fuzzy';
}

/** Why a name on the name line was left as [name]. Names nobody. */
export interface UnresolvedPartner {
  /** Which token of the name line it was, counting from zero. */
  token_index: number;
  reason: 'no_candidates' | 'multiple_candidates' | 'other_section';
  /** How many students fitted. Zero for no_candidates. */
  candidates: number;
}

// A name label owns the rest of its line, up to one of these.
const BOUNDARY_LABEL = /\b(?:period|date|class|hour|block)\b\s*[:\-]/i;
// "Name:", "Names:", "Student Name:", "Partner:" at the start of a line or of
// a table cell. Cells arrive either on their own line or joined by "|".
const NAME_LABEL_ANCHORED = /(^|[|\t]|\s{2,})[ \t]*((?:student[ \t]+)?names?|partners?)[ \t]*[:\-][ \t]*/gi;
// The same label anywhere in the line. PDF text extractors reflow a worksheet
// header into one line — "17.1 Worksheet Title Names: Jordan T Period: 4" —
// so anchoring to the start of a line or cell found nothing on a PDF at all.
// Only used inside the name zone below, because "the names: Diaz, Cabral and
// Magellan" in a body paragraph must not be treated as a roster line.
const NAME_LABEL_ANYWHERE = /\b((?:student\s+)?names?|partners?)\s*:[ \t]*/gi;
// Where a name line can plausibly be: the top of the document. A worksheet
// puts its name line in the header, within a few hundred characters; prose
// that happens to say "the crew names: Diaz, Cabral and Magellan" is further
// down. Past this point a label must still be at the start of a line or a
// table cell to count, which is the shape a real "Partner:" row has anyway.
const NAME_ZONE_CHARS = 1500;

// Pseudonyms already in the text (a prior pass, or Canvas's own anonymous ids).
const PSEUDONYM_TOKEN = /^student$/i;
// "Student 12" as one token, where an extractor dropped the space.
const GLUED_PSEUDONYM = /^student(\d+)$/i;
// A lone initial next to a name, with or without its period.
const INITIAL = /^\p{L}[.)]?$/u;
// A value that is only underscores, dots or spaces: a blank to be filled in,
// which in a table means the names are in the next cell.
const EMPTY_VALUE = /^[\s_.\u2026|-]*$/;
// How far a name line may run on past its own line. A wrapped surname is a few
// characters; anything much longer is the document, not the name line.
const MAX_NAME_SPAN = 300;
// A heading that always ends the names and starts the worksheet proper.
const DIRECTIONS_HEADING = /^\s*directions?\b/i;

/** How far into the text a bare "Names:" is still read as a roster line. */
export function nameZoneEnd(_text: string): number {
  return NAME_ZONE_CHARS;
}

/**
 * A name reduced to bare letters: accents folded, hyphens and apostrophes
 * gone. "José-Luis O'Neil" and "jose luis oneil" are the same student, and a
 * worksheet is written by hand so only the loose form can be relied on.
 */
function loose(token: string): string {
  return token
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

/** Every loose spelling of one roster member's name, for the relaxed pass. */
function looseKeys(member: RosterMember): Set<string> {
  const keys = new Set<string>();
  for (const token of member.tokens) {
    const whole = loose(token);
    if (whole.length >= 2) keys.add(whole);
    // "José-Luis" is also written "Jose" or "Luis" on its own.
    for (const part of token.split(/[-'\u2019\s]+/)) {
      const piece = loose(part);
      if (piece.length >= 3) keys.add(piece);
    }
  }
  for (const full of member.fullNames) {
    const joined = loose(full);
    if (joined.length >= 4) keys.add(joined);
  }
  return keys;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lowercase, drop underscores and edge punctuation, keep internal ' and -. */
function clean(token: string): string {
  return token
    .replace(/_/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
}

/** Canvas spells sortable names "Last, First"; everything else is "First Last". */
function normalizeName(field: unknown): string | null {
  if (typeof field !== 'string' || !field.trim()) return null;
  const s = field.trim();
  return s.includes(',')
    ? s.split(',').map(p => p.trim()).filter(Boolean).reverse().join(' ')
    : s;
}

/**
 * Turn course enrollments into match material. Pass users with their real
 * names (listStudents with anonymous: false) — the pseudonym comes from the
 * shared anonymizer, so a partner reads as the same "Student 12" the queue
 * and the grading tools use for them.
 */
export function buildRoster(users: any[], courseId?: unknown): RosterMember[] {
  const members: RosterMember[] = [];
  for (const user of users ?? []) {
    const id = user?.id ?? user?.user_id;
    if (id === undefined || id === null) continue;
    const tokens = new Set<string>();
    const fullNames = new Set<string>();
    for (const field of [user.name, user.short_name, user.sortable_name, user.display_name]) {
      const normalized = normalizeName(field);
      if (!normalized) continue;
      const parts = normalized.split(/\s+/).map(clean).filter(p => p.length >= 2);
      for (const p of parts) tokens.add(p);
      if (parts.length >= 2) {
        fullNames.add(parts.join(' '));
        // Sortable order too, in case the document writes "Tate Jordan".
        fullNames.add([...parts].reverse().join(' '));
        // First + last only, for names carrying a middle name.
        if (parts.length > 2) {
          fullNames.add(`${parts[0]} ${parts[parts.length - 1]}`);
          fullNames.add(`${parts[parts.length - 1]} ${parts[0]}`);
        }
      }
    }
    if (tokens.size === 0) continue;
    // The legal name decides which part is given and which is family; a
    // preferred name contributes tokens but not that ordering.
    const primary = normalizeName(user.name) ?? normalizeName(user.sortable_name);
    const parts = primary ? primary.split(/\s+/).map(clean).filter(Boolean) : [];
    const sectionIds = [...new Set(
      (user.enrollments ?? [])
        .map((e: any) => e?.course_section_id)
        .filter((sid: any) => sid !== undefined && sid !== null)
        .map(String),
    )] as string[];
    members.push({
      userId: String(id),
      pseudonym: DataAnonymizer.pseudonymFor(id, courseId),
      tokens: [...tokens],
      fullNames: [...fullNames],
      ...(parts.length ? { first: parts[0], last: parts[parts.length - 1] } : {}),
      sectionIds,
    });
  }
  return members;
}

export interface Redactor {
  /** Redact one block of extracted text. */
  redact(text: string): string;
  /** Counts since the last call, then reset — one file's worth. */
  takeCounts(): RedactionCounts;
  /** Roster members named on a name line, excluding the submitter. */
  namedPartners(): PartnerMatch[];
  /** Anything the name-line pass wants the grader to know, drained per file. */
  takeNotes(): string[];
  /** Name-line tokens that could not be tied to a student, and why. */
  unresolvedPartners(): UnresolvedPartner[];
}

/** A redactor that leaves text exactly as it found it (anonymous: false). */
export function noopRedactor(): Redactor {
  return {
    redact: t => t,
    takeCounts: () => ({ nameLine: 0, body: 0, unmatched: 0 }),
    namedPartners: () => [],
    takeNotes: () => [],
    unresolvedPartners: () => [],
  };
}

export function createRedactor(options: RedactorOptions): Redactor {
  const { roster, scrubFirstNamesInBody = false, fuzzyPartners = true } = options;
  const submitterId = options.submitterId === undefined ? undefined : String(options.submitterId);

  const byToken = new Map<string, RosterMember | 'ambiguous'>();
  const byFullName = new Map<string, RosterMember | 'ambiguous'>();
  for (const m of roster) {
    for (const t of m.tokens) {
      const seen = byToken.get(t);
      byToken.set(t, seen && seen !== m ? 'ambiguous' : m);
    }
    for (const f of m.fullNames) {
      const seen = byFullName.get(f);
      byFullName.set(f, seen && seen !== m ? 'ambiguous' : m);
    }
  }

  const submitter = submitterId ? roster.find(m => m.userId === submitterId) : undefined;
  // The submitter is the one name on the sheet we are certain belongs there,
  // so it gets the loosest rules: accents folded, hyphens and apostrophes
  // optional, any part of any spelling of their name.
  const submitterKeys = submitter ? looseKeys(submitter) : new Set<string>();
  // A fuzzy guess is only safe inside the submitter's own sections, where a
  // first name is usually unique. Across a whole school it is not.
  const peers = submitter
    ? roster.filter(m => m.userId !== submitter.userId
      && m.sectionIds.some(sid => submitter.sectionIds.includes(sid)))
    : [];
  const partners = new Map<string, PartnerMatch>();
  const unresolved: UnresolvedPartner[] = [];
  const notes: string[] = [];
  // Position within the current name line, so a report can point at which
  // token failed without quoting it.
  let tokenIndex = 0;
  let counts: RedactionCounts = { nameLine: 0, body: 0, unmatched: 0 };

  const record = (m: RosterMember, match: 'exact' | 'fuzzy' = 'exact') => {
    if (m.userId === submitterId) return;
    // An exact match must never be downgraded by a later fuzzy one.
    const existing = partners.get(m.userId);
    if (!existing || (existing.match === 'fuzzy' && match === 'exact')) {
      partners.set(m.userId, { member: m, match });
    }
  };

  /** The submitter, written however they wrote it, over 1 to 3 tokens. */
  function matchSubmitter(tokens: string[], from: number): number {
    if (!submitter) return 0;
    for (let len = Math.min(3, tokens.length - from); len >= 1; len--) {
      const joined = loose(tokens.slice(from, from + len).join(''));
      if (joined.length >= 2 && submitterKeys.has(joined)) return len;
    }
    return 0;
  }

  /**
   * "Jordan T" or "casey": a first name, optionally a last initial. Answers
   * only when exactly one classmate fits — zero or several is not a match, and
   * the count is reported without naming anybody.
   */
  function matchPeer(tokens: string[], from: number): { member: RosterMember; length: number } | { candidates: number } | { otherSection: number } | null {
    const first = loose(tokens[from] ?? '');
    if (first.length < 3) return null;
    let fits = peers.filter(m => m.first && loose(m.first) === first);
    if (fits.length === 0) {
      // Known to the course but not to this class: a real student, and still
      // not a safe guess, so the distinction is reported rather than guessed at.
      const elsewhere = roster.filter(m => m.userId !== submitterId && m.first && loose(m.first) === first);
      return elsewhere.length ? { otherSection: elsewhere.length } : null;
    }
    let length = 1;
    const nextRaw = (tokens[from + 1] ?? '').replace(/_/g, '');
    if (fits.length > 1 && INITIAL.test(nextRaw)) {
      const initial = loose(nextRaw);
      const narrowed = fits.filter(m => m.last && loose(m.last).startsWith(initial));
      if (narrowed.length > 0) {
        fits = narrowed;
        length = 2;
      }
    } else if (INITIAL.test(nextRaw) && fits.length === 1) {
      const initial = loose(nextRaw);
      if (fits[0].last && loose(fits[0].last).startsWith(initial)) length = 2;
    }
    if (fits.length === 1) return { member: fits[0], length };
    return { candidates: fits.length };
  }

  // --- body text ---

  // Two passes, full names before single tokens: when two students share a
  // first name, a bare token must not eat the first word of the other's full
  // name and leave the surname standing.
  const fullNamePatterns: { re: RegExp; member: RosterMember }[] = [];
  const tokenPatterns: { re: RegExp; member: RosterMember }[] = [];
  for (const m of roster) {
    if (m.fullNames.length) {
      // A full name may be written with any separator a document feeds us.
      const terms = [...m.fullNames]
        .map(f => f.split(' ').map(escapeRegExp).join('[\\s_]+'))
        .sort((a, b) => b.length - a.length);
      // Letter lookarounds rather than \b, so "Tate_Jordan_essay.pdf" matches.
      fullNamePatterns.push({ re: new RegExp(`(?<!\\p{L})(?:${terms.join('|')})(?!\\p{L})`, 'giu'), member: m });
    }
    // The submitter keeps the old behaviour — single name parts go too, so
    // their first name alone doesn't survive in the body of their own work.
    // Every other student needs scrubFirstNamesInBody, because course content
    // is full of words that are also somebody's first name.
    const singles = (submitter && m.userId === submitter.userId) || scrubFirstNamesInBody
      ? m.tokens.filter(t => t.length >= 3)
      : [];
    if (singles.length) {
      const terms = singles.map(escapeRegExp).sort((a, b) => b.length - a.length);
      tokenPatterns.push({ re: new RegExp(`(?<!\\p{L})(?:${terms.join('|')})(?!\\p{L})`, 'giu'), member: m });
    }
  }

  function redactBody(text: string): string {
    if (!text) return text;
    let out = text;
    for (const { re, member } of [...fullNamePatterns, ...tokenPatterns]) {
      // Deliberately not recorded as a partner: only the name line says who
      // worked on this, and a body mention is as likely to be a citation.
      out = out.replace(re, () => {
        counts.body++;
        return member.pseudonym;
      });
    }
    return out;
  }

  // --- name lines ---

  /** Resolve one comma- or "and"-separated piece of a name line. */
  function resolvePiece(piece: string): string[] {
    const tokens = piece.trim().split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      const here = clean(tokens[i]);
      const next = clean(tokens[i + 1] ?? '');

      // A pseudonym already in the text: "Student 4", or "Student4" where an
      // extractor dropped the space. It is a name that is already accounted
      // for, so it counts as matched and never as unmatched.
      const glued = GLUED_PSEUDONYM.exec(here);
      if (glued) {
        out.push(`Student ${glued[1]}`);
        counts.nameLine++;
        i++;
        continue;
      }
      if (PSEUDONYM_TOKEN.test(here) && /^\d+$/.test(next)) {
        out.push(`Student ${next}`);
        counts.nameLine++;
        i += 2;
        continue;
      }
      // Two-token full name.
      if (here && next) {
        const pair = byFullName.get(`${here} ${next}`);
        if (pair && pair !== 'ambiguous') {
          out.push(pair.pseudonym);
          record(pair);
          counts.nameLine++;
          i += 2;
          continue;
        }
      }
      // Single token: a first name, a last name, or a preferred name.
      const one = here ? byToken.get(here) : undefined;
      if (one && one !== 'ambiguous') {
        out.push(one.pseudonym);
        record(one);
        counts.nameLine++;
        i++;
        // A trailing initial belongs to the name just matched.
        if (tokens[i] && INITIAL.test(tokens[i].replace(/_/g, ''))) i++;
        continue;
      }
      // Nothing left to identify: punctuation, a stray initial, a blank.
      if (!here || INITIAL.test(tokens[i].replace(/_/g, ''))) {
        i++;
        continue;
      }
      // The submitter, spelled their own way. Tried before anything else is
      // called unknown, because their name is the one certainly on this sheet.
      const own = matchSubmitter(tokens, i);
      if (own && submitter) {
        out.push(submitter.pseudonym);
        counts.nameLine++;
        i += own;
        continue;
      }
      // An informal partner name, resolved only if one classmate fits.
      const peer = fuzzyPartners ? matchPeer(tokens, i) : null;
      if (peer && 'member' in peer) {
        out.push(peer.member.pseudonym);
        record(peer.member, 'fuzzy');
        counts.nameLine++;
        i += peer.length;
        continue;
      }
      // Last resort before blanking: the full-name body scrubber, which knows
      // spellings the name-line tokeniser does not.
      const scrubbed = redactBody(tokens[i]);
      if (scrubbed !== tokens[i]) {
        out.push(scrubbed.trim());
        counts.nameLine++;
        i++;
        continue;
      }
      // A name-like token that matches nobody. Blank it and say so.
      if (out[out.length - 1] !== '[name]') {
        out.push('[name]');
        counts.unmatched++;
        counts.nameLine++;
        if (peer && 'candidates' in peer) {
          unresolved.push({ token_index: tokenIndex + i, reason: 'multiple_candidates', candidates: peer.candidates });
          notes.push(`A first name on the name line fits ${peer.candidates} students in this section; left as [name] rather than guessing.`);
        } else if (peer && 'otherSection' in peer) {
          unresolved.push({ token_index: tokenIndex + i, reason: 'other_section', candidates: peer.otherSection });
          notes.push(`A first name on the name line matches ${peer.otherSection} student(s) in other sections only; left as [name].`);
        } else {
          unresolved.push({ token_index: tokenIndex + i, reason: 'no_candidates', candidates: 0 });
        }
      }
      i++;
    }
    return out;
  }

  function redactNameValue(value: string): string {
    const stripped = value.replace(/_+/g, ' ');
    const pieces = stripped.split(/\s*(?:,|&|\+|;|\/|\band\b)\s*/i);
    const names: string[] = [];
    // Counted within this name line, so the index points somewhere a teacher
    // can actually look.
    tokenIndex = 0;
    for (const piece of pieces) {
      for (const resolved of resolvePiece(piece)) {
        if (!names.includes(resolved) || resolved === '[name]') names.push(resolved);
      }
      tokenIndex += piece.trim().split(/\s+/).filter(Boolean).length;
    }
    return names.join(', ');
  }

  /**
   * Redact one line. `inZone` widens label matching from "start of a line or
   * cell" to "anywhere", for the top of the document where a name line lives.
   * `wantsValue` is set when the label was there but its value was blank —
   * a table whose label and names are in neighbouring cells, which arrive as
   * separate lines. The caller then feeds the next line back as a value.
   */
  function redactLine(line: string, inZone: boolean): { text: string; openSpan: boolean } {
    const label = inZone ? NAME_LABEL_ANYWHERE : NAME_LABEL_ANCHORED;
    label.lastIndex = 0;
    let out = '';
    let idx = 0;
    let openSpan = false;
    let m: RegExpExecArray | null;
    while ((m = label.exec(line)) !== null) {
      const labelStart = m.index;
      const valueStart = m.index + m[0].length;
      if (labelStart < idx) {
        label.lastIndex = idx;
        continue;
      }
      out += redactBody(line.slice(idx, labelStart));
      out += line.slice(labelStart, valueStart);
      const rest = line.slice(valueStart);
      const boundary = BOUNDARY_LABEL.exec(rest);
      const value = boundary ? rest.slice(0, boundary.index) : rest;
      // Keep the whitespace and cell divider that ran up to the next label,
      // or "Name: Avery   Period: 3" collapses into "Name: Student 1Period: 3".
      const trail = /[\s|]*$/.exec(value)?.[0] ?? '';
      out += redactNameValue(value) + trail;
      // No stop label after the names on this line, so they may wrap onto the
      // next one — whether the value here is blank (a table cell) or not.
      openSpan = !boundary;
      idx = valueStart + value.length;
      label.lastIndex = idx;
    }
    out += redactBody(line.slice(idx));
    return { text: out, openSpan };
  }

/**
 * Whether the line after a name label is more of that name line.
 *
 * A PDF wraps: "Names: Jordan T, Casey Lee, Riley Park, Sam" then "ortega
 * ______" on the next line, and stopping at the break left the surname in the
 * output. So the span runs on — but it has to stop before it starts eating the
 * worksheet, because every token inside a name span that matches nobody is
 * blanked. A sentence is the signal that the names are over.
 */
function nameSpanVerdict(line: string): 'continue' | 'stop' | 'empty' {
  const trimmed = line.trim();
  if (!trimmed) return 'empty';
  if (BOUNDARY_LABEL.test(trimmed) || DIRECTIONS_HEADING.test(trimmed)) return 'stop';
  const words = trimmed.split(/\s+/).filter(w => /\p{L}/u.test(w));
  // Underscores, dots, a rule: part of the blank being filled in, not an end.
  if (words.length === 0) return 'empty';
  // Punctuated prose, or a run of words too long to be a list of names.
  if (/[.!?]$/.test(trimmed) && words.length >= 3) return 'stop';
  if (words.length > 8) return 'stop';
  return 'continue';
}

  /** A whole line read as the value of a label on the line before it. */
  function redactValueLine(line: string): string {
    const boundary = BOUNDARY_LABEL.exec(line);
    const value = boundary ? line.slice(0, boundary.index) : line;
    const tail = boundary ? line.slice(boundary.index) : '';
    const trail = /[\s|]*$/.exec(value)?.[0] ?? '';
    return redactNameValue(value) + trail + (tail ? redactBody(tail) : '');
  }

  return {
    redact(text: string): string {
      if (!text) return text;
      const lines = text.split('\n');
      const zoneEnd = nameZoneEnd(text);
      const out: string[] = [];
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // The first pass both detects an open span and redacts, so its counts
        // are rolled back if the line is redone as part of a longer span.
        const before = { ...counts };
        const first = redactLine(line, offset < zoneEnd);
        offset += line.length + 1;
        if (!first.openSpan) {
          out.push(first.text);
          continue;
        }
        // The names ran to the end of the line with no stop label. Pull in the
        // lines that are still part of them, then redact the whole span at
        // once so a surname split across the break is still one name.
        const extra: string[] = [];
        let blanks = 0;
        let spanChars = 0;
        let j = i + 1;
        for (; j < lines.length && spanChars < MAX_NAME_SPAN; j++) {
          const verdict = nameSpanVerdict(lines[j]);
          if (verdict === 'stop') break;
          if (verdict === 'empty') {
            // Two lines with nothing to read mean the name line is over.
            if (++blanks >= 2) break;
            extra.push(lines[j]);
            continue;
          }
          blanks = 0;
          extra.push(lines[j]);
          spanChars += lines[j].trim().length;
        }
        // Trim trailing blanks back out of the span; they belong to the body.
        while (extra.length && !extra[extra.length - 1].trim()) extra.pop();
        if (extra.length === 0) {
          out.push(first.text);
          continue;
        }
        counts = before;
        const joined = redactLine(`${line} ${extra.join(' ')}`, offset - line.length - 1 < zoneEnd);
        out.push(joined.text);
        // The consumed lines held names and fill-in rules, now accounted for
        // on the line above. Keeping them as blanks preserves the line count.
        for (let k = 0; k < extra.length; k++) {
          out.push('');
          offset += lines[i + 1 + k].length + 1;
        }
        i += extra.length;
      }
      return out.join('\n');
    },
    takeCounts(): RedactionCounts {
      const taken = counts;
      counts = { nameLine: 0, body: 0, unmatched: 0 };
      return taken;
    },
    namedPartners(): PartnerMatch[] {
      return [...partners.values()];
    },
    takeNotes(): string[] {
      const taken = [...new Set(notes)];
      notes.length = 0;
      return taken;
    },
    unresolvedPartners(): UnresolvedPartner[] {
      // A line that wraps is redacted twice — once to detect the open span,
      // once over the whole span — so the same token reports itself twice.
      // The first verdict for a position is the one that counts.
      const byToken = new Map<number, UnresolvedPartner>();
      for (const entry of unresolved) {
        if (!byToken.has(entry.token_index)) byToken.set(entry.token_index, entry);
      }
      return [...byToken.values()].sort((a, b) => a.token_index - b.token_index);
    },
  };
}
