// A New Quiz that draws its questions from item banks read as a list of empty
// rows: the summary in list-new-quiz-items reached for entry.interaction_type_slug,
// entry.title and entry.item_body on every item, and a bank-backed item has none
// of those at that level. A teacher looking at a test they had built from banks
// saw nulls and concluded the server could not see the quiz.
//
// The two bank shapes are different in the way that matters, so they are tested
// apart. Fixtures are trimmed copies of live payloads from gfalls.instructure.com
// (course 26012, quizzes 373386 and 373364), captured 2026-09-17.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

// entry_type "Bank": ONE item standing for a whole random draw. The questions
// are not in the payload, and are not anywhere in the Canvas API.
const BANK_DRAW = {
  id: '9624',
  position: 2,
  points_possible: 4,
  properties: { sample_num: '8' },
  entry_type: 'Bank',
  entry_editable: true,
  stimulus_quiz_entry_id: '',
  status: 'mutable',
  entry: {
    id: '290',
    title: '16 Test: The Reformation in Europe, 1517-1600 - Lesson 1',
    archived: false,
    entry_count: 12,
    item_entry_count: 12,
  },
};

// entry_type "BankEntry": ONE question that lives in a bank, linked into the
// quiz. The whole question IS present, one level deeper than a plain Item.
const BANK_ENTRY = {
  id: '9667',
  position: 6,
  points_possible: 1,
  properties: {},
  entry_type: 'BankEntry',
  stimulus_quiz_entry_id: '',
  status: 'immutable',
  entry: {
    id: '1018',
    entry_type: 'Item',
    bank_id: '134',
    entry: {
      id: '6445',
      title: 'Question',
      item_body: '<div>One Maya calendar was based on a</div>',
      interaction_type_slug: 'choice',
      scoring_data: { value: 'c1931038-6bf2-44d2-9b68-a40e86a13933' },
      scoring_algorithm: 'Equivalence',
    },
  },
};

const PLAIN_ITEM = {
  id: '9631',
  position: 6,
  points_possible: 11,
  entry_type: 'Item',
  entry: {
    title: 'Question',
    item_body: '<div>Compare Henry VIII&rsquo;s motives with Luther&rsquo;s.</div>',
    interaction_type_slug: 'essay',
  },
};

const rowsOf = text => JSON.parse(text.split('\n\nNOTE')[0]);

test('a bank draw reports the bank, the pool and how many it pulls', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [BANK_DRAW]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373386',
    });

    const [row] = rowsOf(canvas.textOf(result));
    assert.equal(row.entry_type, 'Bank');
    assert.equal(row.bank_id, '290');
    assert.equal(row.bank_title, '16 Test: The Reformation in Europe, 1517-1600 - Lesson 1');
    assert.equal(row.draws_questions, '8');
    assert.equal(row.pool_size, 12);
    // The old bug: an Item-shaped projection onto a shape that has no such fields.
    assert.ok(!('type' in row), 'a draw is not a question and must not claim a question type');
    assert.ok(!('item_body' in row));
  });
});

test('a bank draw says the pool is unreachable, and where to go instead', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [BANK_DRAW]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373386',
    });

    const text = canvas.textOf(result);
    assert.match(text, /NOTE —/);
    assert.match(text, /draws 8 of 12 from bank 290/);
    assert.match(text, /NOT readable through the Canvas API/);
    assert.match(text, /Item Banks in the Canvas course navigation/);
  });
});

test('a bank-linked question is unwrapped and shown, not warned about', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [BANK_ENTRY]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373364',
    });

    const text = canvas.textOf(result);
    const [row] = rowsOf(text);
    assert.equal(row.entry_type, 'BankEntry');
    assert.equal(row.type, 'choice');
    assert.match(row.item_body, /One Maya calendar/);
    assert.equal(row.bank_id, '134', 'the bank it came from is worth keeping');
    // Its content is right here, so sending the reader to the Canvas UI for it
    // would be wrong — the note is for draws only.
    assert.ok(!text.includes('NOTE —'), 'a readable question must not be reported as unreachable');
  });
});

test('plain items are unchanged by the unwrapping', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [PLAIN_ITEM]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373386',
    });

    const [row] = rowsOf(canvas.textOf(result));
    assert.equal(row.type, 'essay');
    assert.equal(row.title, 'Question');
    assert.ok(!('bank_id' in row));
  });
});

