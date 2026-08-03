// Rubric reading and authoring.
//
// The assertions that matter here are on the HTTP body, not the tool output.
// Canvas wants criteria as an indexed nested hash (rubric[criteria][0][ratings][0]);
// a JSON array makes Ruby destructure each criterion into (idx, nil) and die on a
// bare 500. That mistake is invisible at the tool-argument layer and only shows
// up in the outgoing request, so that is what these tests look at.
//
// None of this proves the shape is right — only that the server sends what
// reading canvas-lms says it should. See the live checks listed in the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const criteria = [
  {
    description: 'Thesis',
    ratings: [
      { description: 'Strong', points: 6 },
      { description: 'Weak', points: 2 },
    ],
  },
  {
    description: 'Evidence',
    ratings: [
      { description: 'Ample', points: 4 },
      { description: 'Thin', points: 1 },
    ],
  },
];

// What Canvas gives back for the rubric the criteria above describe.
const storedRubric = (over = {}) => ({
  id: 55,
  title: 'DBQ Essay Rubric',
  points_possible: 10,
  free_form_criterion_comments: false,
  data: [
    {
      id: '_1', description: 'Thesis', long_description: '', points: 6,
      ratings: [
        { id: '_1a', description: 'Strong', points: 6, long_description: '' },
        { id: '_1b', description: 'Weak', points: 2, long_description: '' },
      ],
    },
    {
      id: '_2', description: 'Evidence', long_description: '', points: 4,
      ratings: [
        { id: '_2a', description: 'Ample', points: 4, long_description: '' },
        { id: '_2b', description: 'Thin', points: 1, long_description: '' },
      ],
    },
  ],
  ...over,
});

/** Answer a create/read cycle: POST the rubric, GET it back. */
function createAndRead(rubric = storedRubric(), association = { id: 9, association_type: 'Course' }) {
  return ({ method }) => (method === 'POST'
    ? { rubric, rubric_association: association }
    : rubric);
}

const bodyOf = (canvas, method) => canvas.requests.find(r => r.method === method)?.body;

// ---------------------------------------------------------------------------
// The wire shape — the single most likely thing to be wrong
// ---------------------------------------------------------------------------

test('criteria reach Canvas as an indexed hash, not a JSON array', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });

    const sent = bodyOf(canvas, 'POST').rubric.criteria;
    assert.equal(typeof sent, 'object', 'criteria must not be a JSON string');
    assert.ok(!Array.isArray(sent), 'criteria must be an indexed hash, not an array');
    assert.deepEqual(Object.keys(sent), ['0', '1'], 'keys must be integer indices in order');
    assert.equal(sent['0'].description, 'Thesis');
    assert.equal(sent['1'].description, 'Evidence');
  });
});

test('ratings nest as an indexed hash inside each criterion', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });

    const ratings = bodyOf(canvas, 'POST').rubric.criteria['0'].ratings;
    assert.ok(!Array.isArray(ratings), 'ratings must be an indexed hash, not an array');
    assert.deepEqual(Object.keys(ratings), ['0', '1']);
    assert.deepEqual(ratings['0'], { description: 'Strong', points: 6 });
    assert.deepEqual(ratings['1'], { description: 'Weak', points: 2 });
  });
});

// The bug class this project keeps hitting: a client hands an object over as a
// JSON string, it goes to Canvas verbatim, and Canvas answers a bare 500.
test('criteria passed as a JSON string still arrive as an indexed hash of objects', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria: JSON.stringify(criteria),
    });

    const sent = bodyOf(canvas, 'POST').rubric.criteria;
    const encoded = JSON.stringify(sent);
    assert.ok(!encoded.includes('\\"description\\"'), 'criteria must not be double-encoded');
    assert.equal(typeof sent, 'object');
    assert.ok(!Array.isArray(sent));
    assert.equal(typeof sent['0'], 'object', 'each criterion must be an object, not a string');
    assert.equal(sent['0'].description, 'Thesis');
    assert.equal(sent['0'].ratings['0'].points, 6);
  });
});

// A caller working from the Canvas docs will naturally write the indexed hash.
test('criteria already in Canvas indexed-hash form are accepted and preserved in order', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1',
      title: 'DBQ Essay Rubric',
      criteria: { 1: criteria[1], 0: criteria[0] },
    });

    const sent = bodyOf(canvas, 'POST').rubric.criteria;
    assert.ok(!Array.isArray(sent), 'criteria must be an indexed hash, not an array');
    assert.deepEqual(Object.keys(sent), ['0', '1']);
    assert.equal(sent['0'].description, 'Thesis', 'indexed keys decide the order, not insertion order');
    assert.equal(sent['1'].description, 'Evidence');
  });
});

