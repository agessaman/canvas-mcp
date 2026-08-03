// Extra time is an accommodation, so the failure that matters is the one that
// reports success: the wrong quiz engine, a silently-ignored option, a section
// that expanded to nobody, or a grant on a quiz with no clock to extend.
//
// The wire format carries most of the risk here — the two engines want
// different paths and different body shapes (Classic wraps its array in
// quiz_extensions, New Quizzes posts a bare array), and nothing in a tool's
// arguments shows which one was actually sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMockCanvas } from './helpers/mockCanvas.mjs';

const CLASSIC_QUIZ = { id: 900, title: 'Unit 3 Quiz', quiz_type: 'assignment', time_limit: 60 };
const NEW_QUIZ = {
  id: '371566',
  title: 'API Write-Path Test Quiz',
  quiz_settings: { has_time_limit: true, session_time_limit_in_seconds: 3600 },
};

// Serves one engine and 404s the other, which is what a real instance does:
// the two engines have separate ID spaces and separate API roots.
function canvasWith({
  engine = 'new',
  classicQuiz = CLASSIC_QUIZ,
  newQuiz = NEW_QUIZ,
  enrollments = [{ user_id: 6199 }],
  extensionResponse,
  accommodationResponse = { message: 'ok', successful: [{ user_id: 6199 }], failed: [] },
  submissions = { quiz_submissions: [] },
} = {}) {
  return ({ url, body }) => {
    if (url.includes('/enrollments')) return enrollments;
    if (url.includes('/extensions')) {
      // Default: echo back exactly what was asked for.
      return extensionResponse ?? { quiz_extensions: body.quiz_extensions };
    }
    if (url.includes('/accommodations')) return accommodationResponse;
    if (url.includes('/submissions')) return submissions;
    if (url.startsWith('/api/quiz/v1/')) {
      return engine === 'new' || engine === 'both' ? newQuiz : { __status: 404, __body: { errors: ['not found'] } };
    }
    if (url.includes('/quizzes/')) {
      return engine === 'classic' || engine === 'both' ? classicQuiz : { __status: 404, __body: { errors: ['not found'] } };
    }
    return {};
  };
}

test('a New Quiz gets a bare accommodations array, not a Classic extension', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.match(write.url, /^\/api\/quiz\/v1\/courses\/18473\/quizzes\/371566\/accommodations/);
    // The body is a bare array here — every other write on this server wraps.
    assert.deepEqual(write.body, [{ user_id: 6199, extra_time: 30 }]);
    assert.match(canvas.textOf(result), /30 extra minute/);
  });
});

test('a Classic quiz gets a wrapped quiz_extensions array on the v1 endpoint', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'classic' }));
    await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30,
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.match(write.url, /^\/api\/v1\/courses\/18473\/quizzes\/900\/extensions/);
    assert.deepEqual(write.body, { quiz_extensions: [{ user_id: 6199, extra_time: 30 }] });
  });
});

// The ID spaces are independent, so one number can name a real quiz under each
// engine. Guessing would extend the wrong quiz and report success.
test('an ID that names a quiz under both engines is refused, not guessed', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'both' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30,
    });

    assert.match(JSON.stringify(result), /ambiguous/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'), 'nothing may be written while the engine is unclear');
  });
});

test('an ambiguous ID is resolved by naming the engine', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'both' }));
    await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30, engine: 'classic',
    });
    assert.match(canvas.requests.find(r => r.method === 'POST').url, /\/api\/v1\/.*\/extensions/);
  });
});

// Canvas ignores parameters it does not support rather than rejecting them, so
// an option aimed at the wrong engine would read as granted.
test('a New Quizzes-only option on a Classic quiz is refused rather than dropped', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'classic' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30, reduceChoices: true,
    });
    assert.match(JSON.stringify(result), /reduceChoices is a New Quizzes accommodation/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

test('a Classic-only option on a New Quiz is refused rather than dropped', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30, manuallyUnlocked: true,
    });
    assert.match(JSON.stringify(result), /manuallyUnlocked is a Classic Quizzes extension/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

// Extra minutes on an untimed quiz is the silent no-op this server exists to
// catch: Canvas stores it and the student's experience is unchanged.
test('extra time on a quiz with no time limit is warned about', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      newQuiz: { ...NEW_QUIZ, quiz_settings: { has_time_limit: false, session_time_limit_in_seconds: 0 } },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /no time limit/);
    assert.match(text, /extend-due-date/);
  });
});

