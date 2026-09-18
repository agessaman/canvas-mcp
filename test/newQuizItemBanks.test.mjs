// New Quizzes item banks — the LTI handshake and the quiz-api wire format.
//
// These tools are the only part of the server that talks to hosts other than
// Canvas, so the mock here stands in for all three at once: Canvas, the
// quiz-lti tool backend, and the quiz-api bank service. One HTTP server answers
// all of them and tells them apart by the Host header, which is also how the
// tests assert that the hosts were DERIVED from the external tool's url rather
// than assumed.
//
// `*.localhost` is used for the quiz-lti/quiz-api names because the client
// picks the host out of the tool url, and the substring "quiz-lti" has to be in
// it for the tool to be recognised at all. It resolves to loopback on macOS and
// on glibc/systemd Linux; the suite skips itself rather than failing red if a
// resolver disagrees.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COURSE = '18473';
const TOOL_ID = 229;

const resolvesLocally = await new Promise(resolve => {
  dns.lookup('quiz-lti.localhost', err => resolve(!err));
});

// A JWT the client will parse for `exp`. Only the payload is ever read — the
// signature is never checked by anything in this repo, so a placeholder is fine.
function fakeJwt(claims) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS512' })}.${part(claims)}.c2lnbmF0dXJl`;
}

// The launch blob Canvas embeds in the Item Banks page. The client finds it with
// a regex over the raw HTML, so the shape of the surrounding page matters:
// it is inside a <script>, with other ENV keys around it.
function banksPage(backendUrl) {
  const blob = JSON.stringify({
    params: { backend_url: backendUrl, oauth_consumer_key: 'key', custom_canvas_course_id: COURSE },
    signature: 'c2lnbmVkLWJ5LWNhbnZhcw==',
    basename: `/courses/${COURSE}`,
    launchType: 'regular',
  });
  return `<!DOCTYPE html><html><head><script>
    ENV = {"current_user_id":"1","NEW_QUIZZES":${blob},"context_asset_string":"course_${COURSE}"};
  </script></head><body><div id="ams_container"></div></body></html>`;
}

/**
 * Serve Canvas, quiz-lti and quiz-api from one socket, run `body` against a
 * server wired to it, and hand back every request that was made.
 */
