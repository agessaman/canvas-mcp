// Round 6: the grading practices are the teacher's, not the server's.
//
// A run of a real class turned up five things the tools could not do, and one
// thing they should never have done: ship a particular teacher's habits —
// comment length, what copied work is worth — as if they were everybody's.
// These tests pin the fix: a catalogue of questions with no answers in it, a
// store for whatever the teacher said, and the four capabilities the run
// needed (sources, sections, the late policy, a plan that survives a session).
//
// Every name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  ROSTER, SECTIONS, assignment, attachment, router, submission, textOf, worksheetHtml,
} from './helpers/gradingFixture.mjs';

const summaryOf = text => JSON.parse(text.split('\n').find(l => l.startsWith('{')));

function classOf(api, { bodies = {}, roster = ROSTER } = {}) {
  const files = {};
  const submissions = {};
  roster.forEach((student, i) => {
    const body = bodies[student.id] ?? [`Answer from seat ${i + 1}.`];
    files[i + 1] = { bytes: worksheetHtml(`Names: ${student.name}`, body), filename: 'w.html', contentType: 'text/html' };
    submissions[student.id] = submission(student.id, {
      attachments: [attachment(api.baseUrl, i + 1, 'w.html', 400, 'text/html')],
    });
  });
  return { files, submissions };
}

// --- 1. no grading preference ships with the server ---

test('the packet asks for the practices it needs instead of assuming them', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classOf(api);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));

    assert.match(text, /Not yet answered/);
    for (const key of ['comment_shape', 'copied_work', 'copy_threshold', 'below_lowest_rating', 'posting']) {
      assert.match(text, new RegExp(key), `${key} should be asked about`);
    }
    // The habits a previous version stated as rules.
    assert.doesNotMatch(text, /2.3 sentences/);
    assert.doesNotMatch(text, /Feedback is OFF by default/);
    assert.doesNotMatch(text, /copied box earns no credit/i);
  });
});

test('a recorded practice is applied, and a course answer beats the default', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classOf(api);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    await api.callTool('set-grading-preferences', {
      answers: { comment_shape: 'one line naming the next step', copied_work: 'no credit for the copied part' },
    });
    await api.callTool('set-grading-preferences', {
      courseId: '1',
      answers: { comment_shape: 'a paragraph per criterion for this course' },
    });

    const read = JSON.parse(textOf(await api.callTool('get-grading-preferences', { courseId: '1' })));
    const shape = read.preferences.find(p => p.key === 'comment_shape');
    assert.equal(shape.answer, 'a paragraph per criterion for this course');
    assert.equal(shape.scope, 'course');
    const copied = read.preferences.find(p => p.key === 'copied_work');
    assert.equal(copied.scope, 'default', 'a course that says nothing falls back to the default');

    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777' }));
    assert.match(text, /On record/);
    assert.match(text, /a paragraph per criterion for this course/);
    assert.doesNotMatch(text, /- comment_shape: When you do write a comment/, 'an answered question is not asked again');
  });
});

test('an answer is forgotten when it is cleared, and becomes an open question again', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({ baseUrl: api.baseUrl }));
    await api.callTool('set-grading-preferences', { answers: { posting: 'hold them and release together' } });
    await api.callTool('set-grading-preferences', { answers: { posting: '' } });
    const read = JSON.parse(textOf(await api.callTool('get-grading-preferences', {})));
    assert.equal(read.preferences.find(p => p.key === 'posting').answer, undefined);
    assert.ok(read.open_questions > 0);
  });
});

// --- 2. the late policy, between the score entered and the score seen ---

test('the dry run prices the late deduction, not just the rubric total', async () => {
  await withMockCanvas(async api => {
    const late = submission(101, { late: true, seconds_late: 90000, submitted_at: '2026-10-28T12:00:00Z' });
    api.setResponse(router({
      baseUrl: api.baseUrl,
      submissions: { 101: late },
      latePolicy: {
        late_policy: {
          late_submission_deduction_enabled: true,
          late_submission_deduction: 10,
          late_submission_interval: 'day',
          late_submission_minimum_percent_enabled: false,
        },
      },
    }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', score: 23, dryRun: true,
    })));
    assert.equal(preview.total, 23);
    // 90000 seconds is two started days at 10% of 25 points.
    assert.equal(preview.late.points_deducted, 5);
    assert.equal(preview.final_score_after_late_policy, 18);
    assert.match(preview.late.explanation, /2 days late/);
  });
});

