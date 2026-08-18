#!/usr/bin/env node
// Runs the server out of a packed .mcpb, not out of dist/.
//
// The packer can strip a file the runtime needs and say nothing about it: a
// bare "src/" in .mcpbignore once emptied node_modules/debug, leaving a
// package.json pointing main at code that was no longer in the bundle. Nothing
// caught it because dist/ on disk was fine and the tests never load the bundle.
// So this extracts the artifact and completes a real MCP handshake against a
// stand-in Canvas — a missing module shows up here instead of in somebody's
// Claude Desktop.
//
// Usage: node scripts/verify-bundle.mjs <bundle.mcpb | extracted-dir>
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-bundle.mjs <bundle.mcpb | extracted-dir>');
  process.exit(2);
}

let bundleDir = target;
if (!fs.statSync(target).isDirectory()) {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-verify-'));
  execFileSync('unzip', ['-q', path.resolve(target), '-d', bundleDir]);
}

const entry = path.join(bundleDir, 'dist', 'index.js');
if (!fs.existsSync(entry)) {
  console.error(`no dist/index.js in ${bundleDir} — the bundle has no server to run`);
  process.exit(1);
}

// One canned assignment, with a body, is enough: it exercises a real tool call
// end to end rather than just proving the process starts.
const BODY = '<p>Read chapter 4, then answer the <strong>three</strong> questions.</p>';
const canvas = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 371866, name: 'Verification Assignment', description: BODY,
    due_at: '2026-09-01T23:59:00Z', points_possible: 10, published: true,
  }));
});
await new Promise(resolve => canvas.listen(0, '127.0.0.1', resolve));
const { port } = canvas.address();

const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    CANVAS_API_TOKEN: 'verify-token',
    CANVAS_BASE_URL: `http://127.0.0.1:${port}`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// A missing module lands on stderr and nowhere else, so it has to be reported
// with whatever the failure turns out to be.
let stderr = '';
child.stderr.on('data', chunk => (stderr += chunk));
child.on('error', err => {
  console.error(`could not start the bundled server: ${err.message}`);
  process.exit(1);
});

// A server that dies on a missing module dies immediately, so waiting out the
// per-request timeout would just make CI slow to tell the truth.
let exited = null;
const pending = new Map();
child.on('exit', (code, signal) => {
  exited = signal ? `killed by ${signal}` : `exited with code ${code}`;
  for (const [, settle] of pending) settle(undefined);
  pending.clear();
});

let buffer = '';
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const fail = why => reject(new Error(
      `${why} waiting for ${method}${stderr ? `\n--- server stderr ---\n${stderr}` : ''}`
    ));
    pending.set(id, () => fail(`the bundled server ${exited}`));
    const timer = setTimeout(() => fail('timed out'), 20000);
    pending.set(id, answer => {
      clearTimeout(timer);
      if (answer === undefined) fail(`the bundled server ${exited}`);
      else resolve(answer);
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return promise;
}

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-bundle', version: '1' },
  });
  const info = init.result?.serverInfo;
  check('handshake completes', !!info, info && `${info.name} ${info.version}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = (await call('tools/list', {})).result?.tools ?? [];
  check('tools register', tools.length > 0, `${tools.length} tools`);

  // Every tool the bundle claims has to carry a usable schema; a tool that
  // registers with a broken one is worse than one that is missing.
  const malformed = tools.filter(t => !t.name || !t.description || !t.inputSchema);
  check('every tool has a name, description and schema', malformed.length === 0,
    malformed.length ? malformed.map(t => t.name ?? '(unnamed)').join(', ') : '');

  const called = await call('tools/call', {
    name: 'get-assignment',
    arguments: { courseId: '1', assignmentId: '371866' },
  });
  let summary = {};
  try { summary = JSON.parse((called.result?.content ?? []).map(c => c.text).join('')); } catch {}
  check('a tool call reaches Canvas and returns its payload', summary.description === BODY,
    summary.description === BODY ? 'assignment body intact' : JSON.stringify(called.result ?? called.error));
} catch (error) {
  check('verification ran to completion', false, error.message);
} finally {
  child.kill();
  canvas.close();
}

const failed = checks.filter(c => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${checks.length} checks failed against ${path.resolve(bundleDir)}`);
  if (stderr) console.error(`--- server stderr ---\n${stderr}`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed — the bundle runs standalone`);
