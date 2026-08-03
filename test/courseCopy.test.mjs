// A course copy merges rather than replaces, and Canvas has no undo for one.
// The refusals are the feature; the wire format matters because date_shift_options
// is nested and a dropped key means last term's due dates arrive intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const MIGRATION = {
  id: 771,
  workflow_state: 'pre_processing',
  migration_type: 'course_copy_importer',
  progress_url: 'http://127.0.0.1/api/v1/progress/900',
  settings: { source_course_id: '16477' },
};

// An empty destination unless the test says otherwise: assignments, modules and
// pages are what the emptiness check reads.
function canvasWith({
  assignments = [],
  modules = [],
  pages = [],
  migration = MIGRATION,
  issues = [],
  progress = { completion: 40 },
} = {}) {
  return ({ url, method }) => {
    if (url.includes('/migration_issues')) return issues;
    if (url.includes('/progress/')) return progress;
    if (url.includes('/content_migrations')) {
      // A single migration and the list live at nearly the same path; returning
      // the list for both would leave every field undefined and quietly weaken
      // these assertions.
      if (/\/content_migrations\/\d+/.test(url)) return migration;
      return method === 'POST' ? migration : [migration];
    }
    if (url.includes('/assignments')) return assignments;
    if (url.includes('/modules')) return modules;
    if (url.includes('/pages')) return pages;
    return {};
  };
}

test('a copy into an empty shell sends course_copy_importer and the source course', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.match(write.url, /\/courses\/18473\/content_migrations/);
    assert.equal(write.body.migration_type, 'course_copy_importer');
    assert.equal(write.body.settings.source_course_id, '16477');
    assert.match(canvas.textOf(result), /Migration 771/);
  });
});

// The refusal that matters: copying into a course that already has content
// leaves two of everything, and unpicking it is manual.
test('a destination that already has content is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      assignments: [{ id: 1 }, { id: 2 }],
      modules: [{ id: 3 }],
    }));
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
    });

    const text = JSON.stringify(result);
    assert.match(text, /not empty/);
    assert.match(text, /2 assignment\(s\), 1 module\(s\)/);
    assert.match(text, /allowExistingContent/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'), 'nothing may be copied while this is unconfirmed');
  });
});

test('allowExistingContent proceeds, and says duplicates are coming', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ assignments: [{ id: 1 }] }));
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473', allowExistingContent: true,
    });
    assert.ok(canvas.requests.some(r => r.method === 'POST'));
    assert.match(canvas.textOf(result), /Expect duplicates/);
  });
});

test('copying a course into itself is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '18473', destinationCourseId: '18473',
    });
    assert.match(JSON.stringify(result), /cannot be copied into itself/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

test('date shifting reaches Canvas in the nested shape it expects', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
      shiftDates: true,
      oldStartDate: '2026-01-06', newStartDate: '2026-08-24',
      oldEndDate: '2026-05-22', newEndDate: '2026-12-18',
    });

    const options = canvas.requests.find(r => r.method === 'POST').body.date_shift_options;
    assert.equal(options.shift_dates, true);
    assert.equal(options.old_start_date, '2026-01-06');
    assert.equal(options.new_start_date, '2026-08-24');
    assert.equal(options.old_end_date, '2026-05-22');
    assert.equal(options.new_end_date, '2026-12-18');
  });
});

// Canvas rounds the shift to whole weeks so each item keeps its weekday —
// verified live, where a 358-day request was applied as 357 and a Friday
// stayed a Friday. The dates given are therefore not a literal instruction.
test('a date shift says that Canvas preserves the weekday rather than the exact offset', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
      shiftDates: true, oldStartDate: '2026-01-06', newStartDate: '2026-08-24',
    });
    const text = canvas.textOf(result);
    assert.match(text, /DAY OF THE WEEK/);
    assert.match(text, /whole weeks/);
  });
});

// Without the dates there is nothing to shift between, and the copy would
// silently arrive carrying last term's due dates.
test('shiftDates without the start dates is refused rather than sent', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473', shiftDates: true,
    });
    assert.match(JSON.stringify(result), /needs oldStartDate and newStartDate/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

test('shiftDates and removeDates together are refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
      shiftDates: true, removeDates: true,
      oldStartDate: '2026-01-06', newStartDate: '2026-08-24',
    });
    assert.match(JSON.stringify(result), /mutually exclusive/);
  });
});

test('removeDates strips dates instead of shifting them', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473', removeDates: true,
    });
    assert.deepEqual(canvas.requests.find(r => r.method === 'POST').body.date_shift_options, { remove_dates: true });
    assert.match(canvas.textOf(result), /arrive undated/);
  });
});

