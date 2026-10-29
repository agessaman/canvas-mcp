// Regressions from a fifth pass, 34 submissions scanned and 10 read closely.
// The headline is that the cross-submission check was missing copied text
// outright: it hashed sentences, and a PDF's text layer ends a table cell
// wherever the cell ended, so a cell's last sentence has no full stop and runs
// into the next row.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  attachment, headerOf, makeTablePdf, makeTextPdf, router, submission, textOf,
} from './helpers/gradingFixture.mjs';

const SECTION = sections => ({ enrollments: sections.map(s => ({ course_section_id: s })) });
const CLASS = [
  { id: 101, name: 'Avery Nolan', sortable_name: 'Nolan, Avery', ...SECTION([1]) },
  { id: 102, name: 'Jordan Tate', sortable_name: 'Tate, Jordan', ...SECTION([1]) },
  { id: 103, name: 'Casey Lee', sortable_name: 'Lee, Casey', ...SECTION([1]) },
  { id: 104, name: 'Riley Park', sortable_name: 'Park, Riley', ...SECTION([1]) },
  { id: 105, name: 'Sam Ortega', sortable_name: 'Ortega, Sam', ...SECTION([1]) },
];

const HEADERS = ['Question', 'Evidence', 'Analysis'];
const DIRECTIONS_HEADING = 'Directions';
const DIRECTIONS = '● Choose an explorer from the list your teacher handed out. Read both of the'
  + ' primary sources provided, and underline anything that tells you why the voyage was funded.'
  + ' Answer every question in complete sentences, using evidence from the sources, not memory.';

// Fourteen words, no full stop — exactly the shape that ends at a cell edge.
const COPIED = 'the caravel was small and highly manoeuvrable and the portuguese developed it during the fifteenth century';

const packet = (api, args) => api.callTool('get-grading-packet', {
  courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true, ...args,
});
const summaryOf = result => JSON.parse(textOf(result).split('\n').find(l => l.startsWith('{')));

/**
 * One worksheet per student. `copiedBy` get the shared run with DIFFERENT text
 * after it, so the run really does end at a cell edge rather than being a
 * sentence both students happened to finish the same way.
 */
function classWith(api, { copiedBy = [], periodEntry = '2', nameLine = null }) {
  const sheet = (student, copied) => makeTextPdf([
    nameLine ?? `Names: ${student}`,
    'Period:',
    periodEntry,
    DIRECTIONS_HEADING,
    DIRECTIONS,
    'Question Evidence Analysis',
    `Seat ${student} kept a detailed log of every landfall that the voyage made that year.`,
    ...(copied ? [COPIED, `and then student ${student} added a different closing line of their own here.`] : []),
  ]);
  const files = {};
  const submissions = {};
  CLASS.forEach((u, i) => {
    const bytes = sheet(String(u.id), copiedBy.includes(u.id));
    files[i + 1] = { bytes, filename: 'w.pdf', contentType: 'application/pdf' };
    submissions[u.id] = submission(u.id, { attachments: [attachment(api.baseUrl, i + 1, 'w.pdf', bytes.length)] });
  });
  return { files, submissions };
}

// --- 1. shingles, not sentences ---

test('a run with no full stop, running into different next-row text, is flagged', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classWith(api, { copiedBy: [103, 104] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = summaryOf(await packet(api, { crossCheck: true }));
    const signals = summary.integrity_signals ?? [];
    assert.equal(signals.length, 1, JSON.stringify(signals));
    assert.ok(signals[0].words >= 12, `expected a span of 12+ words, got ${signals[0].words}`);
    assert.ok(signals[0].excerpt.length <= 40, `excerpt too long: ${signals[0].excerpt}`);
    assert.deepEqual(signals[0].students.length, 2);
    assert.ok(signals[0].students.every(s => /^Student \d+$/.test(s)));
    assert.match(signals[0].reason, /another student's work/);
  });
});