test('a timed quiz reports the total clock the students end up with', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'classic' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.match(canvas.textOf(result), /time limit is 60 minutes, so these students get 90/);
  });
});

// Neither engine has a section-level extension, so a section is expanded to
// user IDs — and that expansion is a snapshot the caller has to know about.
test('a section is expanded to its students, with the snapshot said out loud', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      enrollments: [{ user_id: 6199 }, { user_id: 1234 }],
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', sectionId: '38485', extraMinutes: 30,
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.deepEqual(write.body.map(e => e.user_id), [6199, 1234]);
    assert.match(canvas.textOf(result), /students added to that section later will NOT get this extension/i);
  });
});

test('an empty section is refused instead of granting to nobody', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new', enrollments: [] }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', sectionId: '38485', extraMinutes: 30,
    });
    assert.match(JSON.stringify(result), /no currently-enrolled students/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

test('targeting both a section and students is refused', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], sectionId: '38485', extraMinutes: 30,
    });
    assert.match(JSON.stringify(result), /exactly one of studentIds or sectionId/);
  });
});

// Classic echoes the stored extension, so a dropped student is visible.
test('a student Canvas dropped from a Classic extension is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'classic',
      extensionResponse: { quiz_extensions: [{ user_id: 6199, extra_time: 30 }] },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199', '9999'], extraMinutes: 30,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /9999/);
    assert.match(text, /NO extension/);
  });
});

test('a Classic extension stored with the wrong number of minutes is reported', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'classic',
      extensionResponse: { quiz_extensions: [{ user_id: 6199, extra_time: 0 }] },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '900', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.match(canvas.textOf(result), /WARNING[\s\S]*asked for 30 extra minutes, Canvas stored 0/);
  });
});

// New Quizzes reports per-student outcomes instead of echoing the record, and
// offers no readback, so a partial failure has to be surfaced verbatim.
test('a New Quizzes accommodation Canvas rejected is surfaced', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      accommodationResponse: { message: 'partial', successful: [{ user_id: 6199 }], failed: [{ user_id: 9999, error: 'not enrolled' }] },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199', '9999'], extraMinutes: 30,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /9999/);
  });
});

test('a student in neither the successful nor the failed list is reported as having nothing', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      accommodationResponse: { message: 'ok', successful: [{ user_id: 6199 }], failed: [] },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199', '9999'], extraMinutes: 30,
    });
    assert.match(canvas.textOf(result), /9999.*NO accommodation|NO accommodation: 9999/);
  });
});

// The worst case, and the one the first version of this check walked straight
// past: Canvas answers 200 with an empty successful array, so the grant reads as
// applied when nobody has it.
test('a 200 that confirms nobody is reported as nobody having the accommodation', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      accommodationResponse: { message: 'Accommodations processed', successful: [], failed: [] },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    const text = canvas.textOf(result);
    assert.match(text, /WARNING/);
    assert.match(text, /NO accommodation: 6199/);
  });
});

// A body with no arrays at all is absence of evidence. Canvas has never been
// seen to answer this way, and inventing a failure from it would cry wolf.
test('a message-only response is not turned into a false alarm', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      accommodationResponse: { message: 'Accommodations processed' },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING — Canvas did not apply/);
  });
});

// The exact body Canvas returns, pasted from a live call, must read as success.
test('the real Canvas success body produces no warning', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'new',
      accommodationResponse: {
        message: 'Accommodations processed',
        successful: [{ user_id: 6199 }],
        failed: [],
      },
    }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371565', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.doesNotMatch(canvas.textOf(result), /WARNING — Canvas did not apply/);
  });
});

// Verified in the Canvas UI: a course-wide 45 plus a per-quiz 30 reads as
// "+1 hr 15 min". Neither value can be read back, so the tool cannot detect the
// overlap — it can only say that it happens.
test('a New Quiz grant says it adds to a course-wide accommodation rather than replacing it', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.match(canvas.textOf(result), /ADDS this to any course-wide accommodation/);
  });
});

test('clearing a grant does not carry the stacking note, which would only confuse', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 0,
    });
    assert.doesNotMatch(canvas.textOf(result), /ADDS this/);
  });
});

test('the absence of a New Quizzes readback endpoint is stated, not implied', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.match(canvas.textOf(result), /no endpoint for reading New Quizzes accommodations back/);
  });
});

