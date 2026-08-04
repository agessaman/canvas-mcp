// A Classic quiz's time limit is the one setting extend-quiz-time depends on:
// extra minutes are added to a clock, and on a quiz with no clock Canvas stores
// the grant and nothing happens. Until 1.14.0 no tool here could set one, so
// that path had never run against a real timed quiz.
//
// The risk is in the wire format. Canvas spells "no time limit" as null
// (quizzes.json in the instance's own API spec), while both this tool and
// newQuizSettings take 0 — so the translation is invisible at the tool-argument
// layer, and a 0 forwarded verbatim would mean "zero minutes" rather than
// "unlimited".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

// Echoes the request back as a stored quiz, which is what Canvas does on both
// create and update.
function echoQuiz(overrides = {}) {
  return ({ body }) => ({
    id: 111372,
    title: body?.quiz?.title ?? 'Classic extension test quiz',
    published: false,
    ...body?.quiz,
    ...overrides,
  });
}

test('a time limit is sent in minutes under quiz[time_limit]', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz());
    const result = await canvas.callTool('create-quiz', {
      courseId: '18473', title: 'Timed', time_limit: 60,
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.equal(write.body.quiz.time_limit, 60);
    assert.match(canvas.textOf(result), /time limit 60 min/);
  });
});

test('0 clears the time limit by sending null, not 0', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz({ time_limit: null }));
    const result = await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', time_limit: 0,
    });

    const write = canvas.requests.find(r => r.method === 'PUT');
    // A literal 0 would give students a zero-minute quiz.
    assert.equal(write.body.quiz.time_limit, null);
    assert.ok(!Object.is(write.body.quiz.time_limit, 0));
    assert.match(canvas.textOf(result), /time limit removed/);
  });
});

test('an omitted time limit is not sent at all', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz());
    const result = await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', title: 'Renamed',
    });

    const write = canvas.requests.find(r => r.method === 'PUT');
    // Sending null on a rename would silently strip an existing quiz's clock.
    assert.ok(!('time_limit' in write.body.quiz));
    assert.doesNotMatch(canvas.textOf(result), /time limit/i);
  });
});

test('a time limit Canvas did not store is reported, not assumed', async () => {
  await withMockCanvas(async canvas => {
    // Gotcha 11: Canvas answers 200 and drops what it does not support.
    canvas.setResponse(echoQuiz({ time_limit: null }));
    const result = await canvas.callTool('create-quiz', {
      courseId: '18473', title: 'Timed', time_limit: 60,
    });

    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /asked for 60 min but Canvas stored no time limit/);
  });
});

test('no time-limit warning is emitted when none was requested', async () => {
  await withMockCanvas(async canvas => {
    // A quiz that already has a limit must not read as a failed write on a
    // call that never mentioned one — the update-syllabus lesson (gotcha 16).
    canvas.setResponse(echoQuiz({ time_limit: 30 }));
    const result = await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', title: 'Renamed',
    });

    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});
