// Regression tests for the shape of what actually goes over the wire to Canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const entry = {
  title: 'probe',
  item_body: '<p>q</p>',
  interaction_type_slug: 'choice',
  properties: {},
  interaction_data: { choices: [{ id: 'a', position: 1, item_body: '<p>A</p>' }] },
  scoring_data: { value: 'a' },
  scoring_algorithm: 'Equivalence',
};

// The bug: rawEntry was z.any(), which advertises a bare {} with no type, so
// clients could pass it as a JSON string. That string went to Canvas verbatim
// and every rawEntry call died on an unexplained 500.
test('rawEntry reaches Canvas as an object whether passed as object or string', async () => {
  await withMockCanvas(async canvas => {
    for (const rawEntry of [entry, JSON.stringify(entry)]) {
      await canvas.callTool('create-new-quiz-item', {
        courseId: '1', assignmentId: '2', pointsPossible: 1, rawEntry,
      });
      const sent = canvas.lastRequest().body.item.entry;
      assert.equal(typeof sent, 'object', 'entry must not be a JSON string');
      assert.deepEqual(sent, entry);
    }
  });
});

test('rubric_assessment reaches Canvas as an object when passed as a string', async () => {
  await withMockCanvas(async canvas => {
    const assessment = { criterion_1: { points: 5, comments: 'good' } };
    await canvas.callTool('grade-submission', {
      courseId: '1', assignmentId: '2', userId: '3',
      rubric_assessment: JSON.stringify(assessment),
    });
    const sent = canvas.lastRequest().body;
    const encoded = JSON.stringify(sent);
    assert.ok(!encoded.includes('\\"points\\"'), 'rubric must not be double-encoded');
    assert.equal(typeof JSON.parse(encoded).rubric_assessment, 'object');
  });
});

test('a malformed JSON string is rejected with a readable message, not forwarded', async () => {
  await withMockCanvas(async canvas => {
    const before = canvas.requests.length;
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '1', assignmentId: '2', rawEntry: '{not json',
    });
    assert.equal(canvas.requests.length, before, 'nothing should be sent to Canvas');
    assert.match(JSON.stringify(result), /JSON/i);
  });
});

// Canvas accepts stimulus_quiz_entry_id, returns 200, and does not store it.
test('a dropped stimulus attachment is reported, not passed off as success', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9', points_possible: 1, stimulus_quiz_entry_id: '' }));
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '1', assignmentId: '2', interactionType: 'essay',
      body: 'Discuss.', stimulusQuizEntryId: '9085',
    });
    assert.match(canvas.textOf(result), /WARNING/);
    assert.match(canvas.textOf(result), /9085/);
  });
});

test('an honored stimulus attachment is not warned about', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9', points_possible: 1, stimulus_quiz_entry_id: '9085' }));
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '1', assignmentId: '2', interactionType: 'essay',
      body: 'Discuss.', stimulusQuizEntryId: '9085',
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});

// A deliberate product decision, asserted so it cannot drift back in: reading
// student messages is supported, sending them is not.
test('no tool can send a conversation message', async () => {
  await withMockCanvas(async canvas => {
    const names = (await canvas.listTools()).map(tool => tool.name);
    const senders = names.filter(name =>
      /(send|create|post|reply|add).*(conversation|message)|conversation.*(send|reply)/i.test(name)
    );
    assert.deepEqual(senders, []);
  });
});
