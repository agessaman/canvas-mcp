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
