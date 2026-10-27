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
