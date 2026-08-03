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

// A rating carries its own long description — the sentence a grader actually
// reads when deciding between two levels. It goes over the wire as
// long_description inside the rating hash, one level deeper than the criterion's.
test('a rating\'s long description reaches Canvas inside the rating, not the criterion', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(createAndRead());
    await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric',
      criteria: [{
        description: 'Thesis',
        longDescription: 'The criterion-level one.',
        ratings: [
          { description: 'Strong', points: 6, longDescription: 'States a defensible claim and sustains it.' },
          { description: 'Weak', points: 2 },
        ],
      }],
    });

    const sent = bodyOf(canvas, 'POST').rubric.criteria['0'];
    assert.equal(sent.long_description, 'The criterion-level one.');
    assert.equal(sent.ratings['0'].long_description, 'States a defensible claim and sustains it.');
    // A rating without one must not acquire an empty key.
    assert.equal('long_description' in sent.ratings['1'], false);
  });
});

// The wipe risk. update-rubric re-sends the stored criteria for anything it is
// not changing, so if a rating's long description did not survive that round
// trip, a title-only rename would quietly strip every one of them — the same
// shape as the hide_points problem. Verified live on rubric 40400: they survive.
test('a title-only update preserves the long descriptions on ratings', async () => {
  const withLongDescriptions = storedRubric({
    data: [{
      id: '_1', description: 'Thesis', long_description: 'Criterion level.', points: 6,
      ratings: [
        { id: '_1a', description: 'Strong', points: 6, long_description: 'Rating level A.' },
        { id: '_1b', description: 'Weak', points: 2, long_description: 'Rating level B.' },
      ],
    }],
  });

  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT'
      ? { rubric: withLongDescriptions }
      : withLongDescriptions));

    await canvas.callTool('update-rubric', { courseId: '1', rubricId: '55', title: 'Renamed' });

    const sent = bodyOf(canvas, 'PUT').rubric.criteria['0'];
    assert.equal(sent.long_description, 'Criterion level.');
    assert.equal(sent.ratings['0'].long_description, 'Rating level A.');
    assert.equal(sent.ratings['1'].long_description, 'Rating level B.');
  });
});

test('get-rubric shows a rating\'s long description next to its rating', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedRubric({
      data: [{
        id: '_1', description: 'Thesis', points: 6,
        ratings: [{ id: '_1a', description: 'Strong', points: 6, long_description: 'Sustains a defensible claim.' }],
      }],
    }));
    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });
    assert.match(canvas.textOf(result), /6 pts — Strong: Sustains a defensible claim\./);
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
    assert.match(text, /association did not take/);
  });
});

// Live testing caught this warning crying wolf: a 400 on the read produced
// "the association did not take" for a rubric whose association was fine. Only
// a 404 means the rubric cannot be resolved through the course.
test('a readback that fails for a reason other than 404 does not blame the association', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'POST'
      ? { rubric: storedRubric(), rubric_association: { id: 9 } }
      : { __status: 400, __body: { message: 'Bad request' } }));

    const result = await canvas.callTool('create-rubric', {
      courseId: '1', title: 'DBQ Essay Rubric', criteria,
    });
    const text = canvas.textOf(result);
    assert.match(text, /could not be read back/);
    assert.match(text, /failure to READ/);
    assert.doesNotMatch(text, /association did not take/);
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

test('get-rubric renders criteria, ratings and IDs', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedRubric());
    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });

    const text = canvas.textOf(result);
    assert.match(text, /Thesis/);
    assert.match(text, /6 pts — Strong/);
    assert.match(text, /criterion id _1/);
    assert.match(text, /rubric_assessment/, 'must say how to key a rubric_assessment');
  });
});

// Reading the serializer suggested `style` gates the `criteria` key, so this
// endpoint used to send style=full unconditionally. Live Canvas 400s on it —
// "Style parameter passed without requesting assessments" — which broke
// get-rubric for every rubric, and with it the readback that create-rubric and
// update-rubric rely on. It is only legal alongside include[]=assessments.
test('get-rubric does not send the style parameter, which Canvas 400s on', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedRubric());
    await canvas.callTool('get-rubric', { courseId: '1', rubricId: '55' });
    assert.doesNotMatch(canvas.lastRequest().url, /style/);
  });
});

