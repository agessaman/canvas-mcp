// Shared grading logic: reading a student's work, describing an assignment's
// rubric with the IDs needed to score it, validating rubric scores before they
// reach Canvas, and the grading-queue rules.
import { CanvasClient } from './canvasClient.js';
import { DataAnonymizer } from './anonymizer.js';
import {
  ContentBlock,
  ExtractOptions,
  FileSummary,
  ImageBudget,
  extractFile,
  htmlToText,
} from './submissionContent.js';
import {
  Redactor,
  RosterMember,
  buildRoster,
  createRedactor,
  noopRedactor,
} from './nameRedaction.js';
import {
  SubmissionText,
  cachedScan,
  directionsBlock,
  recordTemplateVariant,
  rememberScan,
  scanKey,
  sharedTextSignals,
} from './documentSignals.js';
import { formatInZone, resolveCourseZone } from './courseTime.js';
import { ResolvedPreference } from './gradingPreferences.js';
import { SourceMatch, SourcePage, checkAgainstSources } from './sourceCheck.js';

// What each non-file submission type needs the grader to know
const EXTERNAL_TYPE_NOTES: Record<string, string> = {
  online_url: "The student submitted a link; its content was not fetched. Ask the teacher to open it or paste the work if it is needed for grading.",
  media_recording: "Audio/video recording; the media itself can't be read here.",
  basic_lti_launch: "Submitted through an external tool (LTI). The work lives in that tool and may not be visible here.",
  student_annotation: "Canvas student-annotation submission; annotations live in DocViewer and are not available through the API.",
  online_quiz: "Classic quiz submission; use get-quiz-submission-answers instead.",
};

export interface ReadSubmissionOptions extends ExtractOptions {
  attempt?: number | 'all';
  maxImages: number;
  maxFileMB: number;
  anonymous: boolean;
  /** Redact bare first names from the roster in body text (default: false). */
  scrubFirstNamesInBody?: boolean;
  /** Report students named on the worksheet's name line (default: true). */
  includePartners?: boolean;
  /** Compare a partner's file against this one (default: true). */
  comparePartnerFiles?: boolean;
  /** Guess informal partner names within the submitter's sections (default: true). */
  fuzzyPartners?: boolean;
  /** A roster built once by the caller, so a batch doesn't refetch it. */
  roster?: RosterMember[];
  /** Course time zone for the _local date fields. */
  timeZone?: string;
  /** Section id to name, so the header can say which class this student is in. */
  sections?: Map<string, string>;
}

// The roster is read once per course per process. It only moves when someone
// adds or drops, which doesn't happen inside a grading session, and refetching
// it for every student in a 30-student queue is 30 pointless round trips.
const rosterCache = new Map<string, Promise<RosterMember[]>>();

export async function getCourseRoster(canvas: CanvasClient, courseId: string): Promise<RosterMember[]> {
  let cached = rosterCache.get(courseId);
  if (!cached) {
    // Real names, deliberately: they are what the redactor has to find. They
    // stay inside this process — only pseudonyms reach the tool output.
    cached = canvas
      // include[]=enrollments carries course_section_id, which is what confines
      // a fuzzy first-name guess to the submitter's own class.
      .listStudents(courseId, { enrollment_type: ['student'], include: ['enrollments'], per_page: 100 }, { anonymous: false })
      .then((users: any) => buildRoster(users as any[], courseId))
      .catch(() => []);
    rosterCache.set(courseId, cached);
  }
  return cached;
}

export function clearRosterCache(): void {
  rosterCache.clear();
}

/** A content fingerprint cheap enough to compare two partners' uploads. */
interface FileFingerprint {
  bytes: number;
  chars: number;
  head: string;
  /** Letters and digits only, so a PDF and a DOCX of one document match. */
  normalized: string;
  words: string[];
}

const FINGERPRINT_HEAD = 500;
const SHINGLE = 5;
// Above this, two uploads are the same work in different wrappers.
const NEAR_IDENTICAL = 0.9;

function fingerprintOf(bytes: number, text: string): FileFingerprint {
  // Page markers are the extractor's furniture, not the student's words, and
  // a PDF carries them where a DOCX does not — comparing with them in says
  // two copies of one document are different work.
  const content = text.replace(/\[Page \d+\][^\n]*/g, ' ');
  return {
    bytes,
    chars: text.length,
    head: text.replace(/\s+/g, ' ').trim().slice(0, FINGERPRINT_HEAD),
    normalized: content.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    words: content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  };
}

