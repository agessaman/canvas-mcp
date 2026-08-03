// Extra attempts on an assignment.
//
// The assertions that matter are the wire shape (a wrapped array, like Classic
// quiz extensions and unlike the New Quizzes bare one) and the unlimited-attempts
// case, where Canvas accepts the grant, answers 200, and nothing changes —
// a granted-looking accommodation the student already had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const assignment = (over = {}) => ({
  id: 371866, name: 'DBQ Essay', points_possible: 10, allowed_attempts: 1, ...over,
});

/** GET the assignment, POST the extension, then GET each submission to verify. */
function respond({ allowed = 1, stored = 1 } = {}) {
  return ({ method, url }) => {
    if (method === 'POST') return {};
    if (/\/submissions\//.test(url)) return { user_id: 6199, extra_attempts: stored };
    return assignment({ allowed_attempts: allowed });
  };
}

const postBody = canvas => canvas.requests.find(r => r.method === 'POST')?.body;

test('extra attempts reach Canvas as a wrapped assignment_extensions array', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], extraAttempts: 1,
    });

    const post = canvas.requests.find(r => r.method === 'POST');
    assert.match(post.url, /\/assignments\/371866\/extensions/);
    const sent = post.body.assignment_extensions;
    assert.ok(Array.isArray(sent), 'must be an array under assignment_extensions');
    assert.equal(sent[0].extra_attempts, 1);
    // Numbers, not strings — the same rule the quiz extensions follow.
    assert.equal(typeof sent[0].user_id, 'number');
  });
});

// allowed_attempts of -1 means unlimited, which is Canvas's default. Extra
// attempts there are accepted and do nothing.
test('an assignment with unlimited attempts is warned about, not reported as granted', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ allowed: -1 }));
    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], extraAttempts: 1,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /does not limit attempts/);
    assert.match(text, /changes nothing/);
  });
});

test('an assignment that limits attempts states the resulting total', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ allowed: 2, stored: 1 }));
    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], extraAttempts: 1,
    });
    const text = canvas.textOf(result);
    assert.match(text, /allows 2 attempt\(s\), so these students now have 3/);
    assert.doesNotMatch(text, /WARNING/);
  });
});

// Canvas records the grant on the submission, which is the only readback there
// is. A grant it did not apply must not be reported as applied.
test('an extension Canvas did not store is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ allowed: 1, stored: 0 }));
    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], extraAttempts: 2,
    });
    assert.match(canvas.textOf(result), /asked for 2, Canvas stored 0/);
  });
});

test('clearing an extension is described as removal, not a grant', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond({ allowed: 1, stored: 0 }));
    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], extraAttempts: 0,
    });
    assert.match(canvas.textOf(result), /Removed extra attempts/);
  });
});

// Shared with extend-quiz-time via extensionTargets, so the snapshot caveat
// cannot drift between the two tools.
test('a section is expanded to its students, with the snapshot said out loud', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method, url }) => {
      if (method === 'POST') return {};
      if (/\/sections\/38485\/enrollments/.test(url)) {
        return [{ user_id: 6199 }, { user_id: 1234 }];
      }
      if (/\/submissions\//.test(url)) return { extra_attempts: 1 };
      return assignment();
    });

    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', sectionId: '38485', extraAttempts: 1,
    });
    const text = canvas.textOf(result);
    assert.match(text, /expanding it to its 2 currently-enrolled/);
    assert.match(text, /students added to that section later will NOT get this extension/i);
    assert.equal(postBody(canvas).assignment_extensions.length, 2);
  });
});

test('targeting both a section and students is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(respond());
    const result = await canvas.callTool('extend-assignment-attempts', {
      courseId: '1', assignmentId: '371866', studentIds: ['6199'], sectionId: '38485', extraAttempts: 1,
    });
    assert.equal(canvas.requests.filter(r => r.method === 'POST').length, 0);
    assert.match(JSON.stringify(result), /exactly one of studentIds or sectionId/);
  });
});

test('the assignment extension tool is registered', async () => {
  await withMockCanvas(async canvas => {
    const names = (await canvas.listTools()).map(tool => tool.name);
    assert.ok(names.includes('extend-assignment-attempts'));
  });
});

// ---------------------------------------------------------------------------
// The attempt limit itself
// ---------------------------------------------------------------------------

// extend-assignment-attempts is only meaningful on an assignment that limits
// attempts, and until this was added neither create- nor update-assignment
// could set one — so the tool's only useful precondition was unreachable
// without the Canvas UI. Found live: allowed_attempts came back -1 and there
// was no way to change it.
test('create-assignment can set an attempt limit, and reports it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment({ allowed_attempts: 2 }));
    const result = await canvas.callTool('create-assignment', {
      courseId: '1', name: 'DBQ Essay', allowed_attempts: 2,
    });
    assert.equal(canvas.requests.find(r => r.method === 'POST').body.assignment.allowed_attempts, 2);
    assert.match(canvas.textOf(result), /attempts=2/);
  });
});

test('update-assignment can restore unlimited attempts, which Canvas stores as -1', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => assignment({ allowed_attempts: -1 }));
    const result = await canvas.callTool('update-assignment', {
      courseId: '1', assignmentId: '371866', allowed_attempts: -1,
    });
    assert.equal(canvas.requests.find(r => r.method === 'PUT').body.assignment.allowed_attempts, -1);
    // -1 is Canvas's encoding, not something to show a teacher.
    assert.match(canvas.textOf(result), /attempts=unlimited/);
    assert.doesNotMatch(canvas.textOf(result), /attempts=-1/);
  });
});
