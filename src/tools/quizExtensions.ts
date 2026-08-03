import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { resolveTargets, numericIds } from "../extensionTargets.js";

// Extra TIME on a timed quiz — the accommodation extend-due-date deliberately
// does not cover. A due date says when work is handed in; extra time says how
// long the clock runs once a student starts. They are different endpoints, and
// giving a student a later due date when what they need is a longer clock is a
// missed accommodation that looks like a granted one.
//
// The awkward part is that the two quiz engines share nothing here:
//
//   Classic  POST /api/v1/courses/:id/quizzes/:id/extensions
//            body { quiz_extensions: [{ user_id, extra_time, ... }] }
//   New      POST /api/quiz/v1/courses/:id/quizzes/:assignment_id/accommodations
//            body [{ user_id, extra_time, ... }]   <- a bare array
//
// so the engine has to be established before anything is written. A teacher
// should not have to know which engine backs their quiz, so these tools work it
// out; see resolveEngine for why that means probing both.

// Canvas's own ceiling on extra time, in both engines: 10080 minutes = 1 week.
const MAX_EXTRA_MINUTES = 10080;

const EXTRA_MINUTES = z.number().int().min(0).max(MAX_EXTRA_MINUTES)
  .describe(
    "Extra minutes on the clock, added to the quiz's time limit for these students "
    + "(e.g. 30 turns a 60-minute quiz into 90 for them). Within one quiz this is an absolute "
    + "value, not a top-up: calling it again replaces that grant rather than adding to it, and "
    + "0 removes it. It does NOT replace a student's course-wide New Quizzes accommodation — "
    + "those two add together."
  );

type Engine = { kind: 'classic' | 'new'; quiz: any };

/**
 * Decide which engine backs this ID.
 *
 * Both engines are probed, because their ID spaces are independent — a Classic
 * quiz ID is a quiz row, a New Quiz's ID is its assignment row — so the same
 * number can name a real quiz under each. Guessing there would write an
 * accommodation onto the wrong quiz and report success, so an ambiguous ID is
 * refused and the caller names the engine.
 */
async function resolveEngine(
  canvas: CanvasClient,
  courseId: string,
  quizId: string,
  requested?: 'classic' | 'new'
): Promise<Engine> {
  const probe = await canvas.probeQuizEngines(courseId, quizId);

  // Some instances surface New Quizzes through the Classic index as a shim.
  // It answers to the Classic endpoint but not to Classic extensions.
  const classic = probe.classic && probe.classic.quiz_type !== 'quizzes.next' ? probe.classic : null;
  const newQuiz = probe.newQuiz;

  if (requested === 'classic' && classic) return { kind: 'classic', quiz: classic };
  if (requested === 'new' && newQuiz) return { kind: 'new', quiz: newQuiz };
  if (requested) {
    throw new Error(
      `No ${requested === 'new' ? 'New Quiz' : 'Classic quiz'} with ID ${quizId} in course ${courseId}. `
      + `Canvas said: ${(requested === 'new' ? probe.errors.newQuiz : probe.errors.classic) ?? 'nothing'}`
    );
  }

  if (classic && newQuiz) {
    throw new Error(
      `ID ${quizId} names both a Classic quiz ("${classic.title}") and a New Quiz ("${newQuiz.title}") in `
      + `course ${courseId} — the two use separate ID spaces, so this is ambiguous. Pass engine: "classic" or `
      + `engine: "new" to say which one you mean.`
    );
  }
  if (classic) return { kind: 'classic', quiz: classic };
  if (newQuiz) return { kind: 'new', quiz: newQuiz };

  throw new Error(
    `No quiz with ID ${quizId} in course ${courseId} under either engine. `
    + `Classic said: ${probe.errors.classic ?? 'nothing'}. New Quizzes said: ${probe.errors.newQuiz ?? 'nothing'}.`
  );
}

/**
 * Extra minutes on an untimed quiz change nothing at all — the student already
 * has unlimited time. Canvas stores the extension happily and says nothing, so
 * this is exactly the shape of failure this server exists to catch: an
 * accommodation that reports success and does not exist.
 */
