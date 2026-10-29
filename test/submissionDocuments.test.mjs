// get-submission-documents with downloadFiles used to answer a 192 KB PDF with
// "[FILE_TOO_LARGE_FOR_DISPLAY]" — a placeholder, no content, nothing the
// caller could grade from. Any file with a text layer now comes back as text.
//
// Every name in this file is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';
import { attachment, makeTextPdf, router, submission, textOf, worksheetHtml } from './helpers/gradingFixture.mjs';

/** One submission by Avery Nolan (101) carrying `bytes` as `filename`. */
function fileCase(baseUrl, bytes, filename, contentType) {
  return {
    files: { 1: { bytes, filename, contentType } },
    submissions: { 101: submission(101, { attachments: [attachment(baseUrl, 1, filename, bytes.length, contentType)] }) },
  };
}

test('a 200 KB PDF comes back as extracted text, not a placeholder', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['Names: Avery', 'The caravel could sail against the wind.'], 200_000);
    assert.ok(bytes.length > 190_000, `fixture should be about 200 KB, got ${bytes.length}`);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = JSON.parse(textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true,
    })));
    const [file] = result.downloaded_files;
    assert.equal(file.content_encoding, 'text');
    assert.match(file.content, /caravel could sail against the wind/);
    assert.ok(!JSON.stringify(result).includes('FILE_TOO_LARGE_FOR_DISPLAY'));
  });
});

test('oversized text is truncated and says so, never emptied', async () => {
  await withMockCanvas(async api => {
    const line = 'Trade routes shifted around the Cape of Good Hope. ';
    const bytes = Buffer.from(line.repeat(4000), 'utf-8');
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'essay.txt', 'text/plain');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = JSON.parse(textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true, maxChars: 5000,
    })));
    const [file] = result.downloaded_files;
    assert.equal(file.content_encoding, 'text');
    assert.equal(file.truncated, true);
    assert.ok(file.content.length > 0, 'truncated still means content');
    assert.match(file.content, /truncated \d+ characters/);
  });
});

test('forceBase64 still returns the raw bytes', async () => {
  await withMockCanvas(async api => {
    const bytes = Buffer.from('<html><body><p>Answer one.</p></body></html>', 'utf-8');
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'answers.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = JSON.parse(textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true, forceBase64: true,
    })));
    const [file] = result.downloaded_files;
    assert.equal(file.content_encoding, 'base64');
    assert.equal(Buffer.from(file.content, 'base64').toString('utf-8'), bytes.toString('utf-8'));
  });
});

test('names typed into the document are scrubbed when anonymous', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml('Names: Jordan T, Avery N', ['The voyage changed the map.']);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const anonymised = textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true,
    }));
    assert.ok(!/Jordan|Avery|Tate|Nolan/.test(anonymised), `a name survived:\n${anonymised.slice(0, 600)}`);
    assert.match(anonymised, /Names: Student \d+, Student \d+/);

    const plain = textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true, anonymous: false,
    }));
    assert.match(plain, /Names: Jordan T, Avery N/);
  });
});

test('download-submission-file reads a PDF as text and takes base64 on request', async () => {
  await withMockCanvas(async api => {
    const bytes = makeTextPdf(['The astrolabe fixed latitude at sea.']);
    api.setResponse(router({
      baseUrl: api.baseUrl,
      files: { 1: { bytes, filename: 'notes.pdf', contentType: 'application/pdf' } },
    }));

    const asText = JSON.parse(textOf(await api.callTool('download-submission-file', { fileId: '1' })));
    assert.equal(asText.content_encoding, 'text');
    assert.match(asText.content, /astrolabe fixed latitude/);

    const asBytes = JSON.parse(textOf(await api.callTool('download-submission-file', { fileId: '1', forceBase64: true })));
    assert.equal(asBytes.content_encoding, 'base64');
    assert.equal(Buffer.from(asBytes.content, 'base64').length, bytes.length);
  });
});

