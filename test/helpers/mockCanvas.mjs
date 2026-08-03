// Runs the built server over stdio against a stand-in Canvas, so tests can
// assert on the exact HTTP body the server sends. The wire format is where
// this server's real bugs have been: a payload that looks right in the tool
// arguments can still reach Canvas in the wrong shape.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/index.js'
);

export async function withMockCanvas(run) {
  const requests = [];
  let respondWith = () => ({ id: '1', points_possible: 1 });

  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      // A responder can answer with a status other than 200 by returning
      // { __status, __body }. Needed for anything that probes an endpoint and
      // treats a 404 as an answer rather than an error — quiz engine detection
      // asks both engines about an ID and reads the 404 as "not this one".
      const answer = respondWith({ url: req.url, body: parsed, method: req.method });
      const status = answer?.__status ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer?.__status ? (answer.__body ?? {}) : answer));
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const child = spawn('node', [serverEntry], {
    env: {
      ...process.env,
      CANVAS_API_TOKEN: 'test-token',
      CANVAS_BASE_URL: `http://127.0.0.1:${port}`,
    },
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
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const api = {
    requests,
    setResponse(fn) {
      respondWith = fn;
    },
    async callTool(name, args) {
      const message = await request('tools/call', { name, arguments: args });
      return message.result ?? message.error;
    },
    async listTools() {
      const message = await request('tools/list', {});
      return message.result.tools;
    },
    lastRequest() {
      return requests[requests.length - 1];
    },
    textOf(result) {
      return (result.content ?? []).map(part => part.text).join('\n');
    },
  };

  try {
    return await run(api);
  } finally {
    child.kill();
    await new Promise(resolve => httpServer.close(resolve));
  }
}