test('a mixed quiz notes only the draws, and counts them', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [BANK_DRAW, BANK_ENTRY, PLAIN_ITEM]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373386',
    });

    const text = canvas.textOf(result);
    assert.equal(rowsOf(text).length, 3);
    assert.match(text, /NOTE — 1 item\(s\) pull questions at random/);
  });
});

test('full returns the raw payload, bank nesting and all', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [BANK_ENTRY]);
    const result = await canvas.callTool('list-new-quiz-items', {
      courseId: '26012', assignmentId: '373364', full: true,
    });

    const [row] = rowsOf(canvas.textOf(result));
    assert.equal(row.entry.entry.scoring_data.value, 'c1931038-6bf2-44d2-9b68-a40e86a13933');
  });
});

// --- Classic question banks -------------------------------------------------

test('listing banks resolves the context Canvas requires', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [{
      id: 95446,
      title: 'Chapter_16_The_Reformation_in_Europe_1517_1600',
      context_code: 'course_18473',
      assessment_question_count: 88,
      updated_at: '2025-10-20T03:35:03Z',
    }]);
    const result = await canvas.callTool('list-question-banks', { courseId: '18473' });

    const read = canvas.requests.find(r => r.url.startsWith('/api/v1/question_banks'));
    // context_type and context_id are REQUIRED — without both, Canvas answers 400.
    assert.match(read.url, /context_type=Course/);
    assert.match(read.url, /context_id=18473/);
    assert.match(read.url, /include_question_count=true/);
    assert.match(canvas.textOf(result), /"question_count": 88/);
  });
});

test('an account context is sent as Account, not smuggled in as a course', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => []);
    await canvas.callTool('list-question-banks', { accountId: '1' });

    const read = canvas.requests.find(r => r.url.startsWith('/api/v1/question_banks'));
    assert.match(read.url, /context_type=Account/);
    assert.match(read.url, /context_id=1/);
  });
});

test('giving both contexts, or neither, is refused rather than guessed at', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => []);
    for (const args of [{ courseId: '18473', accountId: '1' }, {}]) {
      const result = await canvas.callTool('list-question-banks', args);
      assert.match(canvas.textOf(result), /exactly one of courseId or accountId/);
    }
    assert.equal(canvas.requests.length, 0, 'an ambiguous context must not reach Canvas');
  });
});

test('an empty bank list names New Quizzes as the likely reason', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => []);
    const result = await canvas.callTool('list-question-banks', { courseId: '24667' });

    // A course with New Quizzes item banks and no Classic ones reads as empty
    // here, and that is a boundary rather than a failure worth saying out loud.
    assert.match(canvas.textOf(result), /No Classic question banks/);
    assert.match(canvas.textOf(result), /Item Banks in the Canvas course navigation/);
  });
});

test('bank questions are summarised, and the full payload keeps the answer key', async () => {
  const QUESTION = {
    id: 1507782,
    position: null,
    assessment_question_bank_id: 95446,
    question_name: '',
    question_type: 'multiple_choice_question',
    question_text: '<div>In his work The Praise of Folly, Erasmus called for</div>',
    points_possible: 1,
    answers: [
      { id: 98530, weight: 0, text: 'more pilgrimages.' },
      { id: 93069, weight: 100, text: 'a simpler faith.' },
    ],
  };

  await withMockCanvas(async canvas => {
    canvas.setResponse(() => [QUESTION]);
    const summary = await canvas.callTool('list-question-bank-questions', { bankId: '95446' });
    assert.match(canvas.textOf(summary), /1 question\(s\) in bank 95446/);
    assert.ok(!canvas.textOf(summary).includes('a simpler faith'), 'the summary withholds the key');

    const full = await canvas.callTool('list-question-bank-questions', { bankId: '95446', full: true });
    assert.match(canvas.textOf(full), /a simpler faith/);

    // Canvas returns answers whether or not they are asked for (verified live
    // 2026-09-17), so requesting them would imply a choice that does not exist.
    for (const r of canvas.requests) assert.ok(!r.url.includes('include'), r.url);
  });
});
