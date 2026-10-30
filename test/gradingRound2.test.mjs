// Regressions from a second grading pass, on five real submissions (four PDF,
// one DOCX). Each test here is a thing that worked on the HTML fixtures of the
// first round and failed on the documents teachers actually submit.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import {
  REAL_NAMES, assignment, attachment, course, headerOf,
  makeTablePdf, makeTextPdf, router, submission, textOf,
} from './helpers/gradingFixture.mjs';

function assertNoLeaks(text, { except = [] } = {}) {
  for (const name of REAL_NAMES) {
    if (except.includes(name)) continue;
    assert.ok(
      !new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(text),
      `"${name}" survived anonymization in:\n${text.slice(0, 1000)}`,
    );
  }
}

/** Avery Nolan (101) submits `bytes` as `filename`. */
function oneFile(baseUrl, bytes, filename, contentType) {
  return {
    files: { 1: { bytes, filename, contentType } },
    submissions: {
      101: submission(101, { attachments: [attachment(baseUrl, 1, filename, bytes.length, contentType)] }),
      102: submission(102, { attachments: [] }),
      103: submission(103, { attachments: [] }),
    },
  };
}

const readWork = (api, over = {}) =>
  api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101', ...over });

// --- 1. the name line is not at the start of the line in a PDF ---

test('a PDF that reflows the title onto the name line is still redacted', async () => {
  await withMockCanvas(async api => {
    // What pdfkit gives back for a worksheet header: title and names, one line.
    const bytes = makeTextPdf([
      '17.1 Worksheet Title Names: Jordan T, Casey A Period: 4',
      'Ships sailed south along the coast.',
    ]);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await readWork(api);
    const text = textOf(result);
    assertNoLeaks(text);
    assert.match(text, /Names: Student \d+, Student \d+/);
    assert.match(text, /Period: 4/, 'the boundary label still ends the name line');
    const redactions = headerOf(result).attempts[0].files[0].redactions;
    assert.ok(redactions.nameLine >= 2, `expected name-line redactions, got ${JSON.stringify(redactions)}`);
    assert.equal(redactions.unmatched, 0);
  });
});

test('both named partners are reported from a reflowed PDF name line', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['17.1 Worksheet Title Names: Jordan T, Casey A Period: 4']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const header = headerOf(await readWork(api));
    const ids = (header.partners ?? []).map(p => p.user_id).sort();
    assert.deepEqual(ids, [102, 103], `expected both partners, got ${JSON.stringify(header.partners)}`);
  });
});

test('a name line with no Period on it still stops at the end of the line', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: ____casey Jordan____', 'The astrolabe fixed latitude.']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const text = textOf(await readWork(api));
    assertNoLeaks(text);
    assert.match(text, /Names: Student \d+, Student \d+/);
    assert.match(text, /The astrolabe fixed latitude/, 'body text below the name line is untouched');
  });
});

test('a name joined by "and" with trailing punctuation is redacted in a PDF', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Riley and Jordan!']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const text = textOf(await readWork(api));
    assertNoLeaks(text);
    assert.match(text, /Names: Student \d+, Student \d+/);
  });
});

