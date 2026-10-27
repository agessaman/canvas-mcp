// Calendar events have no draft state — a create is immediately student-visible
// — and one call can make 200 of them. Plus duplication, whose whole risk is the
// asynchronous case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const EVENT = {
  id: 5501,
  title: 'Midterm review session',
  start_at: '2026-09-14T17:00:00Z',
  end_at: '2026-09-14T18:00:00Z',
  location_name: 'Room 214',
  context_code: 'course_18473',
};

function canvasWith({ event = EVENT, events = [EVENT], distort = (x) => x } = {}) {
  return ({ url, body, method }) => {
    if (url.includes('/calendar_events')) {
      if (method === 'POST' || method === 'PUT') {
        return distort({ ...event, ...(body?.calendar_event ?? {}) });
      }
      if (method === 'DELETE') return event;
      return events;
    }
    return {};
  };
}

test('an event is created against the course context code', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473',
      title: 'Midterm review session',
      startAt: '2026-09-14T17:00:00Z',
      endAt: '2026-09-14T18:00:00Z',
      locationName: 'Room 214',
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.equal(write.body.calendar_event.context_code, 'course_18473');
    assert.equal(write.body.calendar_event.title, 'Midterm review session');
    assert.equal(write.body.calendar_event.location_name, 'Room 214');
    // No draft state exists, so this must be said rather than assumed known.
    assert.match(canvas.textOf(result), /Students in a published course can see this now/);
  });
});

test('a recurring series sends the duplicate block and says how many events it made', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473',
      title: 'Office hours',
      startAt: '2026-09-01T16:00:00Z',
      repeatCount: 9,
      repeatFrequency: 'weekly',
    });

    const sent = canvas.requests.find(r => r.method === 'POST').body.calendar_event;
    assert.deepEqual(sent.duplicate, { count: 9, frequency: 'weekly', interval: 1 });
    // 9 additional copies plus the original.
    assert.match(canvas.textOf(result), /created 10 events/);
  });
});

test('a repeat count with no frequency is refused rather than silently made once', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473', title: 'Office hours', startAt: '2026-09-01T16:00:00Z', repeatCount: 9,
    });
    assert.match(JSON.stringify(result), /needs repeatFrequency/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

// A frequency without a count would create exactly one event, with the
// frequency quietly discarded — a recurring series that isn't.
test('a frequency with no count is refused too', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473', title: 'Office hours', startAt: '2026-09-01T16:00:00Z', repeatFrequency: 'weekly',
    });
    assert.match(JSON.stringify(result), /needs repeatCount/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

// A bare date is read in the course's time zone, so an event can land on a
// different day from the one asked for without anyone noticing.
test('a start time Canvas stored differently is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      distort: event => ({ ...event, start_at: '2026-09-15T17:00:00Z' }),
    }));
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473', title: 'Exam', startAt: '2026-09-14T17:00:00Z',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /course time zone/);
  });
});

test('listing defaults to a date window and reports it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('list-calendar-events', { courseId: '18473' });

    const read = canvas.requests.find(r => r.method === 'GET');
    assert.match(read.url, /context_codes%5B%5D=course_18473|context_codes\[\]=course_18473/);
    assert.match(read.url, /type=event/);
    assert.match(read.url, /start_date=/);
    assert.match(canvas.textOf(result), /Midterm review session/);
  });
});

test('allEvents drops the date filter instead of quietly keeping it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('list-calendar-events', { courseId: '18473', allEvents: true });
    const read = canvas.requests.find(r => r.method === 'GET');
    assert.match(read.url, /all_events=true/);
    assert.ok(!/start_date=/.test(read.url), 'a date filter would contradict allEvents');
  });
});

test('an empty calendar suggests widening the window rather than just saying none', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ events: [] }));
    const result = await canvas.callTool('list-calendar-events', { courseId: '18473' });
    assert.match(canvas.textOf(result), /Widen the range/);
  });
});

// 'which' is what separates moving one office hour from moving the whole term's.
test('updating one occurrence does not send a series-wide which', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('update-calendar-event', {
      eventId: '5501', locationName: 'Room 300',
    });
    const write = canvas.requests.find(r => r.method === 'PUT');
    assert.equal(write.body.calendar_event.location_name, 'Room 300');
    assert.ok(!/which=/.test(write.url), 'a single-occurrence edit must not carry a series scope');
  });
});

test('updating a whole series passes which=all and says so', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ event: { ...EVENT, series_uuid: 'abc-123' } }));
    const result = await canvas.callTool('update-calendar-event', {
      eventId: '5501', locationName: 'Room 300', which: 'all',
    });
    assert.match(canvas.requests.find(r => r.method === 'PUT').url, /which=all/);
    assert.match(canvas.textOf(result), /Every event in its series was changed/);
  });
});

test('a deletion defaults to the single occurrence', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    await canvas.callTool('delete-calendar-event', { eventId: '5501' });
    const write = canvas.requests.find(r => r.method === 'DELETE');
    assert.ok(!/which=/.test(write.url), 'deleting one event must not reach the series by default');
  });
});

