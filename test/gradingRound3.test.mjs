// Regressions from a third grading pass. Three are about names a worksheet
// carries that Canvas does not spell the same way, and one is about pseudonyms
// that moved between builds — which makes "Student 7 needs a retake" in a
// teacher's notes point at nobody.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  ROSTER, attachment, headerOf, makeTablePdf, makeTextPdf, router, submission, textOf,
} from './helpers/gradingFixture.mjs';

const readWork = (api, over = {}) =>
  api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101', ...over });

function oneFile(baseUrl, bytes, filename = 'worksheet.pdf', contentType = 'application/pdf', extraSubs = {}) {
  return {
    files: { 1: { bytes, filename, contentType } },
    submissions: {
      101: submission(101, { attachments: [attachment(baseUrl, 1, filename, bytes.length, contentType)] }),
      102: submission(102, { attachments: [] }),
      103: submission(103, { attachments: [] }),
      ...extraSubs,
    },
  };
}

// --- 1. the submitter's own name, however they spell it ---

test("the submitter's accented, hyphenated name written plainly still resolves", async () => {
  await withMockCanvas(async api => {
    const roster = [
      { id: 101, name: "José-Luis O'Neil", short_name: 'José-Luis', sortable_name: "O'Neil, José-Luis", enrollments: [{ course_section_id: 1 }] },
      ...ROSTER.slice(1),
    ];
    const bytes = makeTextPdf(['Names: jose luis oneil']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const result = await readWork(api);
    const header = headerOf(result);
    assert.match(textOf(result), new RegExp(`Names: ${header.student}\\b`));
    assert.equal(header.attempts[0].files[0].redactions.unmatched, 0);
    assert.ok(!/jose|luis|oneil/i.test(textOf(result)), 'no spelling of the name survives');
  });
});

test("the submitter's first name alone resolves to their pseudonym", async () => {
  await withMockCanvas(async api => {
    const roster = [
      { id: 101, name: "José-Luis O'Neil", sortable_name: "O'Neil, José-Luis", enrollments: [{ course_section_id: 1 }] },
      ...ROSTER.slice(1),
    ];
    const bytes = makeTextPdf(['Names: Jose']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const result = await readWork(api);
    assert.equal(headerOf(result).attempts[0].files[0].redactions.unmatched, 0);
    assert.match(textOf(result), new RegExp(`Names: ${headerOf(result).student}\\b`));
  });
});

test('a preferred name that differs from the legal name resolves', async () => {
  await withMockCanvas(async api => {
    const roster = [
      { id: 101, name: 'Margaret Nolan', short_name: 'Peggy', sortable_name: 'Nolan, Margaret', enrollments: [{ course_section_id: 1 }] },
      ...ROSTER.slice(1),
    ];
    const bytes = makeTextPdf(['Names: Peggy']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const result = await readWork(api);
    assert.equal(headerOf(result).attempts[0].files[0].redactions.unmatched, 0);
    assert.ok(!/peggy|margaret/i.test(textOf(result)));
  });
});

// --- 2. informal partner names, within the submitter's section ---

test('a first name plus last initial maps to the one classmate who fits', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Jordan T, Avery N']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const header = headerOf(await readWork(api));
    const partner = (header.partners ?? []).find(p => p.user_id === 102);
    assert.ok(partner, `expected Jordan T to resolve, got ${JSON.stringify(header.partners)}`);
    assert.equal(partner.submitted, true);
  });
});

