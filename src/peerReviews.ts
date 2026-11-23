// Peer reviews on an assignment: who reviews whom, what they wrote, what they
// scored on the rubric, and — when the teacher says what counts — whether each
// review succeeded and how close its scores came to the teacher's.
//
// Canvas spreads this over three places, and the obvious reading of each one
// is wrong in a different way (all confirmed live on a 17-student DBQ):
//
// - GET /assignments/:id/peer_reviews lists the review pairs. With
//   include[]=submission_comments each pair carries EVERY comment on the
//   reviewee's submission — the teacher's, the other reviewer's, the
//   student's own — not just the reviewer's. On that DBQ 47 of 79 attached
//   comments were written by someone other than the pair's reviewer. So the
//   comments are filtered to the ones the reviewer wrote.
//
// - Rubric scores are not on the submission: submissions?include[]=
//   rubric_assessment returns the teacher's assessment only. Every assessment,
//   peer and teacher, lives on the rubric, readable through GET /rubrics/:id
//   ?include[]=assessments&style=full and told apart by assessment_type
//   ("peer_review" or "grading"). Only one include is accepted: asking for
//   peer_assessments and graded_assessments together is a 400. A rubric can be
//   shared by several assignments, so an assessment is tied back to this one by
//   its artifact (the reviewee's submission id), which is specific to it.
//
// - One reviewer can score the same submission more than once: once per
//   attempt when the student resubmits, and sometimes twice for one attempt
//   (a double-submitted rubric). One assessment per attempt is kept, the
//   newest, and the latest attempt is the one judged and averaged.
//
// Canvas's "completed" is not a successful review. It flips when a reviewer
// does anything: of 34 completed reviews on that DBQ, 4 had no comment and 1
// left a criterion unscored. So success is judged from the content, against
// rules the teacher states — this file ships no rule of its own.
//
// The comment author objects Canvas sends have no role, so the generic
// anonymizer (which only rewrites authors whose role is "student") would pass
// real names straight through. Pseudonyms are applied here instead, to every
// reviewer and reviewee.
import { CanvasClient } from './canvasClient.js';
import { getCourseRoster } from './grading.js';
import { resolvePreferences } from './gradingPreferences.js';
import { createRedactor, noopRedactor, RosterMember } from './nameRedaction.js';
import { pseudonymFor } from './pseudonyms.js';

/** What makes a review count. Every rule is off unless the teacher sets it. */
export interface SuccessRules {
  /** Every rubric criterion must be scored. */
  requireRubric?: boolean;
  /** The reviewer must leave a comment. */
  requireComment?: boolean;
  /** The reviewer's comments must run to at least this many words in total. */
  minCommentWords?: number;
  /** Whether comments typed into the rubric count toward the comment rules (default: true). */
  countRubricComments?: boolean;
  /** Fail a review whose total differs from the teacher's by more than this % of the rubric's points. */
  maxDifferencePct?: number;
  /**
   * Fail a review that puts every criterion at its top rating, or every one at
   * its bottom — unless the teacher's own score of that paper agrees (within
   * maxDifferencePct, or exactly when that is unset).
   */
  rejectUniformRatings?: boolean;
}

export interface PeerReviewOptions extends SuccessRules {
  /**
   * "full" returns each review's comment text and per-criterion rubric scores;
   * "summary" leaves them out and keeps the checks, flags and verdicts — all a
   * grading tally needs, at roughly a third of the size (default: "full").
   */
  detail?: 'full' | 'summary';
  /** Only reviews of this student's work. */
  userId?: string;
  /** Only reviews this student wrote. */
  assessorId?: string;
  anonymous?: boolean;
}

