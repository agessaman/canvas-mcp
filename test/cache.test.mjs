// Reads are cached, and a cached read is indistinguishable from a resource
// that does not exist. Write tools invalidate what they touch, so edits made
// THROUGH this server are covered; edits made in the Canvas UI, by a
// co-teacher, or by a background job finishing are not.
//
// This cost a wrong conclusion during the 1.14 work: a question attached to a
// stimulus in the Canvas UI kept not appearing in a cached listing and was
// nearly recorded as "the API does not expose attached questions". The
// assertion that matters here is that a second read really does go back to
// Canvas — which is exactly what no tool parameter could previously force.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

test('a repeated read is served from cache without hitting Canvas', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '1', title: 'Original' }));
    await canvas.callTool('get-quiz', { courseId: '1', quizId: '2' });
    const afterFirst = canvas.requests.filter(r => r.method === 'GET').length;

    await canvas.callTool('get-quiz', { courseId: '1', quizId: '2' });
    assert.equal(
      canvas.requests.filter(r => r.method === 'GET').length, afterFirst,
      'the second read should have been served from cache'
    );
  });
});

test('refresh-canvas-data makes the next read go back to Canvas', async () => {
  await withMockCanvas(async canvas => {
    let title = 'Original';
    canvas.setResponse(() => ({ id: '1', title }));

    await canvas.callTool('get-quiz', { courseId: '1', quizId: '2' });
    const afterFirst = canvas.requests.filter(r => r.method === 'GET').length;

    // Stand-in for an edit made in the Canvas UI: this server cannot know.
    title = 'Renamed in the Canvas UI';

    const refresh = await canvas.callTool('refresh-canvas-data', {});
    assert.match(canvas.textOf(refresh), /Discarded \d+ cached response/);

    const result = await canvas.callTool('get-quiz', { courseId: '1', quizId: '2' });
    assert.ok(
      canvas.requests.filter(r => r.method === 'GET').length > afterFirst,
      'the read after a refresh must reach Canvas'
    );
    assert.match(canvas.textOf(result), /Renamed in the Canvas UI/);
  });
});

test('refreshing an empty cache says so rather than claiming work', async () => {
  await withMockCanvas(async canvas => {
    const result = await canvas.callTool('refresh-canvas-data', {});
    assert.match(canvas.textOf(result), /Nothing was cached/);
  });
});

test('refresh-canvas-data sends nothing to Canvas itself', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ id: '1', title: 'Original' }));
    await canvas.callTool('get-quiz', { courseId: '1', quizId: '2' });
    const before = canvas.requests.length;

    await canvas.callTool('refresh-canvas-data', {});
    assert.equal(canvas.requests.length, before, 'clearing a local cache is not a Canvas call');
  });
});
