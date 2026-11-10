// bulk_update is the one v1 endpoint that wants a bare JSON array of
// { id, all_dates } — the old wrapped { assignment_dates: [...] } body got a
// 400 "expected array" from Canvas. Any date left out of the base entry is
// cleared, so current values must be carried forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

function canvasStore({ rejectIds = [] } = {}) {
  const puts = [];
  const store = {
    400001: {
      id: 400001, name: 'AP World Unit 1 Quiz', has_overrides: false,
      all_dates: [{ base: true, due_at: '2026-10-01T06:59:59Z', unlock_at: null, lock_at: null }],
    },
    376533: {
      id: 376533, name: 'Parent Signature Slip', has_overrides: true,
      all_dates: [
        { base: true, due_at: '2026-09-09T06:59:59Z', unlock_at: null, lock_at: null },
        { id: 77, title: '1 student', due_at: '2026-09-12T06:59:59Z', unlock_at: null, lock_at: null },
      ],
    },
  };
  return ({ url, method, body }) => {
    if (method === 'PUT' && url.includes('/bulk_update')) {
      puts.push(body);
      const bad = body.filter(i => rejectIds.includes(i.id));
      if (bad.length) {
        // Canvas fails the whole job when any item is invalid.
        return { id: 6, workflow_state: 'failed', message: 'errors',
          results: bad.map(i => ({ assignment_id: i.id, errors: { due_at: ['must be in term'] } })) };
      }
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
      return { id: 5, workflow_state: 'completed', completion: 100 };
    }
    const m = url.match(/assignments\/(\d+)/);
    if (m) return store[m[1]] ?? { __status: 404, __body: { errors: [{ message: 'The specified resource does not exist.' }] } };
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

test('a batch with one bad assignment applies the rest and reports the skip', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [
        { assignment_id: '400001', lock_at: '2026-11-10T21:30:00Z' },
        { assignment_id: '376533', lock_at: '2026-11-10T21:30:00Z', overrides: [{ override_id: '999', lock_at: '2026-11-10T21:30:00Z' }] },
        { assignment_id: '123456', lock_at: '2026-11-10T21:30:00Z' },
      ],
    });
    const puts = canvas.requests.filter(r => r.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body.map(i => i.id), [400001]);
    const text = JSON.stringify(result);
    assert.match(text, /completed for 1 assignment/);
    assert.match(text, /Skipped 2 assignment/);
    assert.match(text, /override 999 is not on this assignment; its overrides are 77/);
    assert.match(text, /123456.*could not read it/);
  });
});

test('lock_at before due_at is skipped rather than sent', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [
        { assignment_id: '400001', lock_at: '2026-09-01T00:00:00Z' },
        { assignment_id: '376533', lock_at: '2026-11-10T21:30:00Z' },
      ],
    });
    const put = canvas.requests.find(r => r.method === 'PUT');
    assert.deepEqual(put.body.map(i => i.id), [376533]);
    assert.match(JSON.stringify(result), /400001.*lock_at 2026-09-01T00:00:00Z is before due_at/);
  });
});

test('when Canvas rejects the job over one assignment, the rest are retried', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore({ rejectIds: [400001] }));
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [
        { assignment_id: '400001', lock_at: '2026-11-10T21:30:00Z' },
        { assignment_id: '376533', lock_at: '2026-11-10T21:30:00Z' },
      ],
    });
    const puts = canvas.requests.filter(r => r.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[1].body.map(i => i.id), [376533]);
    const text = JSON.stringify(result);
    assert.match(text, /completed for 1 assignment/);
    assert.match(text, /400001.*Canvas rejected it/);
  });
});

test('a batch where nothing can be updated writes nothing', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasStore());
    const result = await canvas.callTool('bulk-update-assignment-dates', {
      courseId: '26079',
      assignmentDates: [{ assignment_id: '376533', overrides: [{ override_id: '999', lock_at: '2026-11-10T21:30:00Z' }] }],
    });
    assert.match(JSON.stringify(result), /No assignment in the batch could be updated/);
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