test('a criterion is sent with the points Canvas derives from its highest rating', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });

    const sent = bodyOf(canvas, 'POST').rubric.criteria;
    assert.equal(sent['0'].points, 6);
    assert.equal(sent['1'].points, 4);
  });
});

// Canvas stores this field as `params[...] == "1"`, so a JSON boolean true is
// stored as FALSE — a setting silently inverted behind a 200.
test('free_form_criterion_comments goes over the wire as the string "1", not a boolean', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead(storedRubric({ free_form_criterion_comments: true })));
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria, freeFormComments: true,
    });

    const sent = bodyOf(canvas, 'POST').rubric.free_form_criterion_comments;
    assert.equal(sent, '1');
    assert.notEqual(sent, true, 'a boolean here is stored by Canvas as false');
  });
});

// ---------------------------------------------------------------------------
// The association — get this wrong and the rubric is invisible in the UI
// ---------------------------------------------------------------------------

test('a course-level rubric is sent with a Course/bookmark association', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });

    assert.deepEqual(bodyOf(canvas, 'POST').rubric_association, {
      association_id: '1', association_type: 'Course', purpose: 'bookmark',
    });
  });
});

test('an assignment rubric is sent with an Assignment/grading association', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
      assignmentId: '42', useForGrading: true,
    });

    assert.deepEqual(bodyOf(canvas, 'POST').rubric_association, {
      association_id: '42', association_type: 'Assignment', purpose: 'grading', use_for_grading: '1',
    });
  });
});

// The Canvas docs put this under rubric[], but the controller reads it from the
// top level and matches it against /true/i.
test('keepAssignmentPoints is sent top-level as the string "true"', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
      assignmentId: '42', useForGrading: true, keepAssignmentPoints: true,
    });

    const body = bodyOf(canvas, 'POST');
    assert.equal(body.skip_updating_points_possible, 'true');
    assert.equal(body.rubric.skip_updating_points_possible, undefined);
  });
});

test('a rubric that cannot be read back afterwards is reported as possibly invisible', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'POST'
      ? { rubric: storedRubric(), rubric_association: { id: 9 } }
      : { __status: 404, __body: { message: 'Rubric not found' } }));

    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /may not appear in the Canvas UI/);
  });
});

test('a response with no rubric_association is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'POST'
      ? { rubric: storedRubric() }
      : storedRubric()));

    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    assert.match(canvas.textOf(result), /no rubric_association/);
  });
});

// ---------------------------------------------------------------------------
// Refusing ambiguity rather than letting Canvas drop it
// ---------------------------------------------------------------------------

test('criterion points that disagree with the top rating are refused, and nothing is sent', async () => {
  await withMockCanvas(async canvas => {
    const before = canvas.requests.length;
    const result = await canvas.callTool('create-rubric', {
      courseId: '1',
      title: 'DBQ Essay Rubric',
      criteria: [{ description: 'Thesis', points: 10, ratings: [{ description: 'Strong', points: 6 }] }],
    });
    assert.equal(canvas.requests.length, before, 'nothing should be sent to Canvas');
    assert.match(JSON.stringify(result), /highest rating/);
  });
});

test('useForGrading without an assignment is refused, and nothing is sent', async () => {
  await withMockCanvas(async canvas => {
    const before = canvas.requests.length;
    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria, useForGrading: true,
    });
    assert.equal(canvas.requests.length, before);
    assert.match(JSON.stringify(result), /assignmentId/);
  });
});

test('a malformed criteria string is rejected with a readable message, not forwarded', async () => {
  await withMockCanvas(async canvas => {
    const before = canvas.requests.length;
    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria: '{not json',
    });
    assert.equal(canvas.requests.length, before, 'nothing should be sent to Canvas');
    assert.match(JSON.stringify(result), /JSON/i);
  });
});

// ---------------------------------------------------------------------------
// Never trusting a 200
// ---------------------------------------------------------------------------

// Canvas renders { error: true, messages: [...] } under HTTP 200 when a rubric
// fails validation.
test('an error body returned under HTTP 200 is reported as a failure', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ error: true, messages: ['Title is too long'] }));
    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    const text = JSON.stringify(result);
    assert.match(text, /Title is too long/);
    assert.match(text, /200/);
  });
});

test('criteria Canvas stored differently from what was sent are warned about', async () => {
  await withMockCanvas(async canvas => {
    // Canvas kept only the first criterion and rewrote its points.
    const mangled = storedRubric({ points_possible: 6, data: [storedRubric().data[0]] });
    canvas.setResponse(createAndRead(mangled));

    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /sent 2, Canvas stored 1/);
  });
});

