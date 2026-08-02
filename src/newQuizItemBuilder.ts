import { randomUUID } from 'node:crypto';

// New Quizzes item entries are verbose: every choice needs a UUID, and the
// scoring_data / scoring_algorithm pair differs per interaction type. These
// helpers take teacher-shaped input (a question, some options, which one is
// right) and produce the payload the API expects.

export type InteractionType =
  | 'choice'
  | 'true-false'
  | 'multi-answer'
  | 'essay'
  | 'numeric'
  | 'matching';

export interface BuildItemInput {
  interactionType: InteractionType;
  title?: string;
  body: string;
  choices?: string[];
  correctChoiceIndex?: number;
  correctChoiceIndexes?: number[];
  correctBoolean?: boolean;
  numericAnswer?: number;
  numericMarginType?: 'absolute' | 'percent';
  numericMargin?: number;
  gradingNotes?: string;
  partialCredit?: boolean;
  matchPairs?: { left: string; right: string }[];
  distractors?: string[];
  feedback?: { neutral?: string; correct?: string; incorrect?: string };
}

// Canvas renders item bodies as HTML; wrap bare text so it isn't run together.
function asHtml(text: string): string {
  return /<[a-z][\s\S]*>/i.test(text) ? text : `<p>${text}</p>`;
}

function buildChoices(choices: string[]) {
  return choices.map((choice, index) => ({
    id: randomUUID(),
    position: index + 1,
    item_body: asHtml(choice),
  }));
}

function requireChoices(input: BuildItemInput): string[] {
  if (!input.choices || input.choices.length < 2) {
    throw new Error(`interactionType "${input.interactionType}" requires at least 2 choices`);
  }
  return input.choices;
}

function assertIndexInRange(index: number, length: number, field: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new Error(`${field} must be a 0-based index between 0 and ${length - 1} (got ${index})`);
  }
}

/**
 * Build the `entry` half of a New Quizzes item payload.
 * Throws with a teacher-readable message when the answer key doesn't line up
 * with the choices, rather than letting Canvas reject it opaquely.
 */
export function buildItemEntry(input: BuildItemInput): Record<string, any> {
  const base = {
    title: input.title ?? '',
    item_body: asHtml(input.body),
    interaction_type_slug: input.interactionType,
    properties: {},
    ...(input.feedback ? { feedback: input.feedback } : {}),
  };

  switch (input.interactionType) {
    case 'choice': {
      const choices = requireChoices(input);
      if (input.correctChoiceIndex === undefined) {
        throw new Error('interactionType "choice" requires correctChoiceIndex');
      }
      assertIndexInRange(input.correctChoiceIndex, choices.length, 'correctChoiceIndex');
      const built = buildChoices(choices);
      return {
        ...base,
        interaction_data: { choices: built },
        scoring_data: { value: built[input.correctChoiceIndex].id },
        scoring_algorithm: 'Equivalence',
      };
    }

    case 'multi-answer': {
      const choices = requireChoices(input);
      const correct = input.correctChoiceIndexes;
      if (!correct || correct.length === 0) {
        throw new Error('interactionType "multi-answer" requires correctChoiceIndexes');
      }
      correct.forEach(i => assertIndexInRange(i, choices.length, 'correctChoiceIndexes'));
      const built = buildChoices(choices);
      return {
        ...base,
        interaction_data: { choices: built },
        scoring_data: { value: correct.map(i => built[i].id) },
        scoring_algorithm: input.partialCredit ? 'PartialScore' : 'AllOrNothing',
      };
    }

    case 'true-false': {
      if (input.correctBoolean === undefined) {
        throw new Error('interactionType "true-false" requires correctBoolean');
      }
      return {
        ...base,
        interaction_data: { true_choice: 'True', false_choice: 'False' },
        scoring_data: { value: input.correctBoolean },
        scoring_algorithm: 'Equivalence',
      };
    }

    case 'essay': {
      return {
        ...base,
        interaction_data: {
          rce: true,
          word_count: true,
          spell_check: false,
          word_limit_enabled: false,
        },
        // Essays are hand-graded; this string is the grading note shown to the grader.
        scoring_data: { value: input.gradingNotes ?? '' },
        scoring_algorithm: 'None',
      };
    }

    case 'matching': {
      const pairs = input.matchPairs;
      if (!pairs || pairs.length < 2) {
        throw new Error('interactionType "matching" requires at least 2 matchPairs of { left, right }');
      }

      // Empirically confirmed against a live Canvas instance, and it differs
      // from the published appendix in two ways worth not re-discovering:
      //   1. scoring_algorithm is DeepEquals / PartialDeep — NOT a type-specific
      //      name like "Matching", which the API rejects outright.
      //   2. scoring_data.value is an ARRAY OF STRINGS shaped "questionId:answerId".
      //      The docs show a { questionId: answerText } map; sending objects
      //      fails with "property '#/value/0' of type object did not match ...
      //      type: string".
      const questions = pairs.map(pair => ({
        id: randomUUID(),
        item_body: asHtml(pair.left),
      }));
      const answers = pairs.map(pair => ({
        id: randomUUID(),
        item_body: asHtml(pair.right),
      }));
      // Distractors are extra right-hand options that match nothing.
      const extras = (input.distractors ?? []).map(text => ({
        id: randomUUID(),
        item_body: asHtml(text),
      }));

      return {
        ...base,
        interaction_data: { questions, answers: [...answers, ...extras] },
        scoring_data: {
          value: questions.map((question, i) => `${question.id}:${answers[i].id}`),
        },
        scoring_algorithm: input.partialCredit ? 'PartialDeep' : 'DeepEquals',
      };
    }

    case 'numeric': {
      if (input.numericAnswer === undefined) {
        throw new Error('interactionType "numeric" requires numericAnswer');
      }
      const answer =
        input.numericMargin !== undefined
          ? {
              id: randomUUID(),
              type: 'marginOfError',
              value: String(input.numericAnswer),
              margin: String(input.numericMargin),
              margin_type: input.numericMarginType ?? 'absolute',
            }
          : {
              id: randomUUID(),
              type: 'exactResponse',
              value: String(input.numericAnswer),
            };
      return {
        ...base,
        interaction_data: {},
        scoring_data: { value: [answer] },
        scoring_algorithm: 'Numeric',
      };
    }
  }
}
