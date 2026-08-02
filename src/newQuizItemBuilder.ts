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

// Matching question ids are short numeric strings in the UI ("52556"), not the
// UUIDs used elsewhere in an item. Kept the same here so an API-authored item is
// indistinguishable from a UI-authored one. They key scoring_data.value, so a
// collision would silently drop a pair from the answer key — hence unique-by
// -construction rather than unique-by-luck.
function numericIds(count: number): string[] {
  const ids = new Set<string>();
  while (ids.size < count) {
    ids.add(String(Math.floor(10000 + Math.random() * 90000)));
  }
  return [...ids];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
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
      for (const pair of pairs) {
        if (!pair.left?.trim() || !pair.right?.trim()) {
          throw new Error('every matchPair needs a non-empty left and right');
        }
      }

      // This shape is copied from a matching question authored in the Canvas UI
      // and read back with get-new-quiz-item (course 18473, item 9092). Do not
      // "improve" it from the API appendix — an earlier version derived that way
      // stored and read back perfectly while making the Canvas editor throw
      // "React error #31: Objects are not valid as a React child", which takes
      // down the whole quiz page. Four details matter, all of them load-bearing:
      //
      //   1. interaction_data.answers are PLAIN STRINGS. Objects are what the
      //      editor choked on.
      //   2. scoring_data.value is a MAP of question id -> answer TEXT, not an
      //      array. (The appendix was right about this; the note claiming
      //      otherwise had actually sent an array.)
      //   3. scoring_data.edit_data must be there, or the editor has nothing to
      //      populate its match rows from.
      //   4. question item_body is raw text, NOT wrapped in <p>, and ids are
      //      short numeric strings rather than UUIDs — matching the UI.
      //
      // Note there is no answer_type: "match_string". The UI does not write one.
      const ids = numericIds(pairs.length);
      const questions = pairs.map((pair, i) => ({
        id: ids[i],
        item_body: pair.left,
      }));

      // Distractors are extra right-hand options that match nothing. Duplicate
      // answer text is deduped: two prompts may share an answer, but the option
      // should still be offered once.
      const answers = dedupe([
        ...pairs.map(pair => pair.right),
        ...(input.distractors ?? []),
      ]);

      const value: Record<string, string> = {};
      pairs.forEach((pair, i) => {
        value[questions[i].id] = pair.right;
      });

      return {
        ...base,
        properties: { shuffle_rules: { questions: { shuffled: false } } },
        interaction_data: { answers, questions },
        scoring_data: {
          value,
          edit_data: {
            matches: pairs.map((pair, i) => ({
              answer_body: pair.right,
              question_id: questions[i].id,
              question_body: pair.left,
            })),
            distractors: input.distractors ?? [],
          },
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
