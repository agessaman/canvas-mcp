import { z } from "zod";

// The New Quiz settings a teacher actually sets.
//
// These live outside both tools because create-new-quiz and update-new-quiz had
// drifted: create carried shuffle/time-limit/attempts and update carried none of
// them, so changing the time limit on an existing quiz meant hand-writing raw
// quiz_settings JSON. Sharing the schema and the builder is what stops that
// happening again — parity by construction rather than by copying.
//
// Canvas's quiz_settings has three shapes in one object:
//
//   flat            shuffle_answers, calculator_type, has_time_limit, ...
//   paired          require_student_access_code + student_access_code, where
//                   the flag without its value is a setting that does nothing
//   nested groups   multiple_attempts { ... }, result_view_settings { ... }
//
// The nested groups are why update reads the quiz first: sending
// `multiple_attempts: { score_to_keep: "latest" }` to change one field would,
// if Canvas replaces the group rather than merging it, silently drop the
// cooling period next to it. Merging client-side is correct under both
// behaviours, so it does not depend on knowing which one Canvas does.

export const NEW_QUIZ_SETTING_PARAMS = {
  shuffleQuestions: z.boolean().optional().describe("Present questions in a random order"),
  shuffleAnswers: z.boolean().optional().describe("Present answer options in a random order"),
  timeLimitMinutes: z.number().int().min(0).optional().describe(
    "Minutes a student gets once they start. 0 removes the time limit. This is the clock, not the due date."
  ),
  multipleAttempts: z.boolean().optional().describe(
    "Let students take the quiz more than once. Only needed to turn retakes OFF — setting maxAttempts, "
    + "scoreToKeep or coolingPeriodMinutes turns them on."
  ),
  maxAttempts: z.number().int().min(1).optional().describe(
    "Cap the number of attempts. Omit while multipleAttempts is on to allow unlimited retakes."
  ),
  scoreToKeep: z.enum(["highest", "latest", "average"]).optional().describe(
    "Which attempt counts when a student takes the quiz more than once"
  ),
  coolingPeriodMinutes: z.number().int().min(0).optional().describe(
    "How long a student must wait between attempts. 0 removes the wait."
  ),
  accessCode: z.string().optional().describe(
    "Password students must type to start the quiz. Pass an empty string to remove it."
  ),
  oneQuestionAtATime: z.boolean().optional().describe(
    "Show one question per screen rather than the whole quiz at once"
  ),
  allowBacktracking: z.boolean().optional().describe(
    "Let students return to earlier questions. Only meaningful with oneQuestionAtATime — without it students "
    + "can already see every question."
  ),
  calculatorType: z.enum(["none", "basic", "scientific"]).optional().describe(
    "Which on-screen calculator students get"
  ),
  // Result view. Each of these is independently meaningful, so they are named
  // separately rather than bundled — a teacher who wants scores shown but not
  // the answer key needs exactly this granularity.
  restrictResultView: z.boolean().optional().describe(
    "Restrict what students see after submitting. The showX options below apply within that restriction."
  ),
  showItems: z.boolean().optional().describe("Show students the questions after submitting"),
  showStudentResponses: z.boolean().optional().describe("Show students what they answered"),
  showItemFeedback: z.boolean().optional().describe("Show students the per-question feedback"),
  showPointsAwarded: z.boolean().optional().describe("Show students the points they earned"),
  showPointsPossible: z.boolean().optional().describe("Show students the points each question was worth"),
};

type Args = Record<string, any>;

const isSet = (value: any) => value !== undefined;

/** Did the caller ask for anything that belongs in quiz_settings? */
export function touchesSettings(args: Args): boolean {
  return Object.keys(NEW_QUIZ_SETTING_PARAMS).some(key => isSet(args[key]));
}

/**
 * Refuse the combinations Canvas would accept and quietly ignore.
 *
 * Every one of these produces a 200 and a setting that does nothing, which on
 * a quiz means a teacher believing an exam is locked down when it is not.
 */