test('"names:" deep in body prose is not treated as a roster line', async () => {
  await withMockCanvas(async api => {
    // Far past the name zone, so a sentence that happens to list names stays prose.
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about the spice trade and its routes across the Indian Ocean.`);
    const bytes = makeTextPdf([...filler, 'The crew names: Diaz, Cabral and Magellan appear in the log.']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const text = textOf(await readWork(api));
    assert.match(text, /Diaz, Cabral and Magellan/, 'explorers in a body sentence are not names to blank');
  });
});

// --- 2. a pseudonym already in the text is not an unknown name ---

test('a pseudonym already on the name line counts as matched, not unmatched', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Student 1, Student 7']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await readWork(api);
    const redactions = headerOf(result).attempts[0].files[0].redactions;
    assert.equal(redactions.unmatched, 0, 'an existing pseudonym is a known name');
    assert.ok(redactions.nameLine >= 2);
    assert.ok(!textOf(result).includes('[name]'));
  });
});

test('the submitter on their own name line ends as their pseudonym', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Avery Nolan']);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await readWork(api);
    const header = headerOf(result);
    assert.match(textOf(result), new RegExp(`Names: ${header.student}\\b`));
    assert.equal(header.attempts[0].files[0].redactions.unmatched, 0);
  });
});

test('a label and its names in neighbouring table cells are still a name line', async () => {
  await withMockCanvas(async api => {
    // A DOCX table flattens to the label on one line and the names on the next.
    const bytes = Buffer.from('<html><body><p>Names:</p><p>Riley and Avery</p></body></html>', 'utf-8');
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await readWork(api);
    const text = textOf(result);
    assertNoLeaks(text);
    assert.match(text, /Student \d+, Student \d+/);
    assert.equal(headerOf(result).attempts[0].files[0].redactions.unmatched, 0);
    assert.ok((headerOf(result).partners ?? []).some(p => p.user_id === 104), 'the partner on the next line is found');
  });
});

// --- 3. self-referential comparison ---

test('an answer that renames its own subject is flagged', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf([
      'Names: Avery',
      "Explorer's name: Francis Drake",
      'Which explorer is most like yours?',
      'Drake Francis is most like Sir Francis Drake from Part 1.',
    ]);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const signals = headerOf(await readWork(api)).attempts[0].files[0].integrity_signals ?? [];
    assert.ok(
      signals.some(s => /same thing the question asked about/.test(s.reason)),
      `expected a self-reference signal, got ${JSON.stringify(signals)}`,
    );
    assert.ok(signals.every(s => s.excerpt.length <= 40));
  });
});

test('a genuine comparison between two different things is not flagged', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf([
      'Names: Avery',
      "Explorer's name: Francis Drake",
      'The astrolabe is most like a modern GPS receiver.',
    ]);
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const signals = headerOf(await readWork(api)).attempts[0].files[0].integrity_signals ?? [];
    assert.ok(
      !signals.some(s => /same thing the question asked about/.test(s.reason)),
      `comparison of two different things should not fire: ${JSON.stringify(signals)}`,
    );
  });
});

// --- 4. a PDF has a template fingerprint too ---

test('a multi-page PDF is fingerprinted by the header row it repeats', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTablePdf({
      title: '17.1 Worksheet',
      headers: ['Question', 'Evidence', 'Analysis'],
      rows: page => [[String(page + 1), `Answer on page ${page + 1}`, `Analysis ${page + 1}`]],
      pages: 3,
    });
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const file = headerOf(await readWork(api)).attempts[0].files[0];
    assert.match(file.template_fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(file.template_headers, 'question evidence analysis');
  });
});

test('a one-page PDF is fingerprinted from its laid-out first table row', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTablePdf({
      title: '17.1 Worksheet',
      headers: ['Question', 'Evidence', 'Analysis'],
      rows: [['1', 'Ships sailed south', 'Routes shifted']],
      pages: 1,
    });
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const file = headerOf(await readWork(api)).attempts[0].files[0];
    assert.match(file.template_fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(file.template_headers, 'question | evidence | analysis');
  });
});

test('two worksheet versions get two fingerprints', async () => {
  const fingerprint = async headers => withMockCanvas(async api => {
    const bytes = makeTablePdf({ title: '17.1 Worksheet', headers, rows: [headers.map((_, i) => `cell ${i}`)], pages: 1 });
    const { files, submissions } = oneFile(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));
    return headerOf(await readWork(api)).attempts[0].files[0].template_fingerprint;
  });
  const original = await fingerprint(['Question', 'Evidence', 'Analysis']);
  const revised = await fingerprint(['Question', 'Evidence', 'Analysis', 'Source']);
  assert.ok(original && revised);
  assert.notEqual(original, revised, 'a revised template must not share the original fingerprint');
});

test('scanTemplates reads the queue and summarises the versions in use', async () => {
  await withMockCanvas(async api => {
    const variant = headers => makeTablePdf({ title: '17.1 Worksheet', headers, rows: [headers.map((_, i) => `cell ${i}`)], pages: 1 });
    const original = variant(['Question', 'Evidence', 'Analysis']);
    const revised = variant(['Question', 'Evidence', 'Analysis', 'Source']);
    const files = {
      1: { bytes: original, filename: 'w.pdf', contentType: 'application/pdf' },
      2: { bytes: revised, filename: 'w.pdf', contentType: 'application/pdf' },
      3: { bytes: original, filename: 'w.pdf', contentType: 'application/pdf' },
    };
    const submissions = {
      101: submission(101, { attachments: [attachment(api.baseUrl, 1, 'w.pdf', original.length)] }),
      102: submission(102, { attachments: [attachment(api.baseUrl, 2, 'w.pdf', revised.length)] }),
      103: submission(103, { attachments: [attachment(api.baseUrl, 3, 'w.pdf', original.length)] }),
    };
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    // Reading the queue costs a download per student. The cross-check needs
    // that, and runs by default, so the way out is explicit — and the packet
    // says it happened either way.
    const optedOut = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: false,
    })).split('\n').find(l => l.startsWith('{')));
    assert.equal(optedOut.template_variants, undefined, 'scanTemplates: false reads nothing');

    const byDefault = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'],
    })).split('\n').find(l => l.startsWith('{')));
    assert.match(byDefault.scan_note, /download each/, 'a scan the caller did not ask for says so');

    const scanned = JSON.parse(textOf(await api.callTool('get-grading-packet', {
      courseId: '1', assignmentId: '777', include: ['queue'], scanTemplates: true,
    })).split('\n').find(l => l.startsWith('{')));
    assert.equal(scanned.template_scan.students, 3);
    assert.equal(scanned.template_scan.scanned, 3);
    assert.equal(scanned.template_variants.length, 2, JSON.stringify(scanned.template_variants));
    const sizes = scanned.template_variants.map(v => v.students.length).sort();
    assert.deepEqual(sizes, [1, 2], 'two students on one version, one on the other');
    assert.ok(scanned.template_variants.every(v => v.students.every(s => /^Student \d+$/.test(s))));
  });
});

// --- 5. the grading standard the course actually uses ---

test('an account-level grading standard is resolved, not skipped for the default', async () => {
  await withMockCanvas(async api => {
    const standard = {
      id: 52,
      title: 'District Standard Grading Scale',
      grading_scheme: [
        { name: 'A', value: 0.93 }, { name: 'A-', value: 0.90 }, { name: 'B+', value: 0.87 },
        { name: 'B', value: 0.84 }, { name: 'F', value: 0.0 },
      ],
    };
    // What a real Canvas does: the course names standard 52, but the
    // course-scoped and sub-account paths both 404 — only /accounts/self has it.
    api.setResponse(({ url, method }) => {
      const path = url.split('?')[0];
      if (/^\/api\/v1\/(courses\/\d+|accounts\/4)\/grading_standards\/52$/.test(path)) {
        return { __status: 404, __body: { errors: [{ message: 'The specified resource does not exist.' }] } };
      }
      if (path === '/api/v1/accounts/self/grading_standards/52') return standard;
      return router({
        baseUrl: api.baseUrl,
        course: course({ grading_standard_id: 52, account_id: 4 }),
        submissions: { 101: submission(101) },
      })({ url, method });
    });

    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true, score: 23.25,
    })));
    // 23.25 of 25 is 93%: an A on the school's scale, an A- on Canvas's.
    assert.equal(preview.letter_grade, 'A');
    assert.equal(preview.grading_standard.source, 'course');
    assert.equal(preview.grading_standard.id, 52);
    assert.equal(preview.grading_standard.name, 'District Standard Grading Scale');
    assert.equal(preview.grading_standard.fell_back_because, undefined);
  });
});

test('a course with no standard says so instead of silently using the default', async () => {
  await withMockCanvas(async api => {
    api.setResponse(router({
      baseUrl: api.baseUrl,
      course: course({ grading_standard_id: null }),
      submissions: { 101: submission(101) },
    }));
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true, score: 23.25,
    })));
    assert.equal(preview.grading_standard.source, 'default');
    assert.ok(
      preview.grading_standard.fell_back_because.some(r => /neither the assignment nor the course/.test(r)),
      JSON.stringify(preview.grading_standard),
    );
  });
});

test('an assignment standard wins over the course one', async () => {
  await withMockCanvas(async api => {
    const scheme = (title, aCut) => ({ id: 77, title, grading_scheme: [{ name: 'A', value: aCut }, { name: 'B', value: 0.8 }, { name: 'F', value: 0 }] });
    api.setResponse(({ url, method }) => {
      const path = url.split('?')[0];
      if (path.endsWith('/grading_standards/77')) return scheme('Assignment scale', 0.95);
      if (path.endsWith('/grading_standards/52')) return scheme('Course scale', 0.9);
      return router({
        baseUrl: api.baseUrl,
        assignment: assignment({ grading_standard_id: 77 }),
        course: course({ grading_standard_id: 52 }),
        submissions: { 101: submission(101) },
      })({ url, method });
    });
    const preview = JSON.parse(textOf(await api.callTool('grade-submission', {
      courseId: '1', assignmentId: '777', userId: '101', dryRun: true, score: 23.25,
    })));
    assert.equal(preview.grading_standard.source, 'assignment');
    assert.equal(preview.grading_standard.name, 'Assignment scale');
    assert.equal(preview.letter_grade, 'B', '93% is below the assignment scale\'s 95% A cutoff');
  });
});
