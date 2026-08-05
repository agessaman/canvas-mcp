// The bug this file exists for: assignment_groups takes FLAT parameters, not
// the assignment_group[...] wrapper that assignments and quizzes use. Wrapped,
// Canvas saw no fields, ignored all of them, returned 200 and made a default
// group called "Assignments". Nothing at the tool-argument layer showed it —
// only the outgoing request does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

test('assignment group fields go out flat, not wrapped in assignment_group', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ body }) => ({
      id: 25050, name: body?.name, position: body?.position, group_weight: body?.group_weight,
    }));
    await canvas.callTool('create-assignment-group', {
      courseId: '18473', name: 'Homework', group_weight: 20,
    });
    const write = canvas.requests.find(r => r.method === 'POST');
    assert.equal(write.body.name, 'Homework', 'name must be a top-level field');
    assert.equal(write.body.group_weight, 20);
    assert.equal('assignment_group' in write.body, false, 'the wrapper is what caused the bug');
  });
});

// A 200 from Canvas is not proof the fields were applied — that is exactly how
// this shipped broken in the first place.
test('a name Canvas did not apply is reported, not presented as success', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25051, name: 'Assignments', position: 2, group_weight: 0 }));
    const result = await canvas.callTool('create-assignment-group', {
      courseId: '18473', name: 'Homework', group_weight: 20,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /asked for name "Homework", Canvas stored "Assignments"/);
    assert.match(text, /asked for weight 20, Canvas stored 0/);
  });
});

test('no warning when Canvas stored what it was asked for', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ body }) => ({
      id: 25052, name: body?.name, position: 1, group_weight: body?.group_weight,
    }));
    const result = await canvas.callTool('create-assignment-group', {
      courseId: '18473', name: 'Homework', group_weight: 20,
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});

// rules is accepted only on PUT per the instance spec, so offering it on create
// would be a parameter that is accepted and silently does nothing.
test('create does not advertise rules, which the create endpoint ignores', async () => {
  await withMockCanvas(async canvas => {
    const tools = await canvas.listTools();
    const create = tools.find(t => t.name === 'create-assignment-group');
    const params = Object.keys(create.inputSchema.properties ?? {});
    assert.ok(params.includes('name'), 'schema not read correctly');
    assert.equal(params.includes('rules'), false);
  });
});

// --- update-assignment-group ---
// Rules can only be set here: the create endpoint accepts none at all.

test('update sends flat fields, and rules as a newline-separated string', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({
      id: 25049, name: 'Homework', position: 1, group_weight: 20,
      rules: { drop_lowest: 1, never_drop: [101, 102] },
    }));
    await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', name: 'Homework',
      rules: { drop_lowest: 1, never_drop: [101, 102] },
    });
    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.body.name, 'Homework');
    assert.equal('assignment_group' in write.body, false);
    // Canvas takes rules as a string even though it returns them as an object.
    assert.equal(write.body.rules, 'drop_lowest:1\nnever_drop:101\nnever_drop:102');
  });
});

// Omitting rules leaves them alone; an empty object is a deliberate clear.
test('an empty rules object clears the rules rather than being ignored', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25049, name: 'Homework', position: 1, group_weight: 20, rules: {} }));
    await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', rules: {},
    });
    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.body.rules, '');
  });
});

test('omitting rules does not send the parameter at all', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25049, name: 'Homework', position: 1, group_weight: 20 }));
    await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', name: 'Homework',
    });
    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal('rules' in write.body, false, 'sending rules would clear existing ones');
  });
});

// The rules encoding is inferred from the spec's type, not from an exemplar,
// so a wrong guess has to be loud rather than silent.
test('rules Canvas did not store are reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25049, name: 'Homework', position: 1, group_weight: 20, rules: {} }));
    const result = await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', rules: { drop_lowest: 2 },
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /asked for drop_lowest 2, Canvas stored nothing/);
  });
});

test('a never_drop list Canvas did not store is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({
      id: 25049, name: 'Homework', position: 1, group_weight: 20,
      rules: { never_drop: [101] },
    }));
    const result = await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', rules: { never_drop: [101, 102] },
    });
    assert.match(canvas.textOf(result), /asked to never drop \[101, 102\], Canvas stored \[101\]/);
  });
});

test('no warning when Canvas stored the rules asked for', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({
      id: 25049, name: 'Homework', position: 1, group_weight: 20,
      rules: { drop_lowest: 1, never_drop: [101] },
    }));
    const result = await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', rules: { drop_lowest: 1, never_drop: [101] },
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});

// Canvas would drop an unrecognised rule key without saying so, so refuse it
// here where the caller can still see the message.
test('an unknown rule key is refused rather than silently dropped', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25049 }));
    const result = await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049', rules: { drop_smallest: 1 },
    });
    assert.match(JSON.stringify(result), /only supports drop_lowest, drop_highest and never_drop/);
    assert.equal(canvas.requests.some(r => r.method === 'PUT'), false, 'nothing should be written');
  });
});

test('an update with no fields is refused instead of writing nothing', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: 25049 }));
    const result = await canvas.callTool('update-assignment-group', {
      courseId: '18473', assignmentGroupId: '25049',
    });
    assert.match(JSON.stringify(result), /Nothing to update/);
  });
});
