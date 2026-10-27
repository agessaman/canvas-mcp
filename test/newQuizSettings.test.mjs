// New Quiz settings.
//
// create-new-quiz and update-new-quiz had drifted: create carried shuffle,
// time limit and attempts, update carried none of them, so changing a time
// limit on an existing quiz meant hand-writing raw quiz_settings JSON. They now
// share one schema and one builder, and the first test here is the one that
// keeps them in step.
//
// The rest are the settings that fail silently: a flag whose value is missing,
// or a value whose flag is missing, both of which Canvas stores and ignores. On
// a quiz that means a teacher believing an exam is locked down when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

// Modelled on a real UI-authored quiz (371872 in the sandbox), which is where
// the parameter list came from.
const storedSettings = (over = {}) => ({
  calculator_type: 'none',
  filter_ip_address: false,
  filters: {},
  one_at_a_time_type: 'none',
  allow_backtracking: true,
  shuffle_answers: false,
  shuffle_questions: false,
  require_student_access_code: false,
  student_access_code: null,
  has_time_limit: false,
  session_time_limit_in_seconds: null,
  multiple_attempts: {
    multiple_attempts_enabled: true,
    score_to_keep: 'highest',
    cooling_period: true,
    cooling_period_seconds: 64800,
  },
  result_view_settings: {
    display_items: true,
    display_item_feedback: false,
    result_view_restricted: true,
  },
  ...over,
});

const quiz = (settings = storedSettings()) => ({
  id: '371872', title: 'Timed Quiz Example', quiz_settings: settings,
});

const bodyOf = (canvas, method) => canvas.requests.find(r => r.method === method)?.body;
const sentSettings = (canvas, method) => bodyOf(canvas, method)?.quiz?.quiz_settings
  ?? bodyOf(canvas, method)?.quiz_settings;

// ---------------------------------------------------------------------------
// Parity — the reason the shared module exists
// ---------------------------------------------------------------------------