function timeLimitNote(engine: Engine, extraMinutes: number): string {
  if (extraMinutes === 0) return '';

  if (engine.kind === 'classic') {
    const limit = engine.quiz?.time_limit;
    if (!limit) {
      return `\n\nWARNING: "${engine.quiz?.title}" has no time limit, so extra minutes change nothing — `
        + `these students already have unlimited time. The extension is stored and will apply if a time limit `
        + `is set later. If what they need is a later DEADLINE, use extend-due-date instead.`;
    }
    return `\n\nThe quiz's time limit is ${limit} minutes, so these students get ${limit + extraMinutes}.`;
  }

  const settings = engine.quiz?.quiz_settings ?? {};
  const seconds = settings.session_time_limit_in_seconds ?? 0;
  if (!settings.has_time_limit || !seconds) {
    return `\n\nWARNING: "${engine.quiz?.title}" has no time limit, so extra minutes change nothing — `
      + `these students already have unlimited time. The accommodation is stored and will apply if a time limit `
      + `is set later. If what they need is a later DEADLINE, use extend-due-date instead.`;
  }
  const limit = Math.round(seconds / 60);
  return `\n\nThe quiz's time limit is ${limit} minutes, so these students get ${limit + extraMinutes}.`;
}

/**
 * Classic echoes the stored extension back, so what landed can be compared
 * against what was asked for — the same readback discipline the override tools
 * use, and for the same reason: Canvas answers 200 to writes it did not apply.
 */
function verifyClassic(requested: any[], response: any): string {
  const stored: any[] = response?.quiz_extensions ?? [];
  const problems: string[] = [];

  for (const want of requested) {
    const got = stored.find((e: any) => String(e.user_id) === String(want.user_id));
    if (!got) {
      problems.push(
        `student ${want.user_id} is missing from Canvas's response and has NO extension `
        + `(most likely they are not enrolled in this course)`
      );
      continue;
    }
    if (Number(got.extra_time ?? 0) !== Number(want.extra_time)) {
      problems.push(`student ${want.user_id}: asked for ${want.extra_time} extra minutes, Canvas stored ${got.extra_time ?? 0}`);
    }
    if (want.extra_attempts !== undefined && Number(got.extra_attempts ?? 0) !== Number(want.extra_attempts)) {
      problems.push(`student ${want.user_id}: asked for ${want.extra_attempts} extra attempts, Canvas stored ${got.extra_attempts ?? 0}`);
    }
  }

  return problems.length > 0
    ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
    : '';
}

/**
 * New Quizzes reports per-student outcomes instead of echoing the stored record,
 * and offers no way to read accommodations back afterwards, so this response is
 * the only evidence the accommodation exists.
 *
 * The shape, captured live from `/api/quiz/v1/.../accommodations`:
 *
 *   {"message":"Accommodations processed","successful":[{"user_id":6199}],"failed":[]}
 *
 * Both arrays are always present on a 200, and `successful` holds objects rather
 * than bare IDs. An unknown user does not land in `failed` — the whole request
 * 404s with `{"error":"Users with IDs N were not found"}` and nothing is applied
 * — so what `failed` is actually for remains unknown. It is still reported: an
 * empty array that never fills costs nothing, and a populated one would be the
 * only sign that Canvas took some students and not others.
 */
function verifyNewQuiz(requested: any[], response: any): string {
  const problems: string[] = [];
  const failed: any[] = Array.isArray(response?.failed) ? response.failed : [];

  if (failed.length > 0) {
    problems.push(`Canvas rejected these: ${JSON.stringify(failed)}`);
  }

  // Every student asked for must come back named in `successful`. The earlier
  // version only checked when that array was non-empty, which left the worst
  // case unguarded: a 200 carrying `successful: []` would have been reported as
  // a granted accommodation that nobody actually has. An instance that answers
  // with a message and no array at all is still not treated as failure — that
  // is absence of evidence, not evidence of absence.
  if (Array.isArray(response?.successful)) {
    const named = new Set(response.successful.map((entry: any) => String(entry?.user_id ?? entry)));
    const missing = requested
      .map(r => String(r.user_id))
      .filter(id => !named.has(id));
    if (missing.length > 0) {
      problems.push(
        `Canvas did not confirm these students and they have NO accommodation: ${missing.join(', ')}`
      );
    }
  }

  const caveat = `\n\nNote: Canvas exposes no endpoint for reading New Quizzes accommodations back, so this `
    + `response is the only confirmation available. To see it in Canvas, open the quiz and use Moderate.`;

  return (problems.length > 0
    ? `\n\nWARNING — Canvas did not apply all of this:\n- ${problems.join('\n- ')}`
    : '') + caveat;
}

