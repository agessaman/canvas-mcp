// Peer reviews.
//
// The traps are all in what Canvas hands back, not in what is asked for: the
// peer_reviews endpoint attaches every comment on the reviewee's submission to
// each pair (the teacher's and the other reviewer's too), comment authors have
// no role so the generic anonymizer leaves their names alone, a reviewer's
// rubric scores live on the rubric rather than the submission, and a
// double-saved rubric leaves two identical assessments for one attempt.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import { ROSTER, REAL_NAMES } from './helpers/gradingFixture.mjs';

const TEACHER = { id: 900, display_name: 'Dana Whitlock' };
const user = id => {
  const u = ROSTER.find(r => r.id === id);
  return { id, display_name: u.name, anonymous_id: `a${id}` };
};
const comment = (id, authorId, text, over = {}) => ({
  id, author_id: authorId, author_name: authorId === TEACHER.id ? TEACHER.display_name : user(authorId).display_name,
  comment: text, created_at: '2026-11-20T10:00:00Z', attempt: 1,
  author: authorId === TEACHER.id ? TEACHER : user(authorId), ...over,
});

const RUBRIC = [
  { id: '_c1', description: 'Thesis', points: 6, ratings: [{ id: '_c1a', description: 'Clear', points: 6 }, { id: '_c1b', description: 'Vague', points: 3 }] },
  { id: '_c2', description: 'Evidence', points: 8, ratings: [{ id: '_c2a', description: 'Strong', points: 8 }, { id: '_c2b', description: 'Thin', points: 4 }] },
];
const assignment = (over = {}) => ({
  id: 383815, name: 'DBQ: Black Death', peer_reviews: true, automatic_peer_reviews: true,
  peer_review_count: 2, peer_reviews_assign_at: '2026-11-19T08:00:00Z', anonymous_peer_reviews: true,
  rubric: RUBRIC, rubric_settings: { id: 41291, title: 'DBQ Rubric', points_possible: 14 }, ...over,
});

// Submissions: 101 -> s1001, 102 -> s1002, 103 -> s1003.
// 102 reviews 101 (done), 103 reviews 101 (done), 101 reviews 102 (not done).
const PAIRS = [
  {
    id: 1, user_id: 101, assessor_id: 102, asset_id: 1001, asset_type: 'Submission', workflow_state: 'completed',
    submission_comments: [
      comment(11, 102, 'Avery, your thesis is clear but the evidence on Jordan Tate\'s favorite document is thin.'),
      comment(12, 103, 'Good use of document C.'),
      comment(13, TEACHER.id, 'See me about the conclusion.'),
    ],
  },
  {
    id: 2, user_id: 101, assessor_id: 103, asset_id: 1001, asset_type: 'Submission', workflow_state: 'completed',
    submission_comments: [
      comment(11, 102, 'Avery, your thesis is clear but the evidence on Jordan Tate\'s favorite document is thin.'),
      comment(12, 103, 'Good use of document C.'),
      comment(13, TEACHER.id, 'See me about the conclusion.'),
    ],
  },
  { id: 3, user_id: 102, assessor_id: 101, asset_id: 1002, asset_type: 'Submission', workflow_state: 'assigned', submission_comments: [] },
];

const assessment = (id, artifactId, assessorId, points, over = {}) => ({
  id, rubric_id: 41291, artifact_type: 'Submission', artifact_id: artifactId, artifact_attempt: 1,
  assessment_type: 'peer_review', assessor_id: assessorId, score: points.reduce((s, n) => s + n, 0),
  data: [
    { id: points[0] === 6 ? '_c1a' : '_c1b', criterion_id: '_c1', points: points[0], comments: '' },
    { id: points[1] === 8 ? '_c2a' : '_c2b', criterion_id: '_c2', points: points[1], comments: over.comment ?? '' },
  ],
  ...over,
});
const ASSESSMENTS = [
  assessment(500, 1001, 102, [6, 4], { comment: 'Casey Lin explained this part better.' }),
  // The same rubric saved twice: identical, consecutive ids.
  assessment(501, 1001, 103, [6, 8]),
  assessment(502, 1001, 103, [6, 8]),
  // The teacher's own score of 101's paper: compared against, never listed as
  // a review. And a peer review on another assignment sharing this rubric.
  assessment(503, 1001, 900, [3, 4], { assessment_type: 'grading' }),
  assessment(504, 7777, 102, [3, 4]),
];

