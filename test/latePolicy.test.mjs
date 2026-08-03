// The course late policy, and extra attempts on an assignment.
//
// The late policy is the only setting on this server that changes how every
// grade in a course is computed, so the assertions here are mostly about not
// getting it silently backwards: the API field is a DEDUCTION while the Canvas
// UI (and this tool) name the resulting GRADE, and a percentage without its
// _enabled flag is stored and ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const storedPolicy = (over = {}) => ({
  late_policy: {
    missing_submission_deduction_enabled: false,
    missing_submission_deduction: 0,
    late_submission_deduction_enabled: false,
    late_submission_deduction: 0,
    late_submission_interval: 'day',
    late_submission_minimum_percent_enabled: false,
    late_submission_minimum_percent: 0,
    ...over,
  },
});

const bodyOf = (canvas, method) => canvas.requests.find(r => r.method === method)?.body;
const noPolicy = { __status: 404, __body: { message: 'The specified resource does not exist.' } };

// ---------------------------------------------------------------------------
// The inversion — the single most likely thing to get wrong
// ---------------------------------------------------------------------------

// Canvas stores the percentage DEDUCTED; the UI asks for the grade the student
// RECEIVES. "Missing submissions get 0%" is missing_submission_deduction: 100.
// Passing the UI's number straight through would award full marks for work
// never handed in.
test('a missing-submission grade is sent as its complement, the deduction', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'GET' ? storedPolicy() : storedPolicy({
      missing_submission_deduction_enabled: true, missing_submission_deduction: 100,
    })));

    await canvas.callTool('set-late-policy', { courseId: '1', missingSubmissionGrade: 0 });

    const sent = bodyOf(canvas, 'PATCH').late_policy;
    assert.equal(sent.missing_submission_deduction, 100, '0% grade must be a 100% deduction');
    assert.equal(sent.missing_submission_deduction_enabled, true);
  });
});

test('a 50% missing grade is a 50% deduction, and reads back as the grade', async () => {
  await withMockCanvas(async canvas => {
    const applied = storedPolicy({
      missing_submission_deduction_enabled: true, missing_submission_deduction: 50,
    });
    canvas.setResponse(({ method }) => (method === 'GET' ? applied : applied));

    const result = await canvas.callTool('set-late-policy', { courseId: '1', missingSubmissionGrade: 50 });

    assert.equal(bodyOf(canvas, 'PATCH').late_policy.missing_submission_deduction, 50);
    // The teacher-facing rendering must be the grade, not the deduction.
    assert.match(canvas.textOf(result), /automatically graded 50% of the assignment's points/);
  });
});

// ---------------------------------------------------------------------------
// A percentage without its flag is stored and ignored
// ---------------------------------------------------------------------------

test('setting a late deduction turns the late policy on', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy({
      late_submission_deduction_enabled: true, late_submission_deduction: 10,
    }));

    await canvas.callTool('set-late-policy', { courseId: '1', lateDeductionPercent: 10 });

    const sent = bodyOf(canvas, 'PATCH').late_policy;
    assert.equal(sent.late_submission_deduction, 10);
    assert.equal(sent.late_submission_deduction_enabled, true, 'a deduction Canvas ignores is not a policy');
  });
});

test('setting a minimum percent turns the floor on', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy({
      late_submission_minimum_percent_enabled: true, late_submission_minimum_percent: 40,
    }));

    await canvas.callTool('set-late-policy', { courseId: '1', lateMinimumPercent: 40 });

    const sent = bodyOf(canvas, 'PATCH').late_policy;
    assert.equal(sent.late_submission_minimum_percent, 40);
    assert.equal(sent.late_submission_minimum_percent_enabled, true);
  });
});

test('a percentage contradicting an explicit off switch is refused, and nothing is sent', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy());
    const result = await canvas.callTool('set-late-policy', {
      courseId: '1', missingSubmissionGrade: 0, applyMissingPolicy: false,
    });
    assert.equal(canvas.requests.filter(r => r.method !== 'GET').length, 0, 'must not write');
    assert.match(JSON.stringify(result), /Pass one or the other/);
  });
});

