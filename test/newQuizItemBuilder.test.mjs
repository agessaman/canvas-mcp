// The expected shapes here were read back off a live Canvas instance on
// 2026-08-02 (course 18473, quiz 371566), one item per supported type. Where
// the published appendix disagrees with these, the appendix is wrong — see the
// comments in src/newQuizItemBuilder.ts.
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

test('matching: value is "questionId:answerId" strings, never an object map', () => {
  const entry = buildItemEntry({
    interactionType: 'matching', body: 'Country to capital.',
    matchPairs: [{ left: 'France', right: 'Paris' }, { left: 'Japan', right: 'Tokyo' }],
    distractors: ['Madrid'],
  });
  assert.equal(entry.scoring_algorithm, 'DeepEquals');
  // The published appendix shows { questionId: answerText }; Canvas rejects it
  // with "property '#/value/0' of type object did not match ... type: string".
  for (const pair of entry.scoring_data.value) {
    assert.equal(typeof pair, 'string');
    assert.match(pair, /^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  }
  // Answers are objects with item_body, not plain strings.
  assert.equal(entry.interaction_data.answers.length, 3, 'distractor must be included');
  for (const answer of entry.interaction_data.answers) {
    assert.equal(typeof answer.item_body, 'string');
    assert.match(answer.id, UUID);
  }
  assert.equal(entry.interaction_data.questions.length, 2, 'distractor is not a question');
  const [first] = entry.scoring_data.value;
  assert.equal(
    first,
    `${entry.interaction_data.questions[0].id}:${entry.interaction_data.answers[0].id}`
  );
  assert.equal(
    buildItemEntry({
      interactionType: 'matching', body: 'x',
      matchPairs: [{ left: 'a', right: 'b' }, { left: 'c', right: 'd' }],
      partialCredit: true,
    }).scoring_algorithm,
    'PartialDeep'
  );
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
});