async function withMockHosts(body, { overrides = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const host = (req.headers.host ?? '').split(':')[0];
      const url = new URL(req.url, `http://${host}`);
      const record = {
        host,
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(record);

      const send = (status, payload, headers = {}) => {
        const isHtml = typeof payload === 'string';
        res.writeHead(status, { 'Content-Type': isHtml ? 'text/html' : 'application/json', ...headers });
        res.end(isHtml ? payload : JSON.stringify(payload ?? {}));
      };

      const override = overrides[`${req.method} ${url.pathname}`];
      if (override) {
        const answer = override(record, requests);
        if (answer) return send(answer.status ?? 200, answer.body, answer.headers);
      }

      const { port } = server.address();
      const quizLti = `http://quiz-lti.localhost:${port}`;
      const quizApi = `http://quiz-api.localhost:${port}`;

      // --- Canvas ---
      if (url.pathname === `/api/v1/courses/${COURSE}/external_tools`) {
        return send(200, [
          { id: 7, name: 'Google Apps', url: 'https://www.google.com/lti' },
          { id: 8, name: 'Broken', url: null },
          { id: TOOL_ID, name: 'Quizzes 2', url: `${quizLti}/lti/launch` },
        ]);
      }
      if (url.pathname === '/login/session_token') {
        return send(200, { session_url: `http://127.0.0.1:${port}/banks-redirect` });
      }
      if (url.pathname === '/banks-redirect') {
        return send(302, {}, { Location: `/courses/${COURSE}/banks/${TOOL_ID}`, 'Set-Cookie': 'canvas_session=abc; Path=/; HttpOnly' });
      }
      if (url.pathname === `/courses/${COURSE}/banks/${TOOL_ID}`) {
        return send(200, banksPage(quizLti));
      }
      if (url.pathname === `/api/v1/courses/${COURSE}`) {
        return send(200, { id: Number(COURSE), name: 'Sandbox', account: { id: 4, root_account_id: 1 } });
      }
      if (url.pathname === '/api/v1/jwts') {
        return send(200, { token: fakeJwt({ sub: 'user', exp: Math.floor(Date.now() / 1000) + 7200 }) });
      }

      // --- quiz-lti ---
      if (url.pathname === '/api/native/launch') {
        return send(200, {
          access_token: 'lti-access-token',
          launch_token: fakeJwt({ aud: ['quiz-lti'], exp: Math.floor(Date.now() / 1000) + 7200 }),
          item_banks_scope: { type: 'course', uuid: 'course-uuid', title: 'Sandbox' },
        });
      }
      if (url.pathname === '/api/sdk_tokens/banks.build') {
        return send(200, {
          host: quizApi,
          token: fakeJwt({ scope: 'banks.build', exp: Math.floor(Date.now() / 1000) + 86400 }),
        });
      }

      // --- quiz-api ---
      if (url.pathname === '/api/banks') {
        return send(200, [{ id: '136', title: 'Pre-Columbian America', entry_count: 3, item_entry_count: 3, shared_count: 0, permission: 'edit', archived: false }], { total: '290' });
      }
      if (url.pathname === '/api/banks/136') {
        return send(200, { id: '136', title: 'Pre-Columbian America', entry_count: 3 });
      }
      if (url.pathname === '/api/banks/136/bank_entries/search') {
        return send(200, {
          total: 1,
          entries: [{
            id: '1027',
            entry_type: 'Item',
            updated_at: '2026-09-17T00:00:00Z',
            entry: { id: '9454', title: 'q', item_body: '<p>q</p>', status: 'mutable', interaction_type: { id: '1', slug: 'choice' } },
          }],
          filters: { interaction_types: [], tags: [] },
        });
      }
      if (url.pathname === '/api/interaction_types') {
        return send(200, [
          { id: '1', slug: 'choice', name: 'Multiple Choice', user_response_type_options: ['Uuid'] },
          { id: '9', slug: 'essay', name: 'Essay', user_response_type_options: ['Text'] },
        ]);
      }
      if (url.pathname === '/api/banks/136/items' && req.method === 'POST') {
        return send(201, { id: '11364', title: record.body?.item?.title ?? null, status: 'mutable' });
      }
      if (url.pathname === '/api/banks/136/bank_entries' && req.method === 'POST') {
        return send(201, { id: '2460', bank_id: '136', entry_type: 'Item' });
      }
      if (url.pathname === '/api/banks/136/items/11364' && req.method === 'PATCH') {
        return send(200, { id: '11364', title: record.body?.item?.title ?? null });
      }
      if (url.pathname === '/api/banks/136/bank_entries/2460' && req.method === 'DELETE') {
        return send(204, {});
      }

      return send(404, { error: `mock has no route for ${req.method} ${url.pathname}` });
    });
  });

  // Listen on every interface so the same socket answers to 127.0.0.1 and to
  // the *.localhost names (which resolve to ::1 on some systems).
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'dist/index.js')],
    cwd: repoRoot,
    env: {
      ...process.env,
      CANVAS_API_TOKEN: 'test-token',
      CANVAS_BASE_URL: `http://127.0.0.1:${port}`,
      CANVAS_ENABLE_ITEM_BANKS: 'true',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'item-bank-test', version: '1.0.0' });
  await client.connect(transport);

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content ?? []).map(part => part.text).join('\n');
    return { result, text, isError: result.isError === true };
  };

  try {
    return await body({ call, requests, port, client });
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
}

const itemBankTest = (name, fn, opts) =>
  test(name, { skip: resolvesLocally ? false : 'quiz-lti.localhost does not resolve to loopback here' }, () =>
    withMockHosts(fn, opts));

itemBankTest('the handshake reaches the hosts named by the external tool, not hardcoded ones', async ({ call, requests }) => {
  const { text } = await call('list-item-banks', { courseId: COURSE });
  assert.match(text, /Pre-Columbian America/);

  const hostFor = p => requests.find(r => r.path === p)?.host;
  assert.equal(hostFor('/api/native/launch'), 'quiz-lti.localhost', 'the launch must go to the tool url\'s host');
  assert.equal(hostFor('/api/sdk_tokens/banks.build'), 'quiz-lti.localhost');
  assert.equal(hostFor('/api/banks'), 'quiz-api.localhost', 'the bank API host must come from the sdk token response');
  assert.equal(hostFor('/login/session_token'), '127.0.0.1', 'Canvas itself is still Canvas');
});