// Canvas serializes the criteria under `data`; some responses also carry
// `criteria`. The reader has to take either.
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

// An outcome-aligned criterion carries a learning_outcome_id and its own
// mastery_points, neither of which this tool's criterion shape can express. Since
// Canvas replaces the whole rubric on update, re-sending one would silently
// demote it to a plain criterion — under a message saying the update succeeded.
test('update-rubric refuses to touch a rubric with an outcome-aligned criterion', async () => {
  const withOutcome = storedRubric({
    data: [
      {
        id: '_1', description: 'Sourcing (outcome)', points: 5,
        learning_outcome_id: 4321, mastery_points: 3,
        ratings: [{ id: '_1a', description: 'Mastery', points: 5 }],
      },
      {
        id: '_2', description: 'Evidence', points: 4,
        ratings: [{ id: '_2a', description: 'Ample', points: 4 }],
      },
    ],
  });

  await withMockCanvas(async canvas => {
    canvas.setResponse(() => withOutcome);

    // A title-only change is the dangerous case: nothing about the request
    // mentions the criteria, and it would still have wiped the alignment.
    const result = await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55', title: 'Renamed',
    });

    assert.equal(canvas.requests.filter(r => r.method === 'PUT').length, 0, 'must not PUT');
    const text = JSON.stringify(result);
    assert.match(text, /aligned to a learning outcome/);
    assert.match(text, /Sourcing \(outcome\)/);
    // The unaligned criterion must not be named as a casualty.
    assert.doesNotMatch(text, /"Evidence"/);
  });
});

test('update-rubric still edits a rubric whose criteria carry no outcome alignment', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT'
      ? { rubric: storedRubric({ title: 'Renamed' }) }
      : storedRubric()));

    await canvas.callTool('update-rubric', { courseId: '1', rubricId: '55', title: 'Renamed' });
    assert.equal(canvas.requests.filter(r => r.method === 'PUT').length, 1);
  });
});

// The update sends no rubric_association, so this readback is the only evidence
// the rubric is still linked to the course and visible in the UI.
test('an update that cannot be read back afterwards is reported as possibly invisible', async () => {
  await withMockCanvas(async canvas => {
    let gets = 0;
    canvas.setResponse(({ method }) => {
      if (method === 'PUT') return { rubric: storedRubric({ title: 'Renamed' }) };
      gets += 1;
      // The pre-read succeeds; the readback after the write does not.
      return gets === 1 ? storedRubric() : { __status: 404, __body: { message: 'Rubric not found' } };
    });

    const result = await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55', title: 'Renamed',
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /association with the course/);
    assert.match(text, /Rubrics page/);
  });
});

// Editing a rubric changes a different object: Canvas pushes the new total onto
// every assignment the rubric grades. Caught live — an assignment deliberately
// held at 25 points by keepAssignmentPoints was rewritten to 13 when a criterion
// was added to its rubric later, with nothing said about it.
test('update-rubric warns when a changed total will be pushed onto the assignment', async () => {
  await withMockCanvas(async canvas => {
    const bigger = storedRubric({ points_possible: 13 });
    canvas.setResponse(({ method }) => (method === 'PUT' ? { rubric: bigger } : storedRubric()));

    const result = await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55',
      criteria: [
        { description: 'Thesis', ratings: [{ description: 'Strong', points: 6 }] },
        { description: 'Evidence', ratings: [{ description: 'Ample', points: 4 }] },
        { description: 'Mechanics', ratings: [{ description: 'Clean', points: 3 }] },
      ],
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /10 to 13/);
    assert.match(text, /keepAssignmentPoints/);
  });
});

