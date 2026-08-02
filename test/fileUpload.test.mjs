// Canvas file upload is a three-step handshake across two hosts, and the parts
// that are easy to get wrong are all invisible from the tool's return value:
// whether the bearer token leaks to the storage host, whether upload_params are
// written before the file, and whether the redirect is followed to finalize.
// So the stand-ins below record the raw requests and the assertions read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/index.js'
);

async function withCanvasAndStorage(run, { finalize = 'redirect' } = {}) {
  const canvasRequests = [];
  const storageRequests = [];
  let canvasOrigin;
  let storageOrigin;

  // The storage host — S3 or inst-fs in reality. Must never see a Canvas token.
  const storage = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      storageRequests.push({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('binary'),
      });
      if (finalize === 'created') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 77, display_name: 'notes.pdf', folder_id: 5, url: 'https://files/77' }));
        return;
      }
      res.writeHead(302, { Location: `${canvasOrigin}/api/v1/files/77/confirm` });
      res.end();
    });
  });

  const canvas = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      canvasRequests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url.includes('/files/77/confirm')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 77, display_name: 'notes.pdf', folder_id: 5, url: 'https://files/77' }));
        return;
      }
      if (req.method === 'POST' && /\/courses\/\d+\/files$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          upload_url: `${storageOrigin}/put`,
          upload_params: { key: 'abc/notes.pdf', policy: 'signed-policy' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    });
  });

  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => canvas.listen(0, '127.0.0.1', resolve));
  storageOrigin = `http://127.0.0.1:${storage.address().port}`;
  canvasOrigin = `http://127.0.0.1:${canvas.address().port}`;

  const child = spawn('node', [serverEntry], {
    env: { ...process.env, CANVAS_API_TOKEN: 'secret-token', CANVAS_BASE_URL: canvasOrigin },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  };

  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  try {
    return await run({
      canvasRequests,
      storageRequests,
      async callTool(name, args) {
        const message = await request('tools/call', { name, arguments: args });
        return message.result ?? message.error;
      },
      textOf(result) {
        return (result.content ?? []).map(part => part.text).join('\n');
      },
    });
  } finally {
    child.kill();
    await new Promise(resolve => storage.close(resolve));
    await new Promise(resolve => canvas.close(resolve));
  }
}

async function sampleFile(contents = 'PDF BYTES HERE') {
  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-upload-'));
  const filePath = path.join(dir, 'notes.pdf');
  await writeFile(filePath, contents);
  return filePath;
}

test('upload walks all three steps and reports the stored file', async () => {
  await withCanvasAndStorage(async harness => {
    const filePath = await sampleFile();
    const result = await harness.callTool('upload-course-file', {
      courseId: '18473', filePath, folderPath: '/Handouts',
    });

    // 1. metadata to Canvas, with the size and guessed content type
    const init = harness.canvasRequests.find(r => r.method === 'POST' && r.url.endsWith('/files'));
    assert.ok(init, 'should POST metadata to /courses/:id/files');
    const metadata = JSON.parse(init.body);
    assert.equal(metadata.name, 'notes.pdf');
    assert.equal(metadata.content_type, 'application/pdf');
    assert.equal(metadata.size, 14);
    assert.equal(metadata.parent_folder_path, '/Handouts');
    assert.equal(metadata.on_duplicate, 'rename');

    // 2. bytes to storage
    assert.equal(harness.storageRequests.length, 1);
    assert.ok(harness.storageRequests[0].body.includes('PDF BYTES HERE'));

    // 3. redirect followed back to Canvas to finalize
    assert.ok(
      harness.canvasRequests.some(r => r.url.includes('/files/77/confirm')),
      'should follow the redirect to finalize the upload'
    );
    assert.match(harness.textOf(result), /File ID 77/);
  });
});

// The upload URL points at a third-party store. Sending the Canvas bearer token
// there would hand a full-access API credential to another host.
test('the Canvas token is never sent to the storage host', async () => {
  await withCanvasAndStorage(async harness => {
    await harness.callTool('upload-course-file', { courseId: '18473', filePath: await sampleFile() });

    assert.equal(harness.storageRequests.length, 1);
    const sent = JSON.stringify(harness.storageRequests[0].headers);
    assert.ok(!/secret-token/i.test(sent), 'bearer token must not reach the storage host');
    assert.equal(harness.storageRequests[0].headers.authorization, undefined);

    // ...while Canvas itself is still authenticated.
    const init = harness.canvasRequests.find(r => r.method === 'POST');
    assert.match(init.headers.authorization, /Bearer secret-token/);
  });
});

// S3 ignores form fields that arrive after the file content, so a signed policy
// written last is silently dropped and the upload is rejected.
test('upload_params are written before the file field', async () => {
  await withCanvasAndStorage(async harness => {
    await harness.callTool('upload-course-file', { courseId: '18473', filePath: await sampleFile() });

    const body = harness.storageRequests[0].body;
    assert.ok(body.includes('name="key"'), 'upload_params must be included');
    assert.ok(body.includes('signed-policy'));
    assert.ok(
      body.indexOf('name="key"') < body.indexOf('name="file"'),
      'every upload_param must precede the file field'
    );
  });
});

test('a 201 from storage is accepted without a finalize round trip', async () => {
  await withCanvasAndStorage(async harness => {
    const result = await harness.callTool('upload-course-file', {
      courseId: '18473', filePath: await sampleFile(),
    });
    assert.ok(!harness.canvasRequests.some(r => r.url.includes('confirm')));
    assert.match(harness.textOf(result), /File ID 77/);
  }, { finalize: 'created' });
});

test('folderId and folderPath are never sent together', async () => {
  await withCanvasAndStorage(async harness => {
    await harness.callTool('upload-course-file', {
      courseId: '18473', filePath: await sampleFile(),
      folderPath: '/Handouts', folderId: '99',
    });
    const metadata = JSON.parse(
      harness.canvasRequests.find(r => r.method === 'POST' && r.url.endsWith('/files')).body
    );
    // Canvas rejects a request carrying both.
    assert.equal(metadata.parent_folder_id, '99');
    assert.equal(metadata.parent_folder_path, undefined);
  });
});

test('a missing local file fails before anything is sent to Canvas', async () => {
  await withCanvasAndStorage(async harness => {
    const result = await harness.callTool('upload-course-file', {
      courseId: '18473', filePath: '/nope/does-not-exist.pdf',
    });
    assert.match(JSON.stringify(result), /No file at/);
    assert.equal(harness.canvasRequests.length, 0);
    assert.equal(harness.storageRequests.length, 0);
  });
});

// /courses/:id/files takes no folder_id — passing one is silently ignored and
// the whole course comes back. A folder listing must use /folders/:id/files.
test('listing one folder queries the folder endpoint, not the course', async () => {
  await withCanvasAndStorage(async harness => {
    await harness.callTool('list-course-files', { courseId: '18473', folderId: '172065' });

    const listing = harness.canvasRequests.filter(r => r.method === 'GET');
    assert.ok(
      listing.some(r => r.url.startsWith('/api/v1/folders/172065/files')),
      'should query /folders/:id/files'
    );
    for (const request of listing) {
      assert.ok(
        !/\/courses\/\d+\/files/.test(request.url),
        `must not fall back to the course endpoint: ${request.url}`
      );
      assert.ok(!/folder_id=/.test(request.url), 'folder_id is not a parameter Canvas honors here');
    }
  });
});