/**
 * The New Quizzes service keeps its own user records and rejects students
 * Canvas itself knows perfectly well. It has two distinct 404s, and the
 * difference between them is the whole diagnosis — Canvas documents both as
 * "the course or assignment was not found", which they are not.
 *
 * Established live in course 18473, against a student who was already an active
 * enrollment with an assignment override and a working Classic extension:
 *
 *   "Users with IDs N were not found"
 *     The service has never heard of the student. Publishing the course does
 *     not help (tried). It learns about them when they first launch a New Quiz:
 *     the same call succeeded minutes after the student opened one.
 *
 *   "Users with IDs N are not participants in this assignment"
 *     The service knows the student, but they have not opened *this* quiz. Seen
 *     on quiz 371566 at the same moment 371565 — the one they had opened —
 *     accepted the identical call.
 *
 * The second is the one that bites a real teacher, because granting extra time
 * before an exam is the entire point and nobody has opened the quiz yet. The
 * course-level endpoint is not restricted this way and is the way through.
 */
function explainNewQuizUserError(error: any, ids: number[], scope: 'quiz' | 'course'): never {
  const message = String(error?.message ?? '');

  if (/are not participants in this assignment/i.test(message)) {
    throw new Error(
      `${message}\n\n`
      + `Canvas will only accept a per-quiz accommodation for students who have already opened that quiz — which `
      + `is backwards for an exam accommodation, since you normally grant it beforehand. Nothing is wrong with `
      + `the IDs: ${ids.join(', ')}.\n\n`
      + `To grant extra time ahead of the quiz, use set-course-quiz-accommodations, which applies to every New `
      + `Quiz in the course and does not require the student to have opened anything. Verified working where this `
      + `per-quiz call failed. (Canvas documents this 404 as a missing course or assignment, which it is not.)`
    );
  }

  if (/were not found/i.test(message)) {
    throw new Error(
      `${message}\n\n`
      + `Canvas's New Quizzes service keeps its own record of users, separate from the course roster, and has `
      + `never heard of these students: ${ids.join(', ')}. An active enrollment is not enough — the same ID can `
      + `be enrolled, hold an assignment override, and accept a Classic quiz extension while this service still `
      + `reports it as missing. Publishing the course does NOT fix it. (Canvas documents this 404 as a missing `
      + `course or assignment, which it is not.)\n\n`
      + `The service learns about a student the first time they launch a New Quiz, so this means these students `
      + `have never opened one in this course${scope === 'quiz' ? '' : ' — including via any other quiz'}. Have `
      + `them open a New Quiz once, then grant the accommodation. If one ID in a batch is unknown, Canvas rejects `
      + `the whole call and nobody gets it, so check for a typo'd ID too. Date accommodations (extend-due-date) `
      + `and Classic quiz extensions are unaffected and work now.`
    );
  }

  throw error;
}

/**
 * New Quizzes adds a per-quiz accommodation to the student's course-wide one
 * rather than overriding it. Verified in the Canvas UI: a course-wide 45 plus a
 * per-quiz 30 showed as "Time: +1 hr 15 min" on the Moderate page.
 *
 * This is worth saying on every grant, because neither value can be read back —
 * the accommodations API is write-only — so a teacher topping up one quiz has no
 * way to see the standing accommodation they are adding to, and the tool has no
 * way to detect it and warn precisely.
 */
function stackingNote(scope: 'quiz' | 'course', extraMinutes: number): string {
  if (extraMinutes === 0) return '';
  return scope === 'quiz'
    ? `\n\nNote: New Quizzes ADDS this to any course-wide accommodation the student already has, rather than `
      + `replacing it — a standing 45 minutes plus 30 here becomes 75. Canvas cannot read course-wide `
      + `accommodations back, so if this student may have one, check the quiz's Moderate page for the real total.`
    : `\n\nNote: New Quizzes ADDS this to any per-quiz accommodation a student already has on an individual quiz, `
      + `rather than replacing it. Neither value can be read back through the API, so check a quiz's Moderate `
      + `page if you need the total a particular student ends up with.`;
}