itemBankTest('the launch replays Canvas\'s own signature and never leaks the Canvas token to quiz-*', async ({ call, requests }) => {
  await call('list-item-banks', { courseId: COURSE });

  const launch = requests.find(r => r.path === '/api/native/launch');
  assert.equal(launch.body.signature, 'c2lnbmVkLWJ5LWNhbnZhcw==', 'the signature must be the one Canvas computed');
  assert.equal(launch.body.params.oauth_consumer_key, 'key', 'the params must be Canvas\'s, passed through unaltered');

  const jwts = requests.find(r => r.path === '/api/v1/jwts');
  assert.equal(jwts.query.get('context_id'), '1', 'the JWT is scoped to the ROOT account (1), not the course account (4)');
  assert.equal(jwts.query.get('workflows[]'), 'new_quizzes_native_launch');

  // The Canvas API token is the user's only real credential. It must reach
  // Canvas and nothing else.
  for (const request of requests.filter(r => r.host !== '127.0.0.1')) {
    assert.ok(
      !String(request.auth ?? '').includes('test-token'),
      `the Canvas API token was sent to ${request.host}${request.path}`
    );
  }

  const page = requests.find(r => r.path === `/courses/${COURSE}/banks/${TOOL_ID}`);
  assert.match(page.cookie ?? '', /canvas_session=abc/, 'the banks page only renders for a request carrying the session cookie');
});

itemBankTest('quiz-api is given the raw token, with no Bearer prefix', async ({ call, requests }) => {
  await call('list-item-banks', { courseId: COURSE });
  const banks = requests.find(r => r.host === 'quiz-api.localhost');
  assert.ok(banks.auth, 'quiz-api was called with no Authorization header at all');
  assert.ok(
    !banks.auth.startsWith('Bearer '),
    'quiz-api rejects a Bearer-prefixed token with a misleading JWT::DecodeError — it takes the raw JWT'
  );
  assert.match(banks.auth, /^ey/, 'the raw JWT should be the whole header value');
});

itemBankTest('the launch is done once per course and reused across calls', async ({ call, requests }) => {
  await call('list-item-banks', { courseId: COURSE });
  await call('get-item-bank', { courseId: COURSE, bankId: '136' });
  await call('list-item-bank-questions', { courseId: COURSE, bankId: '136' });

  const launches = requests.filter(r => r.path === '/api/native/launch');
  assert.equal(launches.length, 1, 'the whole handshake should run once and the token be reused');
});

itemBankTest('a 401 from quiz-api triggers exactly one relaunch', async ({ call, requests }) => {
  const { text } = await call('list-item-banks', { courseId: COURSE });
  assert.match(text, /Pre-Columbian America/, 'the retried call should succeed');
  assert.equal(
    requests.filter(r => r.path === '/api/native/launch').length, 2,
    'an expired token should be re-minted once'
  );
}, {
  overrides: {
    'GET /api/banks': (_record, requests) =>
      requests.filter(r => r.path === '/api/banks').length === 1
        ? { status: 401, body: { error: 'Signature has expired' } }
        : null,
  },
});

itemBankTest('a token quiz-api refuses twice is reported, not retried forever', async ({ call, requests }) => {
  const { text, isError } = await call('list-item-banks', { courseId: COURSE });
  assert.ok(isError, 'a persistent 401 must surface as an error');
  assert.match(text, /private/, 'the error should say the private API is what failed');
  assert.equal(
    requests.filter(r => r.path === '/api/banks').length, 2,
    'exactly two attempts: the original and one relaunch'
  );
}, {
  overrides: { 'GET /api/banks': () => ({ status: 401, body: { error: 'Signature has expired' } }) },
});

itemBankTest('a course without the Quizzes 2 tool is explained rather than 404ing', async ({ call }) => {
  const { text, isError } = await call('list-item-banks', { courseId: COURSE });
  assert.ok(isError);
  assert.match(text, /no Quizzes 2 \(New Quizzes\) LTI tool/);
}, {
  overrides: {
    [`GET /api/v1/courses/${COURSE}/external_tools`]: () => ({ body: [{ id: 7, name: 'Google Apps', url: 'https://www.google.com/lti' }] }),
  },
});

itemBankTest('a redirect that leaves Canvas is refused rather than followed with the session cookie', async ({ call }) => {
  const { text, isError } = await call('list-item-banks', { courseId: COURSE });
  assert.ok(isError);
  assert.match(text, /redirected off Canvas/);
  assert.match(text, /session cookie/, 'the reason matters: the request carries a live credential');
}, {
  overrides: {
    'GET /banks-redirect': () => ({ status: 302, body: {}, headers: { Location: 'http://evil.localhost:9/steal' } }),
  },
});

