// Overrides are the highest-stakes surface on this server: a dropped one is a
// missed accommodation, and nothing in Canvas's 200 response says it happened.
// These tests are mostly about the refusals and the warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

// due_at here is deliberately NOT the base date, which is what Canvas actually
// returns once overrides exist: the assignment's due_at is the date as it
// applies to the requesting user. all_dates carries the real base.
const ASSIGNMENT = {
  id: 371566,
  name: 'Unit 3 Quiz',
  due_at: '2026-09-25T23:59:00Z',
  all_dates: [
    { base: true, due_at: '2026-09-10T23:59:00Z' },
    { id: 55, title: 'IEP', due_at: '2026-09-25T23:59:00Z' },
  ],
};

// Serves an assignment, a list of overrides, and echoes writes back — with an
// optional distortion so we can model Canvas quietly not applying something.
function canvasWith({ overrides = [], assignment = ASSIGNMENT, distort = (x) => x } = {}) {
  return ({ url, body }) => {
    if (url.includes('/overrides')) {
      if (body?.assignment_override) {
        return distort({ id: 900, ...body.assignment_override });
      }
      return overrides;
    }
    return assignment;
  };
}

test('an override must target students or a section, never both', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-assignment-override', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], sectionId: '42', dueAt: '2026-09-20T23:59:00Z',
    });
    // Canvas would accept this and silently use only the most specific target.
    assert.match(JSON.stringify(result), /exactly one of studentIds or sectionId/);
  });
});

test('an override with no dates is refused rather than created as a no-op', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-assignment-override', {
      courseId: '18473', assignmentId: '371566', studentIds: ['6199'],
    });
    assert.match(JSON.stringify(result), /at least one of dueAt, unlockAt or lockAt/);
  });
});

test('a student-targeted override always carries a title, which Canvas requires', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('create-assignment-override', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], dueAt: '2026-09-20T23:59:00Z',
    });
    const sent = canvas.lastRequest().body.assignment_override;
    assert.equal(sent.title, 'Extended deadline');
    assert.deepEqual(sent.student_ids, ['6199']);
    assert.equal(sent.course_section_id, undefined);
  });
});

// The failure that matters most: Canvas accepts the override but drops a
// student who is not enrolled, leaving them with no accommodation at all.
test('a student Canvas silently dropped is reported as having no accommodation', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      distort: override => ({ ...override, student_ids: ['6199'] }),
    }));
    const result = await canvas.callTool('create-assignment-override', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199', '9999'], dueAt: '2026-09-20T23:59:00Z',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /9999/);
    assert.match(text, /NO accommodation/);
  });
});

test('a due date Canvas stored differently is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      distort: override => ({ ...override, due_at: '2026-01-01T00:00:00Z' }),
    }));
    const result = await canvas.callTool('create-assignment-override', {
      courseId: '18473', assignmentId: '371566',
      sectionId: '42', dueAt: '2026-09-20T23:59:00Z',
    });
    assert.match(canvas.textOf(result), /WARNING[\s\S]*due_at/);
  });
});

test('"only visible to overrides" is surfaced, because it hides the assignment', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      assignment: { ...ASSIGNMENT, only_visible_to_overrides: true },
      overrides: [{ id: 1, title: 'IEP', student_ids: [6199], due_at: '2026-09-20T23:59:00Z' }],
    }));
    const result = await canvas.callTool('list-assignment-overrides', {
      courseId: '18473', assignmentId: '371566',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /cannot see it at all/);
  });
});

test('with no overrides, the base due date is stated plainly', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('list-assignment-overrides', {
      courseId: '18473', assignmentId: '371566',
    });
    assert.match(canvas.textOf(result), /No overrides/);
    assert.match(canvas.textOf(result), /2026-09-10/);
  });
});

// extend-due-date must not stack a second override on a student who already
// has one, and must not move someone else's deadline as a side effect.
test('extend-due-date reuses an override covering exactly those students', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      overrides: [{ id: 55, title: 'IEP', student_ids: [6199], due_at: '2026-09-15T23:59:00Z' }],
    }));
    const result = await canvas.callTool('extend-due-date', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], dueAt: '2026-09-25T23:59:00Z',
    });
    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.ok(write, 'should update the existing override, not create a new one');
    assert.match(write.url, /overrides\/55$/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'), 'must not stack a second override');
    assert.match(canvas.textOf(result), /Reused override 55/);
  });
});

test('extend-due-date creates a new override when nothing covers those students', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      overrides: [{ id: 55, title: 'Other', student_ids: [1234], due_at: '2026-09-15T23:59:00Z' }],
    }));
    await canvas.callTool('extend-due-date', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], dueAt: '2026-09-25T23:59:00Z',
    });
    const write = canvas.requests.find(r => r.method === 'POST');
    assert.ok(write, 'should create an override');
    assert.deepEqual(write.body.assignment_override.student_ids, ['6199']);
  });
});

test('extend-due-date refuses to move a deadline for students it was not given', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      // 6199 shares this override with 1234, who was not named.
      overrides: [{ id: 55, title: 'Group ext', student_ids: [6199, 1234], due_at: '2026-09-15T23:59:00Z' }],
    }));
    const result = await canvas.callTool('extend-due-date', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], dueAt: '2026-09-25T23:59:00Z',
    });
    assert.match(JSON.stringify(result), /already share an override/);
    assert.ok(
      !canvas.requests.some(r => r.method === 'PUT' || r.method === 'POST'),
      'nothing should be written when the request is ambiguous'
    );
  });
});

test('an overlapping section override is pointed out', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      overrides: [{ id: 60, title: 'Extra Time', course_section_id: 42, due_at: '2026-09-30T23:59:00Z' }],
    }));
    const result = await canvas.callTool('extend-due-date', {
      courseId: '18473', assignmentId: '371566',
      studentIds: ['6199'], dueAt: '2026-09-25T23:59:00Z',
    });
    const text = canvas.textOf(result);
    assert.match(text, /section-wide override/);
    assert.match(text, /more generous date/);
  });
});

// The assignment's own due_at is the requesting user's effective date, not the
// base. Reporting it as "what everyone else gets" is a lie about the class
// deadline — observed live, where a student override moved the assignment's
// reported due_at with it.
test('the base due date comes from all_dates, not the assignment due_at', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      overrides: [{ id: 55, title: 'IEP', student_ids: [6199], due_at: '2026-09-25T23:59:00Z' }],
    }));
    const result = await canvas.callTool('list-assignment-overrides', {
      courseId: '18473', assignmentId: '371566',
    });
    const text = canvas.textOf(result);

    assert.ok(
      canvas.requests.some(r => /all_dates/.test(r.url)),
      'must request include[]=all_dates'
    );
    assert.match(text, /base due date \(2026-09-10T23:59:00Z\)/);
    // The override's own date must not be presented as the base.
    assert.doesNotMatch(text, /base due date \(2026-09-25/);
  });
});
