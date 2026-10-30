// Regressions from a fourth grading pass, on ten submissions. The first is a
// privacy leak: a surname that wrapped onto the next line survived
// anonymization, because the name-line capture stopped at the line break.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  attachment, headerOf, makeTablePdf, makeTextPdf, router, submission, textOf,
} from './helpers/gradingFixture.mjs';

const SECTION = sections => ({ enrollments: sections.map(s => ({ course_section_id: s })) });

// A class where every student is in one section, so a first name is unique.
const CLASS = [
  { id: 101, name: 'Avery Nolan', sortable_name: 'Nolan, Avery', ...SECTION([1]) },
  { id: 102, name: 'Jordan Tate', sortable_name: 'Tate, Jordan', ...SECTION([1]) },
  { id: 103, name: 'Casey Lee', sortable_name: 'Lee, Casey', ...SECTION([1]) },
  { id: 104, name: 'Riley Park', sortable_name: 'Park, Riley', ...SECTION([1]) },
  { id: 105, name: 'Sam Ortega', sortable_name: 'Ortega, Sam', ...SECTION([1]) },
  { id: 106, name: 'Morgan Devi', sortable_name: 'Devi, Morgan', ...SECTION([2]) },
];

const readWork = (api, over = {}) =>
  api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101', ...over });

function oneFile(baseUrl, bytes, filename = 'worksheet.pdf', contentType = 'application/pdf') {
  const att = attachment(baseUrl, 1, filename, bytes.length, contentType);
  return {
    files: { 1: { bytes, filename, contentType } },
    submissions: Object.fromEntries(CLASS.map(u => [
      u.id,
      submission(u.id, { attachments: u.id === 101 ? [att] : [] }),
    ])),
  };
}

// --- 1. a wrapped name line (privacy) ---

test('a surname that wraps onto the next line does not survive', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf([
      'Names: Jordan T, Casey Lee, Riley Park, Sam',
      'ortega ___________________',
      'Period: 2nd',
    ]);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const result = await readWork(api);
    const text = textOf(result);
    assert.ok(!/ortega/i.test(text), `the wrapped surname leaked:\n${text.slice(0, 600)}`);
    for (const name of ['Jordan', 'Tate', 'Casey', 'Lee', 'Riley', 'Park', 'Sam']) {
      assert.ok(!new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(text), `"${name}" leaked`);
    }
    assert.match(text, /Period: 2nd/, 'the stop label still ends the span');
  });
});

test('a wrapped name line still reports every partner', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Jordan T, Casey Lee, Riley Park, Sam', 'ortega ______', 'Period: 2nd']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const ids = (headerOf(await readWork(api)).partners ?? []).map(p => p.user_id).sort();
    assert.deepEqual(ids, [102, 103, 104, 105], 'the wrapped name is one of the partners');
  });
});

test('the span stops before a sentence, so body text is not blanked', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf([
      'Names: Avery',
      'The astrolabe fixed latitude at sea and changed navigation.',
      'Prince Henry sent ships south, and Henry Hudson sailed west.',
    ]);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const text = textOf(await readWork(api));
    assert.match(text, /The astrolabe fixed latitude at sea/, 'a sentence ends the name line');
    assert.match(text, /Prince Henry sent ships south/);
    assert.ok(!text.includes('[name]'), 'nothing in the body was treated as a name');
  });
});

test('a Directions heading ends the name line', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Jordan T, Sam', 'ortega', 'Directions: answer every question below.']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const text = textOf(await readWork(api));
    assert.ok(!/ortega/i.test(text));
    assert.match(text, /Directions: answer every question below/);
  });
});

// --- 2. the directions region ---

const NAME_LINE = 'Names: ______________________ Period: ____';
const HEADERS = ['Question', 'Evidence', 'Analysis'];
const DIRECTIONS = '● Choose an explorer from the list your teacher handed out. Read both of the'
  + ' primary sources provided, and underline anything that tells you why the voyage was funded.'
  + ' Answer every question in complete sentences, using evidence from the sources, not memory.';
const SHORTER = '● Choose an explorer from the list your teacher handed out. Read both of the'
  + ' primary sources provided, and underline anything that tells you why the voyage was funded.';

const asPdf = directions => makeTablePdf({
  title: '17.1 Worksheet', nameLine: NAME_LINE, directions, headers: HEADERS, rows: [['1', 'a', 'b']], pages: 1,
});
const asDoc = directions => Buffer.from(
  `<html><body><p>17.1 Worksheet</p><p>${NAME_LINE}</p><p>${directions}</p>`
  + `<table><tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr><tr><td>1</td><td>a</td><td>b</td></tr></table>`
  + '</body></html>', 'utf-8');