// An empty list would read as "nobody has an accommodation", which for a New
// Quiz is not something Canvas can actually tell us.
test('list-quiz-extensions says New Quizzes cannot be read rather than reporting none', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('list-quiz-extensions', {
      courseId: '18473', quizId: '371566',
    });
    const text = canvas.textOf(result);
    assert.match(text, /no endpoint for reading its accommodations back|only be written/);
    assert.doesNotMatch(text, /No student has an extension/);
  });
});

test('list-quiz-extensions reports Classic extensions from the quiz submissions', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({
      engine: 'classic',
      submissions: {
        quiz_submissions: [
          { user_id: 6199, extra_time: 30, extra_attempts: 0 },
          { user_id: 1234, extra_time: 0, extra_attempts: 0 },
        ],
      },
    }));
    const result = await canvas.callTool('list-quiz-extensions', {
      courseId: '18473', quizId: '900',
    });
    const text = canvas.textOf(result);
    assert.match(text, /"user_id": 6199/);
    assert.doesNotMatch(text, /1234/);
    assert.match(text, /time limit is 60 minutes/);
  });
});

test('a non-numeric student ID is refused before anything is written', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['adam@example.com'], extraMinutes: 30,
    });
    assert.match(JSON.stringify(result), /must be numeric Canvas user IDs/);
    assert.ok(!canvas.requests.some(r => r.method === 'POST'));
  });
});

// Observed live: an active, override-holding, Classic-extension-accepting
// student is still unknown to the New Quizzes service, which 404s with a
// message Canvas's docs attribute to a missing course or assignment.
test('a user the New Quizzes service does not know is explained, not passed through raw', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.includes('/accommodations')) {
        return { __status: 404, __body: { error: 'Users with IDs 6199 were not found' } };
      }
      return url.startsWith('/api/quiz/v1/') ? NEW_QUIZ : { __status: 404, __body: {} };
    });
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    const text = JSON.stringify(result);
    assert.match(text, /keeps its own record of users/);
    assert.match(text, /have never opened one in this course/);
    // The other 404 has a different fix, so the two must not blur together.
    assert.doesNotMatch(text, /set-course-quiz-accommodations/);
    // The raw Canvas message has to survive too — it is the searchable part.
    assert.match(text, /Users with IDs 6199 were not found/);
  });
});

// The 404 a real teacher hits: they grant extra time before the exam, and
// Canvas refuses because nobody has opened the quiz yet. The way through is the
// course-level endpoint, so the error has to name it.
test('a per-quiz grant refused for non-participants points at the course-level tool', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.includes('/accommodations')) {
        return { __status: 404, __body: { error: 'Users with IDs 6199 are not participants in this assignment' } };
      }
      return url.startsWith('/api/quiz/v1/') ? NEW_QUIZ : { __status: 404, __body: {} };
    });
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    const text = JSON.stringify(result);
    assert.match(text, /set-course-quiz-accommodations/);
    assert.match(text, /already opened that quiz/);
    // Must not be confused with the never-heard-of-them case, which has a
    // completely different fix.
    assert.doesNotMatch(text, /never heard of/);
  });
});

test('an unrelated accommodations failure is not dressed up as a missing user', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(({ url }) => {
      if (url.includes('/accommodations')) {
        return { __status: 400, __body: { errors: ['extra_time must be an integer'] } };
      }
      return url.startsWith('/api/quiz/v1/') ? NEW_QUIZ : { __status: 404, __body: {} };
    });
    const result = await canvas.callTool('extend-quiz-time', {
      courseId: '18473', quizId: '371566', studentIds: ['6199'], extraMinutes: 30,
    });
    assert.match(JSON.stringify(result), /extra_time must be an integer/);
    assert.doesNotMatch(JSON.stringify(result), /keeps its own record of users/);
  });
});

test('the course-wide accommodation posts to the course endpoint and says Classic is untouched', async () => {
  await withMockCanvas(async canvas => {
    canvas.setResponse(canvasWith({ engine: 'new' }));
    const result = await canvas.callTool('set-course-quiz-accommodations', {
      courseId: '18473', studentIds: ['6199'], extraMinutes: 45, applyToInProgressSessions: true,
    });

    const write = canvas.requests.find(r => r.method === 'POST');
    assert.match(write.url, /^\/api\/quiz\/v1\/courses\/18473\/accommodations/);
    assert.deepEqual(write.body, [{ user_id: 6199, extra_time: 45, apply_to_in_progress_quiz_sessions: true }]);
    assert.match(canvas.textOf(result), /Classic quizzes in this course are unaffected/);
  });
});