test('a file with no text extractor returns its bytes and the reason', async () => {
  await withMockCanvas(async api => {
    const bytes = Buffer.from('PK\u0003\u0004not really a deck', 'latin1');
    api.setResponse(router({
      baseUrl: api.baseUrl,
      files: { 1: { bytes, filename: 'slides.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } },
    }));
    const result = JSON.parse(textOf(await api.callTool('download-submission-file', { fileId: '1' })));
    assert.equal(result.content_encoding, 'base64');
    assert.ok(result.content.length > 0, 'bytes rather than an empty placeholder');
    assert.match(result.note, /presentation/);
  });
});

test('the size limits are stated in both tool descriptions', async () => {
  await withMockCanvas(async api => {
    const byName = Object.fromEntries((await api.listTools()).map(t => [t.name, t.description]));
    for (const name of ['get-submission-documents', 'download-submission-file']) {
      assert.match(byName[name], /60000 characters/, `${name} should state its text limit`);
      assert.match(byName[name], /5 MB/, `${name} should state its base64 limit`);
    }
  });
});

test('get-submission-content is discoverable by what a grader would search for', async () => {
  await withMockCanvas(async api => {
    const tool = (await api.listTools()).find(t => t.name === 'get-submission-content');
    assert.ok(tool, 'get-submission-content must be registered');
    const haystack = `${tool.name} ${tool.description}`.toLowerCase();
    for (const term of ['submission', 'content', 'student work', 'read']) {
      assert.ok(haystack.includes(term), `the description should contain "${term}"`);
    }
    // Each tool should say which of the two to reach for.
    const packet = (await api.listTools()).find(t => t.name === 'get-grading-packet');
    assert.match(packet.description, /get-submission-content/);
    assert.match(tool.description, /get-grading-packet/);
  });
});

test('footnote and wiki residue are flagged as prompts, with short excerpts', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml('Names: Avery', [
      'Portugal claimed the route.12 Now the spice trade shifted.',
      'The Treaty of Tordesillas[citation needed] split the map.',
    ]);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const signals = JSON.parse(result.content[0].text).attempts[0].files[0].integrity_signals;
    assert.ok(Array.isArray(signals) && signals.length >= 2, `expected signals, got ${JSON.stringify(signals)}`);
    assert.ok(signals.every(s => s.excerpt.length <= 40), 'excerpts stay short');
    assert.ok(signals.every(s => s.reason), 'every signal says why it fired');
    assert.ok(signals.some(s => /footnote/i.test(s.reason)));
    assert.ok(signals.some(s => /citation needed/i.test(s.reason)));
  });
});

test('ordinary writing raises no integrity signals', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml('Names: Avery', [
      'Version 2.1 of the map was printed in 1502.',
      'Portugal claimed the route. Now the spice trade shifted.',
    ]);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const file = JSON.parse(result.content[0].text).attempts[0].files[0];
    assert.equal(file.integrity_signals, undefined, `expected no signals, got ${JSON.stringify(file.integrity_signals)}`);
  });
});

test('an answer that names its own question is flagged', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml('Names: Avery', [
      'Which invention is most like the printing press? The printing press is the closest match.',
    ]);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const signals = JSON.parse(result.content[0].text).attempts[0].files[0].integrity_signals ?? [];
    assert.ok(signals.some(s => /same thing the question asked about/.test(s.reason)), JSON.stringify(signals));
  });
});

test('a document carries the fingerprint of the worksheet version it used', async () => {
  await withMockCanvas(async api => {
    const bytes = worksheetHtml('Names: Avery', ['Answer.'], ['Question', 'Evidence', 'Analysis']);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'worksheet.html', 'text/html');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = await api.callTool('get-submission-content', { courseId: '1', assignmentId: '777', userId: '101' });
    const file = JSON.parse(result.content[0].text).attempts[0].files[0];
    assert.match(file.template_fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(file.template_headers, 'question | evidence | analysis');
  });
});

test('a PDF with more text than the limit is truncated, not dropped', async () => {
  await withMockCanvas(async api => {
    // Both PDF text extractors clip at the page edge, so a long text layer is
    // made by lowering the limit rather than by writing a 100-page document.
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i}: the monsoon winds carried ships east each summer.`);
    const bytes = makeTextPdf(lines, 200_000);
    const { files, submissions } = fileCase(api.baseUrl, bytes, 'long.pdf', 'application/pdf');
    api.setResponse(router({ baseUrl: api.baseUrl, files, submissions }));

    const result = JSON.parse(textOf(await api.callTool('get-submission-documents', {
      courseId: '1', assignmentId: '777', userId: '101', downloadFiles: true, maxChars: 1000,
    })));
    const [file] = result.downloaded_files;
    assert.equal(file.content_encoding, 'text');
    assert.equal(file.truncated, true);
    assert.match(file.content, /monsoon winds carried ships east/);
    assert.match(file.content, /truncated \d+ characters/);
    assert.ok(file.size > 190_000, 'a large file still returns text rather than bytes');
  });
});

test('@napi-rs/canvas ships with the package, so scanned pages can be rendered', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  const declared = pkg.optionalDependencies?.['@napi-rs/canvas'] ?? pkg.dependencies?.['@napi-rs/canvas'];
  assert.ok(declared, 'the package must declare @napi-rs/canvas');
  await assert.doesNotReject(import('@napi-rs/canvas'), 'npm install should bring the renderer with it');
});
