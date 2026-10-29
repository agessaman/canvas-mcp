// Anonymized submissions used to leak names typed onto the worksheet itself.
// Canvas knows how it spells a student's name; a worksheet's "Names:" line
// knows nothing of the sort — a partner's first name, a lowercase name wedged
// into a run of underscores, a name joined by "and". Each pattern below is one
// that got through on a real grading pass, rewritten with invented names.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  REAL_NAMES, attachment, headerOf, router, submission, textOf, worksheetHtml,
} from './helpers/gradingFixture.mjs';

/** Assert that no roster name survives anywhere in the tool output. */
function assertNoLeaks(text, { except = [] } = {}) {
  for (const name of REAL_NAMES) {
    if (except.includes(name)) continue;
    assert.ok(
      !new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(text),
      `"${name}" survived anonymization in:\n${text.slice(0, 1200)}`,
    );
  }
}

/** One submission by Avery Nolan (101) whose worksheet carries `nameLine`. */
function worksheetCase(baseUrl, nameLine, body = ['The voyage changed the map.']) {
  const bytes = worksheetHtml(nameLine, body);
  const file = { bytes, filename: 'worksheet.html', contentType: 'text/html' };
  const att = id => attachment(baseUrl, id, 'worksheet.html', bytes.length, 'text/html');
  const subs = {
    101: submission(101, { attachments: [att(1)] }),
    102: submission(102, { attachments: [att(2)] }),
    103: submission(103, { workflow_state: 'unsubmitted', submitted_at: null, attachments: [] }),
    104: submission(104, { attachments: [] }),
  };
  return { files: { 1: file, 2: { ...file } }, submissions: subs };
}

test('a partner first name plus last initial does not survive the name line', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const text = textOf(result);
    assertNoLeaks(text);
    // The partner is enrolled, so they get their own pseudonym rather than [name].
    assert.match(text, /Names: Student \d+, Student \d+/);
    assert.ok(!text.includes('[name]'), 'an enrolled partner should not be blanked');
  });
});

test('a lowercase first name wedged into underscores does not survive', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: ____________casey Avery__________________');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assertNoLeaks(text);
    assert.match(text, /Names: Student \d+, Student \d+/);
  });
});

test('a first name joined by "and" and followed by punctuation does not survive', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Riley and Avery!');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assertNoLeaks(text);
    assert.match(text, /Names: Student \d+, Student \d+/);
  });
});

test('a name label stops at the next label on the line', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Name: Avery Nolan    Period: 3');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assertNoLeaks(text);
    assert.match(text, /Period: 3/, 'the period must survive the name-line pass');
  });
});

test('a history passage keeps first names that happen to match an enrolled student', async () => {
  await withMockCanvas(async api => {
    // Henry Bowen (105) is enrolled; Avery Nolan (101) is the one submitting.
    const { files, submissions } = worksheetCase(
      api.baseUrl,
      'Names: Avery',
      ['Prince Henry sent ships south, and Henry Hudson sailed west.'],
    );
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.match(text, /Prince Henry/, 'a bare first name in body text must not be redacted by default');
    assert.match(text, /Henry Hudson/);
    assertNoLeaks(text, { except: ['Henry'] });
    assert.ok(!text.includes('Bowen'), "the enrolled student's surname still must not appear");
  });
});

test('scrubFirstNamesInBody redacts roster first names in body text when asked', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(
      api.baseUrl,
      'Names: Avery',
      ['Prince Henry sent ships south.'],
    );
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const text = textOf(await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101', scrubFirstNamesInBody: true,
    }));
    assert.ok(!/Prince Henry/.test(text), 'with the flag on, the first name goes too');
    assert.match(text, /Prince Student \d+/);
  });
});

test('anonymous: false leaves the document exactly as submitted', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const result = await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101', anonymous: false,
    });
    const text = textOf(result);
    assert.match(text, /Names: Jordan T, Avery N/);
    assert.ok(!text.includes('[name]'));
    assert.equal(headerOf(result).attempts[0].files[0].redactions, undefined);
  });
});

test('each file reports what was redacted, and an unmatched name raises a warning', async () => {
  await withMockCanvas(async api => {
    // Dakota Fields is not on the roster.
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Dakota Fields and Avery');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const header = headerOf(result);
    const redactions = header.attempts[0].files[0].redactions;
    assert.ok(redactions, 'every file carries its redaction counts when anonymous');
    assert.equal(redactions.unmatched, 1);
    assert.ok(redactions.nameLine >= 2);
    assert.ok(textOf(result).includes('[name]'), 'an unmatchable name is blanked, not left alone');
    assert.ok(
      header.warnings.some(w => /matched nobody in the course/.test(w)),
      `expected an unmatched-name warning, got ${JSON.stringify(header.warnings)}`,
    );
  });
});

test('a named partner who is enrolled is reported with their submission state', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.equal(header.partners.length, 1);
    const [partner] = header.partners;
    assert.equal(partner.user_id, 102);
    assert.equal(partner.submitted, true);
    assert.equal(partner.workflow_state, 'submitted');
    assert.match(partner.student, /^Student \d+$/, 'anonymous mode gives the pseudonym only');
    assert.ok(!JSON.stringify(partner).includes('Jordan'));
  });
});

test('a partner who has not turned anything in is reported as not submitted', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Casey L, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.equal(header.partners.length, 1);
    assert.equal(header.partners[0].user_id, 103);
    assert.equal(header.partners[0].submitted, false);
    assert.equal(header.partners[0].workflow_state, 'unsubmitted');
  });
});

test('a partner name that is not on the roster produces no partner, only an unmatched count', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Dakota Fields and Avery');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.equal(header.partners, undefined);
    assert.equal(header.attempts[0].files[0].redactions.unmatched, 1);
  });
});

test('identical partner uploads are reported as the same work', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.equal(header.partners[0].same_file_hash, true);
  });
});

test('a partner who uploaded different work is reported as such', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    const other = worksheetHtml('Names: Jordan T, Avery N', ['A completely different answer, written alone.']);
    files[2] = { bytes: other, filename: 'worksheet.html', contentType: 'text/html' };
    submissions[102].attachments[0].size = other.length;
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assert.equal(header.partners[0].same_file_hash, false);
  });
});

test('includePartners: false skips partner lookups entirely', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Jordan T, Avery N');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const result = await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101', includePartners: false,
    });
    assert.equal(headerOf(result).partners, undefined);
    assertNoLeaks(textOf(result), {});
  });
});

test('a name label inside a table cell is redacted too', async () => {
  await withMockCanvas(async api => {
    const bytes = Buffer.from(
      '<html><body><table><tr><td>Names: Riley and Avery</td><td>Period: 4</td></tr></table></body></html>',
      'utf-8',
    );
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'cells.html', bytes.length, 'text/html')] }),
      104: submission(104, { attachments: [] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files: { 1: { bytes, filename: 'cells.html', contentType: 'text/html' } }, submissions }));
    const text = textOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    assertNoLeaks(text);
    assert.match(text, /Period: 4/);
  });
});

test('the blanket @napi-rs/canvas warning is gone from submissions that need no rendering', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Avery');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    for (const w of header.warnings ?? []) {
      assert.ok(!/napi-rs\/canvas/.test(w), `a text PDF must not warn about page rendering: ${w}`);
    }
  });
});

test('submitted_at comes back in the course time zone as well as UTC', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = worksheetCase(api.baseUrl, 'Names: Avery');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const header = headerOf(await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' }));
    // 2026-10-26T21:14Z is 14:14 Pacific on the same day.
    assert.equal(header.attempts[0].submitted_at_local, '2026-10-26 14:14 PDT');
  });
});