test('create and update accept the same settings parameters', async () => {
  await withMockCanvas(async canvas => {
    const tools = await canvas.listTools();
    const create = tools.find(t => t.name === 'create-new-quiz');
    const update = tools.find(t => t.name === 'update-new-quiz');

    const settingKeys = [
      'shuffleQuestions', 'shuffleAnswers', 'timeLimitMinutes', 'multipleAttempts', 'maxAttempts',
      'scoreToKeep', 'coolingPeriodMinutes', 'accessCode', 'oneQuestionAtATime', 'allowBacktracking',
      'calculatorType', 'restrictResultView', 'showItems', 'showStudentResponses', 'showItemFeedback',
      'showPointsAwarded', 'showPointsPossible',
    ];
    for (const key of settingKeys) {
      assert.ok(create.inputSchema.properties[key], `create-new-quiz must accept ${key}`);
      assert.ok(update.inputSchema.properties[key], `update-new-quiz must accept ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Nested groups must merge, not replace
// ---------------------------------------------------------------------------

// Changing one attempt field must not drop the cooling period beside it. The
// merge happens client-side so it holds whether or not Canvas merges its own
// nested objects — which is not something this server should have to know.
test('changing one attempt setting preserves the rest of the group', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', scoreToKeep: 'latest',
    });

    const attempts = sentSettings(canvas, 'PATCH').multiple_attempts;
    assert.equal(attempts.score_to_keep, 'latest');
    assert.equal(attempts.cooling_period_seconds, 64800, 'the cooling period must survive');
    assert.equal(attempts.multiple_attempts_enabled, true);
  });
});

test('changing one result-view flag preserves the rest of the group', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', showItemFeedback: true,
    });

    const view = sentSettings(canvas, 'PATCH').result_view_settings;
    assert.equal(view.display_item_feedback, true);
    assert.equal(view.display_items, true, 'the other flags must survive');
    assert.equal(view.result_view_restricted, true);
  });
});

// Writing blind could drop settings the call never mentions.
test('update refuses to write settings if the quiz cannot be read first', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'GET'
      ? { __status: 404, __body: { message: 'not found' } }
      : quiz()));

    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', scoreToKeep: 'latest',
    });
    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 0, 'must not write');
    assert.match(JSON.stringify(result), /could drop settings this call never mentions/);
  });
});

// ---------------------------------------------------------------------------
// Paired settings — a flag without its value does nothing
// ---------------------------------------------------------------------------

test('an access code sets both the requirement and the code', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', accessCode: 'testpassword',
    });

    const sent = sentSettings(canvas, 'PATCH');
    assert.equal(sent.require_student_access_code, true);
    assert.equal(sent.student_access_code, 'testpassword');
  });
});

test('an empty access code clears both, rather than requiring a password nobody has', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', { courseId: '1', assignmentId: '371872', accessCode: '' });

    const sent = sentSettings(canvas, 'PATCH');
    assert.equal(sent.require_student_access_code, false);
    assert.equal(sent.student_access_code, null);
  });
});

test('a time limit sets both the flag and the seconds, and 0 removes it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', { courseId: '1', assignmentId: '371872', timeLimitMinutes: 10 });
    const on = sentSettings(canvas, 'PATCH');
    assert.equal(on.has_time_limit, true);
    assert.equal(on.session_time_limit_in_seconds, 600);
  });

  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', { courseId: '1', assignmentId: '371872', timeLimitMinutes: 0 });
    const off = sentSettings(canvas, 'PATCH');
    assert.equal(off.has_time_limit, false);
  });
});

test('a cooling period is sent in seconds, with its flag', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', coolingPeriodMinutes: 30,
    });
    const attempts = sentSettings(canvas, 'PATCH').multiple_attempts;
    assert.equal(attempts.cooling_period, true);
    assert.equal(attempts.cooling_period_seconds, 1800);
    assert.equal(attempts.multiple_attempts_enabled, true, 'a retake setting implies retakes');
  });
});

test('one question at a time maps to the string Canvas stores', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', oneQuestionAtATime: true, allowBacktracking: false,
    });
    const sent = sentSettings(canvas, 'PATCH');
    assert.equal(sent.one_at_a_time_type, 'question');
    assert.equal(sent.allow_backtracking, false);
  });
});

// ---------------------------------------------------------------------------
// Contradictions refused rather than resolved
// ---------------------------------------------------------------------------

test('backtracking without one-question-at-a-time is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', allowBacktracking: true, oneQuestionAtATime: false,
    });
    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 0);
    assert.match(JSON.stringify(result), /only means something when the quiz shows one question at a time/);
  });
});

test('capping attempts while turning retakes off is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', maxAttempts: 3, multipleAttempts: false,
    });
    assert.equal(canvas.requests.filter(r => r.method === 'PATCH').length, 0);
    assert.match(JSON.stringify(result), /Pass one or the other/);
  });
});

// ---------------------------------------------------------------------------
// Publishing, which is not a quiz field at all
// ---------------------------------------------------------------------------

// A New Quiz's ID is its assignment ID, and `published` lives on the assignment.
test('publishing a New Quiz goes through the assignment endpoint', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', published: true,
    });

    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.ok(put, 'must write to the assignment');
    assert.match(put.url, /\/assignments\/371872/);
    assert.equal(put.body.assignment.published, true);
    assert.match(canvas.textOf(result), /Published/);
  });
});

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

test('an update reports the stored settings in teacher terms', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz(storedSettings({
      has_time_limit: true, session_time_limit_in_seconds: 600,
      require_student_access_code: true, student_access_code: 'testpassword',
    })));

    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', timeLimitMinutes: 10,
    });
    const text = canvas.textOf(result);
    assert.match(text, /Time limit: 10 minutes/);
    assert.match(text, /Access code: required \("testpassword"\)/);
    assert.match(text, /keeping the highest score/);
  });
});

// IP filtering has no parameter, so the read must at least say it is on rather
// than let a teacher assume these tools can see everything.
test('IP filtering is reported as present but not settable here', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz(storedSettings({ filter_ip_address: true })));
    const result = await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872', shuffleAnswers: true,
    });
    assert.match(canvas.textOf(result), /IP filtering: ON — not settable through this server/);
  });
});

// The escape hatch has to keep winning, for settings with no parameter.
test('quizSettings is merged last and overrides a named parameter', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => quiz());
    await canvas.callTool('update-new-quiz', {
      courseId: '1', assignmentId: '371872',
      calculatorType: 'basic',
      quizSettings: { calculator_type: 'scientific', filter_ip_address: true },
    });
    const sent = sentSettings(canvas, 'PATCH');
    assert.equal(sent.calculator_type, 'scientific');
    assert.equal(sent.filter_ip_address, true);
  });
});
