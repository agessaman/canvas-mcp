// Quiz results are read for decisions about students — who struggled, which
// question was unfair, whose score to change — so the failures that matter are
// the quiet ones: a class list that stops at Canvas's first page, a report
// summary that finds no questions, a student's answer joined to the wrong
// question text, a failed report described as "still generating".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const QUIZ_PATH = '/api/v1/courses/1/quizzes/900';

test('list-quiz-submissions follows every page, names students on request, and does not count extension-only rows', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (!url.startsWith(`${QUIZ_PATH}/submissions`)) return {};
      if (!url.includes('page=2')) {
        return {
          __headers: { Link: `<${canvas.baseUrl}${QUIZ_PATH}/submissions?page=2&per_page=100>; rel="next"` },
          __body: {
            quiz_submissions: [{ id: 1, user_id: 10, workflow_state: 'complete', score: 8, kept_score: 8 }],
            users: [{ id: 10, name: 'Ada Lovelace' }],
          },
        };
      }
      return {
        quiz_submissions: [
          { id: 2, user_id: 11, workflow_state: 'complete', score: 6, kept_score: 6 },
          { id: 3, user_id: 12, workflow_state: 'settings_only', kept_score: null, extra_time: 30 },
        ],
        users: [{ id: 11, name: 'Grace Hopper' }, { id: 12, name: 'Linus Pauling' }],
      };
    });

    const result = await canvas.callTool('list-quiz-submissions', { courseId: '1', quizId: '900', anonymous: false });
    const data = JSON.parse(canvas.textOf(result));

    assert.equal(canvas.requests.length, 2, 'the second page was never requested');
    assert.match(decodeURIComponent(canvas.requests[0].url), /include\[\]=user/);
    assert.deepEqual(data.submissions.map(s => s.student), ['Ada Lovelace', 'Grace Hopper', 'Linus Pauling']);
    // The settings_only row carries an extension and no attempt.
    assert.deepEqual(data.summary, { submissions: 2, graded: 2, average: 7, high: 8, low: 6 });
  });
});

test('list-quiz-submissions does not ask Canvas for names it is going to hide', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => url.startsWith(`${QUIZ_PATH}/submissions`)
      ? { quiz_submissions: [{ id: 1, user_id: 10, workflow_state: 'complete', kept_score: 8 }] }
      : {});

    const result = await canvas.callTool('list-quiz-submissions', { courseId: '1', quizId: '900' });
    const data = JSON.parse(canvas.textOf(result));

    assert.doesNotMatch(decodeURIComponent(canvas.requests[0].url), /include/);
    assert.match(data.submissions[0].student, /^Student \d+$/);
  });
});

// Regression: list-quiz-extensions read one page of quiz submissions, and
// Canvas's default page is 10, so the eleventh student's extension was absent.
test('list-quiz-extensions finds an extension past the first page of submissions', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.startsWith(`${QUIZ_PATH}/submissions`)) {
        return url.includes('page=2')
          ? { quiz_submissions: [{ id: 2, user_id: 6211, extra_time: 30 }] }
          : {
              __headers: { Link: `<${canvas.baseUrl}${QUIZ_PATH}/submissions?page=2&per_page=100>; rel="next"` },
              __body: { quiz_submissions: [{ id: 1, user_id: 6199 }] },
            };
      }
      if (url.startsWith('/api/quiz/v1/')) return { __status: 404, __body: { errors: ['not found'] } };
      if (url.startsWith(QUIZ_PATH)) return { id: 900, title: 'Unit 3 Quiz', time_limit: 60 };
      return {};
    });

    const result = await canvas.callTool('list-quiz-extensions', { courseId: '1', quizId: '900' });
    assert.match(canvas.textOf(result), /"user_id": 6211/);
  });
});

// Canvas heads each question's points column with the question's points
// possible, so the same header ("1.0") can appear once per question.
const STUDENT_ANALYSIS_CSV = '﻿'
  + 'name,id,sis_id,section,section_id,section_sis_id,submitted,"101: What is 2+2?",1.0,"102: Name a prime",1.0,n correct,n incorrect,score\n'
  + 'Ada Lovelace,10,S-1,Section A,5,SA,2026-09-01,4,1.0,7,1.0,2,0,2.0\n'
  + 'Grace Hopper,11,S-2,Section A,5,SA,2026-09-01,5,0.0,,,0,1,0.0\n';

function reportCanvas(canvas, fileUrl = `${canvas.baseUrl}/files/77/download?verifier=abc`) {
  return ({ url }) => {
    if (url.startsWith(`${QUIZ_PATH}/reports`)) {
      return [{ id: 55, report_type: 'student_analysis', includes_all_versions: false, file: { url: fileUrl } }];
    }
    if (url.startsWith('/files/77/download')) return { __text: STUDENT_ANALYSIS_CSV };
    return {};
  };
}