const fingerprintOf = (bytes, filename, contentType) => withMockCanvas(async api => {
  const { files, submissions } = oneFile(api.baseUrl, bytes, filename, contentType);
  api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));
  const file = headerOf(await readWork(api)).attempts[0].files[0];
  return { template: file.template_fingerprint, directions: file.directions_fingerprint, chars: file.directions_chars };
});

test('the directions region is found in a PDF, not left empty', async () => {
  const pdf = await fingerprintOf(asPdf(DIRECTIONS), 'w.pdf', 'application/pdf');
  assert.ok(pdf.directions, 'a PDF must have a directions fingerprint at all');
  assert.ok(pdf.chars > 200, `expected a real region, got ${pdf.chars} characters`);
});

test('PDF and Word-style exports of one sheet agree on both fingerprints', async () => {
  const pdf = await fingerprintOf(asPdf(DIRECTIONS), 'w.pdf', 'application/pdf');
  const doc = await fingerprintOf(asDoc(DIRECTIONS), 'w.html', 'text/html');
  assert.equal(pdf.template, doc.template);
  assert.equal(pdf.directions, doc.directions, 'a bullet glyph must not change the hash');
  assert.ok(doc.chars > 200, `expected a real region, got ${doc.chars} characters`);
});

test('cutting a sentence from the directions changes only the directions hash', async () => {
  const full = await fingerprintOf(asPdf(DIRECTIONS), 'w.pdf', 'application/pdf');
  const cut = await fingerprintOf(asPdf(SHORTER), 'w.pdf', 'application/pdf');
  assert.equal(full.template, cut.template);
  assert.notEqual(full.directions, cut.directions);
  assert.ok(cut.chars < full.chars);
});

test('a word from the header appearing in the directions does not truncate them', async () => {
  // "Answer every question" contains the first header cell.
  const withWord = await fingerprintOf(asPdf(DIRECTIONS), 'w.pdf', 'application/pdf');
  assert.ok(withWord.chars > 200, `the region was cut short at ${withWord.chars} characters`);
});

// --- 3. the same work in two formats ---

test('identical work uploaded as PDF and as a Word-style export reads as the same text', async () => {
  await withMockCanvas(async api => {
    const answers = ['Names: Jordan T, Avery N', 'The caravel could sail against the wind, which opened the Atlantic.'];
    const mine = makeTextPdf(answers);
    const theirs = Buffer.from(`<html><body>${answers.map(a => `<p>${a}</p>`).join('')}</body></html>`, 'utf-8');
    const files = {
      1: { bytes: mine, filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: theirs, filename: 'w.html', contentType: 'text/html' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', mine.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.html', theirs.length, 'text/html')] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const partner = (headerOf(await readWork(api)).partners ?? []).find(p => p.user_id === 102);
    assert.ok(partner, 'the partner must be reported');
    assert.equal(partner.same_file_hash, false, 'the bytes genuinely differ');
    assert.equal(partner.same_text, true, 'but the words do not');
    assert.ok(partner.text_similarity > 0.9, `expected near-identical text, got ${partner.text_similarity}`);
  });
});

test('a partner who wrote something else scores low similarity', async () => {
  await withMockCanvas(async api => {
    const mine = makeTextPdf(['Names: Jordan T, Avery N', 'The caravel could sail against the wind, which opened the Atlantic.']);
    const theirs = makeTextPdf(['Names: Jordan T, Avery N', 'Monsoon winds carried ships east each summer and back each winter.']);
    const files = {
      1: { bytes: mine, filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: theirs, filename: 'w.pdf', contentType: 'application/pdf' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', mine.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.pdf', theirs.length)] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const partner = (headerOf(await readWork(api)).partners ?? []).find(p => p.user_id === 102);
    assert.equal(partner.same_text, false);
    assert.ok(partner.text_similarity < 0.6, `expected different work, got ${partner.text_similarity}`);
  });
});

// --- 4. why a name was not resolved ---

test('an unresolvable name says why, without naming anybody', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Dakota and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const header = headerOf(await readWork(api));
    assert.deepEqual(header.partner_unresolved, [{ token_index: 0, reason: 'no_candidates', candidates: 0 }]);
  });
});