function respond({ a = assignment(), pairs = PAIRS, assessments = ASSESSMENTS, rubricStatus } = {}) {
  return ({ url }) => {
    const path = url.split('?')[0];
    if (/\/users$/.test(path)) return ROSTER;
    if (/\/peer_reviews$/.test(path)) return pairs;
    if (/\/rubrics\/41291$/.test(path)) {
      return rubricStatus ? { __status: rubricStatus, __body: { errors: [{ message: 'nope' }] } } : { id: 41291, assessments };
    }
    if (/\/assignments\/383815$/.test(path)) return a;
    return {};
  };
}

const call = (canvas, args = {}) => canvas.callTool('get-peer-reviews', { courseId: '26037', assignmentId: '383815', ...args });
const parse = (canvas, result) => JSON.parse(canvas.textOf(result));

test('each review carries only its reviewer\'s comments, with names replaced', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const result = await call(canvas);
    const text = canvas.textOf(result);
    const report = JSON.parse(text);

    for (const name of [...REAL_NAMES, 'Dana', 'Whitlock']) {
      assert.ok(!new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(text), `"${name}" leaked:\n${text}`);
    }

    const by102 = report.reviews.find(r => r.assessor_id === 102);
    assert.equal(by102.comments.length, 1, 'the other reviewer\'s and the teacher\'s comments are not this reviewer\'s');
    assert.match(by102.comments[0].comment, /Student \d+, your thesis is clear/);
    assert.match(by102.reviewee, /^Student \d+$/);
    assert.match(by102.assessor, /^Student \d+$/);

    const by103 = report.reviews.find(r => r.assessor_id === 103);
    assert.deepEqual(by103.comments.map(c => c.comment), ['Good use of document C.']);
  });
});

test('rubric scores come from the rubric\'s peer assessments, one per attempt', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas));

    const rubricRequest = canvas.requests.find(r => /\/rubrics\/41291/.test(r.url));
    // One include only: peer_assessments plus graded_assessments is a 400.
    assert.match(decodeURIComponent(rubricRequest.url), /include\[\]=assessments&/);
    assert.match(rubricRequest.url, /style=full/);
    const prRequest = canvas.requests.find(r => /\/peer_reviews/.test(r.url));
    assert.match(decodeURIComponent(prRequest.url), /include\[\]=submission_comments/);

    const by102 = report.reviews.find(r => r.assessor_id === 102);
    assert.equal(by102.rubric_assessments.length, 1);
    assert.equal(by102.rubric_assessments[0].score, 10);
    // Points in legend order; the legend is sent once, not on every review.
    assert.deepEqual(by102.rubric_assessments[0].points, [6, 4]);
    assert.deepEqual(Object.keys(by102.rubric_assessments[0].comments), ['_c2']);
    assert.match(by102.rubric_assessments[0].comments._c2, /^Student \d+ explained this part better\.$/);
    assert.deepEqual(report.assignment.rubric.criteria, [
      { id: '_c1', name: 'Thesis', points: 6, ratings: ['6: Clear', '3: Vague'] },
      { id: '_c2', name: 'Evidence', points: 8, ratings: ['8: Strong', '4: Thin'] },
    ]);
    const text = canvas.textOf(await call(canvas));
    assert.equal(text.split('Strong').length - 1, 1, 'rating text appears only in the legend');

    const by103 = report.reviews.find(r => r.assessor_id === 103);
    assert.equal(by103.rubric_assessments.length, 1, 'a double-saved rubric is one assessment');

    // Neither the teacher's grading assessment nor another assignment's leaks in.
    const scores = report.reviews.flatMap(r => (r.rubric_assessments ?? []).map(a => a.score));
    assert.deepEqual(scores.sort(), [10, 14]);
  });
});