test('a lowercase first name alone maps when it is unique in the section', async () => {
  await withMockCanvas(async api => {
    // A name only the fuzzy pass can reach: not a roster token on its own.
    const roster = ROSTER.map(u => (u.id === 103 ? { ...u, name: 'Casey Lindqvist', sortable_name: 'Lindqvist, Casey' } : u));
    const bytes = makeTextPdf(['Names: casey and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const header = headerOf(await readWork(api));
    assert.ok((header.partners ?? []).some(p => p.user_id === 103), JSON.stringify(header.partners));
    assert.equal(header.attempts[0].files[0].redactions.unmatched, 0);
  });
});

test('a first name shared by two students in the section stays unmatched, with a count', async () => {
  await withMockCanvas(async api => {
    // Two Jordans in section 1, so no guess is safe.
    const roster = [
      ...ROSTER,
      { id: 107, name: 'Jordan Vasquez', sortable_name: 'Vasquez, Jordan', enrollments: [{ course_section_id: 1 }] },
    ];
    const bytes = makeTextPdf(['Names: Jordan and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const result = await readWork(api);
    const file = headerOf(result).attempts[0].files[0];
    assert.ok(textOf(result).includes('[name]'), 'an ambiguous first name is not guessed');
    assert.equal(file.redactions.unmatched, 1);
    assert.ok(
      (file.name_line_notes ?? []).some(n => /fits 2 students/.test(n)),
      `expected a candidate count, got ${JSON.stringify(file.name_line_notes)}`,
    );
    assert.ok(
      !(file.name_line_notes ?? []).join(' ').match(/Jordan|Tate|Vasquez/),
      'the note must not name the candidates',
    );
  });
});

test('a first name shared across sections is resolved to the one in this section', async () => {
  await withMockCanvas(async api => {
    // Two Jordans, so the name alone is ambiguous course-wide. Only one of
    // them is in the submitter's section, which is what makes the guess safe.
    const roster = [
      ...ROSTER,
      { id: 108, name: 'Jordan Vasquez', sortable_name: 'Vasquez, Jordan', enrollments: [{ course_section_id: 2 }] },
    ];
    const bytes = makeTextPdf(['Names: Jordan and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const header = headerOf(await readWork(api));
    const partner = (header.partners ?? []).find(p => p.user_id === 102);
    assert.ok(partner, `expected the section-1 Jordan, got ${JSON.stringify(header.partners)}`);
    assert.equal(partner.match, 'fuzzy', 'a guess is reported as a guess');
    assert.ok(!(header.partners ?? []).some(p => p.user_id === 108), 'the other section\'s Jordan is not named');
    assert.equal(header.attempts[0].files[0].redactions.unmatched, 0);
  });
});

test('a full roster name is an exact match, not a guess', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Riley Okafor, Avery N']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const partners = headerOf(await readWork(api)).partners ?? [];
    assert.equal(partners.find(p => p.user_id === 104)?.match, 'exact');
  });
});

test('fuzzyPartners: false leaves an ambiguous first name alone', async () => {
  await withMockCanvas(async api => {
    const roster = [
      ...ROSTER,
      { id: 108, name: 'Jordan Vasquez', sortable_name: 'Vasquez, Jordan', enrollments: [{ course_section_id: 2 }] },
    ];
    const bytes = makeTextPdf(['Names: Jordan and Avery']);
    const { files, submissions } = oneFile(api.baseUrl, bytes);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions, roster }));

    const result = await readWork(api, { fuzzyPartners: false });
    assert.ok(textOf(result).includes('[name]'), 'with guessing off the name is blanked');
    assert.equal(headerOf(result).attempts[0].files[0].redactions.unmatched, 1);
  });
});

// --- 3. one template, whatever it was exported as ---

// Long enough to wrap in a PDF, the way a real sheet's directions do, and
// bulleted — a bullet glyph does not survive a PDF export intact.
const DIRECTIONS = '\u25cf Choose an explorer from the list your teacher handed out. Read both of the primary'
  + ' sources provided, and underline anything that tells you why the voyage was funded. Answer every'
  + ' question in complete sentences, using evidence from the sources rather than from memory.';
const SHORTER = '\u25cf Choose an explorer from the list your teacher handed out. Read both of the primary'
  + ' sources provided, and underline anything that tells you why the voyage was funded.';
const NAME_LINE = 'Names: ______________________ Period: ____';
const HEADERS = ['Question', 'Evidence', 'Analysis'];

const worksheetHtmlDoc = directions => Buffer.from(
  '<html><body><p>17.1 Worksheet</p>'
  + `<p>${NAME_LINE}</p>`
  + `<p>${directions}</p>`
  + `<table><tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr><tr><td>1</td><td>a</td><td>b</td></tr></table>`
  + '</body></html>', 'utf-8');

const worksheetPdfDoc = directions => makeTablePdf({
  title: '17.1 Worksheet', nameLine: NAME_LINE, directions, headers: HEADERS, rows: [['1', 'a', 'b']], pages: 1,
});

async function fingerprintOf(bytes, filename, contentType) {
  return withMockCanvas(async api => {
    const { files, submissions } = oneFile(api.baseUrl, bytes, filename, contentType);
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    const file = headerOf(await readWork(api)).attempts[0].files[0];
    return { template: file.template_fingerprint, directions: file.directions_fingerprint, chars: file.directions_chars };
  });
}

test('the same document exported as PDF and as a Word-style export fingerprints identically', async () => {
  const asPdf = await fingerprintOf(worksheetPdfDoc(DIRECTIONS), 'w.pdf', 'application/pdf');
  const asDoc = await fingerprintOf(worksheetHtmlDoc(DIRECTIONS), 'w.html', 'text/html');
  assert.ok(asPdf.template, 'the PDF must have a fingerprint at all');
  assert.equal(asPdf.template, asDoc.template, 'one template must not split by file format');
  assert.equal(asPdf.directions, asDoc.directions, 'and the directions must hash the same in both');
  assert.ok(asPdf.chars > 200, `expected a real directions region, got ${asPdf.chars} characters`);
  assert.ok(asDoc.chars > 200, `expected a real directions region, got ${asDoc.chars} characters`);
});