test('get-quiz-report summarises every question, counting a blank cell as unanswered rather than zero', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(reportCanvas(canvas));
    const result = await canvas.callTool('get-quiz-report', { courseId: '1', quizId: '900' });
    const data = JSON.parse(canvas.textOf(result));

    assert.equal(data.question_statistics.length, 2, 'question columns were not recognised');
    const [q1, q2] = data.question_statistics;
    assert.equal(q1.points_possible, 1);
    assert.deepEqual([q1.responses, q1.full_credit_count, q1.full_credit_rate], [2, 1, 0.5]);
    // Grace left question 102 blank: one response, not two.
    assert.deepEqual([q2.responses, q2.full_credit_count], [1, 1]);

    // Anonymous by default: no real names, and pseudonyms per user id.
    assert.ok(data.students.every(s => /^Student \d+$/.test(s.student)));
    assert.deepEqual(data.students.map(s => s.score), [2, 0]);
  });
});

test('get-quiz-report full format keeps each question\'s points under its own key', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(reportCanvas(canvas));
    const result = await canvas.callTool('get-quiz-report', { courseId: '1', quizId: '900', format: 'full' });
    const data = JSON.parse(canvas.textOf(result));

    assert.ok(data.columns.includes('101: points') && data.columns.includes('102: points'));
    assert.equal(data.columns[0], 'name', 'the byte-order mark leaked into the first column name');
    const ada = data.rows[0];
    assert.equal(ada['101: points'], '1.0');
    assert.equal(ada['102: points'], '1.0');
    assert.equal(ada.sis_id, '', 'SIS id survived anonymisation');
    assert.notEqual(ada.name, 'Ada Lovelace');
  });
});

test('get-quiz-report does not send the Canvas token to a report file on another host', async () => {
  const seen = [];
  const fileHost = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(STUDENT_ANALYSIS_CSV);
  });
  await new Promise(resolve => fileHost.listen(0, resolve));
  try {
    await withMockCanvas(async canvas => {
      const offHost = `http://localhost:${fileHost.address().port}/files/77/download`;
      canvas.setResponse(reportCanvas(canvas, offHost));
      const result = await canvas.callTool('get-quiz-report', { courseId: '1', quizId: '900' });

      assert.ok(!result.isError, canvas.textOf(result));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, undefined);
      // The same-host API calls still carry it.
      assert.match(canvas.requests[0].headers.authorization, /^Bearer /);
    });
  } finally {
    await new Promise(resolve => fileHost.close(resolve));
  }
});

test('get-quiz-report reports a failed generation as a failure, not as still generating', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url, method }) => {
      if (url.startsWith(`${QUIZ_PATH}/reports`)) {
        if (method === 'POST') {
          return { id: 56, report_type: 'student_analysis', includes_all_versions: false,
            progress: { workflow_state: 'failed', message: 'report job crashed' } };
        }
        return [];
      }
      return {};
    });

    const result = await canvas.callTool('get-quiz-report', { courseId: '1', quizId: '900' });
    assert.equal(result.isError, true);
    assert.match(canvas.textOf(result), /report job crashed/);
  });
});

// A question group drawing from a bank puts questions in front of a student
// that are not in the quiz's own question list, so joining against that list
// returned every drawn question with no text and no correct answer.
test('get-quiz-submission-answers joins against the questions that attempt was shown', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.startsWith('/api/v1/courses/1/assignments/300/submissions/10')) {
        return {
          user_id: 10,
          submission_history: [
            { attempt: 1, score: 1, submission_data: [{ question_id: 5001, answer_id: 7, correct: true, points: 1 }] },
          ],
        };
      }
      if (url.startsWith(`${QUIZ_PATH}/submissions`)) return { quiz_submissions: [{ id: 42, user_id: 10 }] };
      if (url.startsWith(`${QUIZ_PATH}/questions`)) {
        return url.includes('quiz_submission_id=42') && url.includes('quiz_submission_attempt=1')
          ? [{ id: 5001, question_text: '<p>Drawn from the bank</p>', answers: [{ id: 7, text: 'Right', weight: 100 }] }]
          : [];
      }
      if (url.startsWith(QUIZ_PATH)) return { id: 900, assignment_id: 300, points_possible: 1 };
      return {};
    });

    const result = await canvas.callTool('get-quiz-submission-answers', { courseId: '1', quizId: '900', userId: '10' });
    const data = JSON.parse(canvas.textOf(result));

    assert.equal(data.answers[0].question_text, 'Drawn from the bank');
    assert.equal(data.answers[0].given_answer, 'Right');
    assert.deepEqual(data.answers[0].correct_answers, ['Right']);
  });
});

test('get-quiz-submission-events explains an empty log instead of presenting it as clean', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ quiz_submission_events: [] }));
    const result = await canvas.callTool('get-quiz-submission-events', { courseId: '1', quizId: '900', submissionId: '42' });
    assert.match(canvas.textOf(result), /Quiz Log Auditing/);
  });
});

test('update-quiz-submission-score sends Canvas the wrapped quiz_submissions shape', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ body }) => ({ quiz_submissions: [{ ...body?.quiz_submissions?.[0], score: 3, kept_score: 3 }] }));
    await canvas.callTool('update-quiz-submission-score', {
      courseId: '1', quizId: '900', submissionId: '42', attempt: 1,
      fudgePoints: 1, questions: { '5001': { score: 2, comment: 'Accepted' } },
    });

    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.url, `${QUIZ_PATH}/submissions/42`);
    assert.deepEqual(write.body, {
      quiz_submissions: [{ attempt: 1, fudge_points: 1, questions: { '5001': { score: 2, comment: 'Accepted' } } }],
    });
  });
});
