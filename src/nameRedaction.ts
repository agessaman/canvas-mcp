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
}

// A name label owns the rest of its line, up to one of these.
const BOUNDARY_LABEL = /\b(?:period|date|class|hour)\b\s*[:\-]/i;
// "Name:", "Names:", "Student Name:", "Partner:" — at the start of a line or
// of a table cell. Cells arrive either on their own line or joined by "|".
const NAME_LABEL = /(^|[|\t]|\s{2,})[ \t]*((?:student[ \t]+)?names?|partners?)[ \t]*[:\-][ \t]*/gi;
// Pseudonyms already in the text (a prior pass, or Canvas's own anonymous ids).
const PSEUDONYM_TOKEN = /^student$/i;
// A lone initial next to a name, with or without its period.
const INITIAL = /^\p{L}[.)]?$/u;

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
export function buildRoster(users: any[]): RosterMember[] {
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
    members.push({
      userId: String(id),
      pseudonym: DataAnonymizer.pseudonymFor(id),
      tokens: [...tokens],
      fullNames: [...fullNames],
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
  namedPartners(): RosterMember[];
}

/** A redactor that leaves text exactly as it found it (anonymous: false). */
export function noopRedactor(): Redactor {
  return {
    redact: t => t,
    takeCounts: () => ({ nameLine: 0, body: 0, unmatched: 0 }),
    namedPartners: () => [],
  };
}

export function createRedactor(options: RedactorOptions): Redactor {
  const { roster, scrubFirstNamesInBody = false } = options;
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
  const partners = new Map<string, RosterMember>();
  let counts: RedactionCounts = { nameLine: 0, body: 0, unmatched: 0 };

  const record = (m: RosterMember) => {
    if (m.userId !== submitterId) partners.set(m.userId, m);
  };

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

      // A pseudonym already in the text: "Student 4".
      if (PSEUDONYM_TOKEN.test(here) && /^\d+$/.test(next)) {
        out.push(`Student ${next}`);
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
      // A name-like token that matches nobody. Blank it and say so.
      if (out[out.length - 1] !== '[name]') {
        out.push('[name]');
        counts.unmatched++;
        counts.nameLine++;
      }
      i++;
    }
    return out;
  }

  function redactNameValue(value: string): string {
    const stripped = value.replace(/_+/g, ' ');
    const pieces = stripped.split(/\s*(?:,|&|\+|;|\/|\band\b)\s*/i);
    const names: string[] = [];
    for (const piece of pieces) {
      for (const resolved of resolvePiece(piece)) {
        if (!names.includes(resolved) || resolved === '[name]') names.push(resolved);
      }
    }
    return names.join(', ');
  }

  function redactLine(line: string): string {
    NAME_LABEL.lastIndex = 0;
    let out = '';
    let idx = 0;
    let m: RegExpExecArray | null;
    while ((m = NAME_LABEL.exec(line)) !== null) {
      const labelStart = m.index;
      const valueStart = m.index + m[0].length;
      if (labelStart < idx) {
        NAME_LABEL.lastIndex = idx;
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
      idx = valueStart + value.length;
      NAME_LABEL.lastIndex = idx;
    }
    out += redactBody(line.slice(idx));
    return out;
  }

  return {
    redact(text: string): string {
      if (!text) return text;
      return text.split('\n').map(redactLine).join('\n');
    },
    takeCounts(): RedactionCounts {
      const taken = counts;
      counts = { nameLine: 0, body: 0, unmatched: 0 };
      return taken;
    },
    namedPartners(): RosterMember[] {
      return [...partners.values()];
    },
  };
}