export function validateSettings(args: Args): void {
  if (args.accessCode === '' && args.requireAccessCode === true) {
    throw new Error('An empty accessCode removes the password, so it cannot be required at the same time.');
  }

  // allow_backtracking is only read when the quiz is one-question-at-a-time.
  // Setting it alone is inert, and setting it against an explicit false is a
  // contradiction rather than a preference.
  if (isSet(args.allowBacktracking) && args.oneQuestionAtATime === false) {
    throw new Error(
      'allowBacktracking only means something when the quiz shows one question at a time — otherwise students '
      + 'can already move freely through every question. Pass oneQuestionAtATime: true, or drop allowBacktracking.'
    );
  }

  if (isSet(args.maxAttempts) && args.multipleAttempts === false) {
    throw new Error(
      'maxAttempts caps how many retakes a student gets, but multipleAttempts: false turns retakes off entirely. '
      + 'Pass one or the other.'
    );
  }
  if (isSet(args.scoreToKeep) && args.multipleAttempts === false) {
    throw new Error(
      'scoreToKeep decides which attempt counts, which only arises when retakes are allowed, but '
      + 'multipleAttempts: false turns them off. Pass one or the other.'
    );
  }
  if (isSet(args.coolingPeriodMinutes) && args.multipleAttempts === false) {
    throw new Error(
      'coolingPeriodMinutes sets the wait between attempts, but multipleAttempts: false turns retakes off. '
      + 'Pass one or the other.'
    );
  }
}

/**
 * Build the quiz_settings patch.
 *
 * `current` is the quiz's existing quiz_settings, used to merge the nested
 * groups. Omit it on create, where there is nothing to merge into.
 */
export function buildQuizSettings(args: Args, current: any = {}): Record<string, any> {
  const settings: Record<string, any> = {};

  if (isSet(args.shuffleQuestions)) settings.shuffle_questions = args.shuffleQuestions;
  if (isSet(args.shuffleAnswers)) settings.shuffle_answers = args.shuffleAnswers;
  if (isSet(args.calculatorType)) settings.calculator_type = args.calculatorType;

  // has_time_limit and the seconds are a pair: the number without the flag is
  // stored and ignored, and the flag without a number is a limit of nothing.
  if (isSet(args.timeLimitMinutes)) {
    if (args.timeLimitMinutes === 0) {
      settings.has_time_limit = false;
      settings.session_time_limit_in_seconds = null;
    } else {
      settings.has_time_limit = true;
      settings.session_time_limit_in_seconds = args.timeLimitMinutes * 60;
    }
  }

  // Same pairing: requiring a code without supplying one locks students out of
  // a quiz with no way in, so the code is what turns the requirement on.
  if (isSet(args.accessCode)) {
    if (args.accessCode === '') {
      settings.require_student_access_code = false;
      settings.student_access_code = null;
    } else {
      settings.require_student_access_code = true;
      settings.student_access_code = args.accessCode;
    }
  }

  if (isSet(args.oneQuestionAtATime)) {
    settings.one_at_a_time_type = args.oneQuestionAtATime ? 'question' : 'none';
  }
  if (isSet(args.allowBacktracking)) settings.allow_backtracking = args.allowBacktracking;

  // Nested group. Merged over what the quiz already has so that changing one
  // field cannot drop the others, whether or not Canvas merges it itself.
  const attemptKeys = ['multipleAttempts', 'maxAttempts', 'scoreToKeep', 'coolingPeriodMinutes'];
  if (attemptKeys.some(key => isSet(args[key]))) {
    const attempts: Record<string, any> = { ...(current?.multiple_attempts ?? {}) };
    const enabling = isSet(args.maxAttempts) || isSet(args.scoreToKeep) || isSet(args.coolingPeriodMinutes);

    if (isSet(args.multipleAttempts)) attempts.multiple_attempts_enabled = args.multipleAttempts;
    else if (enabling) attempts.multiple_attempts_enabled = true;

    if (isSet(args.maxAttempts)) {
      attempts.attempt_limit = true;
      attempts.max_attempts = args.maxAttempts;
    }
    if (isSet(args.scoreToKeep)) attempts.score_to_keep = args.scoreToKeep;
    if (isSet(args.coolingPeriodMinutes)) {
      if (args.coolingPeriodMinutes === 0) {
        attempts.cooling_period = false;
        attempts.cooling_period_seconds = null;
      } else {
        attempts.cooling_period = true;
        attempts.cooling_period_seconds = args.coolingPeriodMinutes * 60;
      }
    }
    // Turning retakes off leaves the rest of the group describing a state that
    // no longer applies, which is harmless but confusing to read back.
    if (args.multipleAttempts === false) {
      attempts.attempt_limit = false;
    }
    settings.multiple_attempts = attempts;
  }

  const resultKeys = [
    'restrictResultView', 'showItems', 'showStudentResponses',
    'showItemFeedback', 'showPointsAwarded', 'showPointsPossible',
  ];
  if (resultKeys.some(key => isSet(args[key]))) {
    const view: Record<string, any> = { ...(current?.result_view_settings ?? {}) };
    if (isSet(args.restrictResultView)) view.result_view_restricted = args.restrictResultView;
    if (isSet(args.showItems)) view.display_items = args.showItems;
    if (isSet(args.showStudentResponses)) view.display_item_response = args.showStudentResponses;
    if (isSet(args.showItemFeedback)) view.display_item_feedback = args.showItemFeedback;
    if (isSet(args.showPointsAwarded)) view.display_points_awarded = args.showPointsAwarded;
    if (isSet(args.showPointsPossible)) view.display_points_possible = args.showPointsPossible;
    settings.result_view_settings = view;
  }

  return settings;
}

