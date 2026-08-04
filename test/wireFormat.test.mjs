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

// Canvas accepts stimulus_quiz_entry_id, returns 200, and does not store it —
// proven live four ways (create/update x JSON/form-encoded, both of a
// stimulus's two IDs). Until 1.14.0 this server sent it anyway and warned
// afterwards; it now refuses up front, because the only honest outcome of that
// write is a question the teacher believes is attached and is not. The
// assertion that matters is that NOTHING reaches Canvas.
test('a stimulus attachment is refused rather than attempted', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9', points_possible: 1, stimulus_quiz_entry_id: '' }));
    const before = canvas.requests.length;
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '1', assignmentId: '2', interactionType: 'essay',
      body: 'Discuss.', stimulusQuizEntryId: '9085',
    });
    assert.ok(result.isError);
    assert.match(canvas.textOf(result), /read-only/);
    assert.equal(canvas.requests.length, before, 'nothing should be sent to Canvas');
  });
});

// The association is readable even though it is not writable, and that half
// must keep working — it is how a teacher confirms a UI-made attach.
test('a stimulus attachment is still reported when reading an item', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({
      id: '9310', entry_type: 'Item', stimulus_quiz_entry_id: '9307',
      entry: { item_body: '<p>Attached.</p>', interaction_type_slug: 'true-false' },
    }));
    const result = await canvas.callTool('get-new-quiz-item', {
      courseId: '1', assignmentId: '2', itemId: '9310',
    });
    assert.match(canvas.textOf(result), /9307/);
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