test('clearing the late marker stops the deduction and reaches Canvas on the wire', async () => {
  await withMockCanvas(async api => {
    const late = submission(101, { late: true, seconds_late: 90000 });
    api.setResponse(router({
      baseUrl: api.baseUrl,
      submissions: { 101: late },
      latePolicy: {
        late_policy: {
          late_submission_deduction_enabled: true,
          late_submission_deduction: 10,
          late_submission_interval: 'day',
        },
      },
    }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', score: 23, latePolicyStatus: 'none', dryRun: true,
    })));
    assert.equal(preview.late.points_deducted, 0, 'a cleared marker is not deducted for');

    await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', score: 23, latePolicyStatus: 'none',
    });
    const write = api.requests.filter(r => r.method === 'PUT').pop();
    assert.equal(write.body.submission.late_policy_status, 'none');
    assert.equal(write.body.submission.posted_grade, '23');
  });
});

// --- 3. the course's own scale and the rubric's own floor ---

test('the packet carries the course letter cutoffs in points, not an assumed scale', async () => {
  await withMockCanvas(async api => {
    const standard = {
      id: 52,
      title: 'District Scale',
      // No D-: the cut from D to F is a single step, which an assumed scale got wrong.
      grading_scheme: [
        { name: 'A', value: 0.93 }, { name: 'B', value: 0.83 },
        { name: 'C', value: 0.73 }, { name: 'D', value: 0.60 }, { name: 'F', value: 0 },
      ],
    };
    api.setResponse(router({
      baseUrl: api.baseUrl,
      assignment: assignment({ grading_standard_id: 52 }),
      gradingStandard: standard,
    }));
    const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['assignment'],
    })));
    assert.equal(summary.grading_standard.name, 'District Scale');
    const letters = summary.grading_standard.cutoffs.map(c => c.letter);
    assert.deepEqual(letters, ['A', 'B', 'C', 'D', 'F']);
    assert.equal(summary.grading_standard.cutoffs.find(c => c.letter === 'D').min_points, 15);
  });
});

test('a criterion scored under its lowest rating is flagged, with the teacher\'s rule if known', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({ baseUrl: api.baseUrl }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_crit2', points: 0 }],
    })));
    assert.ok(preview.notes.some(n => /Below the lowest rating/.test(n)));
    assert.ok(preview.notes.some(n => /has not said whether/.test(n)), 'and asks, because nothing is on record');

    await api.callTool('set-grading-preferences', {
      courseId: '1', answers: { below_lowest_rating: 'yes, zero is allowed for copied work' },
    });
    const after = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true,
      rubric: [{ criterionId: '_crit2', points: 0 }],
    })));
    assert.ok(after.notes.some(n => /zero is allowed for copied work/.test(n)));
    assert.ok(!after.notes.some(n => /has not said whether/.test(n)));
  });
});

// --- 4. sections, because they decided what a match meant ---

test('the queue names the section each student is in', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classOf(api);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: false,
    })));
    assert.ok(summary.queue.every(q => Array.isArray(q.sections) && q.sections.length));
    assert.ok(summary.queue.some(q => q.sections.includes('Period 1')));
  });
});

test('a match between two students says whether they share a section and who was first', async () => {
  await withMockCanvas(async api => {
    const shared = 'The fleet rounded the cape in heavy weather and claimed the coast for the crown that year.';
    const sameSection = ROSTER.filter(s => s.enrollments?.[0]?.course_section_id === 1).slice(0, 2);
    assert.ok(sameSection.length === 2, 'fixture needs two students in one section');
    const bodies = Object.fromEntries(sameSection.map(s => [s.id, [shared]]));
    const { files, submissions } = classOf(api, { bodies });
    submissions[sameSection[0].id].submitted_at = '2026-10-26T09:00:00Z';
    submissions[sameSection[1].id].submitted_at = '2026-10-26T14:00:00Z';
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true, crossCheck: true,
    })));
    assert.ok(summary.integrity_signals?.length, JSON.stringify(summary.template_scan));
    const signal = summary.integrity_signals[0];
    assert.equal(signal.same_section, true);
    assert.match(signal.reading, /Same section/);
    assert.ok(signal.submitted_first, 'the earlier submission is named');
  });
});

// --- 5. the sources the assignment sent students to ---

