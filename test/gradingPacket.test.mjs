// get-grading-packet used to resend the whole packet — instructions, the
// assignment, the full rubric and the full queue — on every per-student call.
// On a 33-student queue that was four or five thousand tokens of identical
// text before any of the student's actual work. These tests pin down the split
// between the one full packet and the per-student calls that follow it.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  ROSTER, assignment, attachment, course, router, submission, textOf, worksheetHtml,
} from './helpers/gradingFixture.mjs';

function classFixture(baseUrl, { queueSize = ROSTER.length } = {}) {
  const files = {};
  const submissions = {};
  ROSTER.forEach((student, i) => {
    const bytes = worksheetHtml(`Names: ${student.name}`, [`Answer from seat ${i + 1}.`]);
    files[i + 1] = { bytes, filename: 'worksheet.html', contentType: 'text/html' };
    submissions[student.id] = submission(student.id, {
      submitted_at: `2026-10-26T${String(12 + i).padStart(2, '0')}:00:00Z`,
      attachments: [attachment(baseUrl, i + 1, 'worksheet.html', bytes.length, 'text/html')],
    });
  });
  // A longer queue than the roster, for the truncation check.
  const queue = [];
  for (let i = 0; i < queueSize; i++) {
    const base = ROSTER[i % ROSTER.length];
    queue.push({ ...submissions[base.id], id: 9000 + i, user_id: 2000 + i });
  }
  return { files, submissions, queue };
}

test('the full packet carries the instructions, assignment, rubric and queue', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));
    assert.match(text, /GRADING INSTRUCTIONS/);
    assert.match(text, /Exploration Worksheet/);
    assert.match(text, /_crit1/, 'the rubric criterion IDs must be in the full packet');
    assert.match(text, /"queue":/);
    assert.match(text, /Assignment description/);
  });
});

test('a per-student call drops everything the full packet already said', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const full = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));
    const perStudent = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userId: '101' }));

    assert.ok(!perStudent.includes('GRADING INSTRUCTIONS'), 'instructions are sent once, not per student');
    assert.ok(!perStudent.includes('"queue":'), 'the queue is sent once, not per student');
    assert.ok(!perStudent.includes('Assignment description'), 'the description is sent once, not per student');
    assert.match(perStudent, /_crit1/, 'the header still names the criterion IDs needed to grade');
    assert.match(perStudent, /Assignment 777 "Exploration Worksheet" · 25 points/);

    // The repeated part of a per-student call, with the student's own work and
    // the per-student header taken out, is what used to be resent every time.
    const work = perStudent.indexOf('--- Student work');
    const repeated = perStudent.slice(0, work);
    assert.ok(
      repeated.length < full.length * 0.1,
      `repeated preamble is ${repeated.length} chars against a ${full.length}-char packet; expected under 10%`,
    );
  });
});

test('userIds returns each student in the order asked, with matching user IDs', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const ids = ['103', '101', '105', '102', '104'];
    const result = await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userIds: ids });
    const text = textOf(result);
    const separators = [...text.matchAll(/--- Student work · user (\d+) ---/g)].map(m => m[1]);
    assert.deepEqual(separators, ids, 'one block per student, in the order given');
    const headers = text.split('--- Student work').slice(1)
      .map(block => JSON.parse(block.slice(block.indexOf('{'), block.indexOf('}\n') + 1 || undefined).split('\n')[0]));
    assert.deepEqual(headers.map(h => String(h.user_id)), ids);
  });
});

test('a batch over the limit is refused rather than silently truncated', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const result = await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', userIds: ['101', '102', '103', '104', '105', '106'],
    });
    assert.match(textOf(result), /the limit is 5/);
  });
});

test('include overrides the defaults in both directions', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));

    const rubricOnly = textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['rubric'],
    }));
    assert.match(rubricOnly, /_crit1/);
    assert.ok(!rubricOnly.includes('GRADING INSTRUCTIONS'));
    assert.ok(!rubricOnly.includes('"queue":'));

    const withQueue = textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', userId: '101', include: ['queue', 'work'],
    }));
    assert.match(withQueue, /"queue":/);
    assert.match(withQueue, /--- Student work · user 101 ---/);
  });
});