itemBankTest('creating a question stores the item and then links it into the bank', async ({ call, requests }) => {
  const { text } = await call('create-item-bank-question', {
    courseId: COURSE,
    bankId: '136',
    interactionType: 'choice',
    body: 'Which ocean borders Washington?',
    choices: ['Atlantic', 'Pacific'],
    correctChoiceIndex: 1,
    title: 'oceans',
  });
  assert.match(text, /entryId 2460/);
  assert.match(text, /itemId 11364/);

  const create = requests.find(r => r.path === '/api/banks/136/items' && r.method === 'POST');
  const item = create.body.item;
  // quiz-api takes a NUMERIC interaction_type_id, where the New Quizzes item
  // API takes an interaction_type_slug. Sending the slug silently fails.
  assert.equal(item.interaction_type_id, '1');
  assert.equal(item.interaction_type_slug, undefined, 'the slug must be translated away, not passed alongside');
  assert.equal(item.user_response_type, 'Uuid', 'taken from the interaction type, not guessed');
  assert.equal(item.scoring_algorithm, 'Equivalence');
  assert.equal(item.item_body, '<p>Which ocean borders Washington?</p>');
  assert.equal(item.scoring_data.value, item.interaction_data.choices[1].id, 'the answer key must name the correct choice');

  // A question is not in the bank until a bank_entry links it there. Creating
  // only the item leaves it real and unreachable.
  const link = requests.find(r => r.path === '/api/banks/136/bank_entries' && r.method === 'POST');
  assert.deepEqual(link.body, { bank_entry: { bank_id: '136', entry_type: 'Item', entry_id: '11364' } });
});

itemBankTest('a question that could not be linked says the item is orphaned', async ({ call }) => {
  const { text, isError } = await call('create-item-bank-question', {
    courseId: COURSE, bankId: '136', interactionType: 'essay', body: 'Explain.',
  });
  assert.ok(isError);
  assert.match(text, /item ID 11364/, 'the orphaned item\'s id is the only way to find it again');
  assert.match(text, /not in any bank/);
}, {
  overrides: { 'POST /api/banks/136/bank_entries': () => ({ status: 422, body: { errors: [{ message: 'nope' }] } }) },
});

itemBankTest('updating a question replaces its content without trying to change its type', async ({ call, requests }) => {
  const { text } = await call('update-item-bank-question', {
    courseId: COURSE, bankId: '136', itemId: '11364',
    interactionType: 'choice', body: 'Edited?', choices: ['a', 'b'], correctChoiceIndex: 0, title: 'v2',
  });
  assert.match(text, /Updated question 11364/);

  const patch = requests.find(r => r.method === 'PATCH');
  assert.equal(patch.path, '/api/banks/136/items/11364');
  assert.equal(patch.body.item.item_body, '<p>Edited?</p>');
  assert.equal(
    patch.body.item.interaction_type_id, undefined,
    'a question\'s type cannot be changed on update; sending it would imply otherwise'
  );
});

itemBankTest('an immutable question explains why the edit was refused', async ({ call }) => {
  const { text, isError } = await call('update-item-bank-question', {
    courseId: COURSE, bankId: '136', itemId: '11364', interactionType: 'essay', body: 'x',
  });
  assert.ok(isError);
  assert.match(text, /seen by a student/);
}, {
  overrides: {
    'PATCH /api/banks/136/items/11364': () => ({
      status: 422,
      body: { errors: [{ message: 'cannot update an immutable item' }] },
    }),
  },
});

itemBankTest('deleting takes the entry id, and the two ids are both reported when listing', async ({ call, requests }) => {
  const { text: listed } = await call('list-item-bank-questions', { courseId: COURSE, bankId: '136' });
  assert.match(listed, /"entryId": "1027"/);
  assert.match(listed, /"itemId": "9454"/);

  const { text } = await call('delete-item-bank-question', { courseId: COURSE, bankId: '136', entryId: '2460' });
  assert.match(text, /Removed question 2460/);
  assert.ok(requests.some(r => r.method === 'DELETE' && r.path === '/api/banks/136/bank_entries/2460'));
});

itemBankTest('listing questions filters by type using the ids the service reports', async ({ call, requests }) => {
  await call('list-item-bank-questions', { courseId: COURSE, bankId: '136', interactionType: 'essay', text: 'photosynthesis' });
  const search = requests.find(r => r.path === '/api/banks/136/bank_entries/search');
  assert.equal(search.query.get('interaction_type_ids[]'), '9', 'the slug must be resolved to this instance\'s id');
  assert.equal(search.query.get('text'), 'photosynthesis');
});

itemBankTest('the bank list reports the whole collection size, not just the page', async ({ call }) => {
  const { text } = await call('list-item-banks', { courseId: COURSE, perPage: 1 });
  assert.match(text, /1 of 290 bank\(s\)/);
  assert.match(text, /pass page 2 for more/);
});
