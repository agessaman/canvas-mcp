// The syllabus is the one body of text on this server with no undo. Wiki pages
// have revisions and a revert tool; course[syllabus_body] is a plain column, so
// an overwrite is simply gone. Most of these tests are about that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const COURSE = {
  id: 18473,
  name: "Sandbox '23",
  workflow_state: 'unpublished',
  syllabus_body: '<p>Week 1: Introduction</p>',
};

// Echoes a course back, with the write applied, so readback assertions mean
// something. `distort` models Canvas quietly not applying a write.
function canvasWith({ course = COURSE, distort = (x) => x, page } = {}) {
  return ({ url, body, method }) => {
    if (url.includes('/pages/')) {
      if (page) return page;
      // Echo the page back the way Canvas does, so assertions about what was
      // written mean something — a fixed fixture would pass regardless.
      const wiki = body?.wiki_page ?? {};
      return {
        page_id: 42,
        title: wiki.title ?? 'Welcome',
        url: decodeURIComponent(url.split('/pages/')[1] ?? 'welcome').split('?')[0],
        published: wiki.published ?? true,
        front_page: wiki.front_page ?? false,
        body: wiki.body,
      };
    }
    if (method === 'PUT' && body?.course) {
      const merged = { ...course, ...body.course };
      if (body.course.event) {
        merged.workflow_state = { offer: 'available', claim: 'unpublished', conclude: 'completed' }[body.course.event];
        delete merged.event;
      }
      return distort(merged);
    }
    return course;
  };
}

// The syllabus has no version history of its own, so the outgoing text is
// copied to a page — which does have one — before it is overwritten.
test('replacing a syllabus backs the old one up to an unpublished page first', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Entirely new</p>',
    });

    const backup = canvas.requests.find(r => r.url.includes('/pages/'));
    assert.ok(backup, 'the old syllabus must be written somewhere before it is destroyed');
    assert.match(backup.url, /syllabus-backup/);
    assert.equal(backup.body.wiki_page.title, 'Syllabus - Backup');
    assert.equal(backup.body.wiki_page.published, false, 'students must not see the old syllabus');
    assert.match(backup.body.wiki_page.body, /Week 1: Introduction/);

    const write = canvas.requests.find(r => r.body?.course);
    assert.equal(write.body.course.syllabus_body, '<p>Entirely new</p>');
    assert.match(canvas.textOf(result), /Syllabus - Backup/);
    assert.match(canvas.textOf(result), /list-page-revisions/);
  });
});

// Ordering is the whole guarantee. A backup written after the overwrite would
// be a backup of the new text.
test('the backup is written before the syllabus is overwritten', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('update-syllabus', { courseId: '18473', body: '<p>New</p>' });

    const backupIndex = canvas.requests.findIndex(r => r.url.includes('/pages/'));
    const writeIndex = canvas.requests.findIndex(r => r.body?.course);
    assert.ok(backupIndex !== -1 && writeIndex !== -1);
    assert.ok(backupIndex < writeIndex, 'backup must precede the destructive write');
  });
});

// A backup that silently failed is worse than none, because the caller believes
// the old text is recoverable when it is not.
test('a failed backup stops the syllabus from being replaced', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.includes('/pages/')) return { __status: 403, __body: { errors: ['forbidden'] } };
      return COURSE;
    });
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Entirely new</p>',
    });

    assert.match(JSON.stringify(result), /Failed to update syllabus/);
    assert.ok(
      !canvas.requests.some(r => r.body?.course),
      'the syllabus must be left alone when its backup could not be written'
    );
  });
});

// An unpublished backup is the point; a published one would show students an
// outdated syllabus.
test('a backup page Canvas published anyway aborts the replacement', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      page: { title: 'Syllabus - Backup', url: 'syllabus-backup', page_id: 9, published: true },
    }));
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Entirely new</p>',
    });
    assert.match(JSON.stringify(result), /came back PUBLISHED/);
    assert.ok(!canvas.requests.some(r => r.body?.course), 'the syllabus must not be changed');
  });
});

test('backup: false skips the page and says the old syllabus is gone', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Entirely new</p>', backup: false,
    });
    assert.ok(!canvas.requests.some(r => r.url.includes('/pages/')), 'no backup page should be written');
    assert.match(canvas.textOf(result), /previous syllabus is gone/);
  });
});

test('append adds to the syllabus and needs no backup, since nothing is destroyed', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Week 2: Methods</p>', mode: 'append',
    });

    const write = canvas.requests.find(r => r.body?.course);
    assert.match(write.body.course.syllabus_body, /Week 1: Introduction/);
    assert.match(write.body.course.syllabus_body, /Week 2: Methods/);
    assert.ok(!canvas.requests.some(r => r.url.includes('/pages/')));
  });
});