test('one copied passage is reported once, not once per overlapping window', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classWith(api, { copiedBy: [103, 104] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const signals = summaryOf(await packet(api, { crossCheck: true })).integrity_signals ?? [];
    // A 14-word run is seven overlapping 8-word windows.
    assert.equal(signals.length, 1, `merged spans expected, got ${signals.length}: ${JSON.stringify(signals)}`);
  });
});

test('a short shared phrase is below the bar', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classWith(api, { copiedBy: [] });
    // Nine words: longer than one window, shorter than a span worth reporting.
    const short = 'the voyage was funded by the crown of portugal';
    const patch = id => {
      // Only the nine-word phrase is shared; everything either side differs.
      const bytes = makeTextPdf([
        `Names: ${id}`, 'Period:', '2', DIRECTIONS_HEADING, DIRECTIONS, 'Question Evidence Analysis',
        id === 103
          ? `Magellan crossed the Pacific in ninety eight days, and ${short}, which surprised nobody at court.`
          : `Dias rounded the cape during a storm he never saw, and ${short}, paid for from the treasury.`,
      ]);
      return bytes;
    };
    for (const [idx, id] of [[3, 103], [4, 104]]) {
      const bytes = patch(id);
      files[idx] = { bytes, filename: 'w.pdf', contentType: 'application/pdf' };
      submissions[id] = submission(id, { attachments: [attachment(api.baseUrl, idx, 'w.pdf', bytes.length)] });
    }
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const signals = summaryOf(await packet(api, { crossCheck: true })).integrity_signals ?? [];
    assert.equal(signals.length, 0, `a nine-word phrase should not fire: ${JSON.stringify(signals)}`);
  });
});

test('the worksheet directions are never flagged', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classWith(api, { copiedBy: [] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = summaryOf(await packet(api, { crossCheck: true }));
    assert.equal(summary.integrity_signals, undefined, JSON.stringify(summary.integrity_signals));
  });
});

test('text most of the class wrote is template text, not a signal', async () => {
  await withMockCanvas(async api => {
    const { files, submissions } = classWith(api, { copiedBy: [101, 102, 103, 104, 105] });
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = summaryOf(await packet(api, { crossCheck: true }));
    assert.equal(summary.integrity_signals, undefined, JSON.stringify(summary.integrity_signals));
  });
});

test('partners are not flagged against each other', async () => {
  await withMockCanvas(async api => {
    // 103 and 104 name each other, and share the passage.
    const { files, submissions } = classWith(api, { copiedBy: [] });
    for (const [idx, id] of [[3, 103], [4, 104]]) {
      const bytes = makeTextPdf([
        'Names: Casey Lee, Riley Park', 'Period:', '2', DIRECTIONS_HEADING, DIRECTIONS,
        'Question Evidence Analysis',
        COPIED,
        `and then seat ${id} added a different closing line of their own right here.`,
      ]);
      files[idx] = { bytes, filename: 'w.pdf', contentType: 'application/pdf' };
      submissions[id] = submission(id, { attachments: [attachment(api.baseUrl, idx, 'w.pdf', bytes.length)] });
    }
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const summary = summaryOf(await packet(api, { crossCheck: true }));
    const signals = summary.integrity_signals ?? [];
    assert.ok(
      !signals.some(s => s.students.length === 2),
      `partners who share work should not be flagged: ${JSON.stringify(signals)}`,
    );
  });
});

// --- 2. the student's own period entry must not reach the hash ---

const fingerprintWith = periodLines => withMockCanvas(async api => {
  // A positioned table, because a single-column PDF has no header row for the
  // directions region to end at.
  const bytes = makeTablePdf({
    title: '17.1 Worksheet',
    nameLine: 'Names: ______________________',
    preLines: periodLines,
    directions: DIRECTIONS,
    headers: HEADERS,
    rows: [['1', 'a', 'b']],
    pages: 1,
  });
  const files = { 1: { bytes, filename: 'w.pdf', contentType: 'application/pdf' } };
  const submissions = { 101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', bytes.length)] }) };
  api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));
  const file = headerOf(await api.callTool('get-submission-content', {
    courseId: '1', assignmentId: '777', userId: '101',
  })).attempts[0].files[0];
  return { directions: file.directions_fingerprint, chars: file.directions_chars };
});

