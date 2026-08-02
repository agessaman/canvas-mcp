// Canvas paginates two different ways and the difference is not cosmetic:
// /courses/:id/students/submissions is bookmark-paginated and rejects a page
// number outright with
//   400 [{"page":"Invalid page; please restart iteration and follow `next` links"}]
// The stand-in Canvas below enforces that, so reintroducing page=N fails here
// rather than against a live course.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/index.js'
);

// Three pages of students, linked only by Link headers, served from a
// bookmark-paginated endpoint that 400s on any `page` parameter.
async function withBookmarkPaginatedCanvas(run) {
  const requestedUrls = [];
  let origin;

  const httpServer = http.createServer((req, res) => {
    requestedUrls.push(req.url);
    const url = new URL(req.url, origin);

    if (url.searchParams.has('page') || url.pathname.includes('/courses/400/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { page: 'Invalid page; please restart iteration and follow `next` links' },
      ]));
      return;
    }

    const bookmark = url.searchParams.get('bookmark') ?? '1';
    const pages = {
      '1': [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
      '2': [{ id: 3, name: 'C' }],
      '3': [{ id: 4, name: 'D' }],
    };
    const headers = { 'Content-Type': 'application/json' };
    const nextBookmark = { '1': '2', '2': '3' }[bookmark];
    if (nextBookmark) {
      headers.Link = `<${origin}${url.pathname}?bookmark=${nextBookmark}>; rel="next"`;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(pages[bookmark] ?? []));
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${httpServer.address().port}`;

  const child = spawn('node', [serverEntry], {
    env: { ...process.env, CANVAS_API_TOKEN: 'test-token', CANVAS_BASE_URL: origin },
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
      requestedUrls,
      async callTool(name, args) {
        const message = await request('tools/call', { name, arguments: args });
        return message.result ?? message.error;
      },
    });
  } finally {
    child.kill();
    await new Promise(resolve => httpServer.close(resolve));
  }
}

test('pagination follows Link headers and never sends page=N', async () => {
  await withBookmarkPaginatedCanvas(async canvas => {
    const result = await canvas.callTool('list-students', {
      courseId: '1', includeEmail: false,
    });
    const text = JSON.stringify(result);

    // A page= parameter would have produced a 400 from the stand-in above.
    for (const url of canvas.requestedUrls) {
      assert.ok(!/[?&]page=/.test(url), `request must not carry page=N: ${url}`);
    }
    // All three pages were walked, not just the first.
    assert.ok(canvas.requestedUrls.some(url => url.includes('bookmark=2')));
    assert.ok(canvas.requestedUrls.some(url => url.includes('bookmark=3')));
    assert.doesNotMatch(text, /Invalid page/);
    // Every page's worth of students came back, not just the first two.
    assert.match(text, /Total students: 4/);
  });
});

// Course 400 makes the stand-in reject the request the way Canvas rejects a
// page number. A failed paginated call has to route through handleError like
// every other verb, or it surfaces as a bare "Request failed with status code
// 400" naming neither the endpoint nor the reason.
test('a paginated request failure names the endpoint instead of a bare status', async () => {
  await withBookmarkPaginatedCanvas(async canvas => {
    const result = await canvas.callTool('list-students', { courseId: '400' });
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /Request failed with status code/);
    assert.match(text, /400/);
    assert.match(text, /courses\/400\/users/, 'the error should name the endpoint that failed');
    assert.match(text, /Invalid page/, 'and should carry Canvas\'s own explanation');
  });
});