export async function getPeerReviewReport(
  canvas: CanvasClient,
  courseId: string,
  assignmentId: string,
  options: PeerReviewOptions = {},
) {
  const anonymous = options.anonymous !== false;
  const assignment: any = await canvas.getAssignment(courseId, assignmentId);
  if (!assignment?.peer_reviews) {
    return {
      assignment: { id: assignment?.id, name: assignment?.name, peer_reviews: false },
      notes: ['Peer reviews are not turned on for this assignment.'],
    };
  }

  const notes: string[] = [];
  const pairs: any[] = await canvas.listPeerReviews(courseId, assignmentId);

  let peerAssessments: any[] = [];
  let teacherAssessments: any[] = [];
  const rubricId = assignment.rubric_settings?.id;
  if (rubricId && pairs.length) {
    try {
      const rubric: any = await canvas.getRubric(courseId, String(rubricId), {
        include: ['assessments'],
        style: 'full',
      });
      const artifacts = new Set(pairs.map(p => String(p.asset_id)));
      const ours = (rubric?.assessments ?? []).filter((a: any) =>
        a.artifact_type === 'Submission' && artifacts.has(String(a.artifact_id)));
      peerAssessments = ours.filter((a: any) => a.assessment_type === 'peer_review');
      teacherAssessments = ours.filter((a: any) => a.assessment_type === 'grading');
    } catch (error: any) {
      notes.push(`Rubric scores could not be read (${error?.message ?? error}); comments are shown without them.`);
    }
  }

  const roster: RosterMember[] = anonymous ? await getCourseRoster(canvas, courseId) : [];
  const label = (id: unknown, user: any) =>
    anonymous ? pseudonymFor(courseId, id) : (user?.display_name ?? user?.name ?? String(id));

  return buildPeerReviewReport({
    courseId, assignmentId, assignment, pairs, peerAssessments, teacherAssessments, roster, anonymous, label, notes,
    options,
  });
}

interface BuildInput {
  courseId: string;
  assignmentId: string;
  assignment: any;
  pairs: any[];
  peerAssessments: any[];
  teacherAssessments: any[];
  roster: RosterMember[];
  anonymous: boolean;
  label: (id: unknown, user: any) => string;
  notes: string[];
  options: PeerReviewOptions;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const mean = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
const wordCount = (t: unknown) =>
  typeof t === 'string' ? t.trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length : 0;

/** Newest assessment per attempt, oldest attempt first. */
function latestPerAttempt(list: any[]): any[] {
  const perAttempt = new Map<number, any>();
  for (const a of list) {
    const attempt = a.artifact_attempt ?? 0;
    const kept = perAttempt.get(attempt);
    if (!kept || Number(a.id) > Number(kept.id)) perAttempt.set(attempt, a);
  }
  return [...perAttempt.values()].sort((x, y) => (x.artifact_attempt ?? 0) - (y.artifact_attempt ?? 0));
}

function groupBy(list: any[], key: (a: any) => string): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const a of list) {
    const k = key(a);
    const arr = out.get(k) ?? [];
    arr.push(a);
    out.set(k, arr);
  }
  return out;
}

