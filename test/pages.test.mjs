// Every page this server created before 1.19.0 was invisible to students:
// Canvas creates pages in draft state, and the tool had no way to publish one.
// It reported "Published: No" and nothing said that mattered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

// Echoes the write back the way Canvas does, deriving a new page's slug from
// its title rather than from the request path.
function canvasPages({ published = false } = {}) {
  return ({ body }) => {
    const wiki = body?.wiki_page ?? {};
    const title = wiki.title ?? 'Untitled';
    return {
      url: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title,
      page_id: 87725,
      published: wiki.published ?? published,
      updated_at: '2026-08-04T20:56:12Z',
    };
  };
}

test('published is sent to Canvas as wiki_page[published]', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>', published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.equal(write.body.wiki_page.published, true);
  });
});

test('a page left unpublished is warned about, since students cannot see it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>',
    });
    const text = canvas.textOf(result);
    assert.match(text, /UNPUBLISHED/);
    assert.match(text, /published: true/);
  });
});

// A warning that fires on every call is one nobody reads, so it must not fire
// when the caller deliberately asked for a draft.
test('no unpublished warning when a draft was asked for explicitly', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>', published: false,
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});

test('no unpublished warning on a page that is published', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>', published: true,
    });
    assert.doesNotMatch(canvas.textOf(result), /UNPUBLISHED/);
  });
});

// Verified live: asking for 'mcp-publish-probe' with the title "MCP Publish
// Probe (throwaway)" produced 'mcp-publish-probe-throwaway', and reading back
// the requested slug 404s.
test('a slug Canvas renamed is pointed out rather than left to 404', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'mcp-publish-probe',
      title: 'MCP Publish Probe (throwaway)', body: '<p>hi</p>', published: true,
    });
    const text = canvas.textOf(result);
    assert.match(text, /mcp-publish-probe-throwaway/);
    assert.match(text, /not the 'mcp-publish-probe' that was asked for/);
  });
});

test('a slug Canvas kept produces no note', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>', published: true,
    });
    assert.doesNotMatch(canvas.textOf(result), /NOTE: Canvas stored/);
  });
});

// Notifying the class is a real outward-facing side effect; it must never be
// sent unless asked for.
test('notify_of_update is not sent unless asked for', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', title: 'Unit 1', body: '<p>hi</p>', published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.equal('notify_of_update' in write.body.wiki_page, false);
  });
});

test('notifyOfUpdate reaches Canvas when it is asked for', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', body: '<p>hi</p>', notifyOfUpdate: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.equal(write.body.wiki_page.notify_of_update, true);
  });
});

// published alone is a real edit — publishing an existing page — so it must
// not fall into the "nothing to write" guard.
test('published on its own is a write, not a no-op', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const result = await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', published: true,
    });
    assert.doesNotMatch(canvas.textOf(result), /nothing was written/);
    assert.ok(canvas.requests.some(r => r.method !== 'GET'), 'must actually write');
  });
});