// A real series carries a series_uuid, and only then does which=all mean
// anything.
test('deleting a real series is explicit and reported as such', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ event: { ...EVENT, series_uuid: 'abc-123' } }));
    const result = await canvas.callTool('delete-calendar-event', { eventId: '5501', which: 'all' });
    assert.match(canvas.requests.find(r => r.method === 'DELETE').url, /which=all/);
    assert.match(canvas.textOf(result), /entire series was deleted/);
  });
});

// Found live: repeatCount events are independent, Canvas ignores `which` on
// them and still answers 200. Deleting the first of four with which=all removed
// exactly one and left three orphans, while the tool announced a series-wide
// delete that never happened.
test('which=all on an event with no series says so instead of claiming a series delete', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith()); // EVENT has no series_uuid
    const result = await canvas.callTool('delete-calendar-event', { eventId: '5501', which: 'all' });
    const text = canvas.textOf(result);
    assert.doesNotMatch(text, /entire series was deleted/, 'must not claim a deletion that did not happen');
    assert.match(text, /had no effect/);
    assert.match(text, /delete the rest individually/);
  });
});

test('which=all on an unseried event does not claim a series-wide edit either', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-calendar-event', {
      eventId: '5501', locationName: 'Room 300', which: 'all',
    });
    const text = canvas.textOf(result);
    assert.doesNotMatch(text, /Every event in its series was changed/);
    assert.match(text, /had no effect/);
  });
});

test('creating repeating events warns that they are independent, not a series', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('create-calendar-event', {
      courseId: '18473', title: 'Office hours', startAt: '2026-09-01T16:00:00Z',
      repeatCount: 3, repeatFrequency: 'weekly',
    });
    const text = canvas.textOf(result);
    assert.match(text, /INDEPENDENT events/);
    assert.match(text, /deleting each in turn|deleting each/);
  });
});

test('an update with no fields writes nothing', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith());
    const result = await canvas.callTool('update-calendar-event', { eventId: '5501' });
    assert.match(canvas.textOf(result), /nothing was changed/);
    assert.ok(!canvas.requests.some(r => r.method === 'PUT'));
  });
});

// --- Assignment duplication ---

const ASSIGNMENT = { id: 900, name: 'Weekly Reflection', points_possible: 10 };

function duplicating({ original = ASSIGNMENT, copy } = {}) {
  return ({ url, body, method }) => {
    if (url.includes('/duplicate')) {
      return copy ?? { ...original, id: 901, name: `${original.name} Copy`, published: false };
    }
    if (method === 'PUT') return { id: 901, ...(body?.assignment ?? {}), published: !!body?.assignment?.published };
    return original;
  };
}

test('duplicating an assignment reports the unpublished copy', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(duplicating());
    const result = await canvas.callTool('duplicate-assignment', {
      courseId: '18473', assignmentId: '900',
    });
    assert.ok(canvas.requests.some(r => /\/assignments\/900\/duplicate/.test(r.url)));
    const text = canvas.textOf(result);
    assert.match(text, /Weekly Reflection Copy/);
    assert.match(text, /students cannot see it yet/);
  });
});

// A New Quiz needs result_type=Quiz, and the caller should not have to know
// which engine backs the assignment.
test('a New Quiz is duplicated with result_type=Quiz, detected not asked', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(duplicating({
      original: { ...ASSIGNMENT, name: 'Unit 3 Quiz', is_quiz_lti_assignment: true },
    }));
    const result = await canvas.callTool('duplicate-assignment', {
      courseId: '18473', assignmentId: '900',
    });
    const call = canvas.requests.find(r => /\/duplicate/.test(r.url));
    assert.match(call.url, /result_type=Quiz/);
    assert.match(canvas.textOf(result), /a New Quiz/);
  });
});

test('a plain assignment is duplicated without result_type', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(duplicating());
    await canvas.callTool('duplicate-assignment', { courseId: '18473', assignmentId: '900' });
    assert.ok(!/result_type/.test(canvas.requests.find(r => /\/duplicate/.test(r.url)).url));
  });
});

test('a rename and due date are applied to the copy in the same call', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(duplicating());
    await canvas.callTool('duplicate-assignment', {
      courseId: '18473', assignmentId: '900',
      newName: 'Week 2 Reflection', dueAt: '2026-09-08T23:59:00Z', publish: true,
    });

    const edit = canvas.requests.find(r => r.method === 'PUT');
    assert.match(edit.url, /assignments\/901/);
    assert.equal(edit.body.assignment.name, 'Week 2 Reflection');
    assert.equal(edit.body.assignment.due_at, '2026-09-08T23:59:00Z');
    assert.equal(edit.body.assignment.published, true);
  });
});

// Editing an assignment Canvas is still copying races its own write, so the
// follow-up is skipped and said out loud rather than attempted.
test('an asynchronous duplicate is not edited mid-flight', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(duplicating({
      copy: { id: 901, name: 'Weekly Reflection Copy', workflow_state: 'duplicating' },
    }));
    const result = await canvas.callTool('duplicate-assignment', {
      courseId: '18473', assignmentId: '900', newName: 'Week 2 Reflection',
    });

    assert.ok(!canvas.requests.some(r => r.method === 'PUT'), 'must not edit an assignment mid-duplication');
    const text = canvas.textOf(result);
    assert.match(text, /still building this copy/);
    assert.match(text, /were NOT applied/);
  });
});