// Day substitutions are a keyed map, the shape that used to break on this
// server when passed as a JSON string by a client.
test('day substitutions survive as an object, whether given as one or as a string', async () => {
  for (const value of [{ 1: '3' }, '{"1":"3"}']) {
    await withMockCanvas(async canvas => {
      canvas.setResponse(canvasWith());
      const result = await canvas.callTool('copy-course-content', {
        sourceCourseId: '16477', destinationCourseId: '18473',
        shiftDates: true, oldStartDate: '2026-01-06', newStartDate: '2026-08-24',
        daySubstitutions: value,
      });
      const options = canvas.requests.find(r => r.method === 'POST').body.date_shift_options;
      assert.deepEqual(options.day_substitutions, { 1: '3' });
      assert.match(canvas.textOf(result), /Monday to Wednesday/);
    });
  }
});

test('a copy with no date handling says the old due dates are coming with it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('copy-course-content', {
      sourceCourseId: '16477', destinationCourseId: '18473',
    });
    assert.match(canvas.textOf(result), /still carry last term's due dates/);
  });
});

// A migration record is polled, not read. The cache serves any entry without a
// network call for its first 60 seconds, which is exactly a status-checking
// cadence — live, two consecutive checks returned an identical state while the
// copy was progressing.
test('a migration status is never served from cache', async () => {
  await withMockCanvas(async canvas => {
    let state = 'running';
    canvas.setResponse(({ url }) => {
      if (url.includes('/migration_issues')) return [];
      if (url.includes('/progress/')) return { completion: 40 };
      if (/\/content_migrations\/\d+/.test(url)) return { ...MIGRATION, workflow_state: state };
      return {};
    });

    await canvas.callTool('get-content-migration', { courseId: '18473', migrationId: '771' });
    state = 'completed';
    const result = await canvas.callTool('get-content-migration', { courseId: '18473', migrationId: '771' });

    // Two network reads, and the second must see the new state.
    const statusReads = canvas.requests.filter(r =>
      /\/content_migrations\/771/.test(r.url) && !r.url.includes('migration_issues')
    );
    assert.equal(statusReads.length, 2, 'the second check must reach Canvas rather than the cache');
    assert.match(canvas.textOf(result), /finished/);
  });
});

test('an in-flight migration reports its progress percentage', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      migration: {
        ...MIGRATION,
        workflow_state: 'running',
        // Absolute, the way Canvas returns it — the client must follow it as-is.
        progress_url: `${canvas.baseUrl}/api/v1/progress/900`,
      },
    }));
    const result = await canvas.callTool('get-content-migration', {
      courseId: '18473', migrationId: '771',
    });
    assert.match(canvas.textOf(result), /running now — 40% complete/);
  });
});

// A migration can say "completed" and still have dropped content. That is only
// recorded in migration_issues, so it is part of the result, not an extra.
test('a completed migration still reports what it failed to bring across', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      migration: { ...MIGRATION, workflow_state: 'completed', finished_at: '2026-08-03T04:00:00Z' },
      issues: [{ issue_type: 'warning', description: 'Couldn\'t find the linked file for page "Welcome"' }],
    }));
    const result = await canvas.callTool('get-content-migration', {
      courseId: '18473', migrationId: '771',
    });
    const text = canvas.textOf(result);
    assert.match(text, /finished/);
    assert.match(text, /did not come across cleanly/);
    assert.match(text, /linked file/);
  });
});

test('a clean completed migration says so explicitly', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ migration: { ...MIGRATION, workflow_state: 'completed' } }));
    const result = await canvas.callTool('get-content-migration', {
      courseId: '18473', migrationId: '771',
    });
    assert.match(canvas.textOf(result), /no migration issues/);
  });
});

test('a failed migration is called a failure, not a status', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      migration: { ...MIGRATION, workflow_state: 'failed' },
      issues: [{ issue_type: 'error', description: 'Source course not found' }],
    }));
    const result = await canvas.callTool('get-content-migration', {
      courseId: '18473', migrationId: '771',
    });
    const text = canvas.textOf(result);
    assert.match(text, /FAILED/);
    assert.match(text, /Source course not found/);
  });
});

// Selective import is not supported; a migration parked in that state would
// otherwise look like it was merely slow.
test('a migration waiting for a selection says this server cannot finish it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ migration: { ...MIGRATION, workflow_state: 'waiting_for_select' } }));
    const result = await canvas.callTool('get-content-migration', {
      courseId: '18473', migrationId: '771',
    });
    assert.match(canvas.textOf(result), /finish it in the Canvas UI/);
  });
});

test('a course with no migrations says so plainly', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => (url.includes('/content_migrations') ? [] : {}));
    const result = await canvas.callTool('list-content-migrations', { courseId: '18473' });
    assert.match(canvas.textOf(result), /No content has ever been copied/);
  });
});
