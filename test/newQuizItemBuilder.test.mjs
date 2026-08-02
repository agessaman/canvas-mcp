// The expected shapes here were read back off a live Canvas instance on
// 2026-08-02 (course 18473, quiz 371566), one item per supported type.
//
// Readback alone is NOT proof of correctness: it only shows Canvas stored what
// it was sent. Matching round-tripped cleanly for a whole session and still
// broke the quiz page in the UI. A shape is only confirmed once the quiz has
// been opened in the Canvas editor — or, better, copied from an item the editor
// itself authored, which is where the matching expectations below come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItemEntry } from '../dist/newQuizItemBuilder.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('choice: scoring_data.value is the correct choice id', () => {
  const entry = buildItemEntry({
    interactionType: 'choice', body: 'Closest planet?',
    choices: ['Mercury', 'Venus'], correctChoiceIndex: 0,
  });
  assert.equal(entry.interaction_type_slug, 'choice');
  assert.equal(entry.item_body, '<p>Closest planet?</p>');
  assert.equal(entry.scoring_algorithm, 'Equivalence');
  assert.match(entry.scoring_data.value, UUID);
  assert.equal(entry.scoring_data.value, entry.interaction_data.choices[0].id);
  assert.deepEqual(entry.interaction_data.choices.map(c => c.position), [1, 2]);
});

test('multi-answer: value is an array of ids; partial credit picks the algorithm', () => {
  const input = {
    interactionType: 'multi-answer', body: 'Primes?',
    choices: ['2', '3', '4'], correctChoiceIndexes: [0, 1],
  };
  const entry = buildItemEntry(input);
  assert.equal(entry.scoring_algorithm, 'AllOrNothing');
  assert.deepEqual(entry.scoring_data.value, [
    entry.interaction_data.choices[0].id,
    entry.interaction_data.choices[1].id,
  ]);
  assert.equal(
    buildItemEntry({ ...input, partialCredit: true }).scoring_algorithm,
    'PartialScore'
  );
});

test('true-false: value is a real boolean, not a string', () => {
  const entry = buildItemEntry({
    interactionType: 'true-false', body: 'Water boils at 100C.', correctBoolean: true,
  });
  assert.equal(entry.scoring_data.value, true);
  assert.deepEqual(entry.interaction_data, { true_choice: 'True', false_choice: 'False' });
});

test('essay: hand-graded, with grading notes carried in scoring_data', () => {
  const entry = buildItemEntry({
    interactionType: 'essay', body: 'Why is the sky blue?', gradingNotes: 'Rayleigh scattering.',
  });
  assert.equal(entry.scoring_algorithm, 'None');
  assert.equal(entry.scoring_data.value, 'Rayleigh scattering.');
  assert.equal(buildItemEntry({ interactionType: 'essay', body: 'x' }).scoring_data.value, '');
});

test('numeric: margin of error is sent as strings, as Canvas stores it', () => {
  const entry = buildItemEntry({
    interactionType: 'numeric', body: 'pi?',
    numericAnswer: 3.14, numericMargin: 0.01, numericMarginType: 'absolute',
  });
  assert.equal(entry.scoring_algorithm, 'Numeric');
  const [answer] = entry.scoring_data.value;
  assert.equal(answer.type, 'marginOfError');
  assert.equal(answer.value, '3.14');
  assert.equal(answer.margin, '0.01');
  assert.equal(answer.margin_type, 'absolute');
});

// Asserted against a matching question authored in the Canvas UI and read back
// with get-new-quiz-item (course 18473, quiz 371566, item 9092). An earlier
// version of this test asserted the opposite of nearly every line below and
// passed the whole time, because the item it described round-tripped through
// the API cleanly while making the Canvas editor throw React error #31.
test('matching: matches the shape the Canvas UI authors', () => {
  const entry = buildItemEntry({
    interactionType: 'matching', body: 'Country to capital.',
    matchPairs: [{ left: 'France', right: 'Paris' }, { left: 'Japan', right: 'Tokyo' }],
    distractors: ['Madrid'],
  });

  // 1. Answers are plain strings. Objects here are what broke the editor.
  assert.deepEqual(entry.interaction_data.answers, ['Paris', 'Tokyo', 'Madrid']);
  for (const answer of entry.interaction_data.answers) {
    assert.equal(typeof answer, 'string');
  }

  // 2. Questions carry raw text, not <p>-wrapped HTML, with short numeric ids.
  const [france, japan] = entry.interaction_data.questions;
  assert.equal(france.item_body, 'France');
  assert.match(france.id, /^[0-9]{5}$/);
  assert.notEqual(france.id, japan.id);

  // 3. scoring_data.value is a map of question id -> answer TEXT.
  assert.deepEqual(entry.scoring_data.value, { [france.id]: 'Paris', [japan.id]: 'Tokyo' });

  // 4. edit_data is what the editor populates its match rows from.
  assert.deepEqual(entry.scoring_data.edit_data, {
    matches: [
      { answer_body: 'Paris', question_id: france.id, question_body: 'France' },
      { answer_body: 'Tokyo', question_id: japan.id, question_body: 'Japan' },
    ],
    distractors: ['Madrid'],
  });

  // The UI writes no answer_type; neither should we.
  assert.equal(entry.answer_type, undefined);
  assert.equal(entry.interaction_data.answer_type, undefined);

  assert.deepEqual(entry.properties, { shuffle_rules: { questions: { shuffled: false } } });
  assert.equal(entry.scoring_algorithm, 'DeepEquals');
  assert.equal(
    buildItemEntry({
      interactionType: 'matching', body: 'x',
      matchPairs: [{ left: 'a', right: 'b' }, { left: 'c', right: 'd' }],
      partialCredit: true,
    }).scoring_algorithm,
    'PartialDeep'
  );
});

test('matching: a shared answer is offered once but keyed to both prompts', () => {
  const entry = buildItemEntry({
    interactionType: 'matching', body: 'x',
    matchPairs: [{ left: 'A', right: 'same' }, { left: 'B', right: 'same' }],
  });
  assert.deepEqual(entry.interaction_data.answers, ['same']);
  assert.deepEqual(Object.values(entry.scoring_data.value), ['same', 'same']);
});

test('a mismatched answer key fails with a teacher-readable message', () => {
  assert.throws(
    () => buildItemEntry({
      interactionType: 'choice', body: 'q', choices: ['a', 'b'], correctChoiceIndex: 5,
    }),
    /correctChoiceIndex must be a 0-based index between 0 and 1/
  );
  assert.throws(
    () => buildItemEntry({ interactionType: 'choice', body: 'q', choices: ['a'] }),
    /at least 2 choices/
  );
  assert.throws(
    () => buildItemEntry({ interactionType: 'true-false', body: 'q' }),
    /requires correctBoolean/
  );
  assert.throws(
    () => buildItemEntry({
      interactionType: 'matching', body: 'q', matchPairs: [{ left: 'a', right: 'b' }],
    }),
    /at least 2 matchPairs/
  );
  assert.throws(
    () => buildItemEntry({
      interactionType: 'matching', body: 'q',
      matchPairs: [{ left: 'a', right: '' }, { left: 'c', right: 'd' }],
    }),
    /non-empty left and right/
  );
});
