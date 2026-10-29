// A teacher wants to see a draft grade before anything reaches a student. This
// assignment is letter_grade with post_manually false, so every write is
// visible the moment it lands — there is no safe way to "try" a grade.
// dryRun validates exactly as a real write does and returns the letter, while
// the assertion that matters is the one about the HTTP requests: none of them
// may be a write.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import { assignment, course, router, submission, textOf } from './helpers/gradingFixture.mjs';

const SCHOOL_STANDARD = {
  id: 44,
  title: 'District scale',
  grading_scheme: [
    { name: 'A', value: 0.93 }, { name: 'B', value: 0.85 }, { name: 'C', value: 0.75 },
    { name: 'D', value: 0.65 }, { name: 'F', value: 0.0 },
  ],
};

function writesIn(requests) {
  return requests.filter(r => r.method !== 'GET');
}

test('dryRun returns the draft, its total and its letter grade without writing', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({
      baseUrl: api.baseUrl,
      submissions: { 101: submission(101) },
      course: course({ grading_standard_id: 44 }),
      gradingStandard: SCHOOL_STANDARD,
    }));
    const result = await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_crit1', ratingId: '_r1a' }, { criterionId: '_crit2', ratingId: '_r2b' }],
    });
    const preview = JSON.parse(textOf(result));

    assert.equal(preview.dry_run, true);
    assert.equal(preview.total, 20);
    assert.equal(preview.points_possible, 25);
    // 20 of 25 is 80%, which is a C on this district scale — exactly the kind
    // of thing a teacher wants to see before the student does.
    assert.equal(preview.letter_grade, 'C');
    assert.equal(preview.grading_standard.name, 'District scale');
    assert.equal(preview.grading_standard.source, 'course');
    assert.equal(preview.visible_immediately, true, 'post_manually is false, so a real write would show at once');
    assert.deepEqual(preview.would_write.rubric_assessment, {
      _crit1: { points: 15, rating_id: '_r1a' },
      _crit2: { points: 5, rating_id: '_r2b' },
    });
    assert.deepEqual(writesIn(api.requests), [], 'a dry run must send no write to Canvas');
  });
});

test('dryRun validates the rubric exactly as a real write does', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({ baseUrl: api.baseUrl, submissions: { 101: submission(101) } }));
    const bad = await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_nope', points: 5 }],
    });
    assert.match(textOf(bad), /Unknown criterionId "_nope"/);

    const outOfRange = await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_crit1', points: 40 }],
    });
    assert.match(textOf(outOfRange), /outside 0–15/);
    assert.deepEqual(writesIn(api.requests), [], 'a rejected dry run writes nothing either');
  });
});

test('a manually posted assignment says the grade would not be visible yet', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({
      baseUrl: api.baseUrl,
      assignment: assignment({ post_manually: true }),
      submissions: { 101: submission(101) },
    }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true, score: 22,
    })));
    assert.equal(preview.visible_immediately, false);
    assert.equal(preview.total, 22);
    // 22 of 25 is 88%: a B+ under Canvas's own default scheme.
    assert.equal(preview.letter_grade, 'B+', 'with no standard set, Canvas\'s default scheme applies');
    assert.equal(preview.grading_standard.source, 'default');
    assert.deepEqual(writesIn(api.requests), []);
  });
});

test('dryRun reports the criteria a draft left unscored', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({ baseUrl: api.baseUrl, submissions: { 101: submission(101) } }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_crit1', ratingId: '_r1b' }],
    })));
    assert.equal(preview.total, 8);
    assert.ok(preview.notes.some(n => /Criteria not scored: Analysis/.test(n)));
    assert.deepEqual(writesIn(api.requests), []);
  });
});

test('without dryRun the grade still reaches Canvas', async () => {
  await withMockCanvas(async api => {
    api.setResponse(({ url, method }) => {
      if (method === 'PUT') return { user_id: 101, score: 20, grade: 'B', workflow_state: 'graded' };
      return router({ baseUrl: api.baseUrl, submissions: { 101: submission(101) } })({ url, method });
    });
    const result = await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101',
      rubric: [{ criterionId: '_crit1', ratingId: '_r1a' }, { criterionId: '_crit2', ratingId: '_r2b' }],
    });
    const writes = writesIn(api.requests);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'PUT');
    assert.deepEqual(writes[0].body.rubric_assessment, {
      _crit1: { points: 15, rating_id: '_r1a' },
      _crit2: { points: 5, rating_id: '_r2b' },
    });
    assert.equal(JSON.parse(textOf(result)).grade, 'B');
  });
});