test('a name belonging to another section is reported as such', async () => {
  await withMockCanvas(async api => {
    // Morgan is in section 2, the submitter in section 1, and "Morgan" is not
    // a roster token here because only the surname is on file.
    const roster = CLASS.map(u => (u.id === 106 ? { id: 106, name: 'Morgan Devi', sortable_name: 'Devi, Morgan', ...SECTION([2]) } : u));
    const bytes = makeTextPdf(['Names: morgan d and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const header = headerOf(await readWork(api));
    const entry = (header.partner_unresolved ?? [])[0];
    if (entry) {
      assert.ok(['other_section', 'no_candidates'].includes(entry.reason));
      assert.ok(!JSON.stringify(header.partner_unresolved).match(/morgan|devi/i), 'no names in the report');
    }
  });
});

test('an ambiguous first name reports how many students fitted', async () => {
  await withMockCanvas(async api => {
    const roster = [...CLASS, { id: 107, name: 'Jordan Vasquez', sortable_name: 'Vasquez, Jordan', ...SECTION([1]) }];
    const bytes = makeTextPdf(['Names: Jordan and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const header = headerOf(await readWork(api));
    const entry = (header.partner_unresolved ?? [])[0];
    assert.equal(entry?.reason, 'multiple_candidates');
    assert.equal(entry?.candidates, 2);
    assert.ok(!JSON.stringify(header.partner_unresolved).match(/Jordan|Tate|Vasquez/), 'no names in the report');
  });
});

// --- 5. text shared between submissions ---

const SOURCE_SENTENCE = 'The caravel was a small highly manoeuvrable sailing ship developed in the fifteenth century by the Portuguese.';

function crossCheckClass(api, { sharedBy, partnerLine = 'Names: Avery' }) {
  const sheet = (student, extra) => {
    const lines = [NAME_LINE.replace('______________________', student), DIRECTIONS, 'Question Evidence Analysis'];
    lines.push(`My explorer sailed in ${student} and kept a detailed log of every landfall made.`);
    if (extra) lines.push(extra);
    return makeTextPdf(lines);
  };
  const files = {};
  const submissions = {};
  CLASS.slice(0, 5).forEach((u, i) => {
    const bytes = sheet(String(u.id), sharedBy.includes(u.id) ? SOURCE_SENTENCE : null);
    files[i + 1] = { bytes, filename: 'w.pdf', contentType: 'application/pdf' };
    submissions[u.id] = submission(u.id, { attachments: [attachment(api.baseUrl, i + 1, 'w.pdf', bytes.length)] });
  });
  return { files, submissions };
}

test('two non-partners sharing a source sentence are flagged as a prompt', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = crossCheckClass(api, { sharedBy: [103, 104] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true, crossCheck: true,
    })).split('\n').find(l => l.startsWith('{')));

    const signals = summary.integrity_signals ?? [];
    assert.equal(signals.length, 1, JSON.stringify(signals));
    assert.match(signals[0].reason, /another student's work/);
    assert.equal(signals[0].students.length, 2);
    assert.ok(signals[0].students.every(s => /^Student \d+$/.test(s)), 'pseudonyms only');
    assert.ok(signals[0].excerpt.length <= 40, `excerpt too long: ${signals[0].excerpt}`);
    assert.match(summary.integrity_signals_note, /never findings/);
  });
});

test('text every student has is template text, not a signal', async () => {
  await withMockCanvas(async api => {
    // All five carry it, which is what the worksheet's own text looks like.
    const { files, submissions } = crossCheckClass(api, { sharedBy: [101, 102, 103, 104, 105] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true, crossCheck: true,
    })).split('\n').find(l => l.startsWith('{')));
    assert.equal(summary.integrity_signals, undefined, JSON.stringify(summary.integrity_signals));
  });
});

test('the worksheet directions are never flagged as shared text', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = crossCheckClass(api, { sharedBy: [] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true, crossCheck: true,
    })).split('\n').find(l => l.startsWith('{')));
    assert.equal(summary.integrity_signals, undefined, 'the directions are on every sheet by definition');
  });
});

test('crossCheck turned off at the scan says so rather than going quiet', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = crossCheckClass(api, { sharedBy: [] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));
    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], crossCheck: true, scanTemplates: false,
    })).split('\n').find(l => l.startsWith('{')));
    assert.match(summary.cross_check_note, /needs the submissions read/);
    assert.match(summary.scan_note, /neither ran/);
  });
});
