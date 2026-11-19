// The assignment body.
//
// get-assignment built a whitelist summary and left `description` out of it, so
// the body students read was writable through create/update-assignment and never
// readable back — editing existing instructions meant overwriting them blind.
// These tests pin the body into the response, pin the empty case to null rather
// than absent (absent is what read as "this server cannot see it"), and pin the
// read → edit → write round trip that the missing field made impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const BODY = '<p>Read chapter 4, then answer the <strong>three</strong> questions.</p>';

const assignment = (over = {}) => ({
  id: 371866,
  name: 'DBQ Essay',
  description: BODY,
  due_at: '2026-09-01T23:59:00Z',
  points_possible: 10,
  published: true,
  allowed_attempts: 1,
  ...over,
});

const summaryFrom = (canvas, result) => JSON.parse(canvas.textOf(result));

test('get-assignment returns the HTML body', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment());
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    assert.equal(summary.description, BODY);
    // The rest of the summary still has to survive alongside it.
    assert.equal(summary.points_possible, 10);
    assert.equal(summary.due_at, '2026-09-01T23:59:00Z');
    assert.equal(summary.name, 'DBQ Essay');
  });
});

test('an assignment with no body reports null rather than dropping the field', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment({ description: null }));
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    assert.ok('description' in summary, 'an absent field cannot be told from an unreadable one');
    assert.equal(summary.description, null);
  });
});

test('a body read from get-assignment can be edited and written back', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment());
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    const edited = `${summary.description}\n<p>Due at the start of class.</p>`;
    await canvas.callTool('update-assignment', {
      courseId: '1', assignmentId: '371866', description: edited,
    });

    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.match(put.url, /\/courses\/1\/assignments\/371866/);
    // Canvas wants the fields wrapped under `assignment`, and the original body
    // has to arrive intact — the point of reading it first.
    assert.equal(put.body.assignment.description, edited);
    assert.match(put.body.assignment.description, /three<\/strong> questions/);
  });
});

// The attached rubric.
//
// get-assignment reported only has_rubric, so finding the rubric an assignment
// is graded with meant guessing from list-rubrics titles. These pin the ID and
// title into the response and the no-rubric case to null.

test('get-assignment names the attached rubric by ID and title', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment({
      rubric: [{ id: '_2527', description: 'Mechanics', points: 6, ratings: [] }],
      rubric_settings: { id: 41291, title: 'DBQ Project Writing Rubric', points_possible: 32 },
      use_rubric_for_grading: true,
    }));
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    assert.equal(summary.has_rubric, true);
    assert.deepEqual(summary.rubric, {
      id: '41291',
      title: 'DBQ Project Writing Rubric',
      points_possible: 32,
      use_rubric_for_grading: true,
    });
  });
});

test('an assignment with no rubric reports rubric as null', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment());
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    assert.equal(summary.has_rubric, false);
    assert.ok('rubric' in summary, 'an absent field cannot be told from an unreadable one');
    assert.equal(summary.rubric, null);
  });
});

test('a rubric reported only by rubric_id still comes back with its ID', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment({ rubric_id: 40469 }));
    const summary = summaryFrom(canvas, await canvas.callTool('get-assignment', {
      courseId: '1', assignmentId: '371866',
    }));

    assert.equal(summary.rubric.id, '40469');
    assert.equal(summary.rubric.title, null);
  });
});