test('work lifted from a linked page is reported with the run length and the page', async () => {
  const passage = 'The expedition left the harbour in the spring and followed the coast southward for many weeks, '
    + 'charting every inlet it passed and trading for provisions wherever a settlement allowed it.';
  const page = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><p>${passage}</p></body></html>`);
  });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${page.address().port}/article`;
  try {
    await withMockCanvas(async api => {
      const copier = ROSTER[0];
      const { files, submissions } = classOf(api, { bodies: { [copier.id]: [passage] } });
      api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
      const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
        courseId: '1', assignmentId: '777', include: ['queue'],
        scanTemplates: true, sourceCheck: true, sourceUrls: [sourceUrl],
      })));
      assert.equal(summary.sources_read.length, 1);
      const hit = summary.source_matches?.[0];
      assert.ok(hit, JSON.stringify(summary.sources_failed ?? summary.source_check_note));
      assert.ok(hit.longest_match >= 20, `expected a long run, got ${hit.longest_match}`);
      assert.equal(hit.matches[0].source, sourceUrl);
      assert.match(summary.source_matches_note, /never a finding/);
    });
  } finally {
    await new Promise(resolve => page.close(resolve));
  }
});

test('a source that cannot be fetched is named rather than silently skipped', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classOf(api);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'],
      scanTemplates: true, sourceCheck: true, sourceUrls: ['https://example.invalid/missing-page'],
    })));
    assert.equal(summary.sources_failed.length, 1);
    assert.match(summary.sources_failed_note, /not compared against/);
  });
});

// --- 6. the plan that outlives the session ---

test('a plan is saved, priced against the course scale and the late policy, then posted', async () => {
  await withMockCanvas(async api => {
    const late = submission(101, { late: true, seconds_late: 90000 });
    api.setResponse(router({
      baseUrl: api.baseUrl,
      submissions: { 101: late, 102: submission(102) },
      latePolicy: {
        late_policy: {
          late_submission_deduction_enabled: true,
          late_submission_deduction: 10,
          late_submission_interval: 'day',
        },
      },
    }));

    await api.callTool('save-grading-plan', {
      courseId: '1',
      assignmentId: '777',
      note: 'Copied boxes earn no credit, per the teacher.',
      entries: [
        { userId: '101', student: 'Student 1', rubric: [{ criterionId: '_crit1', points: 14 }, { criterionId: '_crit2', points: 9 }] },
        { userId: '102', student: 'Student 2', rubric: [{ criterionId: '_crit1', points: 10 }, { criterionId: '_crit2', points: 5 }] },
      ],
    });

    const priced = JSON.parse(textOf(await api.callTool('get-grading-plan', { courseId: '1', assignmentId: '777' })));
    const first = priced.entries.find(e => e.user_id === '101');
    assert.equal(first.total, 23);
    assert.equal(first.points_deducted, 5, 'the plan is priced against the policy in force');
    assert.equal(first.final_score, 18);
    assert.equal(priced.distribution.scored, 2);
    assert.match(priced.posting, /visible to that student at once/);
    assert.equal(priced.plan_note, 'Copied boxes earn no credit, per the teacher.');

    const posted = JSON.parse(textOf(await api.callTool('post-grading-plan', { courseId: '1', assignmentId: '777' })));
    assert.equal(posted.posted, 2);
    assert.deepEqual(posted.still_unposted, []);

    const again = JSON.parse(textOf(await api.callTool('post-grading-plan', { courseId: '1', assignmentId: '777' })));
    assert.equal(again.posted, 0, 'a second call does not regrade what is already posted');
  });
});

test('one student failing to post does not cost the rest of the class', async () => {
  await withMockCanvas(async api => {
    const base = router({ baseUrl: api.baseUrl, submissions: { 101: submission(101), 102: submission(102) } });
    api.setResponse(({ url, method, body }) => {
      if (method === 'PUT' && /submissions\/101$/.test(url.split('?')[0])) {
        return { __status: 500, __body: { errors: [{ message: 'Canvas is having a moment' }] } };
      }
      return base({ url, method, body });
    });
    await api.callTool('save-grading-plan', {
      courseId: '1',
      assignmentId: '777',
      entries: [
        { userId: '101', score: 20 },
        { userId: '102', score: 22 },
      ],
    });
    const posted = JSON.parse(textOf(await api.callTool('post-grading-plan', { courseId: '1', assignmentId: '777' })));
    assert.equal(posted.posted, 1);
    assert.equal(posted.failed, 1);
    assert.deepEqual(posted.still_unposted, ['101']);
  });
});