test('an interval on its own is refused rather than stored as an inert setting', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy());
    const result = await canvas.callTool('set-late-policy', { courseId: '1', lateDeductionInterval: 'hour' });
    assert.equal(canvas.requests.filter(r => r.method !== 'GET').length, 0, 'must not write');
    assert.match(JSON.stringify(result), /changes nothing a student would notice/);
  });
});

// ---------------------------------------------------------------------------
// Create versus update — the caller should not have to know
// ---------------------------------------------------------------------------

// A course with no policy 404s on GET, and needs POST rather than PATCH.
test('a course with no policy is created with POST, not PATCH', async () => {
  await withMockCanvas(async canvas => {
    let created = false;
    canvas.setResponse(({ method }) => {
      if (method === 'POST') { created = true; return storedPolicy({ late_submission_deduction: 10, late_submission_deduction_enabled: true }); }
      if (method === 'GET' && !created) return noPolicy;
      return storedPolicy({ late_submission_deduction: 10, late_submission_deduction_enabled: true });
    });

    const result = await canvas.callTool('set-late-policy', { courseId: '1', lateDeductionPercent: 10 });

    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 0);
    assert.match(canvas.textOf(result), /Created the late policy/);
  });
});

test('a course that already has a policy is updated with PATCH', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy({
      late_submission_deduction_enabled: true, late_submission_deduction: 10,
    }));
    const result = await canvas.callTool('set-late-policy', { courseId: '1', lateDeductionPercent: 10 });

    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 1);
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0);
    assert.match(canvas.textOf(result), /Updated the late policy/);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// No policy is a normal state, not a broken course ID.
test('get-late-policy reports a missing policy as a state, not an error', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => noPolicy);
    const result = await canvas.callTool('get-late-policy', { courseId: '1' });
    const text = canvas.textOf(result);
    assert.match(text, /no late policy/);
    assert.doesNotMatch(text, /Failed/);
  });
});

test('get-late-policy explains a floor, and its absence', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy({
      late_submission_deduction_enabled: true, late_submission_deduction: 5,
      late_submission_interval: 'hour',
    }));
    const result = await canvas.callTool('get-late-policy', { courseId: '1' });
    const text = canvas.textOf(result);
    assert.match(text, /5% deducted per hour late/);
    assert.match(text, /can be deducted to zero/);
  });
});

test('a policy Canvas stored differently from what was sent is warned about', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PATCH'
      ? storedPolicy()
      : storedPolicy({ late_submission_deduction_enabled: true, late_submission_deduction: 99 })));

    // Asks for 10; the readback keeps saying 99.
    const result = await canvas.callTool('set-late-policy', { courseId: '1', lateDeductionPercent: 10 });
    assert.match(canvas.textOf(result), /WARNING — Canvas did not store this as requested/);
  });
});

// Turning either policy on changes grades already awarded.
test('turning a policy on says that existing grades can change', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy({
      missing_submission_deduction_enabled: true, missing_submission_deduction: 100,
    }));
    const result = await canvas.callTool('set-late-policy', { courseId: '1', missingSubmissionGrade: 0 });
    assert.match(canvas.textOf(result), /scores students have already seen may change/);
  });
});

test('turning a policy off does not warn about recomputed grades', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedPolicy());
    const result = await canvas.callTool('set-late-policy', { courseId: '1', applyLatePolicy: false });
    assert.doesNotMatch(canvas.textOf(result), /already seen may change/);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the late policy tools are registered', async () => {
  await withMockCanvas(async canvas => {
    const names = (await canvas.listTools()).map(tool => tool.name);
    assert.ok(names.includes('get-late-policy'));
    assert.ok(names.includes('set-late-policy'));
  });
});
