// A New Quiz report is read to decide which question to reteach or throw out,
// so the failure that matters most is the one this file was written for: the
// POST returns the Progress nested under `progress`, and code that read the
// top-level `id` found none, handed back a queued job, and was called again —
// queueing another report every time and never reading one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const REPORTS = '/api/quiz/v1/courses/1/quizzes/900/reports';
const FILE = '/files/report.json';

const ITEM_ANALYSIS = [{
  metadata: { interaction_type: 'choice', item_id: 6425, item_body: '<p>Why did Inca wise men tell stories?</p>' },
  scores: { points_possible: 4, mean: 2.63, median: 4, difficulty_index: 0.66, discrimination_index: 0.55, pearson_correlation: 0.55 },
  answer_summary: {
    choices: [
      { body: '<span>They lacked writing.</span>', count: 27, correct: true, percentage: 69 },
      { body: '<span>Storytelling was sacred.</span>', count: 6, correct: false, percentage: 15 },
    ],
    aggregate: { correct: { count: 27 }, incorrect: { count: 6 } },
    no_answer: { count: 2 },
  },
}];

/** A mock Canvas that queues one report and finishes it after `pollsUntilDone` polls. */
function reportServer(canvas, { payload = ITEM_ANALYSIS, pollsUntilDone = 1, state = 'completed' } = {}) {
  let polls = 0;
  canvas.setResponse(({ url, method }) => {
    if (method === 'POST' && url === REPORTS) {
      // The shape Canvas actually returns — the Progress is nested.
      return { progress: { id: '77', workflow_state: 'queued', completion: null, url: `${canvas.baseUrl}/api/v1/progress/77` } };
    }
    if (url === '/api/v1/progress/77') {
      polls++;
      return polls >= pollsUntilDone
        ? { id: 77, workflow_state: state, completion: 100, message: state === 'failed' ? 'export blew up' : null, results: { url: `${canvas.baseUrl}${FILE}` } }
        : { id: 77, workflow_state: 'running', completion: 40 };
    }
    if (url === FILE) return { __text: JSON.stringify(payload) };
    return {};
  });
}

test('get-new-quiz-report reads the progress out of the POST and returns the parsed report', async () => {
  await withMockCanvas(async canvas => {
    reportServer(canvas);

    const result = await canvas.callTool('get-new-quiz-report', { courseId: '1', assignmentId: '900' });
    const text = canvas.textOf(result);
    const data = JSON.parse(text);

    assert.equal(data.report_type, 'item_analysis');
    assert.equal(data.items, 1);
    const item = data.item_analysis[0];
    assert.equal(item.position, 1);
    assert.equal(item.difficulty_index, 0.66);
    assert.equal(item.discrimination_index, 0.55);
    // HTML is flattened, and the answer spread survives.
    assert.equal(item.question, 'Why did Inca wise men tell stories?');
    assert.deepEqual(item.choices.map(c => [c.text, c.count, c.correct]), [
      ['They lacked writing.', 27, true],
      ['Storytelling was sacred.', 6, false],
    ]);
    // The queued-loop regression: exactly one report was ever requested, and
    // the raw progress JSON was never handed back in place of the report.
    assert.equal(canvas.requests.filter(r => r.method === 'POST' && r.url === REPORTS).length, 1);
    assert.doesNotMatch(text, /workflow_state/);
  });
});

test('get-new-quiz-report hands back a progress id to resume instead of a report that will be requeued', async () => {
  await withMockCanvas(async canvas => {
    reportServer(canvas, { pollsUntilDone: 99 });

    const pending = await canvas.callTool('get-new-quiz-report', { courseId: '1', assignmentId: '900', waitSeconds: 0 });
    assert.match(canvas.textOf(pending), /progressId "77"/);
  });
});

test('get-new-quiz-report resumes a progress id without queueing a second report', async () => {
  await withMockCanvas(async canvas => {
    reportServer(canvas);

    const result = await canvas.callTool('get-new-quiz-report', { courseId: '1', assignmentId: '900', progressId: '77' });
    const data = JSON.parse(canvas.textOf(result));

    assert.equal(data.items, 1);
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0, 'resuming queued another report');
  });
});

test('get-new-quiz-report reports a failed export rather than waiting it out', async () => {
  await withMockCanvas(async canvas => {
    reportServer(canvas, { state: 'failed' });

    const result = await canvas.callTool('get-new-quiz-report', { courseId: '1', assignmentId: '900' });
    assert.match(JSON.stringify(result), /export blew up/);
  });
});

test('get-new-quiz-report anonymises students by default and names them on request', async () => {
  const roster = [{
    student_data: {
      id: 4638, name: 'Kaleigh Walvatne', sis_id: '38482', submitted_at: '2026-09-18T18:03:34Z',
      elapsed_time: '00:38:54', attempt: 1, section_info: { section_names: ['WORLD HISTORY A-04'] },
    },
    item_responses: [
      { item_id: '6416', item_type: 'choice', score: 4, answer: '<span>regularly at war.</span>' },
      { item_id: '6419', item_type: 'choice', score: 0, answer: '' },
    ],
  }];

  await withMockCanvas(async canvas => {
    reportServer(canvas, { payload: roster });
    const hidden = JSON.parse(canvas.textOf(await canvas.callTool('get-new-quiz-report', {
      courseId: '1', assignmentId: '900', reportType: 'student_analysis',
    })));

    const student = hidden.student_analysis[0];
    assert.match(student.student, /^Student \d+$/);
    assert.equal(student.sis_id, undefined);
    assert.equal(student.score, 4);
    assert.equal(student.answered, 1, 'a blank answer counted as answered');
    assert.equal(student.questions, 2);
    assert.equal(student.responses, undefined, 'summary format leaked every response');
  });

  await withMockCanvas(async canvas => {
    reportServer(canvas, { payload: roster });
    const named = JSON.parse(canvas.textOf(await canvas.callTool('get-new-quiz-report', {
      courseId: '1', assignmentId: '900', reportType: 'student_analysis', anonymous: false, format: 'full',
    })));

    const student = named.student_analysis[0];
    assert.equal(student.student, 'Kaleigh Walvatne');
    assert.equal(student.sis_id, '38482');
    assert.deepEqual(student.responses.map(r => r.answer), ['regularly at war.', '']);
  });
});
