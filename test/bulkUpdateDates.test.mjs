// bulk_update is the one v1 endpoint that wants a bare JSON array of
// { id, all_dates } — the old wrapped { assignment_dates: [...] } body got a
// 400 "expected array" from Canvas. Any date left out of the base entry is
// cleared, so current values must be carried forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

function canvasStore() {
  const store = {
    376533: {
      id: 376533, name: 'Parent Signature Slip', has_overrides: true,
      all_dates: [
        { base: true, due_at: '2026-09-09T06:59:59Z', unlock_at: null, lock_at: null },
        { id: 77, title: '1 student', due_at: '2026-09-12T06:59:59Z', unlock_at: null, lock_at: null },
      ],
    },
  };
  let polls = 0;
  return ({ url, method, body }) => {
    if (method === 'PUT' && url.includes('/bulk_update')) {
      for (const item of body) {
        const a = store[item.id];
        a.all_dates = a.all_dates.map(d => {
          const upd = item.all_dates.find(e => (d.base ? e.base : e.id === d.id));
          return upd ? { ...d, ...upd } : d;
        });
      }
      return { id: 5, workflow_state: 'queued', completion: 0 };
    }
    if (url.startsWith('/api/v1/progress/5')) {
      polls++;
      return { id: 5, workflow_state: 'completed', completion: 100 };
    }
    const m = url.match(/assignments\/(\d+)/);
    if (m) return store[m[1]];
    return {};
  };
}

test('bulk dates go out as a bare array of {id, all_dates}, keeping unchanged dates', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [{ assignment_id: '376533', lock_at: '2026-11-10T21:30:00Z' }],
    });
    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.ok(Array.isArray(put.body), 'body must be a bare array');
    assert.match(put.headers['content-type'], /application\/json/);
    assert.deepEqual(put.body, [{
      id: 376533,
      all_dates: [{ base: true, due_at: '2026-09-09T06:59:59Z', unlock_at: null, lock_at: '2026-11-10T21:30:00Z' }],
    }]);
    const text = JSON.stringify(result);
    assert.match(text, /every date verified/);
    // The untouched student override is called out, since it would still be open.
    assert.match(text, /overrides that were left unchanged/);
  });
});

test('override dates are sent by override id and verified', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [{
        assignment_id: '376533', lock_at: '2026-11-10T21:30:00Z',
        overrides: [{ override_id: '77', lock_at: '2026-11-10T21:30:00Z' }],
      }],
    });
    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.deepEqual(put.body[0].all_dates[1],
      { id: 77, due_at: '2026-09-12T06:59:59Z', unlock_at: null, lock_at: '2026-11-10T21:30:00Z' });
    const text = JSON.stringify(result);
    assert.match(text, /every date verified/);
    assert.doesNotMatch(text, /left unchanged/);
  });
});

test('an unknown override id is refused before anything is written', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [{ assignment_id: '376533', overrides: [{ override_id: '999', lock_at: '2026-11-10T21:30:00Z' }] }],
    });
    assert.match(JSON.stringify(result), /Override 999 is not on assignment 376533/);
    assert.equal(canvas.requests.filter(r => r.method === 'PUT').length, 0);
  });
});

test('update-assignment passes lock_at and unlock_at through', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ body }) => ({ id: 1, name: 'x', ...(body?.assignment ?? {}) }));
    await canvas.callTool('update-assignment', {
      courseId: '26079', assignmentId: '376533', lock_at: '2026-11-10T21:30:00Z', unlock_at: null,
    });
    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.deepEqual(put.body.assignment, { lock_at: '2026-11-10T21:30:00Z', unlock_at: null });
  });
});