export function registerQuizExtensionTools(server: McpServer, canvas: CanvasClient) {
  // Tool: extend-quiz-time
  server.tool(
    "extend-quiz-time",
    "Give students extra MINUTES on a timed quiz — the clock accommodation (e.g. time-and-a-half on a 60-minute "
    + "quiz). This is not a due date: use extend-due-date for a later deadline, and this tool for a longer clock. "
    + "Works with both Classic Quizzes and New Quizzes; the engine is detected from the ID. Target either "
    + "studentIds or a sectionId (which is expanded to its students, since Canvas has no section-level extension). "
    + "NOTE for New Quizzes: Canvas only accepts a per-quiz accommodation for students who have already opened "
    + "that quiz, so to grant extra time BEFORE an exam use set-course-quiz-accommodations instead. Classic "
    + "Quizzes has no such restriction.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("A Classic quiz ID, or a New Quiz's assignment ID. Both engines are checked."),
      studentIds: z.array(z.string()).optional().describe("Canvas user IDs of the students getting extra time. Mutually exclusive with sectionId."),
      sectionId: z.string().optional().describe("Grant to every currently-enrolled student in this section. Mutually exclusive with studentIds."),
      extraMinutes: EXTRA_MINUTES,
      extraAttempts: z.number().int().min(0).optional().describe("Extra attempts beyond the quiz's limit, if retakes are part of the accommodation"),
      reduceChoices: z.boolean().optional().describe("New Quizzes only: remove one wrong answer from multiple-choice questions with 4+ options"),
      manuallyUnlocked: z.boolean().optional().describe("Classic Quizzes only: let these students take the quiz even while it is locked for everyone else"),
      engine: z.enum(["classic", "new"]).optional().describe("Only needed if the ID is ambiguous (it can name a quiz under both engines)")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const engine = await resolveEngine(canvas, args.courseId, args.quizId, args.engine);

        // Refuse engine-specific options aimed at the wrong engine rather than
        // dropping them: Canvas ignores parameters it does not support without
        // complaint, so a silently discarded option reads as a granted one.
        if (engine.kind === 'classic' && args.reduceChoices !== undefined) {
          throw new Error('reduceChoices is a New Quizzes accommodation; Classic Quizzes has no equivalent and would ignore it.');
        }
        if (engine.kind === 'new' && args.manuallyUnlocked !== undefined) {
          throw new Error('manuallyUnlocked is a Classic Quizzes extension; the New Quizzes accommodations API has no equivalent and would ignore it.');
        }

        const target = await resolveTargets(canvas, args);
        const ids = numericIds(target.ids);
        const label = args.extraMinutes === 0
          ? `Removed extra time for ${ids.length} student(s)`
          : `Gave ${ids.length} student(s) ${args.extraMinutes} extra minute(s)`;

        if (engine.kind === 'classic') {
          const extensions = ids.map(user_id => {
            const entry: any = { user_id, extra_time: args.extraMinutes };
            if (args.extraAttempts !== undefined) entry.extra_attempts = args.extraAttempts;
            if (args.manuallyUnlocked !== undefined) entry.manually_unlocked = args.manuallyUnlocked;
            return entry;
          });
          const response: any = await canvas.setQuizExtensions(args.courseId, args.quizId, extensions);
          return {
            content: [{
              type: "text",
              text: `${label} on Classic quiz "${engine.quiz?.title}" (${args.quizId}): ${ids.join(', ')}.`
                + timeLimitNote(engine, args.extraMinutes)
                + target.note
                + verifyClassic(extensions, response)
            }]
          };
        }

        const accommodations = ids.map(user_id => {
          const entry: any = { user_id, extra_time: args.extraMinutes };
          if (args.extraAttempts !== undefined) entry.extra_attempts = args.extraAttempts;
          if (args.reduceChoices !== undefined) entry.reduce_choices_enabled = args.reduceChoices;
          return entry;
        });
        const response: any = await canvas
          .setNewQuizAccommodations(args.courseId, args.quizId, accommodations)
          .catch((error: any) => explainNewQuizUserError(error, ids, 'quiz'));
        return {
          content: [{
            type: "text",
            text: `${label} on New Quiz "${engine.quiz?.title}" (${args.quizId}): ${ids.join(', ')}.`
              + timeLimitNote(engine, args.extraMinutes)
              + target.note
              + stackingNote('quiz', args.extraMinutes)
              + verifyNewQuiz(accommodations, response)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to extend quiz time: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-quiz-extensions
  server.tool(
    "list-quiz-extensions",
    "Show who already has extra time or extra attempts on a quiz, before granting more. Classic Quizzes only — "
    + "Canvas's New Quizzes accommodations API is write-only, and this tool says so rather than reporting an "
    + "empty list that would read as \"nobody has an accommodation\".",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("A Classic quiz ID, or a New Quiz's assignment ID"),
      engine: z.enum(["classic", "new"]).optional().describe("Only needed if the ID is ambiguous")
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, engine: requested }: { courseId: string; quizId: string; engine?: 'classic' | 'new' }) => {
      try {
        const engine = await resolveEngine(canvas, courseId, quizId, requested);

        if (engine.kind === 'new') {
          return {
            content: [{
              type: "text",
              text: `"${engine.quiz?.title}" is a New Quiz, and Canvas provides no endpoint for reading its `
                + `accommodations back — they can only be written. Existing extra time for this quiz cannot be `
                + `listed here; open the quiz in Canvas and use Moderate to see it. Granting extra time still `
                + `works: extend-quiz-time.`
            }]
          };
        }

        const response: any = await canvas.listQuizSubmissions(courseId, quizId);
        const submissions: any[] = response?.quiz_submissions ?? [];
        const withExtension = submissions.filter(s =>
          Number(s.extra_time ?? 0) > 0 || Number(s.extra_attempts ?? 0) > 0 || s.manually_unlocked
        );

        const limit = engine.quiz?.time_limit;
        const limitNote = limit
          ? `The quiz's time limit is ${limit} minutes.`
          : `NOTE: this quiz has no time limit, so extra minutes have no effect on it.`;

        if (withExtension.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No student has an extension on "${engine.quiz?.title}". ${limitNote}\n\n`
                + `Caveat: Canvas records extensions on a student's quiz submission, so a student who has never `
                + `opened the quiz and has no extension will not appear here at all.`
            }]
          };
        }

        const rows = withExtension.map(s => ({
          user_id: s.user_id,
          extra_time: s.extra_time ?? 0,
          extra_attempts: s.extra_attempts ?? 0,
          manually_unlocked: !!s.manually_unlocked,
        }));

        return {
          content: [{
            type: "text",
            text: `Extensions on "${engine.quiz?.title}":\n\n${JSON.stringify(rows, null, 2)}\n\n`
              + `${limitNote} Student IDs can be resolved to names with list-students.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list quiz extensions: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: set-course-quiz-accommodations
  server.tool(
    "set-course-quiz-accommodations",
    "Give students extra time on EVERY New Quiz in a course at once — the standing IEP/504 accommodation, rather "
    + "than a per-quiz grant. Also the only way to grant New Quizzes extra time BEFORE a student has opened the "
    + "quiz, which the per-quiz tool cannot do. New Quizzes only: Classic Quizzes has no course-level "
    + "equivalent, so a student's Classic quizzes must still be handled one at a time with extend-quiz-time.",
    {
      courseId: z.string().describe("The ID of the course"),
      studentIds: z.array(z.string()).optional().describe("Canvas user IDs. Mutually exclusive with sectionId."),
      sectionId: z.string().optional().describe("Grant to every currently-enrolled student in this section. Mutually exclusive with studentIds."),
      extraMinutes: EXTRA_MINUTES,
      reduceChoices: z.boolean().optional().describe("Remove one wrong answer from multiple-choice questions with 4+ options"),
      applyToInProgressSessions: z.boolean().optional().describe("Also apply to quiz attempts that are open right now, not just future ones")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const target = await resolveTargets(canvas, args);
        const ids = numericIds(target.ids);

        const accommodations = ids.map(user_id => {
          const entry: any = { user_id, extra_time: args.extraMinutes };
          if (args.reduceChoices !== undefined) entry.reduce_choices_enabled = args.reduceChoices;
          if (args.applyToInProgressSessions !== undefined) {
            entry.apply_to_in_progress_quiz_sessions = args.applyToInProgressSessions;
          }
          return entry;
        });

        const response: any = await canvas
          .setCourseQuizAccommodations(args.courseId, accommodations)
          .catch((error: any) => explainNewQuizUserError(error, ids, 'course'));
        const label = args.extraMinutes === 0
          ? `Removed the course-wide extra time for ${ids.length} student(s)`
          : `Gave ${ids.length} student(s) ${args.extraMinutes} extra minute(s) on every New Quiz`;

        return {
          content: [{
            type: "text",
            text: `${label} in course ${args.courseId}: ${ids.join(', ')}.`
              + `\n\nThis covers New Quizzes only. Any Classic quizzes in this course are unaffected and need `
              + `extend-quiz-time per quiz.`
              + target.note
              + stackingNote('course', args.extraMinutes)
              + verifyNewQuiz(accommodations, response)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set course quiz accommodations: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