test('the per-student tally counts reviews owed and averages peer scores received', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas));
    assert.deepEqual(report.summary, { reviews_assigned: 3, completed: 2, incomplete: 1, students_with_reviews_outstanding: 1, teacher_scored_papers: 1 });

    const s101 = report.by_student.find(s => s.user_id === 101);
    assert.deepEqual(s101.reviews_written, { assigned: 1, completed: 0 });
    assert.deepEqual(s101.reviews_received, { assigned: 2, completed: 2, average_peer_score: 12 });
  });
});

test('userId narrows to the feedback one student received', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas, { userId: '102' }));
    assert.equal(report.reviews.length, 1);
    assert.equal(report.reviews[0].reviewee_id, 102);
    assert.deepEqual(report.by_student.map(s => s.user_id), [102]);
    // The summary still describes the whole assignment.
    assert.equal(report.summary.reviews_assigned, 3);
  });
});

test('anonymous: false shows the names Canvas sent', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ pairs: PAIRS.map(p => ({ ...p, user: user(p.user_id), assessor: user(p.assessor_id) })) }));
    const report = parse(canvas, await call(canvas, { anonymous: false }));
    const by102 = report.reviews.find(r => r.assessor_id === 102);
    assert.equal(by102.assessor, 'Jordan Tate');
    assert.match(by102.comments[0].comment, /^Avery, your thesis/);
  });
});

test('an unreadable rubric still returns the comments, with a note', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ rubricStatus: 404 }));
    const report = parse(canvas, await call(canvas));
    assert.equal(report.reviews.length, 3);
    assert.ok(report.reviews.every(r => !r.rubric_assessments));
    assert.ok(report.notes.some(n => /Rubric scores could not be read/.test(n)));
  });
});

test('an assignment without peer reviews says so without asking for any', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ a: assignment({ peer_reviews: false }) }));
    const report = parse(canvas, await call(canvas));
    assert.equal(report.assignment.peer_reviews, false);
    assert.ok(!canvas.requests.some(r => /peer_reviews/.test(r.url)));
  });
});

// --- Grading peer reviews: checks, the teacher's rules, accuracy ---

const review = (report, assessor) => report.reviews.find(r => r.assessor_id === assessor);

test('every review reports what it contains, from the reviewer\'s own words', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas));
    assert.deepEqual(review(report, 102).checks, {
      criteria_scored: 2, criteria_total: 2, rubric_complete: true,
      comment_count: 1, comment_words: 15, rubric_comment_words: 6,
    });
    assert.deepEqual(review(report, 101).checks, {
      criteria_scored: 0, criteria_total: 2, rubric_complete: false,
      comment_count: 0, comment_words: 0, rubric_comment_words: 0,
    });
  });
});

test('with no rules given, nothing is marked successful and the teacher is to be asked', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas));
    assert.ok(report.reviews.every(r => !('successful' in r)));
    assert.ok(!('successful' in report.summary));
    assert.ok(report.notes.some(n => /Ask the teacher what counts/.test(n)));
  });
});

test('a recorded practice is offered back when no rules are passed', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    await canvas.callTool('set-grading-preferences', {
      courseId: '26037', answers: { peer_review_success: 'rubric and one comment' },
    });
    const report = parse(canvas, await call(canvas));
    assert.ok(report.notes.some(n => /recorded practice: rubric and one comment/.test(n)));
  });
});

test('rubric and comment rules mark each review and count successes per reviewer', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas, { requireRubric: true, requireComment: true }));
    assert.equal(review(report, 102).successful, true);
    assert.equal(review(report, 103).successful, true);
    assert.equal(review(report, 101).successful, false);
    assert.deepEqual(review(report, 101).unmet, ['rubric not completed (0 of 2 criteria scored)', 'no comment']);
    assert.equal(report.summary.successful, 2);
    assert.deepEqual(report.success_rules, { requireRubric: true, requireComment: true, countRubricComments: true });

    const written = id => report.by_student.find(s => s.user_id === id).reviews_written;
    assert.equal(written(102).successful, 1);
    assert.equal(written(101).successful, 0);
  });
});