function buildPeerReviewReport(input: BuildInput) {
  const { assignment, pairs, roster, anonymous, label, notes, options } = input;
  const criteria: any[] = Array.isArray(assignment.rubric) ? assignment.rubric : [];
  const pointsPossible = Number(assignment.rubric_settings?.points_possible)
    || criteria.reduce((s, c) => s + (Number(c.points) || 0), 0);
  // The bottom of a criterion is its lowest rating, not zero: a rubric whose
  // lowest rating is worth a point is still "all bottom" at one point each.
  const bounds = new Map(criteria.map(c => {
    const ratingPoints = (c.ratings ?? []).map((r: any) => Number(r.points)).filter(Number.isFinite);
    return [String(c.id), {
      top: Number(c.points),
      bottom: ratingPoints.length ? Math.min(...ratingPoints) : 0,
    }];
  }));

  // One per attempt, the newest. A double-click on Save leaves two identical
  // assessments with consecutive ids (seen live), and a reviewer who re-scores
  // the same attempt means the later one; Canvas's own UI shows the latest.
  const byPair = new Map<string, any[]>();
  for (const [k, list] of groupBy(input.peerAssessments, a => `${a.artifact_id}:${a.assessor_id}`)) {
    byPair.set(k, latestPerAttempt(list));
  }
  // The teacher's score of each submission: their latest attempt's.
  const teacherBySubmission = new Map<string, any>();
  for (const [k, list] of groupBy(input.teacherAssessments, a => String(a.artifact_id))) {
    const kept = latestPerAttempt(list);
    teacherBySubmission.set(k, kept[kept.length - 1]);
  }

  const names = new Map<string, string>();
  const nameOf = (id: unknown, user?: any) => {
    const key = String(id);
    if (!names.has(key)) names.set(key, label(id, user));
    return names.get(key)!;
  };

  let redacted = 0;
  const reviews = pairs.map(p => {
    const revieweeId = String(p.user_id);
    const assessorId = String(p.assessor_id);
    // The comment is about the reviewee's work, so the reviewee is the
    // "submitter" whose name is scrubbed most loosely; anyone else on the
    // roster is caught by full name.
    const redactor = anonymous ? createRedactor({ roster, submitterId: revieweeId }) : noopRedactor();
    const scrub = (t: unknown) => {
      if (typeof t !== 'string' || !t) return t;
      const out = redactor.redact(t);
      const c = redactor.takeCounts();
      redacted += c.nameLine + c.body;
      return out;
    };

    const own = (p.submission_comments ?? []).filter((c: any) => String(c.author_id) === assessorId);
    const comments = own.map((c: any) => ({
      comment: scrub(c.comment),
      created_at: c.created_at,
      ...(c.attempt != null ? { attempt: c.attempt } : {}),
    }));

    const kept = byPair.get(`${p.asset_id}:${p.assessor_id}`) ?? [];
    // Points only, in the order of the rubric legend the report carries once
    // in assignment.rubric.criteria. Repeating each criterion's name and
    // rating text on every review was three quarters of the rubric output
    // (15 KB of 20 KB on a 37-review DBQ); the points alone identify the
    // rating. Rubric comments are keyed by criterion id, only where written.
    const order: string[] = criteria.length
      ? criteria.map(c => String(c.id))
      : [...new Set(kept.flatMap(a => (a.data ?? []).map((d: any) => String(d.criterion_id))))];
    const rubricAssessments = kept.map(a => {
      const byCriterion = new Map<string, any>((a.data ?? []).map((d: any) => [String(d.criterion_id), d]));
      const written = order
        .filter(id => byCriterion.get(id)?.comments)
        .map(id => [id, scrub(byCriterion.get(id).comments)]);
      return {
        score: a.score,
        ...(a.artifact_attempt != null ? { attempt: a.artifact_attempt } : {}),
        points: order.map(id => byCriterion.get(id)?.points ?? null),
        ...(written.length ? { comments: Object.fromEntries(written) } : {}),
      };
    });

    // Judged on the raw text, before redaction swaps a name for "Student 12".
    const latest = kept[kept.length - 1];
    const scored = new Map<string, number>();
    for (const d of latest?.data ?? []) {
      if (typeof d.points === 'number' && Number.isFinite(d.points)) scored.set(String(d.criterion_id), d.points);
    }
    const checks = {
      ...(criteria.length ? {
        criteria_scored: criteria.filter(c => scored.has(String(c.id))).length,
        criteria_total: criteria.length,
        rubric_complete: criteria.every(c => scored.has(String(c.id))),
      } : {}),
      comment_count: own.length,
      comment_words: own.reduce((s: number, c: any) => s + wordCount(c.comment), 0),
      rubric_comment_words: (latest?.data ?? []).reduce((s: number, d: any) => s + wordCount(d.comments), 0),
    };

    // Accuracy signals, only for a review that scored something.
    let accuracy: any;
    if (latest && scored.size) {
      const flags: string[] = [];
      const all = [...scored].map(([id, pts]) => ({ pts, b: bounds.get(id) })).filter(x => x.b);
      if (all.length >= 2 && all.every(x => x.pts >= x.b!.top)) flags.push('all_top_rating');
      if (all.length >= 2 && all.every(x => x.pts <= x.b!.bottom)) flags.push('all_bottom_rating');

      const teacher = teacherBySubmission.get(String(p.asset_id));
      let vsTeacher: any;
      if (teacher && typeof teacher.score === 'number' && typeof latest.score === 'number') {
        const teacherPoints = new Map<string, number>((teacher.data ?? [])
          .filter((d: any) => typeof d.points === 'number')
          .map((d: any) => [String(d.criterion_id), d.points]));
        const diffs = [...scored].filter(([id]) => teacherPoints.has(id)).map(([id, pts]) => Math.abs(pts - teacherPoints.get(id)!));
        const difference = latest.score - teacher.score;
        vsTeacher = {
          teacher_score: teacher.score,
          difference: round(difference),
          ...(pointsPossible ? { difference_pct: round((difference / pointsPossible) * 100, 1) } : {}),
          ...(diffs.length ? { mean_criterion_difference: round(mean(diffs)) } : {}),
          ...(teacher.artifact_attempt !== latest.artifact_attempt
            ? { teacher_attempt: teacher.artifact_attempt, reviewer_attempt: latest.artifact_attempt }
            : {}),
        };
      }
      accuracy = { ...(flags.length ? { flags } : {}), ...(vsTeacher ? { vs_teacher: vsTeacher } : {}) };
    }

    return {
      reviewee_id: p.user_id,
      reviewee: nameOf(p.user_id, p.user),
      assessor_id: p.assessor_id,
      assessor: nameOf(p.assessor_id, p.assessor),
      workflow_state: p.workflow_state,
      submission_id: p.asset_id,
      checks,
      comments,
      ...(rubricAssessments.length ? { rubric_assessments: rubricAssessments } : {}),
      ...(accuracy ? { accuracy } : {}),
      latestScore: typeof latest?.score === 'number' ? latest.score as number : undefined,
      latestPoints: criteria.map(c => scored.get(String(c.id)) ?? null),
    };
  });

  // How far each review sits from the other reviewers of the same paper. With
  // two or three reviewers per paper this cannot say who is wrong, so it is
  // reported once per reviewer, as an average, and never decides success.
  const bySubmission = groupBy(reviews.filter(r => r.latestScore !== undefined), r => String(r.submission_id));
  for (const r of reviews) {
    if (r.latestScore === undefined) continue;
    const others = (bySubmission.get(String(r.submission_id)) ?? []).filter(o => o !== r).map(o => o.latestScore!);
    if (!others.length) continue;
    (r as any).peerDifference = r.latestScore - mean(others);
  }

  // Success, against the teacher's rules only.
  const rulesGiven = [options.requireRubric, options.requireComment, options.minCommentWords,
    options.maxDifferencePct, options.rejectUniformRatings].some(v => v !== undefined && v !== false);
  const countRubric = options.countRubricComments !== false;
  let uncheckedAccuracy = 0;
  if (rulesGiven) {
    if (options.requireRubric && !criteria.length) {
      notes.push('requireRubric was set, but this assignment has no rubric, so it was not applied.');
    }
    for (const r of reviews as any[]) {
      const unmet: string[] = [];
      const c = r.checks;
      if (options.requireRubric && criteria.length && !c.rubric_complete) {
        unmet.push(`rubric not completed (${c.criteria_scored} of ${c.criteria_total} criteria scored)`);
      }
      const words = c.comment_words + (countRubric ? c.rubric_comment_words : 0);
      const commented = c.comment_count > 0 || (countRubric && c.rubric_comment_words > 0);
      if (options.requireComment && !commented) unmet.push('no comment');
      if (options.minCommentWords !== undefined && words < options.minCommentWords) {
        unmet.push(`comments total ${words} word(s), under ${options.minCommentWords}`);
      }
      const vs = r.accuracy?.vs_teacher;
      const tolerance = options.maxDifferencePct;
      if (tolerance !== undefined && r.latestScore !== undefined) {
        if (vs?.difference_pct === undefined) uncheckedAccuracy++;
        else if (Math.abs(vs.difference_pct) > tolerance) {
          unmet.push(`total differs from your score by ${Math.abs(vs.difference_pct)}% of the points (limit ${tolerance}%)`);
        }
      }
      if (options.rejectUniformRatings) {
        const uniform = (r.accuracy?.flags ?? []).find((f: string) => f === 'all_top_rating' || f === 'all_bottom_rating');
        const teacherAgrees = vs?.difference_pct !== undefined && Math.abs(vs.difference_pct) <= (tolerance ?? 0);
        if (uniform && !teacherAgrees) {
          unmet.push(uniform === 'all_top_rating' ? 'every criterion at the top rating' : 'every criterion at the bottom rating');
        }
      }
      r.successful = unmet.length === 0;
      if (unmet.length) r.unmet = unmet;
    }
    if (uncheckedAccuracy) {
      notes.push(`${uncheckedAccuracy} scored review(s) had no rubric score of yours to compare against, so maxDifferencePct was not applied to them. Grade those papers with the rubric, then read this again.`);
    }
  } else {
    const recorded = resolvePreferences(input.courseId, input.assignmentId).find(p => p.key === 'peer_review_success')?.answer;
    notes.push(recorded
      ? `No success rules were passed, so no review is marked successful. The teacher's recorded practice: ${recorded}. Pass it as requireRubric / requireComment / minCommentWords (and maxDifferencePct / rejectUniformRatings for accuracy).`
      : 'No success rules were passed, so no review is marked successful. Canvas\'s "completed" only means the reviewer did something. Ask the teacher what counts as a successful review, record it with set-grading-preferences (key peer_review_success), and pass it as requireRubric / requireComment / minCommentWords.');
  }

  // Per-student tallies come from every pair, before the filters, so a student
  // asked about by userId still shows how many reviews they owe.
  interface Tally {
    user_id: unknown; student: string;
    written: { assigned: number; completed: number; successful: number; scored: any[] };
    received: { assigned: number; completed: number; scores: number[] };
  }
  const tally = new Map<string, Tally>();
  const row = (id: unknown) => {
    const key = String(id);
    let t = tally.get(key);
    if (!t) {
      t = {
        user_id: id, student: nameOf(id),
        written: { assigned: 0, completed: 0, successful: 0, scored: [] },
        received: { assigned: 0, completed: 0, scores: [] },
      };
      tally.set(key, t);
    }
    return t;
  };
  for (const r of reviews as any[]) {
    const done = r.workflow_state === 'completed';
    const w = row(r.assessor_id).written;
    w.assigned++;
    if (done) w.completed++;
    if (r.successful) w.successful++;
    if (r.latestScore !== undefined) w.scored.push(r);
    const rec = row(r.reviewee_id).received;
    rec.assigned++;
    if (done) rec.completed++;
    if (r.latestScore !== undefined) rec.scores.push(r.latestScore);
  }

  const reviewerAccuracy = (scored: any[]) => {
    if (!scored.length) return undefined;
    const vsTeacher = scored.map(r => r.accuracy?.vs_teacher).filter(Boolean);
    const vsPeers: number[] = scored.map(r => r.peerDifference).filter((d: unknown) => typeof d === 'number');
    const count = (flag: string) => scored.filter(r => r.accuracy?.flags?.includes(flag)).length;
    const vectors = new Set(scored.map(r => JSON.stringify(r.latestPoints)));
    return {
      reviews_scored: scored.length,
      ...(count('all_top_rating') ? { all_top_rating: count('all_top_rating') } : {}),
      ...(count('all_bottom_rating') ? { all_bottom_rating: count('all_bottom_rating') } : {}),
      // The same scores on every paper is not reading the papers.
      ...(scored.length >= 2 && vectors.size === 1 ? { same_scores_every_review: true } : {}),
      ...(vsTeacher.length ? {
        compared_with_teacher: vsTeacher.length,
        // Signed: positive is more generous than the teacher, negative harsher.
        mean_difference_vs_teacher: round(mean(vsTeacher.map((v: any) => v.difference))),
        mean_abs_difference_vs_teacher: round(mean(vsTeacher.map((v: any) => Math.abs(v.difference)))),
      } : {}),
      // Agreement with the other reviewers of the same papers: the one accuracy
      // signal there is before the teacher has scored anything.
      ...(vsPeers.length ? { mean_abs_difference_vs_other_reviewers: round(mean(vsPeers.map(Math.abs))) } : {}),
    };
  };

  const wanted = (id: unknown, filter?: string) => filter === undefined || String(id) === String(filter);
  const shown = reviews.filter(r => wanted(r.reviewee_id, options.userId) && wanted(r.assessor_id, options.assessorId));
  const filtered = options.userId !== undefined || options.assessorId !== undefined;

  const byStudent = [...tally.values()]
    .filter(t => !filtered || [options.userId, options.assessorId].some(f => f !== undefined && String(f) === String(t.user_id)))
    .sort((a, b) => Number(a.user_id) - Number(b.user_id))
    .map(t => {
      const acc = reviewerAccuracy(t.written.scored);
      return {
        user_id: t.user_id,
        student: t.student,
        reviews_written: {
          assigned: t.written.assigned,
          completed: t.written.completed,
          ...(rulesGiven ? { successful: t.written.successful } : {}),
          ...(acc ? { accuracy: acc } : {}),
        },
        reviews_received: {
          assigned: t.received.assigned,
          completed: t.received.completed,
          ...(t.received.scores.length ? { average_peer_score: round(mean(t.received.scores)) } : {}),
        },
      };
    });

  const completed = reviews.filter(r => r.workflow_state === 'completed').length;
  const owing = [...tally.values()].filter(t => t.written.completed < t.written.assigned);

  if (filtered && shown.length === 0) {
    notes.push('No peer reviews match that student. Check the user ID, or that peer reviews have been assigned yet.');
  }
  if (!pairs.length) {
    notes.push(assignment.automatic_peer_reviews && assignment.peer_reviews_assign_at
      && Date.parse(assignment.peer_reviews_assign_at) > Date.now()
      ? `Peer reviews are assigned automatically at ${assignment.peer_reviews_assign_at}; none exist yet.`
      : 'No peer reviews have been assigned on this assignment yet.');
  }
  if (pairs.length && criteria.length && !teacherBySubmission.size) {
    notes.push('No paper has a rubric score from the teacher yet, so accuracy is limited to uniform-rating flags and agreement between reviewers.');
  }
  if (anonymous && redacted) {
    notes.push(`${redacted} student name(s) were replaced with pseudonyms inside review text.`);
  }

  // The legend every review's points array is read against, sent once. The
  // summary detail carries no per-criterion points, so it needs none.
  const rubric = assignment.rubric_settings?.id ? {
    id: assignment.rubric_settings.id,
    title: assignment.rubric_settings.title,
    points_possible: assignment.rubric_settings.points_possible,
    ...(options.detail !== 'summary' && criteria.length ? {
      criteria: criteria.map(c => ({
        id: c.id,
        name: c.description,
        points: c.points,
        ratings: (c.ratings ?? []).map((r: any) =>
          String(r.description).trim() === String(r.points) ? r.points : `${r.points}: ${r.description}`),
      })),
    } : {}),
  } : null;

  const rulesApplied = rulesGiven ? Object.fromEntries(Object.entries({
    requireRubric: options.requireRubric,
    requireComment: options.requireComment,
    minCommentWords: options.minCommentWords,
    countRubricComments: (options.requireComment || options.minCommentWords !== undefined) ? countRubric : undefined,
    maxDifferencePct: options.maxDifferencePct,
    rejectUniformRatings: options.rejectUniformRatings,
  }).filter(([, v]) => v !== undefined)) : undefined;

  return {
    assignment: {
      id: assignment.id,
      name: assignment.name,
      peer_reviews: true,
      automatic_peer_reviews: !!assignment.automatic_peer_reviews,
      peer_review_count: assignment.peer_review_count,
      ...(assignment.peer_reviews_assign_at ? { peer_reviews_assign_at: assignment.peer_reviews_assign_at } : {}),
      anonymous_peer_reviews: !!assignment.anonymous_peer_reviews,
      ...(assignment.intra_group_peer_reviews ? { intra_group_peer_reviews: true } : {}),
      rubric,
    },
    ...(rulesApplied ? { success_rules: rulesApplied } : {}),
    summary: {
      reviews_assigned: reviews.length,
      completed,
      incomplete: reviews.length - completed,
      ...(rulesGiven ? { successful: (reviews as any[]).filter(r => r.successful).length } : {}),
      students_with_reviews_outstanding: owing.length,
      teacher_scored_papers: teacherBySubmission.size,
    },
    by_student: byStudent,
    reviews: shown.map(({ latestScore, latestPoints, peerDifference, ...rest }: any) => {
      if (rest.accuracy && !Object.keys(rest.accuracy).length) delete rest.accuracy;
      if (options.detail === 'summary') {
        delete rest.comments;
        delete rest.rubric_assessments;
        // The total stays: it is one number, and what a teacher scans for.
        if (latestScore !== undefined) rest.score = latestScore;
      }
      return rest;
    }),
    ...(notes.length ? { notes } : {}),
  };
}