/** Render quiz_settings the way a teacher reads them. */
export function formatQuizSettings(settings: any): string {
  if (!settings || Object.keys(settings).length === 0) return 'Settings: Canvas returned none.';

  const lines: string[] = [];
  lines.push(settings.has_time_limit
    ? `Time limit: ${Math.round(Number(settings.session_time_limit_in_seconds ?? 0) / 60)} minutes`
    : 'Time limit: none');

  const attempts = settings.multiple_attempts ?? {};
  if (attempts.multiple_attempts_enabled) {
    const cap = attempts.attempt_limit && attempts.max_attempts
      ? `${attempts.max_attempts} attempts`
      : 'unlimited attempts';
    const keep = attempts.score_to_keep ? `, keeping the ${attempts.score_to_keep} score` : '';
    const wait = attempts.cooling_period && attempts.cooling_period_seconds
      ? `, ${Math.round(Number(attempts.cooling_period_seconds) / 60)} minutes between attempts`
      : '';
    lines.push(`Retakes: ${cap}${keep}${wait}`);
  } else {
    lines.push('Retakes: one attempt only');
  }

  lines.push(`Access code: ${settings.require_student_access_code
    ? `required ("${settings.student_access_code ?? ''}")` : 'none'}`);
  lines.push(`Question order: ${settings.shuffle_questions ? 'shuffled' : 'as authored'}`);
  lines.push(`Answer order: ${settings.shuffle_answers ? 'shuffled' : 'as authored'}`);
  lines.push(settings.one_at_a_time_type === 'question'
    ? `One question at a time: yes (${settings.allow_backtracking ? 'can go back' : 'cannot go back'})`
    : 'One question at a time: no');
  lines.push(`Calculator: ${settings.calculator_type ?? 'none'}`);

  const view = settings.result_view_settings ?? {};
  if (Object.keys(view).length > 0) {
    const shown = [
      view.display_items && 'the questions',
      view.display_item_response && 'their answers',
      view.display_item_feedback && 'feedback',
      view.display_points_awarded && 'points earned',
      view.display_points_possible && 'points possible',
    ].filter(Boolean);
    lines.push(`After submitting, students see: ${shown.length > 0 ? shown.join(', ') : 'nothing'}`
      + `${view.result_view_restricted ? ' (restricted view)' : ''}`);
  }

  // Not exposed as parameters, so say what is there rather than let a teacher
  // assume these tools can see or set everything.
  if (settings.filter_ip_address) {
    lines.push('IP filtering: ON — not settable through this server; use quizSettings or the Canvas UI.');
  }

  return lines.join('\n');
}
