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
  buildNameScrubber,
  canvasAvailable,
  extractFile,
  htmlToText,
} from './submissionContent.js';

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
  const s = await canvas.getSubmissionWithHistory(courseId, assignmentId, userId);
  const alias = anonymous ? DataAnonymizer.pseudonymFor(s.user_id) : (s.user?.name ?? `User ${s.user_id}`);
  const scrub = anonymous ? buildNameScrubber(s.user, alias) : (t: string) => t;

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

  for (const a of attempts) {
    const label = `Attempt ${a.attempt ?? '?'}`;
    const files: FileSummary[] = [];
    const notes: string[] = [];

    if (a.body) {
      blocks.push({ type: 'text', text: `--- ${label} · text entry ---\n${scrub(htmlToText(a.body))}` });
    }
    if (a.discussion_entries?.length) {
      const posts = a.discussion_entries
        .map((e: any) => `[${e.created_at ?? ''}] ${htmlToText(e.message ?? '')}`)
        .join('\n\n');
      blocks.push({ type: 'text', text: `--- ${label} · discussion posts ---\n${scrub(posts)}` });
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
        files.push({ filename, kind: 'skipped', status: 'unsupported', note: `File is ${(att.size / 1048576).toFixed(1)} MB, over maxFileMB.` });
        continue;
      }
      try {
        const { data, contentType } = await canvas.downloadUrl(att.url);
        const { summary, blocks: fileBlocks } = await extractFile(
          data, filename, att['content-type'] || att.content_type || contentType, options, budget
        );
        files.push(summary);
        if (fileBlocks.length) {
          blocks.push({ type: 'text', text: `--- ${label} · ${filename} (${summary.kind}${summary.pages ? `, ${summary.pages} pages` : ''}) ---` });
          for (const b of fileBlocks) {
            blocks.push(b.type === 'text' ? { type: 'text', text: scrub(b.text) } : b);
          }
        }
      } catch (e: any) {
        files.push({ filename, kind: 'unknown', status: 'error', note: `Download failed: ${e?.message ?? e}` });
      }
    }

    attemptSummaries.push({
      attempt: a.attempt,
      submitted_at: a.submitted_at,
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

  const warnings: string[] = [];
  if (attempts.length === 0) warnings.push('The student has not submitted anything for this assignment.');
  if (anonymous) warnings.push('Name scrubbing in document text is best effort; names in images, nicknames or misspellings are not removed.');
  if (!(await canvasAvailable())) warnings.push("@napi-rs/canvas is not installed: scanned PDF pages can't be rendered and large photos can't be downscaled.");

  const header = {
    student: alias,
    user_id: s.user_id,
    assignment_id: s.assignment_id,
    workflow_state: s.workflow_state,
    score: s.score,
    grade: s.grade,
    late: s.late || false,
    missing: s.missing || false,
    excused: s.excused || false,
    total_attempts: s.attempt,
    attempts: attemptSummaries,
    ...(comments.length ? { comments } : {}),
    ...(warnings.length ? { warnings } : {}),
  };

  return [{ type: 'text', text: JSON.stringify(header) }, ...blocks];
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

export const GRADING_INSTRUCTIONS = `GRADING INSTRUCTIONS (follow these for every student in this assignment)

1. Missing materials. Before grading, check whether the assignment or the students' work depends on materials that are not included here: a paper copy of primary sources, a handout, a reading, textbook pages, a video, a lab or a class discussion. If it looks like something is missing, stop and ask the teacher to provide or describe it. Don't guess what it said.

2. Resubmission policy. Ask the teacher ONCE for this assignment whether resubmissions will be accepted, unless they have already answered in this conversation. Canvas's allowed_attempts is only a hint. The answer sets the feedback wording:
   - Resubmissions accepted: forward-looking, "Revise ..." (to fix this piece of work).
   - Not accepted: "Next time ..." (to carry the skill into future work).

3. Feedback is OFF by default. Draft scores only, with no comments, unless the teacher turns feedback on. Even when it's on, never post a comment (submission comments or rubric criterion comments) until the teacher has seen the exact text and approved it. Scores and grades also need the teacher's approval before you write them.

4. Feedback style, when it's on: brief (2–3 sentences), actionable, direct and supportive. Speak to the student, name one specific strength, then give one or two concrete next steps tied to the rubric. No generic praise, and don't restate the score.

5. Evidence. Base every rubric score on the student's work: quote or point to the passage, page or answer that justifies it. If the work can't be fully read (unreadable files, links, recordings, handwriting the OCR got wrong), say so rather than scoring what you can't see.

6. Visibility. If post_manually is false, grades and comments become visible to students as soon as they are written. Remind the teacher of this before writing the first grade.`;