function sameWork(a: FileFingerprint[], b: FileFingerprint[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((f, i) => f.chars === b[i].chars && f.head === b[i].head);
}

/** Runs of SHINGLE consecutive words, the unit similarity is measured in. */
function shinglesOf(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * How alike two sets of uploads are, ignoring the file format they arrived in.
 * The same worksheet submitted by one partner as a PDF and the other as a
 * DOCX is the same work, and comparing bytes or raw text said it was not.
 */
function textAgreement(a: FileFingerprint[], b: FileFingerprint[]): { same_text: boolean; text_similarity: number; near_identical: boolean } {
  const joinedA = a.map(f => f.normalized).join('');
  const joinedB = b.map(f => f.normalized).join('');
  const wordsA = a.flatMap(f => f.words);
  const wordsB = b.flatMap(f => f.words);
  const similarity = Number(jaccard(shinglesOf(wordsA), shinglesOf(wordsB)).toFixed(3));
  return {
    // Strict: the same words in the same order, nothing else.
    same_text: joinedA.length > 0 && joinedA === joinedB,
    text_similarity: similarity,
    // One document exported twice rarely matches to the character — a header
    // or a page number differs — so this is the flag worth reading.
    near_identical: similarity >= NEAR_IDENTICAL,
  };
}

/**
 * Fetch a student's submission and turn every selected attempt into
 * readable blocks. The first block is a JSON header describing the attempts,
 * files, comments and any warnings.
 */
export async function readSubmissionContent(
  canvas: CanvasClient,
  courseId: string,
  assignmentId: string,
  userId: string,
  options: ReadSubmissionOptions,
): Promise<ContentBlock[]> {
  const { attempt, maxImages, maxFileMB, anonymous } = options;
  const includePartners = options.includePartners !== false;
  const comparePartnerFiles = options.comparePartnerFiles !== false;
  const s = await canvas.getSubmissionWithHistory(courseId, assignmentId, userId);
  const alias = anonymous ? DataAnonymizer.pseudonymFor(s.user_id, courseId) : (s.user?.name ?? `User ${s.user_id}`);

  // The roster is what lets a partner's first name resolve to the pseudonym
  // they carry everywhere else, instead of being blanked or missed.
  let roster: RosterMember[] = [];
  if (anonymous || includePartners) {
    roster = options.roster ?? await getCourseRoster(canvas, courseId);
    if (s.user && !roster.some(m => m.userId === String(s.user_id))) {
      roster = [...roster, ...buildRoster([{ ...s.user, id: s.user_id }], courseId)];
    }
  }
  const redactor: Redactor = anonymous
    ? createRedactor({
      roster,
      submitterId: s.user_id,
      scrubFirstNamesInBody: options.scrubFirstNamesInBody,
      fuzzyPartners: options.fuzzyPartners,
    })
    : noopRedactor();
  const scrub = (t: string) => redactor.redact(t);

  const timeZone = options.timeZone ?? (await resolveCourseZone(canvas, courseId)).timeZone;
  const local = (iso: unknown) => formatInZone(iso, timeZone);

  const history: any[] = (s.submission_history?.length ? s.submission_history : [s])
    .filter((h: any) => h.submitted_at || h.attempt);
  let attempts: any[];
  if (attempt === 'all') {
    attempts = history;
  } else if (typeof attempt === 'number') {
    attempts = history.filter((h: any) => h.attempt === attempt);
    if (attempts.length === 0) {
      const available = history.map((h: any) => h.attempt).filter(Boolean).join(', ') || 'none';
      throw new Error(`Attempt ${attempt} not found (available attempts: ${available})`);
    }
  } else {
    attempts = history.length
      ? [history.reduce((a: any, b: any) => ((b.attempt ?? 0) > (a.attempt ?? 0) ? b : a))]
      : [];
  }

  const budget = new ImageBudget(maxImages);
  const blocks: ContentBlock[] = [];
  const attemptSummaries: any[] = [];
  let needsCanvas = false;
  // Redactions made outside any one file still count toward the warning.
  let looseUnmatched = 0;
  const drain = () => { looseUnmatched += redactor.takeCounts().unmatched; };
  // Latest attempt only: what a partner's upload is compared against.
  let ownFingerprints: FileFingerprint[] = [];

  for (const a of attempts) {
    const label = `Attempt ${a.attempt ?? '?'}`;
    const files: FileSummary[] = [];
    const notes: string[] = [];
    const fingerprints: FileFingerprint[] = [];

    if (a.body) {
      blocks.push({ type: 'text', text: `--- ${label} · text entry ---\n${scrub(htmlToText(a.body))}` });
      drain();
    }
    if (a.discussion_entries?.length) {
      const posts = a.discussion_entries
        .map((e: any) => `[${e.created_at ?? ''}] ${htmlToText(e.message ?? '')}`)
        .join('\n\n');
      blocks.push({ type: 'text', text: `--- ${label} · discussion posts ---\n${scrub(posts)}` });
      drain();
    }
    if (EXTERNAL_TYPE_NOTES[a.submission_type]) {
      notes.push(EXTERNAL_TYPE_NOTES[a.submission_type]);
    }
    if (a.url && a.submission_type !== 'online_upload') {
      notes.push(`Submitted URL: ${a.url}`);
    }
    if (a.media_comment?.url) {
      notes.push(`Media: ${a.media_comment.media_type ?? 'recording'} at ${a.media_comment.url}`);
    }

    for (const att of a.attachments ?? []) {
      const filename = scrub(att.display_name || att.filename || `file_${att.id}`);
      if (att.size && att.size > maxFileMB * 1024 * 1024) {
        const skipped: FileSummary = { filename, kind: 'skipped', status: 'unsupported', note: `File is ${(att.size / 1048576).toFixed(1)} MB, over maxFileMB.` };
        const counts = redactor.takeCounts();
        if (anonymous) skipped.redactions = counts;
        files.push(skipped);
        continue;
      }
      try {
        const { data, contentType } = await canvas.downloadUrl(att.url);
        const { summary, blocks: fileBlocks } = await extractFile(
          data, filename, att['content-type'] || att.content_type || contentType, options, budget
        );
        if (summary.needs_canvas) needsCanvas = true;
        const rawText = fileBlocks.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
        fingerprints.push(fingerprintOf(data.length, rawText));
        if (summary.template_fingerprint) {
          // The header row is document text like any other: on a worksheet
          // whose first table row is the name row, it carries names.
          summary.template_headers = scrub(summary.template_headers ?? '');
          const fp = {
            template_fingerprint: summary.template_fingerprint,
            template_headers: summary.template_headers,
            ...(summary.directions_fingerprint ? { directions_fingerprint: summary.directions_fingerprint } : {}),
          };
          recordTemplateVariant(String(s.assignment_id ?? assignmentId), alias, fp);
          // This file is already downloaded and fingerprinted; a later
          // scanTemplates pass must not fetch it a second time.
          rememberScan(scanKey(String(s.assignment_id ?? assignmentId), String(s.user_id), a.attempt), fp);
        }
        if (fileBlocks.length) {
          blocks.push({ type: 'text', text: `--- ${label} · ${filename} (${summary.kind}${summary.pages ? `, ${summary.pages} pages` : ''}) ---` });
          for (const b of fileBlocks) {
            blocks.push(b.type === 'text' ? { type: 'text', text: scrub(b.text) } : b);
          }
        }
        // An excerpt can quote a name line, so it is redacted like any other text.
        if (summary.integrity_signals) {
          summary.integrity_signals = summary.integrity_signals.map(sig => ({ ...sig, excerpt: scrub(sig.excerpt) }));
        }
        const counts = redactor.takeCounts();
        const fileNotes = redactor.takeNotes();
        if (anonymous) summary.redactions = counts;
        if (fileNotes.length) summary.name_line_notes = fileNotes;
        files.push(summary);
      } catch (e: any) {
        drain();
        files.push({ filename, kind: 'unknown', status: 'error', note: `Download failed: ${e?.message ?? e}` });
      }
    }
    if (a === attempts[attempts.length - 1]) ownFingerprints = fingerprints;

    attemptSummaries.push({
      attempt: a.attempt,
      submitted_at: a.submitted_at,
      ...(local(a.submitted_at) ? { submitted_at_local: local(a.submitted_at) } : {}),
      submission_type: a.submission_type,
      late: a.late || false,
      ...(a.body ? { has_text_entry: true } : {}),
      ...(files.length ? { files } : {}),
      ...(notes.length ? { notes } : {}),
    });
  }

  const comments = (s.submission_comments ?? []).map((c: any) => ({
    author: c.author_id === s.user_id ? alias : (c.author_name ?? c.author?.display_name),
    attempt: c.attempt,
    created_at: c.created_at,
    comment: scrub(c.comment ?? ''),
  }));
  drain();

  // Which class this student is in. It decides how shared work is read, and
  // the period written on the sheet was blank or abbreviated too often to use.
  const sectionNames = options.sections ?? (includePartners ? await getSectionNames(canvas, courseId) : undefined);
  const ownSections = sectionNames ? sectionsFor(roster.find(m => m.userId === String(s.user_id)), sectionNames) : [];

  // --- partners ---
  const namedPartners = includePartners ? redactor.namedPartners() : [];
  const partners: any[] = [];
  for (const { member, match } of namedPartners) {
    try {
      const theirs: any = await canvas.getSubmission(courseId, assignmentId, member.userId, { include: ['user'] });
      const theirSections = sectionNames ? sectionsFor(member, sectionNames) : [];
      const entry: any = {
        ...(anonymous ? { student: member.pseudonym } : { student: theirs?.user?.name }),
        user_id: Number(member.userId) || member.userId,
        // 'fuzzy' means a first name was resolved against the submitter's own
        // section because exactly one classmate fitted. Worth a teacher's eye.
        match,
        submitted: !!theirs?.submitted_at,
        workflow_state: theirs?.workflow_state,
        ...(theirSections.length ? { sections: theirSections } : {}),
        ...(theirSections.length && ownSections.length
          ? { same_section: theirSections.some(x => ownSections.includes(x)) }
          : {}),
        ...(theirs?.submitted_at ? { submitted_at: theirs.submitted_at } : {}),
        ...(theirs?.submitted_at && attempts[attempts.length - 1]?.submitted_at
          ? {
            submitted_first: String(theirs.submitted_at) < String(attempts[attempts.length - 1].submitted_at)
              ? (anonymous ? member.pseudonym : theirs?.user?.name)
              : alias,
          }
          : {}),
      };
      const agreement = comparePartnerFiles
        ? await comparePartnerWork(canvas, theirs, ownFingerprints, maxFileMB, options)
        : undefined;
      if (agreement) {
        entry.same_file_hash = agreement.same;
        // Identical work in two formats: different bytes, same words.
        entry.same_text = agreement.same_text;
        entry.text_similarity = agreement.text_similarity;
        entry.near_identical = agreement.near_identical;
      }
      partners.push(entry);
    } catch {
      partners.push({
        ...(anonymous ? { student: member.pseudonym } : {}),
        user_id: Number(member.userId) || member.userId,
        match,
        note: "This student's submission could not be read.",
      });
    }
  }

  const totals = attemptSummaries
    .flatMap((a: any) => a.files ?? [])
    .reduce((acc: any, f: any) => {
      if (!f.redactions) return acc;
      acc.unmatched += f.redactions.unmatched;
      return acc;
    }, { unmatched: looseUnmatched });

  const warnings: string[] = [];
  if (attempts.length === 0) warnings.push('The student has not submitted anything for this assignment.');
  if (anonymous) warnings.push('Name scrubbing in document text is best effort; names in images, nicknames or misspellings are not removed.');
  if (totals.unmatched > 0) {
    warnings.push(`${totals.unmatched} name-like token(s) on a name line matched nobody in the course and were replaced with [name]. Check whether a partner is enrolled in another section, or wrote a nickname.`);
  }
  if (includePartners && partners.length === 0 && redactor.unresolvedPartners().length === 0) {
    // Not a finding, and it was read as one: a sheet with an empty name line
    // was reported to the teacher as "no partner listed" for student after
    // student. Canvas knows who submitted; the blank says nothing.
    warnings.push('No classmate is named on this work. That is the ordinary case for individual work and says nothing on its own — Canvas already records who submitted.');
  }
  if (needsCanvas) warnings.push("@napi-rs/canvas is not installed: this submission has scanned pages or photos that could not be rendered. Run `npm install @napi-rs/canvas`.");

  const header = {
    student: alias,
    user_id: s.user_id,
    ...(ownSections.length ? { sections: ownSections } : {}),
    assignment_id: s.assignment_id,
    workflow_state: s.workflow_state,
    score: s.score,
    grade: s.grade,
    late: s.late || false,
    missing: s.missing || false,
    excused: s.excused || false,
    total_attempts: s.attempt,
    attempts: attemptSummaries,
    ...(partners.length ? { partners } : {}),
    ...(includePartners && redactor.unresolvedPartners().length
      ? { partner_unresolved: redactor.unresolvedPartners() }
      : {}),
    ...(comments.length ? { comments } : {}),
    ...(warnings.length ? { warnings } : {}),
  };

  return [{ type: 'text', text: JSON.stringify(header) }, ...blocks];
}

/**
 * Did the partner upload the same work? Canvas exposes no content hash, so
 * this compares extracted text: length plus the first 500 characters. Sizes
 * that differ settle it without downloading anything, which is the common case.
 * Returns undefined when there is nothing to compare.
 */
async function comparePartnerWork(
  canvas: CanvasClient,
  theirSubmission: any,
  ownFingerprints: FileFingerprint[],
  maxFileMB: number,
  opts: ExtractOptions,
): Promise<{ same: boolean; same_text: boolean; text_similarity: number; near_identical: boolean } | undefined> {
  const attachments: any[] = theirSubmission?.attachments ?? [];
  if (attachments.length === 0 || ownFingerprints.length === 0) return undefined;
  // Byte equality used to end it here, but a partner who exported the same
  // work to a different format has different bytes and the same text, so the
  // files are read either way.
  const theirs: FileFingerprint[] = [];
  for (const att of attachments) {
    if (att.size && att.size > maxFileMB * 1024 * 1024) return undefined;
    try {
      const { data, contentType } = await canvas.downloadUrl(att.url);
      const { blocks } = await extractFile(
        data, att.display_name || att.filename || 'file',
        att['content-type'] || att.content_type || contentType,
        { ...opts, templateFingerprint: false, integritySignals: false },
        new ImageBudget(0),
      );
      theirs.push(fingerprintOf(data.length, blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('\n')));
    } catch {
      return undefined;
    }
  }
  return { same: sameWork(ownFingerprints, theirs), ...textAgreement(ownFingerprints, theirs) };
}

export interface StudentSourceMatches {
  student: string;
  sections?: string[];
  longest_match: number;
  matched_share: number;
  student_words: number;
  matches: SourceMatch[];
}

/**
 * Fingerprint the worksheet version each queued student used.
 *
 * This downloads a file per student, which is the cost the rest of this round
 * of work exists to avoid — so it is opt-in, capped by the queue the caller
 * already asked for, and cached per attempt. Only the first attachment is
 * read: a worksheet's version is decided by the document, and a second file is
 * nearly always a photo appended to it.
 */
export async function scanTemplateVariants(
  canvas: CanvasClient,
  courseId: string,
  assignmentId: string,
  queue: { user_id: any; attempt?: any; submitted_at?: any }[],
  options: {
    anonymous: boolean;
    maxFileMB: number;
    roster?: RosterMember[];
    crossCheck?: boolean;
    /** Section id to name, so a match can say whether the two share a class. */
    sections?: Map<string, string>;
    /** Pages to compare each student's work against, already fetched. */
    sources?: SourcePage[];
    minMatchWords?: number;
  },
): Promise<{
  scanned: number;
  skipped: number;
  shared_text?: ReturnType<typeof sharedTextSignals>;
  source_matches?: StudentSourceMatches[];
}> {
  let count = 0;
  let skipped = 0;
  // Only gathered when crossCheck is on; the downloads are the scan's anyway.
  const texts: SubmissionText[] = [];
  // A header row is document text: on a worksheet whose first table row is the
  // name row, it carries names, and these go straight into the packet.
  const wantsSources = !!options.sources?.length;
  const sourceHits: StudentSourceMatches[] = [];
  // The roster is needed for sections even when names are not being redacted.
  const roster = (options.anonymous || options.sections) ? (options.roster ?? await getCourseRoster(canvas, courseId)) : [];
  const rosterById = new Map(roster.map(m => [m.userId, m]));
  const headerRedactor = options.anonymous ? createRedactor({ roster }) : noopRedactor();
  const clean = (fp: { template_fingerprint: string; template_headers: string; directions_fingerprint?: string }) => ({
    ...fp,
    template_headers: headerRedactor.redact(fp.template_headers),
  });
  for (const entry of queue) {
    const userId = String(entry.user_id);
    const alias = options.anonymous ? DataAnonymizer.pseudonymFor(entry.user_id, courseId) : userId;
    const key = scanKey(String(assignmentId), userId, entry.attempt);
    // The cache holds a fingerprint, not the text, so a cross-check has to
    // read the file even where the template is already known.
    const already = options.crossCheck ? undefined : cachedScan(key);
    if (already !== undefined) {
      if (already) recordTemplateVariant(String(assignmentId), alias, clean(already));
      else skipped++;
      continue;
    }
    try {
      const submission: any = await canvas.getSubmission(courseId, assignmentId, userId, { include: ['submission_history'] });
      const attachment = (submission?.attachments ?? [])[0];
      if (!attachment || (attachment.size && attachment.size > options.maxFileMB * 1024 * 1024)) {
        rememberScan(key, null);
        skipped++;
        continue;
      }
      const { data, contentType } = await canvas.downloadUrl(attachment.url);
      const { summary, blocks } = await extractFile(
        data,
        attachment.display_name || attachment.filename || 'file',
        attachment['content-type'] || attachment.content_type || contentType,
        { maxCharsPerFile: 20000, renderPdfPages: 'never', maxPdfPagesToRender: 0, ocr: false, integritySignals: false },
        new ImageBudget(0),
      );
      if (options.crossCheck || wantsSources) {
        // Redacted first: an excerpt from this text can reach the packet, and
        // the same pass is what says who this student named as a partner.
        const raw = blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
        const reader = options.anonymous
          ? createRedactor({ roster, submitterId: userId })
          : noopRedactor();
        const redacted = reader.redact(raw);
        const directions = directionsBlock(redacted, summary.template_headers)?.text;
        const sections = options.sections ? sectionsFor(rosterById.get(userId), options.sections) : [];
        if (options.crossCheck) {
          texts.push({
            student: alias,
            text: redacted,
            partners: new Set(reader.namedPartners().map(p => p.member.pseudonym)),
            directions,
            ...(sections.length ? { sections } : {}),
            ...(entry.submitted_at ? { submitted_at: String(entry.submitted_at) } : {}),
          });
        }
        if (wantsSources) {
          // The worksheet's own words are not this student's to answer for:
          // without excluding them, every student matches every page that
          // discusses the subject and the check says nothing.
          const result = checkAgainstSources(redacted, options.sources!, {
            minMatchWords: options.minMatchWords,
            exclude: [directions ?? '', summary.template_headers ?? ''].filter(Boolean),
          });
          if (result.matches.length) {
            sourceHits.push({
              student: alias,
              ...(sections.length ? { sections } : {}),
              longest_match: result.longest_match,
              matched_share: result.matched_share,
              student_words: result.student_words,
              matches: result.matches,
            });
          }
        }
      }
      const fp = summary.template_fingerprint
        ? {
          template_fingerprint: summary.template_fingerprint,
          template_headers: summary.template_headers ?? '',
          ...(summary.directions_fingerprint ? { directions_fingerprint: summary.directions_fingerprint } : {}),
        }
        : null;
      rememberScan(key, fp);
      if (fp) {
        recordTemplateVariant(String(assignmentId), alias, clean(fp));
        count++;
      } else {
        skipped++;
      }
    } catch {
      rememberScan(key, null);
      skipped++;
    }
  }
  const shared = options.crossCheck ? sharedTextSignals(texts) : undefined;
  // Worst first: a teacher reading three of these wants the worst three.
  sourceHits.sort((a, b) => b.longest_match - a.longest_match);
  return {
    scanned: count,
    skipped,
    ...(shared && shared.length ? { shared_text: shared } : {}),
    ...(sourceHits.length ? { source_matches: sourceHits } : {}),
  };
}

// --- Rubrics ---

export interface RubricScoreInput {
  criterionId: string;
  ratingId?: string;
  points?: number;
  comments?: string;
}

/** The assignment's rubric in the shape a grader needs: IDs, points, ratings. */
export function describeRubric(assignment: any) {
  if (!Array.isArray(assignment?.rubric) || assignment.rubric.length === 0) return null;
  const settings = assignment.rubric_settings ?? {};
  return {
    title: settings.title,
    points_possible: settings.points_possible,
    use_rubric_for_grading: !!assignment.use_rubric_for_grading,
    free_form_comments: !!settings.free_form_criterion_comments,
    criteria: assignment.rubric.map((c: any) => ({
      criterionId: c.id,
      description: c.description,
      ...(c.long_description ? { longDescription: c.long_description } : {}),
      points: c.points,
      ...(c.criterion_use_range ? { useRange: true } : {}),
      ...(c.ignore_for_scoring ? { ignoreForScoring: true } : {}),
      ratings: (c.ratings ?? []).map((r: any) => ({
        ratingId: r.id,
        description: r.description,
        ...(r.long_description ? { longDescription: r.long_description } : {}),
        points: r.points,
      })),
    })),
  };
}

/**
 * Check rubric scores against the assignment's rubric and convert them to
 * the rubric_assessment object Canvas expects. Throws with every problem
 * listed, so nothing half-valid is written.
 */
export function buildRubricAssessment(assignment: any, scores: RubricScoreInput[]) {
  const criteria: any[] = assignment?.rubric ?? [];
  if (criteria.length === 0) {
    throw new Error('This assignment has no rubric attached; grade with score or posted_grade instead.');
  }
  const byId = new Map(criteria.map(c => [String(c.id), c]));
  const errors: string[] = [];
  const assessment: Record<string, any> = {};
  let total = 0;

  for (const s of scores) {
    const c = byId.get(String(s.criterionId));
    if (!c) {
      errors.push(`Unknown criterionId "${s.criterionId}" (valid: ${[...byId.keys()].join(', ')})`);
      continue;
    }
    if (assessment[c.id]) {
      errors.push(`Criterion "${c.description}" is scored more than once.`);
      continue;
    }
    const ratings: any[] = c.ratings ?? [];
    let rating = s.ratingId ? ratings.find(r => String(r.id) === String(s.ratingId)) : undefined;
    if (s.ratingId && !rating) {
      errors.push(`Unknown ratingId "${s.ratingId}" for "${c.description}" (valid: ${ratings.map(r => `${r.id}=${r.points}pts`).join(', ')})`);
      continue;
    }
    let points = s.points ?? rating?.points;
    if (points === undefined) {
      errors.push(`"${c.description}" needs a ratingId or points.`);
      continue;
    }
    if (points < 0 || points > c.points) {
      errors.push(`${points} points is outside 0–${c.points} for "${c.description}".`);
      continue;
    }
    if (rating && s.points !== undefined && s.points !== rating.points && !c.criterion_use_range) {
      errors.push(`${s.points} points doesn't match rating "${rating.description}" (${rating.points} pts) for "${c.description}"; omit points or pick the matching rating.`);
      continue;
    }
    if (!rating && ratings.length) {
      // Range criteria: a rating covers (next lower rating, its points]
      const sorted = [...ratings].sort((a, b) => b.points - a.points);
      rating = c.criterion_use_range
        ? sorted.find((r, i) => points! <= r.points && points! > (sorted[i + 1]?.points ?? -1))
        : sorted.find(r => r.points === points);
    }
    assessment[c.id] = {
      points,
      ...(rating ? { rating_id: rating.id } : {}),
      ...(s.comments ? { comments: s.comments } : {}),
    };
    if (!c.ignore_for_scoring) total += points;
  }
  if (errors.length) throw new Error(`Rubric scores rejected:\n- ${errors.join('\n- ')}`);

  const unscored = criteria.filter(c => !assessment[c.id]).map(c => c.description);
  return { assessment, total, unscored };
}

// --- Grading queue ---

export function needsGrading(s: any): boolean {
  if (!s?.submitted_at || s.excused) return false;
  return s.workflow_state === 'submitted'
    || s.workflow_state === 'pending_review'
    || s.grade_matches_current_submission === false;
}

// --- Grading standards (letter grades) ---

// Canvas's built-in scheme, used when the course and assignment name none.
const DEFAULT_GRADING_SCHEME: [string, number][] = [
  ['A', 0.94], ['A-', 0.90], ['B+', 0.87], ['B', 0.84], ['B-', 0.80],
  ['C+', 0.77], ['C', 0.74], ['C-', 0.70], ['D+', 0.67], ['D', 0.64], ['D-', 0.61], ['F', 0.0],
];

export interface GradingScheme {
  id?: string | number;
  name: string;
  source: 'assignment' | 'course' | 'default';
  entries: [string, number][];
  /** Why the default was reached, when it was. */
  tried?: string[];
}

function normalizeScheme(data: any[]): [string, number][] {
  return (data ?? [])
    .map((e: any) => [String(e.name ?? e.letter_grade ?? ''), Number(e.value ?? e.calculated_score ?? 0)] as [string, number])
    .filter(([name]) => name)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * The scheme a letter grade should be read from: the assignment's own standard,
 * then the course's, then Canvas's default. A missing or unreadable standard is
 * not an error — the default is what Canvas itself would fall back to.
 */
export async function resolveGradingScheme(
  canvas: CanvasClient,
  courseId: string,
  assignment: any,
): Promise<GradingScheme> {
  const attempts: { id: any; source: 'assignment' | 'course' }[] = [];
  if (assignment?.grading_standard_id) attempts.push({ id: assignment.grading_standard_id, source: 'assignment' });
  let course: any = null;
  try {
    course = await canvas.getCourse(courseId);
  } catch {
    // Unreadable course: the default scheme still gives a usable preview.
  }
  if (course?.grading_standard_id) attempts.push({ id: course.grading_standard_id, source: 'course' });

  const accountId = course?.account_id === undefined || course?.account_id === null
    ? undefined
    : String(course.account_id);

  const tried: string[] = [];
  for (const { id, source } of attempts) {
    try {
      const standard: any = await canvas.getGradingStandard(courseId, String(id), accountId);
      const entries = normalizeScheme(standard?.grading_scheme);
      if (entries.length) {
        return { id: standard?.id ?? id, name: standard?.title ?? `standard ${id}`, source, entries };
      }
      tried.push(`${source} standard ${id} had no scheme`);
    } catch (e: any) {
      tried.push(`${source} standard ${id} could not be read (${e?.message ?? e})`);
    }
  }
  if (attempts.length === 0) {
    tried.push('neither the assignment nor the course names a grading standard');
  }
  // Canvas's own fallback, and worth saying so: it is not the school's scheme,
  // and the cutoffs differ by a point in places.
  return { name: 'Canvas default scheme', source: 'default', entries: DEFAULT_GRADING_SCHEME, tried };
}

/** The letter a percentage earns under a scheme. */
export function letterFor(percentage: number, scheme: GradingScheme): string | undefined {
  if (!Number.isFinite(percentage)) return undefined;
  for (const [name, cutoff] of scheme.entries) {
    if (percentage >= cutoff) return name;
  }
  return scheme.entries[scheme.entries.length - 1]?.[0];
}

// The rules every grader on this server follows, whoever the teacher is.
//
// Deliberately practice-free: nothing here says how long a comment should be,
// what copied work is worth, or where the line between a shared phrase and
// copying falls. Those are the teacher's to set, and they arrive from the
// preferences store — recorded if they have been asked, listed as open
// questions if they have not. Baking one teacher's answers in here would hand
// them to every other teacher silently, which is the one failure mode a
// grading assistant cannot recover from.
const GRADING_RULES = `GRADING INSTRUCTIONS (follow these for every student in this assignment)

1. Missing materials. Before grading, check whether the assignment or the students' work depends on materials that are not included here: a paper copy of primary sources, a handout, a reading, textbook pages, a video, a lab or a class discussion. If it looks like something is missing, stop and ask the teacher to provide or describe it. Don't guess what it said.

2. Resubmission policy. Ask the teacher ONCE for this assignment whether resubmissions will be accepted, and under what conditions, unless they have already answered in this conversation. Canvas's allowed_attempts is only a hint. The policy can apply to only some students and can end at a date; when it does, give that date in the course time zone, using lock_at_local unless the teacher says otherwise.

3. Nothing reaches a student without approval. Draft scores and feedback for the teacher first. Never write a score, a grade, a submission comment or a rubric criterion comment until the teacher has seen the exact text and approved it.

4. Evidence. Base every rubric score on the student's work: quote or point to the passage, page or answer that justifies it. If the work can't be fully read (unreadable files, links, recordings, handwriting the OCR got wrong), say so rather than scoring what you can't see.

5. Visibility. If post_manually is false, grades and comments become visible to students as soon as they are written. Say so before writing the first grade.

6. Integrity signals are not findings. integrity_signals, shared text between students and source matches are excerpts worth a second look — a footnote number left in a sentence, wiki page furniture, a run of words that also appears on a linked page. They are prompts for the teacher, never evidence of copying and never grounds for a lower score on their own. Report what the excerpt is and leave the judgement to the teacher.

7. The assignment's own terms come first. If the description tells students what happens when they copy, or how late work is handled, say so while the plan is being made, and flag any grading decision that departs from what the students were told.

8. Grade the way THIS teacher grades. The practices below are what they have told this server so far. Apply the recorded ones without re-asking. For anything listed as not yet answered, ask when it first matters — one short question at the point of decision, with the examples as options to pick from or talk past — and then record the answer with set-grading-preferences so the next session does not ask again. Never invent an answer, and never carry one teacher's habit to another assignment's teacher.`;

/** The instructions block, with this teacher's recorded practices appended. */
export function gradingInstructions(preferences: ResolvedPreference[]): string {
  const answered = preferences.filter(p => p.answer !== undefined);
  const open = preferences.filter(p => p.answer === undefined);
  const parts = [GRADING_RULES, '', "--- This teacher's grading practices ---"];
  if (answered.length) {
    parts.push('On record (apply these; do not ask again unless the teacher reopens one):');
    for (const p of answered) {
      parts.push(`- ${p.key}${p.scope === 'course' ? ' (this course)' : ''}: ${p.answer}`);
    }
  } else {
    parts.push('Nothing on record yet. Everything below is still open.');
  }
  if (open.length) {
    parts.push('', 'Not yet answered — ask when each first matters, then save it:');
    for (const p of open) {
      const examples = p.examples?.length ? ` [e.g. ${p.examples.join(' / ')}]` : '';
      parts.push(`- ${p.key}: ${p.question} (${p.needed_when})${examples}`);
    }
  }
  return parts.join('\n');
}

// --- Late policy arithmetic ---

export type LatePolicyStatus = 'none' | 'late' | 'missing' | 'extended';

export interface LatePreview {
  late_policy_status?: string | null;
  late: boolean;
  seconds_late?: number;
  /** Points the course policy takes off this score, as this server computes it. */
  points_deducted: number;
  /** The score Canvas should end up showing, entered score minus the deduction. */
  final_score: number;
  explanation: string;
}

const SECONDS = { day: 86400, hour: 3600 } as const;

/**
 * What the course's late policy will do to a score before a student sees it.
 *
 * The dry run used to report the score as entered, which is the number the
 * teacher typed and not the number Canvas shows: a deduction lands between the
 * two, silently. Canvas does not expose a preview endpoint, so this recomputes
 * it from the policy. It is an estimate and is labelled as one — Canvas owns
 * the real arithmetic, and a policy change between this call and the write
 * would move it.
 */
export function previewLateDeduction(
  policy: any,
  assignment: any,
  submission: any,
  enteredScore: number,
  statusOverride?: LatePolicyStatus | null,
): LatePreview {
  const points = Number(assignment?.points_possible);
  const status = statusOverride !== undefined
    ? statusOverride
    : (submission?.late_policy_status as LatePolicyStatus | null | undefined);
  const secondsLate = Number(submission?.seconds_late ?? 0);
  const isLate = status === 'late' || (status == null && !!submission?.late);
  const base = {
    ...(status !== undefined ? { late_policy_status: status ?? null } : {}),
    late: isLate,
    ...(secondsLate > 0 ? { seconds_late: secondsLate } : {}),
  };

  if (status === 'none' || status === 'extended') {
    return { ...base, points_deducted: 0, final_score: enteredScore, explanation: `Marked "${status}": the late policy does not apply.` };
  }
  if (!policy?.late_submission_deduction_enabled) {
    return { ...base, points_deducted: 0, final_score: enteredScore, explanation: 'The course has no automatic late deduction.' };
  }
  if (!isLate || secondsLate <= 0) {
    return { ...base, points_deducted: 0, final_score: enteredScore, explanation: 'Not marked late, so nothing is deducted.' };
  }
  if (!Number.isFinite(points) || points <= 0) {
    return { ...base, points_deducted: 0, final_score: enteredScore, explanation: 'The assignment has no points possible, so a percentage deduction cannot be computed.' };
  }

  const interval = policy.late_submission_interval === 'hour' ? 'hour' : 'day';
  // Canvas charges for a whole interval the moment one is entered.
  const intervals = Math.ceil(secondsLate / SECONDS[interval]);
  const perInterval = (Number(policy.late_submission_deduction ?? 0) / 100) * points;
  let deducted = intervals * perInterval;
  let floorNote = '';
  if (policy.late_submission_minimum_percent_enabled) {
    const floor = (Number(policy.late_submission_minimum_percent ?? 0) / 100) * points;
    if (enteredScore - deducted < floor) {
      deducted = Math.max(0, enteredScore - floor);
      floorNote = ` The deduction stops at the policy floor of ${floor} points.`;
    }
  }
  deducted = Math.max(0, Math.min(deducted, enteredScore));
  const rounded = Number(deducted.toFixed(2));
  return {
    ...base,
    points_deducted: rounded,
    final_score: Number((enteredScore - rounded).toFixed(2)),
    explanation: `${intervals} ${interval}${intervals === 1 ? '' : 's'} late at `
      + `${Number(policy.late_submission_deduction ?? 0)}% of ${points} points.${floorNote} Estimated from the course policy; Canvas computes the stored value.`,
  };
}

/** The letter-grade cutoffs a plan should be read against, for the packet. */
export function describeScheme(scheme: GradingScheme, pointsPossible?: number) {
  const points = Number(pointsPossible);
  return {
    name: scheme.name,
    source: scheme.source,
    ...(scheme.id !== undefined ? { id: scheme.id } : {}),
    ...(scheme.tried ? { fell_back_because: scheme.tried } : {}),
    // Cutoffs in points as well as percent: a plan is built in points, and
    // converting in the grader's head is where an assumed scale slips in.
    cutoffs: scheme.entries.map(([letter, value]) => ({
      letter,
      min_percent: Number((value * 100).toFixed(2)),
      ...(Number.isFinite(points) && points > 0 ? { min_points: Number((value * points).toFixed(2)) } : {}),
    })),
    note: scheme.source === 'default'
      ? 'This is Canvas\'s built-in scheme, not a scheme this course names. Letters from it may not match what the gradebook shows.'
      : 'Letters in the plan should come from these cutoffs, not from a standard scale.',
  };
}

/**
 * Criteria where a score sits below the lowest rating the rubric offers.
 *
 * Canvas accepts these without complaint and maps them to the lowest rating,
 * so a zero on a criterion whose lowest rating is worth a point looks, in the
 * gradebook, exactly like that rating. It may be what the teacher wants; it
 * should not be something they find out later.
 */
export function belowLowestRating(assignment: any, assessment: Record<string, any>): string[] {
  const out: string[] = [];
  for (const c of (assignment?.rubric ?? [])) {
    const scored = assessment?.[c.id];
    if (!scored || scored.points === undefined) continue;
    const ratings: any[] = c.ratings ?? [];
    if (!ratings.length) continue;
    const lowest = Math.min(...ratings.map((r: any) => Number(r.points)).filter(Number.isFinite));
    if (Number.isFinite(lowest) && Number(scored.points) < lowest) {
      out.push(`"${c.description}": ${scored.points} points is below its lowest rating (${lowest}). Canvas will accept it and show the lowest rating.`);
    }
  }
  return out;
}

// --- Sections ---

const sectionCache = new Map<string, Promise<Map<string, string>>>();

/** Section id to name, read once per course. */
export async function getSectionNames(canvas: CanvasClient, courseId: string): Promise<Map<string, string>> {
  let cached = sectionCache.get(courseId);
  if (!cached) {
    cached = canvas
      .listSections(courseId)
      .then((list: any) => new Map((Array.isArray(list) ? list : []).map((s: any) => [String(s.id), String(s.name ?? s.id)])))
      .catch(() => new Map<string, string>());
    sectionCache.set(courseId, cached);
  }
  return cached;
}

export function clearSectionCache(): void {
  sectionCache.clear();
}

/**
 * The sections a student is enrolled in, by name.
 *
 * Whether two students share a class period decided how shared work was
 * graded, and the packet did not say — so the grader asked the teacher, or
 * guessed, for every pair. The period a student wrote on the worksheet is not
 * this: it was left blank, abbreviated and miswritten often enough to be
 * useless, and Canvas already knows.
 */
export function sectionsFor(member: RosterMember | undefined, names: Map<string, string>): string[] {
  return (member?.sectionIds ?? []).map(id => names.get(id) ?? `section ${id}`);
}

// --- What the assignment told students ---

// Sentences a grading plan should not contradict without the teacher saying so.
const TERMS_PATTERNS = [
  /\b(?:copy|copied|copying|plagiar\w*|cheat\w*|word[- ]for[- ]word|your own words)\b/i,
  /\b(?:zero|no credit|loses? all|forfeit)\b/i,
  /\b(?:late|past the due date|after the deadline|will not be accepted)\b/i,
  /\b(?:partner|group|with a classmate|on your own|individually)\b/i,
];

/**
 * Pull the assignment's own rules out of its description.
 *
 * Students were told something — most often what copying costs — and a plan
 * built without it can quietly undercut or overshoot what they were promised.
 * These are sentences from the description, nothing more: they are reported so
 * the teacher can hold the plan against them.
 */
export function assignmentTerms(descriptionText: string): string[] {
  if (!descriptionText) return [];
  const sentences = descriptionText
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 300);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (TERMS_PATTERNS.some(re => re.test(sentence)) && !out.includes(sentence)) out.push(sentence);
    if (out.length >= 6) break;
  }
  return out;
}

/** Every link in an assignment description, for a source check. */
export function descriptionLinks(descriptionHtml: string): { url: string; label?: string }[] {
  if (!descriptionHtml) return [];
  return [...descriptionHtml.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(m => !/\/files\/\d+/.test(m[1]))
    .map(m => ({ url: m[1], label: m[2].replace(/<[^>]+>/g, '').trim() || undefined }));
}