test('a Period entry written across several lines does not change the directions hash', async () => {
  const oneLine = await fingerprintWith(['Period: 2', DIRECTIONS_HEADING]);
  // The same sheet where the student wrote their period across several lines.
  const wrapped = await fingerprintWith(['Period:', '__', '2', '__', DIRECTIONS_HEADING]);
  assert.ok(oneLine.directions, 'the directions must hash at all');
  assert.equal(oneLine.directions, wrapped.directions, "the student's own entry is not part of the template");
  assert.equal(oneLine.chars, wrapped.chars);
});

test('the directions region still has real content in it', async () => {
  const one = await fingerprintWith(['Period: 2', DIRECTIONS_HEADING]);
  assert.ok(one.chars > 200, `expected a real region, got ${one.chars} characters`);
});

// --- 3. one entry per unresolved token ---

test('an unresolved name is reported once, not once per redaction pass', async () => {
  await withMockCanvas(async api => {
    // A wrapped name line, which is redacted twice by design.
    const bytes = makeTextPdf(['Names: Dakota Fields, Rowan', 'Vance ______', 'Period: 2']);
    const files = { 1: { bytes, filename: 'w.pdf', contentType: 'application/pdf' } };
    const submissions = { 101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', bytes.length)] }) };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const header = headerOf(await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101',
    }));
    const entries = header.partner_unresolved ?? [];
    const indexes = entries.map(e => e.token_index);
    assert.deepEqual(indexes, [...new Set(indexes)], `duplicate token_index: ${JSON.stringify(entries)}`);
    assert.ok(entries.length <= 2, `two unknown names should give at most two entries, got ${entries.length}`);
    assert.ok(!JSON.stringify(entries).match(/Dakota|Fields|Rowan|Vance/), 'no names in the report');
  });
});

// --- 4. near_identical ---

test('the same work in two formats reads as near identical', async () => {
  await withMockCanvas(async api => {
    const answers = [
      'Names: Jordan T, Avery N',
      'The caravel could sail against the wind, which opened the Atlantic to Europe.',
      'Portuguese crews used it to work down the African coast and back again each season.',
      'The astrolabe let a navigator fix latitude from the sun without sight of land.',
      'Together the two made a voyage that had been guesswork into something repeatable.',
    ];
    const mine = makeTextPdf(answers);
    const theirs = Buffer.from(`<html><body>${answers.map(a => `<p>${a}</p>`).join('')}<p>page 1</p></body></html>`, 'utf-8');
    const files = {
      1: { bytes: mine, filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: theirs, filename: 'w.html', contentType: 'text/html' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', mine.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.html', theirs.length, 'text/html')] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const partner = (headerOf(await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101',
    })).partners ?? []).find(p => p.user_id === 102);
    assert.equal(partner.near_identical, true, `similarity was ${partner.text_similarity}`);
    assert.equal(partner.same_text, false, 'same_text stays strict: the extra line means not identical');
    assert.ok(partner.text_similarity >= 0.9);
  });
});

test('different work is not near identical', async () => {
  await withMockCanvas(async api => {
    const mine = makeTextPdf(['Names: Jordan T, Avery N', 'The caravel could sail against the wind, which opened the Atlantic.']);
    const theirs = makeTextPdf(['Names: Jordan T, Avery N', 'Monsoon winds carried ships east each summer and back again each winter.']);
    const files = {
      1: { bytes: mine, filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: theirs, filename: 'w.pdf', contentType: 'application/pdf' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', mine.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.pdf', theirs.length)] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster: CLASS }));

    const partner = (headerOf(await api.callTool('get-submission-content', {
      courseId: '1', assignmentId: '777', userId: '101',
    })).partners ?? []).find(p => p.user_id === 102);
    assert.equal(partner.near_identical, false);
    assert.equal(partner.same_text, false);
  });
});