test('rubric comments count toward the word minimum unless the teacher says not', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    // 102: 15 words of comment + 6 in the rubric.
    let report = parse(canvas, await call(canvas, { minCommentWords: 20 }));
    assert.equal(review(report, 102).successful, true);
    report = parse(canvas, await call(canvas, { minCommentWords: 20, countRubricComments: false }));
    assert.deepEqual(review(report, 102).unmet, ['comments total 15 word(s), under 20']);
  });
});

test('accuracy compares each review with the teacher\'s score, and each reviewer with the others', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const report = parse(canvas, await call(canvas));
    // Teacher scored 101's paper 7 of 14. Reviewer 102 gave 10, reviewer 103 gave 14.
    assert.deepEqual(review(report, 102).accuracy, {
      vs_teacher: { teacher_score: 7, difference: 3, difference_pct: 21.4, mean_criterion_difference: 1.5 },
    });
    assert.deepEqual(review(report, 103).accuracy.flags, ['all_top_rating']);

    const acc = report.by_student.find(s => s.user_id === 103).reviews_written.accuracy;
    assert.equal(acc.all_top_rating, 1);
    assert.equal(acc.mean_difference_vs_teacher, 7);
    // Agreement is one number per reviewer, not repeated on every review.
    assert.equal(acc.mean_abs_difference_vs_other_reviewers, 4);
  });
});

test('maxDifferencePct and rejectUniformRatings fail inaccurate reviews', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    let report = parse(canvas, await call(canvas, { maxDifferencePct: 25 }));
    assert.equal(review(report, 102).successful, true);
    assert.deepEqual(review(report, 103).unmet, ['total differs from your score by 50% of the points (limit 25%)']);

    report = parse(canvas, await call(canvas, { rejectUniformRatings: true }));
    assert.deepEqual(review(report, 103).unmet, ['every criterion at the top rating']);
  });
});

test('a top-rated review stands when the teacher scored the paper the same', async () => {
  await withMockCanvas(async canvas => {
    const agreeing = ASSESSMENTS.map(a => (a.id === 503 ? assessment(503, 1001, 900, [6, 8], { assessment_type: 'grading' }) : a));
    canvas.setResponse(respond({ assessments: agreeing }));
    const report = parse(canvas, await call(canvas, { rejectUniformRatings: true }));
    assert.equal(review(report, 103).successful, true);
  });
});

test('a reviewer who gives every paper the same scores is flagged', async () => {
  await withMockCanvas(async canvas => {
    const pairs = [
      { id: 1, user_id: 101, assessor_id: 104, asset_id: 1001, workflow_state: 'completed', submission_comments: [] },
      { id: 2, user_id: 102, assessor_id: 104, asset_id: 1002, workflow_state: 'completed', submission_comments: [] },
    ];
    const assessments = [assessment(600, 1001, 104, [3, 8]), assessment(601, 1002, 104, [3, 8])];
    canvas.setResponse(respond({ pairs, assessments }));
    const report = parse(canvas, await call(canvas));
    const acc = report.by_student.find(s => s.user_id === 104).reviews_written.accuracy;
    assert.equal(acc.same_scores_every_review, true);
    assert.ok(report.notes.some(n => /No paper has a rubric score from the teacher yet/.test(n)));
  });
});

test('summary detail drops the review text but keeps totals, checks and verdicts', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const full = canvas.textOf(await call(canvas, { requireRubric: true, requireComment: true }));
    const result = await call(canvas, { requireRubric: true, requireComment: true, detail: 'summary' });
    const report = parse(canvas, result);
    const r = review(report, 102);
    assert.equal(r.comments, undefined);
    assert.equal(r.rubric_assessments, undefined);
    assert.equal(r.score, 10);
    assert.equal(r.successful, true);
    assert.equal(r.checks.rubric_complete, true);
    assert.equal(report.assignment.rubric.criteria, undefined, 'no points to read, so no legend');
    assert.ok(canvas.textOf(result).length < full.length);
  });
});