test('a faithfully stored rubric is not warned about', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING/);
  });
});

// ---------------------------------------------------------------------------
// get-rubric
// ---------------------------------------------------------------------------

test('get-rubric asks for style=full and renders criteria, ratings and IDs', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedRubric());
    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });

    assert.match(canvas.lastRequest().url, /style=full/);
    const text = canvas.textOf(result);
    assert.match(text, /Thesis/);
    assert.match(text, /6 pts — Strong/);
    assert.match(text, /criterion id _1/);
    assert.match(text, /rubric_assessment/, 'must say how to key a rubric_assessment');
  });
});

// The serializer emits `criteria` only under style=full but always emits `data`;
// the reader has to take either.
test('get-rubric reads criteria from the `criteria` key when Canvas sends it', async () => {
  await withMockCanvas(async canvas => {
    const { data, ...rest } = storedRubric();
    canvas.setResponse(() => ({ ...rest, criteria: data }));
    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });
    assert.match(canvas.textOf(result), /Evidence/);
  });
});

test('a 404 on get-rubric explains the course-association lookup', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ __status: 404, __body: { message: 'Rubric not found' } }));
    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });
    assert.match(JSON.stringify(result), /not linked to this course/);
  });
});

// ---------------------------------------------------------------------------
// update-rubric — Canvas's update is a full replace
// ---------------------------------------------------------------------------

test('update-rubric re-sends the existing criteria when none are given, rather than wiping them', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT'
      ? { rubric: storedRubric({ title: 'Renamed' }) }
      : storedRubric()));

    await canvas.callTool('update-rubric', { courseId: '1', rubricId: '55', title: 'Renamed' });

    const sent = bodyOf(canvas, 'PUT').rubric.criteria;
    assert.ok(!Array.isArray(sent));
    assert.deepEqual(Object.keys(sent), ['0', '1']);
    assert.equal(sent['0'].description, 'Thesis');
    assert.equal(sent['1'].description, 'Evidence');
    // Preserving the IDs is what keeps grading already done against these
    // criteria lined up with them.
    assert.equal(sent['0'].id, '_1');
    assert.equal(sent['0'].ratings['0'].id, '_1a');
  });
});

test('update-rubric re-sends the existing title when none is given', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT' ? { rubric: storedRubric() } : storedRubric()));

    await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55',
      criteria: [{ description: 'Thesis', ratings: [{ description: 'Strong', points: 6 }] }],
    });

    // Canvas renames a rubric to "<Course> Rubric" when the title is omitted.
    assert.equal(bodyOf(canvas, 'PUT').rubric.title, 'DBQ Essay Rubric');
  });
});

test('update-rubric reads the rubric first and refuses to write blind if that fails', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => ({ __status: 404, __body: { message: 'Rubric not found' } }));
    const result = await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55', title: 'Renamed',
    });
    assert.equal(canvas.requests.filter(r => r.method === 'PUT').length, 0, 'must not PUT blind');
    assert.match(JSON.stringify(result), /would delete any criterion/);
  });
});

// Canvas clones a rubric that is in use in more than one place, leaving the
// original — and everything pointing at it — untouched.
test('update-rubric reports a clone when Canvas returns a different rubric ID', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT'
      ? { rubric: storedRubric({ id: 77 }) }
      : storedRubric({ id: 77 })));

    const result = await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55', title: 'DBQ Essay Rubric',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /created a COPY \(ID 77\)/);
    assert.match(text, /original is unchanged/);
  });
});

test('update-rubric sends free_form_criterion_comments as "1"/"0", preserving the stored value', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT'
      ? { rubric: storedRubric({ free_form_criterion_comments: true }) }
      : storedRubric({ free_form_criterion_comments: true })));

    await canvas.callTool('update-rubric', { courseId: '1', rubricId: '55', title: 'Renamed' });
    assert.equal(bodyOf(canvas, 'PUT').rubric.free_form_criterion_comments, '1');
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the three new rubric tools are registered', async () => {
  await withMockCanvas(async canvas => {
    const names = (await canvas.listTools()).map(tool => tool.name);
    for (const name of ['get-rubric', 'create-rubric', 'update-rubric']) {
      assert.ok(names.includes(name), `${name} must be registered`);
    }
    // Deletion was deliberately not built.
    assert.deepEqual(names.filter(n => /delete.*rubric|rubric.*delete/i.test(n)), []);
  });
});