test('a plan reports what moved underneath it before anything is posted', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({ baseUrl: api.baseUrl, submissions: { 101: submission(101) } }));
    await api.callTool('save-grading-plan', {
      courseId: '1', assignmentId: '777', entries: [{ userId: '101', score: 20 }],
    });

    // The teacher changes the course policy between the plan and the posting.
    api.setResponse(router({
      baseUrl: api.baseUrl,
      submissions: { 101: submission(101), 109: submission(109) },
      latePolicy: {
        late_policy: { late_submission_deduction_enabled: true, late_submission_deduction: 20, late_submission_interval: 'day' },
      },
    }));
    const priced = JSON.parse(textOf(await api.callTool('get-grading-plan', { courseId: '1', assignmentId: '777' })));
    assert.ok(priced.changed_since_plan.some(c => /late policy has changed/.test(c)));
    assert.ok(priced.changed_since_plan.some(c => /not in the plan/.test(c)));
  });
});

// --- 7. the name line, read as a name line ---

test('a Period label whose colon wrapped is not read as a partner', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml(`Names: ${ROSTER[0].name}\nPeriod\n: 4`, ['An answer.']);
    const files = { 1: { bytes, filename: 'w.html', contentType: 'text/html' } };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.html', 400, 'text/html')] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userId: '101' }));
    const header = JSON.parse(text.split('\n').find(l => l.startsWith('{')));
    assert.equal(header.partner_unresolved, undefined, '"Period" is a label, not a classmate');
    assert.ok(!(header.warnings ?? []).some(w => /matched nobody/.test(w)));
  });
});

test('a stray lowercase word on the name line is not reported as a missing partner', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml(`Names: ${ROSTER[0].name} and my guy`, ['An answer.']);
    const files = { 1: { bytes, filename: 'w.html', contentType: 'text/html' } };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.html', 400, 'text/html')] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userId: '101' }));
    const header = JSON.parse(text.split('\n').find(l => l.startsWith('{')));
    assert.equal(header.partner_unresolved, undefined, 'a word that is not a name is not a partner to hunt for');
  });
});

test('an empty name line is reported as the ordinary case, not as a finding', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classOf(api);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', userId: '101' }));
    const header = JSON.parse(text.split('\n').find(l => l.startsWith('{')));
    assert.ok((header.warnings ?? []).some(w => /says nothing on its own/.test(w)));
  });
});

// --- 8. what the assignment told students ---

test('the rules the description states to students are pulled out of it', async () => {
  await withMockCanvas(async api => {
    const described = assignment({
      description: '<p>Use your own words. Copying from a website will result in a zero on the assignment.</p>'
        + '<p>Answer every box in the table.</p>',
    });
    api.setResponse(router({ baseUrl: api.baseUrl, assignment: described }));
    const summary = summaryOf(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['assignment'],
    })));
    assert.ok(summary.assignment_terms.some(t => /zero on the assignment/.test(t)));
    assert.match(summary.assignment_terms_note, /what students were told/);
  });
});

// --- 9. nothing identifying ships in the instructions ---

test('no school, course or student of anyone\'s is named in what the tools say', async () => {
  await withMockCanvas(async api => {
    const tools = await api.listTools();
    const spoken = tools.map(t => `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`).join('\n')
      + textOf(await api.callTool('get-grading-packet', { courseId: '1', assignmentId: '777', include: ['instructions'] }));
    // Nothing from the run these tools were built from, and nothing that
    // could only have come from one school's gradebook.
    for (const leak of [/\bGFHS\b/, /Mariners/i, /Gessaman/i, /\bwednet\b/i, /Granite Falls/i, /\bP[1-7]\b/]) {
      assert.doesNotMatch(spoken, leak, `${leak} must not appear in anything the tools say`);
    }
  });
});

test('an address inside the teacher\'s own network is refused, not fetched', async () => {
  // Checked against the module directly: the mock-Canvas harness opts into
  // loopback so it can serve a stand-in source page, and this is the rule
  // that applies without that opt-in.
  const previous = process.env.CANVAS_MCP_ALLOW_LOCAL_SOURCES;
  delete process.env.CANVAS_MCP_ALLOW_LOCAL_SOURCES;
  try {
    const { fetchSources } = await import('../dist/sourceCheck.js');
    const { sources, failures } = await fetchSources([
      { url: 'http://127.0.0.1:9/page' },
      { url: 'http://192.168.1.10/wiki' },
      { url: 'http://localhost/notes' },
      { url: 'file:///etc/passwd' },
    ]);
    assert.equal(sources.length, 0);
    assert.equal(failures.length, 4);
    assert.ok(failures.every(f => /will fetch/.test(f.error)));
  } finally {
    if (previous !== undefined) process.env.CANVAS_MCP_ALLOW_LOCAL_SOURCES = previous;
  }
});
