import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

/**
 * Classic quizzes want `quiz[time_limit]` in MINUTES, with null meaning "no
 * time limit" — see quizzes.json in this instance's own API spec. New Quizzes
 * spell the same setting as a has_time_limit flag plus a seconds value, and
 * newQuizSettings clears it on 0. Both engines take 0 here so a teacher never
 * has to know which one backs their quiz, matching how extend-quiz-time
 * detects the engine rather than asking for it.
 */
function timeLimitField(minutes: number | undefined): { time_limit: number | null } | {} {
  if (minutes === undefined) return {};
  return { time_limit: minutes === 0 ? null : minutes };
}

/**
 * Reports what Canvas actually stored for the time limit.
 *
 * Gotcha 11: Canvas silently ignores parameters it does not support, so a 200
 * is not evidence the limit was set. The Quiz object comes back on both create
 * and update, so the echo can be checked here without a second call.
 *
 * Says nothing when the caller did not ask for a time limit, and nothing when
 * Canvas omits the key entirely — the update-syllabus lesson (gotcha 16) is
 * that a warning firing on every call trains the reader to skip the ones that
 * matter.
 */
function describeTimeLimit(requested: number | undefined, stored: any): string {
  if (requested === undefined) return '';
  if (stored?.time_limit === undefined) return '';

  const expected = requested === 0 ? null : requested;
  const actual = stored.time_limit ?? null;
  if (actual === expected) {
    return expected === null
      ? ', time limit removed (students get unlimited time)'
      : `, time limit ${expected} min`;
  }
  return `. WARNING: asked for ${expected === null ? 'no time limit' : expected + ' min'} but Canvas stored `
    + `${actual === null ? 'no time limit' : actual + ' min'}. The quiz clock is not what you set — check it in Canvas `
    + `before relying on it, and before granting extra time with extend-quiz-time.`;
}

const TIME_LIMIT_DESC =
  "Minutes a student gets once they start, or 0 for no time limit. This is the clock, not the due date "
  + "(use due_at for that). Extra time granted with extend-quiz-time is added on top of this, and only "
  + "does anything when a limit is set here.";

/**
 * The rest of the Classic quiz settings a teacher actually sets, spelled as
 * `quizzes.json` in the instance's own API spec spells them. Shared by create
 * and update so the two cannot drift apart — the same parity rule 1.13.0
 * applied to New Quizzes settings, and for the same reason: a setting you can
 * set at creation and never change again is a setting you have to delete a
 * quiz to fix.
 *
 * `access_code` takes '' to clear, matching `timeLimitMinutes: 0` and
 * `accessCode: ''` on the New Quizzes side.
 */
const CLASSIC_QUIZ_SETTINGS = {
  time_limit: z.number().int().min(0).optional().describe(TIME_LIMIT_DESC),
  allowed_attempts: z.number().int().min(-1).optional().describe(
    "How many times a student may take the quiz. 1 is the Canvas default; -1 is unlimited. "
    + "extend-assignment-attempts can grant an individual student more on top of this."
  ),
  access_code: z.string().optional().describe(
    "Password a student must type to start the quiz. Pass '' to remove it. "
    + "Anyone with the code can start, so it controls timing, not identity."
  ),
  one_question_at_a_time: z.boolean().optional().describe(
    "Show one question per page instead of the whole quiz at once"
  ),
  cant_go_back: z.boolean().optional().describe(
    "Stop students returning to a question once answered. Requires one_question_at_a_time"
  ),
  one_time_results: z.boolean().optional().describe(
    "Let students see their results only once, immediately after submitting"
  ),
  shuffle_answers: z.boolean().optional().describe("Randomize answer order per student"),
} as const;

/**
 * Canvas stores a value and its enabling flag separately and accepts either
 * alone — the silent-failure shape documented at length for New Quizzes. Here
 * `cant_go_back` is inert unless `one_question_at_a_time` is on, and Canvas
 * says nothing: the teacher believes backtracking is blocked on an exam where
 * it is not. Refuse the contradiction rather than resolving it, since either
 * guess would be a decision about someone's exam.
 */
function validateClassicQuizSettings(fields: any, existing?: any): void {
  if (fields.cant_go_back === true) {
    const oneAtATime = fields.one_question_at_a_time ?? existing?.one_question_at_a_time;
    if (oneAtATime !== true) {
      throw new Error(
        'cant_go_back only works when one_question_at_a_time is on — Canvas stores it either way and '
        + 'silently ignores it, so students would still be able to go back. Pass '
        + 'one_question_at_a_time: true in the same call, or turn cant_go_back off.'
      );
    }
  }
  if (fields.one_question_at_a_time === false && fields.cant_go_back === true) {
    throw new Error('one_question_at_a_time: false contradicts cant_go_back: true.');
  }
}