test('include: work without a student is an error, not an empty answer', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const result = await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', include: ['work'] });
    assert.match(textOf(result), /no userId or userIds was given/);
  });
});

test('a long queue is cut at queueLimit and says so', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl, { queueSize: 60 });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));

    const capped = JSON.parse(textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' })).split('\n').find(l => l.startsWith('{')));
    assert.equal(capped.queue.length, 50, 'the default queue limit is 50');
    assert.equal(capped.queue_truncated, true);
    assert.match(capped.queue_note, /50 of 60/);

    const wider = JSON.parse(textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', queueLimit: 60 })).split('\n').find(l => l.startsWith('{')));
    assert.equal(wider.queue.length, 60);
    assert.equal(wider.queue_truncated, undefined);
  });
});

test('dates come back in the course time zone beside the UTC originals', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' })).split('\n').find(l => l.startsWith('{')));
    // 2026-10-27T05:00Z is 10pm Pacific on the 26th — a day earlier than it reads.
    assert.equal(summary.assignment.due_at, '2026-10-27T05:00:00Z');
    assert.equal(summary.assignment.due_at_local, '2026-10-26 22:00 PDT');
    // The lock date lands after daylight time ends, so it reads PST.
    assert.equal(summary.assignment.lock_at_local, '2026-11-02 23:59 PST');
    assert.equal(summary.assignment.unlock_at_local, '2026-10-20 00:00 PDT');
    assert.equal(summary.time_zone.zone, 'America/Los_Angeles');
    assert.equal(summary.time_zone.from, 'course');
    assert.ok(summary.queue.every(q => q.submitted_at_local), 'every queued submission gets a local time');
  });
});

test('a course with no time zone of its own falls back to the account', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({
      baseUrl: api.baseUrl, files, submissions, queue,
      course: course({ time_zone: null }),
    }));
    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' })).split('\n').find(l => l.startsWith('{')));
    assert.equal(summary.time_zone.zone, 'America/New_York');
    assert.equal(summary.time_zone.from, 'account');
    assert.equal(summary.assignment.due_at_local, '2026-10-27 01:00 EDT');
  });
});

test('the resubmission instruction covers conditional policies and the local lock date', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));
    assert.match(text, /and under what conditions/);
    assert.match(text, /can apply to only some students/);
    assert.match(text, /lock_at_local/);
    assert.match(text, /"Revise \.\.\." wording for students who are eligible/);
  });
});

test('integrity signals are described as prompts, never findings', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));
    assert.match(text, /Integrity signals are not findings/);
    assert.match(text, /never evidence of copying/);
  });
});

test('one unreadable student does not take the rest of the batch down', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    delete submissions[103];
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));
    const text = textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', userIds: ['101', '103', '102'],
    }));
    const separators = [...text.matchAll(/--- Student work · user (\d+) ---/g)].map(m => m[1]);
    assert.deepEqual(separators, ['101', '103', '102']);
    assert.match(text, /"user_id":"103","error"/);
    assert.match(text, /"user_id":101/);
    assert.match(text, /"user_id":102/);
  });
});

test('the queue reports the worksheet versions of the students read so far', async () => {
  await withMockCanvas(async api => {
    const { files, submissions, queue } = classFixture(api.baseUrl);
    // Two template versions in circulation: student 102 got the revised one.
    files[2] = {
      bytes: worksheetHtml('Names: Jordan Tate', ['Answer.'], ['Question', 'Evidence', 'Analysis', 'Source']),
      filename: 'worksheet.html',
      contentType: 'text/html',
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, queue }));

    await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userIds: ['101', '102'] });
    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', include: ['queue'] })).split('\n').find(l => l.startsWith('{')));
    assert.equal(summary.template_variants.length, 2);
    const headers = summary.template_variants.map(v => v.template_headers).sort();
    assert.deepEqual(headers, ['question | evidence | analysis', 'question | evidence | analysis | source']);
    assert.ok(summary.template_variants.every(v => v.students.every(s => /^Student \d+$/.test(s))));
    assert.match(summary.template_variants_note, /students read in this session/);
  });
});
