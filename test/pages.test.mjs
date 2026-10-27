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

// Canvas puts its Previous/Next module controls flush against the page body:
// #module_navigation_target has no spacing above, #wiki_page_show none below.
// Nothing but the body HTML is ours to change, so the gap comes from here.
test('a page body gets a spacer so it does not sit flush against the module controls', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', body: '<p>hi</p>', published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.match(write.body.wiki_page.body, /class="mcp-page-end"/);
    assert.match(write.body.wiki_page.body, /height: 2rem/);
  });
});

// The accumulation hazard: read a page, edit it, write it back, repeat. Without
// the marker check each pass would add another empty div for ever.
test('the spacer is not added twice on a read-edit-write round trip', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    const once = '<p>hi</p>\n<div class="mcp-page-end" style="height: 2rem;" aria-hidden="true"></div>';
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', body: once, published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    const count = (write.body.wiki_page.body.match(/mcp-page-end/g) || []).length;
    assert.equal(count, 1, 'a second spacer would accumulate on every round trip');
  });
});

test('page-end spacing can be turned off', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('update-page-content', {
      courseId: '18473', pageUrl: 'unit-1', body: '<p>hi</p>', pageEndSpacing: false, published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.doesNotMatch(write.body.wiki_page.body, /mcp-page-end/);
  });
});

test('apply-page-changes spaces the page end too', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('apply-page-changes', {
      courseId: '18473', pageUrl: 'unit-1', newContent: '<p>revised</p>',
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.match(write.body.wiki_page.body, /mcp-page-end/);
  });
});

// apply-page-changes is the writing half of the patch flow, so it needs the
// publish parameter for the same reason update-page-content did.
test('apply-page-changes can publish', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasPages());
    await canvas.callTool('apply-page-changes', {
      courseId: '18473', pageUrl: 'unit-1', newContent: '<p>revised</p>', published: true,
    });
    const write = canvas.requests.find(r => r.method !== 'GET');
    assert.equal(write.body.wiki_page.published, true);
  });
});

// patch-page-content does not write to Canvas at all. It briefly advertised
// published and notifyOfUpdate because an edit matched a line it shares with
// update-page-content — parameters that would have been accepted and silently
// done nothing, which is the exact failure this server exists to avoid.
test('the read-only patch tool advertises no write-only parameters', async () => {
  await withMockCanvas(async canvas => {
    const tools = await canvas.listTools();
    const patch = tools.find(t => t.name === 'patch-page-content');
    const params = Object.keys(patch.inputSchema.properties ?? {});
    // Guard against this passing because the schema was read wrongly.
    assert.ok(params.includes('instructions'), 'schema not read correctly');
    for (const forbidden of ['published', 'notifyOfUpdate', 'pageEndSpacing']) {
      assert.equal(params.includes(forbidden), false,
        `patch-page-content does not write, so ${forbidden} would do nothing`);
    }
  });
});