test('update-rubric sends skip_updating_points_possible when asked to keep the points', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT' ? { rubric: storedRubric() } : storedRubric()));

    await canvas.callTool('update-rubric', {
      courseId: '1', rubricId: '55', title: 'Renamed', keepAssignmentPoints: true,
    });
    // Top level and the string "true" — the documented rubric[...] spelling is
    // inert, as the live create test confirmed.
    assert.equal(bodyOf(canvas, 'PUT').skip_updating_points_possible, 'true');
  });
});

test('update-rubric says nothing about points when the total is unchanged', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'PUT' ? { rubric: storedRubric() } : storedRubric()));
    const result = await canvas.callTool('update-rubric', { courseId: '1', rubricId: '55', title: 'Renamed' });
    assert.doesNotMatch(canvas.textOf(result), /total changed/);
  });
});

// ---------------------------------------------------------------------------
// attach-rubric-to-assignment
// ---------------------------------------------------------------------------

// This used to PUT /assignments/:id with an empty body and a rubric_id query
// param, which Canvas answers with 400 "assignment is missing". Attaching a
// rubric means creating a RubricAssociation.
test('attach-rubric-to-assignment posts a rubric association, not an assignment update', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'POST'
      ? { id: 12, rubric_id: 55 }
      : { id: 371868, points_possible: 10, has_rubric: true }));

    await canvas.callTool('attach-rubric-to-assignment', {
      courseId: '1', assignmentId: '371868', rubricId: '55',
    });

    const post = canvas.requests.find(r => r.method === 'POST');
    assert.match(post.url, /\/rubric_associations/);
    assert.equal(post.body.rubric_association.rubric_id, '55');
    assert.equal(post.body.rubric_association.association_id, '371868');
    assert.equal(post.body.rubric_association.association_type, 'Assignment');
    assert.equal(post.body.rubric_association.purpose, 'grading');
    assert.equal(canvas.requests.filter(r => r.method === 'PUT').length, 0);
  });
});

test('an attachment Canvas accepted but did not apply is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ method }) => (method === 'POST'
      ? { id: 12 }
      : { id: 371868, points_possible: 10, has_rubric: false }));

    const result = await canvas.callTool('attach-rubric-to-assignment', {
      courseId: '1', assignmentId: '371868', rubricId: '55',
    });
    assert.match(canvas.textOf(result), /still reports no rubric/);
  });
});

// The association is written at /rubric_associations but read at
// /assignments/:id, and invalidateForWrite cannot bridge that — the only common
// ancestor is /courses/:id, which it refuses to climb to. Live, this made the
// tool's own verification warn "still reports no rubric" about an attachment
// that had worked: a stale read indistinguishable from a failed write.
test('attaching a rubric drops the cached assignment, so the check is not stale', async () => {
  await withMockCanvas(async canvas => {
    let hasRubric = false;
    canvas.setResponse(({ method }) => {
      if (method === 'POST') { hasRubric = true; return { id: 12 }; }
      return { id: 371868, points_possible: 10, has_rubric: hasRubric };
    });

    const result = await canvas.callTool('attach-rubric-to-assignment', {
      courseId: '1', assignmentId: '371868', rubricId: '55',
    });

    // Two assignment GETs must actually reach Canvas: the before-read and the
    // verification. If the second is served from cache it sees has_rubric false
    // and cries wolf.
    const gets = canvas.requests.filter(r => r.method === 'GET' && /assignments\/371868/.test(r.url));
    assert.equal(gets.length, 2, 'the verification read must not come from cache');
    assert.doesNotMatch(canvas.textOf(result), /still reports no rubric/);
  });
});

test('get-rubric renders an outcome-aligned criterion as one update-rubric cannot edit', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(() => storedRubric({
      data: [{
        id: '1785772277267', description: 'DBQ Big Picture', points: 4,
        learning_outcome_id: 4321, mastery_points: 3,
        ratings: [{ id: '_4344', description: 'Exceeds Mastery', points: 4 }],
      }],
    }));

    const result = await canvas.callTool('get-rubric', { courseId: '1', rubricId: '40398' });
    const text = canvas.textOf(result);
    assert.match(text, /aligned to a learning outcome/);
    assert.match(text, /cannot edit this rubric/);
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