test('cutting a sentence from the directions moves only the directions fingerprint', async () => {
  const full = await fingerprintOf(worksheetPdfDoc(DIRECTIONS), 'w.pdf', 'application/pdf');
  const trimmed = await fingerprintOf(worksheetPdfDoc(SHORTER), 'w.pdf', 'application/pdf');
  assert.equal(full.template, trimmed.template, 'the table did not change');
  assert.ok(full.directions && trimmed.directions);
  assert.notEqual(full.directions, trimmed.directions, 'the directions did');
});

test('template_variants groups by the template and directions together', async () => {
  await withMockCanvas(async api => {
    const files = {
      1: { bytes: worksheetPdfDoc(DIRECTIONS), filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: worksheetHtmlDoc(DIRECTIONS), filename: 'w.html', contentType: 'text/html' },
      3: { bytes: worksheetPdfDoc(SHORTER), filename: 'w.pdf', contentType: 'application/pdf' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', files[1].bytes.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.html', files[2].bytes.length, 'text/html')] }),
      103: submission(103, { attachments: [attachment(api.baseUrl, 3, 'w.pdf', files[3].bytes.length)] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const summary = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true,
    })).split('\n').find(l => l.startsWith('{')));

    // Two students share a template AND directions despite different formats;
    // the third has the same table under edited directions.
    assert.equal(summary.template_variants.length, 2, JSON.stringify(summary.template_variants));
    const sizes = summary.template_variants.map(v => v.students.length).sort();
    assert.deepEqual(sizes, [1, 2]);
    const templates = new Set(summary.template_variants.map(v => v.template_fingerprint));
    assert.equal(templates.size, 1, 'the table is the same in all three');
    const directions = new Set(summary.template_variants.map(v => v.directions_fingerprint));
    assert.equal(directions.size, 2, 'the directions are not');
  });
});

// --- 4. pseudonyms that stay put ---

test('a student keeps their number across server restarts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-stable-'));
  process.env.CANVAS_MCP_STATE_DIR = stateDir;
  try {
    const labelFor = async userId => withMockCanvas(async api => {
      const bytes = makeTextPdf(['Names: Avery']);
      const { files, submissions } = oneFile(api.baseUrl, bytes);
      submissions[userId] = submissions[userId] ?? submission(Number(userId), { attachments: [] });
      api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
      const header = headerOf(await api.callTool('get-submission-content', {
        courseId: '1', assignmentId: '777', userId: String(userId),
      }));
      return header.student;
    }, { stateDir });

    // Each call is a separate server process, reading the same store.
    const first = await labelFor(101);
    const second = await labelFor(101);
    assert.match(first, /^Student \d+$/);
    assert.equal(first, second, 'the same student must keep the same number across restarts');

    const other = await labelFor(103);
    assert.notEqual(other, first, 'a different student gets a different number');
    assert.equal(await labelFor(103), other);
    assert.equal(await labelFor(101), first, 'and the first student still has theirs');
  } finally {
    delete process.env.CANVAS_MCP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the stored map holds ids and numbers, never names', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-privacy-'));
  process.env.CANVAS_MCP_STATE_DIR = stateDir;
  try {
    await withMockCanvas(async api => {
      const bytes = makeTextPdf(['Names: Avery Nolan']);
      const { files, submissions } = oneFile(api.baseUrl, bytes);
      api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
      await readWork(api);
    }, { stateDir });
    const raw = fs.readFileSync(path.join(stateDir, 'pseudonyms.json'), 'utf-8');
    for (const name of ['Avery', 'Nolan', 'Jordan', 'Tate', 'Casey']) {
      assert.ok(!raw.includes(name), `the pseudonym map must not contain "${name}": ${raw}`);
    }
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.ok(parsed.courses['1'], 'numbering is scoped per course');
    assert.ok(Object.values(parsed.courses['1'].users).every(n => Number.isInteger(n)));
  } finally {
    delete process.env.CANVAS_MCP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a new student takes the next unused number rather than renumbering anyone', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-append-'));
  // A course where 101 and 103 are already numbered, with a gap at 2.
  fs.writeFileSync(path.join(stateDir, 'pseudonyms.json'), JSON.stringify({
    version: 1,
    courses: { 1: { next: 4, users: { 101: 1, 103: 3 } } },
  }));
  process.env.CANVAS_MCP_STATE_DIR = stateDir;
  try {
    await withMockCanvas(async api => {
      const bytes = makeTextPdf(['Names: Avery']);
      const { files, submissions } = oneFile(api.baseUrl, bytes);
      api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
      const existing = headerOf(await readWork(api));
      assert.equal(existing.student, 'Student 1', 'an existing number is kept, not reassigned');

      const fresh = headerOf(await api.callTool('get-submission-content', {
        courseId: '1', assignmentId: '777', userId: '102',
      }));
      assert.equal(fresh.student, 'Student 4', 'a new enrolment takes the next number');
    }, { stateDir });
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'pseudonyms.json'), 'utf-8'));
    assert.equal(after.courses['1'].users['101'], 1);
    assert.equal(after.courses['1'].users['103'], 3);
  } finally {
    delete process.env.CANVAS_MCP_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