test('prepend puts the new content above what was already there', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Read this first</p>', mode: 'prepend',
    });
    const stored = canvas.requests.find(r => r.body?.course).body.course.syllabus_body;
    assert.ok(
      stored.indexOf('Read this first') < stored.indexOf('Week 1'),
      'prepended content should come first'
    );
  });
});

test('a first syllabus is written as-is, with nothing to back up', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ course: { ...COURSE, syllabus_body: null } }));
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Week 1</p>',
    });
    assert.equal(canvas.requests.find(r => r.body?.course).body.course.syllabus_body, '<p>Week 1</p>');
    assert.ok(!canvas.requests.some(r => r.url.includes('/pages/')), 'an empty syllabus needs no backup');
    assert.match(canvas.textOf(result), /Set the syllabus/);
  });
});

test('a syllabus Canvas did not store is reported, not called a success', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      distort: course => ({ ...course, syllabus_body: '' }),
    }));
    const result = await canvas.callTool('update-syllabus', {
      courseId: '18473', body: '<p>Week 2</p>',
    });
    assert.match(canvas.textOf(result), /WARNING[\s\S]*empty syllabus/);
  });
});

test('the syllabus is read from the course, not from a page', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('get-syllabus', { courseId: '18473' });
    assert.ok(
      canvas.requests.some(r => /syllabus_body/.test(r.url)),
      'must request include[]=syllabus_body'
    );
    assert.match(canvas.textOf(result), /Week 1: Introduction/);
  });
});

test('publishing a course sends event=offer and reports the new state', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('set-course-publish-state', {
      courseId: '18473', state: 'published',
    });
    assert.equal(canvas.requests.find(r => r.method === 'PUT').body.course.event, 'offer');
    assert.match(canvas.textOf(result), /now available/);
    assert.match(canvas.textOf(result), /Students can now see it/);
  });
});

test('concluding a course sends event=conclude', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('set-course-publish-state', { courseId: '18473', state: 'concluded' });
    assert.equal(canvas.requests.find(r => r.method === 'PUT').body.course.event, 'conclude');
  });
});

// Canvas refuses to unpublish a course with submissions by leaving the state
// alone, not by erroring — which would otherwise read as success.
test('a publish state Canvas refused to change is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      course: { ...COURSE, workflow_state: 'available' },
      distort: course => ({ ...course, workflow_state: 'available' }),
    }));
    const result = await canvas.callTool('set-course-publish-state', {
      courseId: '18473', state: 'unpublished',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /students have submitted work/);
  });
});

// course[event] also takes 'delete', which removes the course and every
// enrollment in it. No tool may reach it.
test('no tool can delete a course', async () => {
  await withMockCanvas(async canvas => {
    const tools = await canvas.listTools();
    const courseDeleters = tools.filter(tool =>
      /course/i.test(tool.name) && /delete|destroy|remove/i.test(tool.name)
    );
    assert.deepEqual(courseDeleters.map(t => t.name), []);

    // And the publish tool must not accept it by another name.
    const publish = tools.find(t => t.name === 'set-course-publish-state');
    assert.ok(!JSON.stringify(publish.inputSchema).includes('delete'));
  });
});

test('setting a front page marks the page and can move the landing page', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('set-front-page', {
      courseId: '18473', pageUrl: 'welcome', makeLandingPage: true,
    });

    const pageWrite = canvas.requests.find(r => r.url.includes('/pages/'));
    assert.equal(pageWrite.body.wiki_page.front_page, true);
    const courseWrite = canvas.requests.find(r => r.body?.course);
    assert.equal(courseWrite.body.course.default_view, 'wiki');
    assert.match(canvas.textOf(result), /now the front page/);
  });
});

test('a page Canvas refused to make the front page is an error, not a success', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ page: { title: 'Draft', url: 'draft', front_page: false } }));
    const result = await canvas.callTool('set-front-page', {
      courseId: '18473', pageUrl: 'draft',
    });
    assert.match(JSON.stringify(result), /unpublished page cannot be the front page/);
  });
});

test('a wiki landing page warns that it needs a front page to exist', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-course-settings', {
      courseId: '18473', defaultView: 'wiki',
    });
    assert.match(canvas.textOf(result), /students land on an error/);
  });
});

test('a setting Canvas silently ignored is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      distort: course => ({ ...course, name: "Sandbox '23" }),
    }));
    const result = await canvas.callTool('update-course-settings', {
      courseId: '18473', name: 'Renamed Course',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /silently ignores/);
  });
});

test('an empty settings call changes nothing rather than sending an empty write', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-course-settings', { courseId: '18473' });
    assert.match(canvas.textOf(result), /nothing was changed/);
    assert.ok(!canvas.requests.some(r => r.method === 'PUT'));
  });
});
