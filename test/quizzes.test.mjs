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

test('a non-Item entryType is refused before Canvas sees it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9300', entry_type: 'Item' }));
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '18473', assignmentId: '371566', entryType: 'Stimulus',
      interactionType: 'essay', body: 'A short passage.',
    });

    assert.ok(result.isError);
    assert.match(canvas.textOf(result), /accepts only "Item"/);
    assert.match(canvas.textOf(result), /Insert Content > Stimulus/);
    // A request that cannot succeed should never be sent.
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0);
  });
});

// stimulus_quiz_entry_id is read-only in Canvas: a write is accepted with a 200
// and stored as "". Proven live 2026-08-03 four ways — create and update, JSON
// and form-encoded, with both of a stimulus's two IDs. A tool that forwarded it
// would report a question as attached while it stands alone on the page.
test('attaching a question to a stimulus is refused on create, not attempted', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9320', entry_type: 'Item', stimulus_quiz_entry_id: '' }));
    const result = await canvas.callTool('create-new-quiz-item', {
      courseId: '18473', assignmentId: '371872',
      interactionType: 'essay', body: 'A question about the passage.',
      stimulusQuizEntryId: '9307',
    });

    assert.ok(result.isError);
    assert.match(canvas.textOf(result), /read-only/);
    assert.match(canvas.textOf(result), /Canvas UI/);
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0);
  });
});

test('the same attach is refused on update, naming the item to move', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '9310', stimulus_quiz_entry_id: '' }));
    const result = await canvas.callTool('update-new-quiz-item', {
      courseId: '18473', assignmentId: '371872', itemId: '9310',
      stimulusQuizEntryId: '9307',
    });

    assert.ok(result.isError);
    assert.match(canvas.textOf(result), /item 9310/);
    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 0);
  });
});

// The rest of the Classic quiz settings (1.15.0). Same parity rule as the New
// Quizzes settings in 1.13.0: create and update share one schema, because a
// setting you can only choose at creation is one you must delete a quiz to fix.
test('create and update accept exactly the same quiz settings', async () => {
  await withMockCanvas(async canvas => {
    const tools = await canvas.listTools();
    const props = name => Object.keys(
      tools.find(t => t.name === name).inputSchema.properties
    ).filter(k => !['courseId', 'quizId'].includes(k));

    assert.deepEqual(props('create-quiz').sort(), props('update-quiz').sort());
    for (const setting of ['time_limit', 'allowed_attempts', 'access_code',
                           'one_question_at_a_time', 'cant_go_back',
                           'one_time_results', 'shuffle_answers']) {
      assert.ok(props('create-quiz').includes(setting), `create-quiz missing ${setting}`);
    }
  });
});

test("an empty access code clears it by sending null, as time_limit does", async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz({ access_code: null }));
    await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', access_code: '',
    });

    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.body.quiz.access_code, null);
  });
});

test("an access code is sent as given, and an omitted one is not sent", async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz());
    await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', access_code: 'letmein',
    });
    let write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.body.quiz.access_code, 'letmein');

    canvas.requests.length = 0;
    await canvas.callTool('update-quiz', { courseId: '18473', quizId: '111372', title: 'x' });
    write = canvas.requests.find(r => r.method === 'PUT');
    // Sending null on a rename would strip a quiz's password.
    assert.ok(!('access_code' in write.body.quiz));
  });
});

// Canvas stores cant_go_back regardless and silently ignores it unless
// one_question_at_a_time is on — a teacher believing backtracking is blocked
// on an exam where it is not.
test('cant_go_back without one-question-at-a-time is refused, not sent', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz());
    const result = await canvas.callTool('create-quiz', {
      courseId: '18473', title: 'Exam', cant_go_back: true,
    });

    assert.ok(result.isError);
    assert.match(canvas.textOf(result), /one_question_at_a_time/);
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0);
  });
});

test('cant_go_back is allowed when the same call turns one-at-a-time on', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(echoQuiz());
    const result = await canvas.callTool('create-quiz', {
      courseId: '18473', title: 'Exam',
      cant_go_back: true, one_question_at_a_time: true,
    });

    assert.ok(!result.isError);
    const write = canvas.requests.find(r => r.method === 'POST');
    assert.equal(write.body.quiz.cant_go_back, true);
    assert.equal(write.body.quiz.one_question_at_a_time, true);
  });
});

test('cant_go_back is allowed when the quiz already has one-at-a-time on', async () => {
  await withMockCanvas(async canvas => {
    // The setting may already be on from an earlier call, so the check reads
    // the quiz rather than judging on this call's arguments alone.
    canvas.setResponse(({ method }) =>
      method === 'GET'
        ? { id: 111372, one_question_at_a_time: true }
        : echoQuiz()({ body: { quiz: { cant_go_back: true } } }));
    const result = await canvas.callTool('update-quiz', {
      courseId: '18473', quizId: '111372', cant_go_back: true,
    });

    assert.ok(!result.isError, canvas.textOf(result));
    assert.equal(canvas.requests.find(r => r.method === 'PUT').body.quiz.cant_go_back, true);
  });
});