/** '' clears an access code; Canvas wants null for that, as with time_limit. */
function accessCodeField(code: string | undefined): { access_code: string | null } | {} {
  if (code === undefined) return {};
  return { access_code: code === '' ? null : code };
}

export function registerQuizTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-quizzes
  server.tool(
    "list-quizzes",
    "Get a list of all quizzes in a course",
    {
      courseId: z.string().describe("The ID of the course"),
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string; }) => {
      try {
        const quizzes: any[] = await canvas.fetchAllPages(`/api/v1/courses/${courseId}/quizzes`, { per_page: 100 });
        const formattedQuizzes = quizzes
          .map((quiz: any) => {
            return [
              `Quiz: ${quiz.title}`,
              `ID: ${quiz.id}`,
              `Due Date: ${quiz.due_at || 'No due date'}`,
              `Points Possible: ${quiz.points_possible}`,
              `Status: ${quiz.published ? 'Published' : 'Unpublished'}`
            ].join('\n');
          })
          .join('\n---\n');

        return {
          content: [
            {
              type: "text",
              text: quizzes.length > 0
                ? `Quizzes in course ${courseId}:\n\n${formattedQuizzes}\n\nTotal quizzes: ${quizzes.length}`
                : "No quizzes found in this course.",
            },
          ],
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quizzes: ${error.message}`);
        }
        throw new Error('Failed to fetch quizzes: Unknown error');
      }
    }
  );

  // Tool: get-quiz
  server.tool(
    "get-quiz",
    "Fetch metadata for a single quiz",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz")
    },
    { readOnlyHint: true },
    async ({ courseId, quizId }: { courseId: string; quizId: string }) => {
      try {
        const q = await canvas.get(`/api/v1/courses/${courseId}/quizzes/${quizId}`) as any;
        const summary = {
          id: q.id,
          title: q.title,
          quiz_type: q.quiz_type,
          due_at: q.due_at,
          points_possible: q.points_possible,
          published: q.published,
          time_limit: q.time_limit,
          allowed_attempts: q.allowed_attempts,
          // Settable since 1.15.0, and readable here for the same reason
          // allowed_attempts became readable in 1.12.3: a setting you can write
          // and not read is how an exam ends up unlocked without anyone seeing.
          access_code: q.access_code ?? null,
          one_question_at_a_time: q.one_question_at_a_time,
          cant_go_back: q.cant_go_back,
          one_time_results: q.one_time_results,
          shuffle_answers: q.shuffle_answers,
          question_count: q.question_count,
          workflow_state: q.workflow_state,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz: Unknown error');
      }
    }
  );

  // Tool: create-quiz
  server.tool(
    "create-quiz",
    "Create a new quiz in a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      title: z.string().describe("The title of the quiz"),
      description: z.string().optional().describe("A description of the quiz"),
      quiz_type: z.enum(["practice_quiz", "assignment", "graded_survey", "survey"]).optional().describe("The type of quiz"),
      due_at: z.string().optional().describe("The due date for the quiz"),
      points_possible: z.number().optional().describe("The point value of the quiz"),
      published: z.boolean().optional().describe("Whether the quiz is published"),
      ...CLASSIC_QUIZ_SETTINGS,
    },
    { destructiveHint: false },
    async (args: any) => {
      const { courseId, time_limit, access_code, ...fields } = args;
      try {
        validateClassicQuizSettings(args);
        const q = await canvas.post(`/api/v1/courses/${courseId}/quizzes`, {
          quiz: { ...fields, ...timeLimitField(time_limit), ...accessCodeField(access_code) },
        }) as any;
        return {
          content: [{ type: "text", text: `Quiz created: id=${q.id}, title="${q.title}", published=${q.published}${describeTimeLimit(time_limit, q)}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to create quiz: ${error.message}`);
        }
        throw new Error('Failed to create quiz: Unknown error');
      }
    }
  );

  // Tool: update-quiz
  server.tool(
    "update-quiz",
    "Update an existing quiz in a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      title: z.string().optional().describe("The title of the quiz"),
      description: z.string().optional().describe("A description of the quiz"),
      quiz_type: z.enum(["practice_quiz", "assignment", "graded_survey", "survey"]).optional().describe("The type of quiz"),
      due_at: z.string().optional().describe("The due date for the quiz"),
      points_possible: z.number().optional().describe("The point value of the quiz"),
      published: z.boolean().optional().describe("Whether the quiz is published"),
      ...CLASSIC_QUIZ_SETTINGS,
    },
    { idempotentHint: true },
    async (args: any) => {
      const { courseId, quizId, time_limit, access_code, ...fields } = args;
      try {
        // cant_go_back may rely on one_question_at_a_time already being on, so
        // the check needs the quiz's current state, not just this call's args.
        if (args.cant_go_back === true && args.one_question_at_a_time === undefined) {
          const current = await canvas.get(`/api/v1/courses/${courseId}/quizzes/${quizId}`) as any;
          validateClassicQuizSettings(args, current);
        } else {
          validateClassicQuizSettings(args);
        }
        const q = await canvas.put(`/api/v1/courses/${courseId}/quizzes/${quizId}`, {
          quiz: { ...fields, ...timeLimitField(time_limit), ...accessCodeField(access_code) },
        }) as any;
        return {
          content: [{ type: "text", text: `Quiz updated: id=${q.id}, title="${q.title}", published=${q.published}${describeTimeLimit(time_limit, q)}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to update quiz: ${error.message}`);
        }
        throw new Error('Failed to update quiz: Unknown error');
      }
    }
  );

  // Tool: delete-quiz
  server.tool(
    "delete-quiz",
    "Delete a quiz from a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
    },
    { destructiveHint: true },
    async ({ courseId, quizId }: { courseId: string; quizId: string }) => {
      try {
        await canvas.delete(`/api/v1/courses/${courseId}/quizzes/${quizId}`);
        return {
          content: [{ type: "text", text: `Quiz ${quizId} deleted from course ${courseId}.` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to delete quiz: ${error.message}`);
        }
        throw new Error('Failed to delete quiz: Unknown error');
      }
    }
  );

  // Tool: list-quiz-questions
  server.tool(
    "list-quiz-questions",
    "Get a list of all questions in a quiz",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId }: { courseId: string; quizId: string; }) => {
      try {
        const questions: any[] = await canvas.fetchAllPages(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions`, { per_page: 100 });
        const formattedQuestions = questions
          .map((q: any) => {
            return `ID: ${q.id}, Type: ${q.question_type}, Text: ${q.question_text.substring(0, 100)}...`;
          })
          .join('\n');

        return {
          content: [
            {
              type: "text",
              text: questions.length > 0
                ? `Questions for quiz ${quizId}:\n\n${formattedQuestions}`
                : "No questions found for this quiz.",
            },
          ],
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz questions: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz questions: Unknown error');
      }
    }
  );

  // Tool: get-quiz-question
  server.tool(
    "get-quiz-question",
    "Fetch a single question from a quiz",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      questionId: z.string().describe("The ID of the question"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, questionId }: { courseId: string; quizId: string; questionId: string }) => {
      try {
        const q = await canvas.get(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions/${questionId}`) as any;
        const summary = {
          id: q.id,
          question_name: q.question_name,
          question_text: q.question_text,
          question_type: q.question_type,
          points_possible: q.points_possible,
          position: q.position,
          answers: q.answers ?? [],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz question: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz question: Unknown error');
      }
    }
  );

  // Tool: create-quiz-question
  server.tool(
    "create-quiz-question",
    "Create a new question in a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      question: z.object({
        question_name: z.string().optional(),
        question_text: z.string(),
        question_type: z.string(),
        points_possible: z.number(),
        answers: z.array(z.any()).optional(),
      }).describe("The question object"),
    },
    { destructiveHint: false },
    async (args: any) => {
      const { courseId, quizId, question } = args;
      try {
        const q = await canvas.post(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions`, { question }) as any;
        return {
          content: [{ type: "text", text: `Question created: id=${q.id}, type="${q.question_type}", points=${q.points_possible}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to create quiz question: ${error.message}`);
        }
        throw new Error('Failed to create quiz question: Unknown error');
      }
    }
  );

  // Tool: update-quiz-question
  server.tool(
    "update-quiz-question",
    "Update an existing question in a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      questionId: z.string().describe("The ID of the question"),
      question: z.object({
        question_name: z.string().optional(),
        question_text: z.string().optional(),
        question_type: z.string().optional(),
        points_possible: z.number().optional(),
        answers: z.array(z.any()).optional(),
      }).describe("The question object"),
    },
    { idempotentHint: true },
    async (args: any) => {
      const { courseId, quizId, questionId, question } = args;
      try {
        const q = await canvas.put(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions/${questionId}`, { question }) as any;
        return {
          content: [{ type: "text", text: `Question updated: id=${q.id}, type="${q.question_type}", points=${q.points_possible}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to update quiz question: ${error.message}`);
        }
        throw new Error('Failed to update quiz question: Unknown error');
      }
    }
  );

  // Tool: delete-quiz-question
  server.tool(
    "delete-quiz-question",
    "Delete a question from a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      questionId: z.string().describe("The ID of the question"),
    },
    { destructiveHint: true },
    async ({ courseId, quizId, questionId }: { courseId: string; quizId: string; questionId: string }) => {
      try {
        await canvas.delete(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions/${questionId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted question ${questionId} from quiz ${quizId}.`
            }
          ]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to delete quiz question: ${error.message}`);
        }
        throw new Error('Failed to delete quiz question: Unknown error');
      }
    }
  );

  // Tool: list-quiz-question-groups
  server.tool(
    "list-quiz-question-groups",
    "Get a list of all question groups in a quiz",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId }: { courseId: string; quizId: string; }) => {
      try {
        const raw = await canvas.get(`/api/v1/courses/${courseId}/quizzes/${quizId}/groups`) as any[];
        const groups = raw.map((g: any) => ({
          id: g.id,
          name: g.name,
          pick_count: g.pick_count,
          question_points: g.question_points,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(groups) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz question groups: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz question groups: Unknown error');
      }
    }
  );

  // Tool: get-quiz-question-group
  server.tool(
    "get-quiz-question-group",
    "Fetch a single question group from a quiz",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      groupId: z.string().describe("The ID of the question group"),
    },
    { readOnlyHint: true },
    async ({ courseId, quizId, groupId }: { courseId: string; quizId: string; groupId: string }) => {
      try {
        const g = await canvas.get(`/api/v1/courses/${courseId}/quizzes/${quizId}/groups/${groupId}`) as any;
        return {
          content: [{ type: "text", text: JSON.stringify({ id: g.id, name: g.name, pick_count: g.pick_count, question_points: g.question_points }) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch quiz question group: ${error.message}`);
        }
        throw new Error('Failed to fetch quiz question group: Unknown error');
      }
    }
  );

  // Tool: create-quiz-question-group
  server.tool(
    "create-quiz-question-group",
    "Create a new question group in a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      quizGroup: z.object({
        name: z.string(),
        pick_count: z.number(),
        question_points: z.number(),
      }).describe("The quiz group object"),
    },
    { destructiveHint: false },
    async (args: any) => {
      const { courseId, quizId, quizGroup } = args;
      try {
        const g = await canvas.post(`/api/v1/courses/${courseId}/quizzes/${quizId}/groups`, { quiz_group: quizGroup }) as any;
        return {
          content: [{ type: "text", text: `Question group created: id=${g.id}, name="${g.name}", pick_count=${g.pick_count}, question_points=${g.question_points}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to create quiz question group: ${error.message}`);
        }
        throw new Error('Failed to create quiz question group: Unknown error');
      }
    }
  );

  // Tool: update-quiz-question-group
  server.tool(
    "update-quiz-question-group",
    "Update an existing question group in a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      groupId: z.string().describe("The ID of the group"),
      quizGroup: z.object({
        name: z.string().optional(),
        pick_count: z.number().optional(),
        question_points: z.number().optional(),
      }).describe("The quiz group object"),
    },
    { idempotentHint: true },
    async (args: any) => {
      const { courseId, quizId, groupId, quizGroup } = args;
      try {
        const g = await canvas.put(`/api/v1/courses/${courseId}/quizzes/${quizId}/groups/${groupId}`, { quiz_group: quizGroup }) as any;
        return {
          content: [{ type: "text", text: `Question group updated: id=${g.id}, name="${g.name}", pick_count=${g.pick_count}, question_points=${g.question_points}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to update quiz question group: ${error.message}`);
        }
        throw new Error('Failed to update quiz question group: Unknown error');
      }
    }
  );

  // Tool: delete-quiz-question-group
  server.tool(
    "delete-quiz-question-group",
    "Delete a question group from a quiz.",
    {
      courseId: z.string().describe("The ID of the course"),
      quizId: z.string().describe("The ID of the quiz"),
      groupId: z.string().describe("The ID of the group"),
    },
    { destructiveHint: true },
    async ({ courseId, quizId, groupId }: { courseId: string; quizId: string; groupId: string }) => {
      try {
        await canvas.delete(`/api/v1/courses/${courseId}/quizzes/${quizId}/groups/${groupId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted group ${groupId} from quiz ${quizId}.`
            }
          ]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to delete quiz question group: ${error.message}`);
        }
        throw new Error('Failed to delete quiz question group: Unknown error');
      }
    }
  );
}
