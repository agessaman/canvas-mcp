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
  | 'matching'
  | 'rich-fill-blank'
  | 'ordering'
  | 'categorization'
  | 'hot-spot';

// Canvas's per-blank matching methods. The UI writes TextContainsAnswer by
// default; the others come from the documented set.
const BLANK_ALGORITHMS = {
  contains: 'TextContainsAnswer',
  exact: 'TextEquivalence',
  'close-enough': 'TextCloseEnough',
  regex: 'TextRegex',
} as const;

export type BlankMatching = keyof typeof BLANK_ALGORITHMS;

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
  blankMatching?: BlankMatching;
  orderItems?: string[];
  topLabel?: string;
  bottomLabel?: string;
  categories?: { name: string; items: string[] }[];
  imageUrl?: string;
  imagePixelWidth?: number;
  imagePixelHeight?: number;
  hotspotRect?: { x: number; y: number; width: number; height: number };
  hotspotOval?: { x: number; y: number; width: number; height: number };
  hotspotPolygon?: { x: number; y: number }[];
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

    case 'rich-fill-blank': {
      // Shape copied from UI-authored item 9094. Blanks are marked in the body
      // with backticks around the correct answer — which is exactly how Canvas
      // stores it internally in scoring_data.working_item_body, so the teacher's
      // input and Canvas's own working copy are the same string.
      //
      //   "The capital of France is `Paris`."
      //
      // item_body then replaces each backticked run with an empty marker span
      // whose id is "blank_<uuid>", while interaction_data.blanks carries the
      // bare "<uuid>". The two must line up or the blank renders unanswerable.
      const wrapped = asHtml(input.body);
      const answers = [...wrapped.matchAll(/`([^`]+)`/g)].map(match => match[1]);
      if (answers.length === 0) {
        throw new Error(
          'interactionType "rich-fill-blank" needs at least one blank: put backticks around ' +
          'each answer in the body, e.g. "The capital of France is `Paris`."'
        );
      }

      const algorithm = BLANK_ALGORITHMS[input.blankMatching ?? 'contains'];
      const blanks = answers.map(answer => ({ id: randomUUID(), answer }));

      let index = 0;
      const itemBody = wrapped.replace(
        /`([^`]+)`/g,
        () => `<span id="blank_${blanks[index++].id}"></span>`
      );

      return {
        ...base,
        item_body: itemBody,
        properties: { shuffle_rules: { blanks: {} } },
        interaction_data: {
          blanks: blanks.map(blank => ({ id: blank.id, answer_type: 'openEntry' })),
        },
        scoring_data: {
          value: blanks.map(blank => ({
            id: blank.id,
            scoring_data: { value: blank.answer, blank_text: blank.answer },
            scoring_algorithm: algorithm,
          })),
          // Canvas keeps the backticked original so the editor can reconstruct
          // the sentence with its blanks; without it the item opens empty.
          working_item_body: wrapped,
        },
        scoring_algorithm: 'MultipleMethods',
      };
    }

    case 'ordering': {
      // Shape copied from UI-authored item 9093. Two details differ from every
      // other type: interaction_data.choices is a MAP keyed by id rather than an
      // array, and interaction_data carries its own empty item_body.
      const items = input.orderItems;
      if (!items || items.length < 2) {
        throw new Error('interactionType "ordering" requires at least 2 orderItems, in the correct order');
      }

      const built = items.map(text => ({ id: randomUUID(), item_body: asHtml(text) }));
      const choices: Record<string, { id: string; item_body: string }> = {};
      for (const choice of built) choices[choice.id] = choice;

      const includeLabels = !!(input.topLabel || input.bottomLabel);
      return {
        ...base,
        properties: {
          top_label: input.topLabel ?? '',
          bottom_label: input.bottomLabel ?? '',
          shuffle_rules: null,
          include_labels: includeLabels,
          display_answers_paragraph: false,
        },
        interaction_data: { choices, item_body: '' },
        // Correct order, as ids.
        scoring_data: { value: built.map(choice => choice.id) },
        scoring_algorithm: 'DeepEquals',
      };
    }

    case 'categorization': {
      // Shape copied from UI-authored item 9096. The naming is a trap:
      // interaction_data.distractors is NOT just the wrong answers — it is the
      // whole pool of draggable items, correct ones included. Items that belong
      // in no category are simply the pool entries no category claims.
      const categories = input.categories;
      if (!categories || categories.length < 2) {
        throw new Error('interactionType "categorization" requires at least 2 categories of { name, items }');
      }
      for (const category of categories) {
        if (!category.name?.trim()) throw new Error('every category needs a name');
        if (!category.items?.length) throw new Error(`category "${category.name}" has no items`);
      }

      const built = categories.map(category => ({
        id: randomUUID(),
        name: category.name,
        items: category.items.map(text => ({ id: randomUUID(), item_body: text })),
      }));
      const extras = (input.distractors ?? []).map(text => ({ id: randomUUID(), item_body: text }));

      const categoryMap: Record<string, { id: string; item_body: string }> = {};
      for (const category of built) {
        categoryMap[category.id] = { id: category.id, item_body: category.name };
      }
      const pool: Record<string, { id: string; item_body: string }> = {};
      for (const entry of [...built.flatMap(category => category.items), ...extras]) {
        pool[entry.id] = entry;
      }

      return {
        ...base,
        properties: { shuffle_rules: { questions: { shuffled: false } } },
        interaction_data: {
          categories: categoryMap,
          distractors: pool,
          category_order: built.map(category => category.id),
        },
        scoring_data: {
          value: built.map(category => ({
            id: category.id,
            scoring_data: { value: category.items.map(item => item.id) },
            scoring_algorithm: 'AllOrNothing',
          })),
          score_method: 'all_or_nothing',
        },
        scoring_algorithm: 'Categorization',
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

    // Copied from UI exemplar item 9315 (quiz 371875) and verified in the
    // Canvas editor 2026-08-04, including a Canvas Files image_url — the
    // service's own S3 item_media bucket is where the UI puts its uploads, not
    // a requirement of the field, so the whole flow is automatable.
    //
    // Deliberately absent: user_response_type. Most other types carry one; the
    // UI writes none here.
    case 'hot-spot': {
      if (!input.imageUrl) {
        throw new Error('interactionType "hot-spot" requires imageUrl — the image students click on');
      }
      const shapes = [
        ['hotspotRect', input.hotspotRect],
        ['hotspotOval', input.hotspotOval],
        ['hotspotPolygon', input.hotspotPolygon],
      ].filter(([, value]) => value !== undefined);
      if (shapes.length !== 1) {
        throw new Error(
          'interactionType "hot-spot" requires exactly one of hotspotRect, hotspotOval or hotspotPolygon'
          + (shapes.length ? ` (got ${shapes.map(([name]) => name).join(' and ')})` : '')
        );
      }

      // Canvas stores fractions, but nobody can estimate a fraction by looking
      // at a picture — the first API-authored hotspots were all placed wrong
      // for exactly this reason, while rendering perfectly. Given the image's
      // pixel size, coordinates may be supplied in pixels and converted here,
      // which is what someone reading positions off an image viewer actually
      // has.
      const inPixels = input.imagePixelWidth !== undefined || input.imagePixelHeight !== undefined;
      if (inPixels && !(input.imagePixelWidth! > 0 && input.imagePixelHeight! > 0)) {
        throw new Error(
          'imagePixelWidth and imagePixelHeight must BOTH be given, and both greater than 0, '
          + 'to read hotspot coordinates as pixels. Omit both to supply fractions instead.'
        );
      }
      const scale = inPixels
        ? { x: input.imagePixelWidth!, y: input.imagePixelHeight! }
        : { x: 1, y: 1 };

      // Each of the editor's three tools writes its own `type`, and the two
      // box shapes are TWO CORNERS rather than an outline. Note the editor
      // calls the rectangle tool "rectangle" in the UI and stores "square".
      const box = input.hotspotRect ?? input.hotspotOval;
      const shapeType = input.hotspotPolygon ? 'polygon' : input.hotspotOval ? 'oval' : 'square';
      const rawPoints = box ? boxCorners(box, shapeType) : input.hotspotPolygon!;

      if (!box && rawPoints.length < 3) {
        throw new Error(`hotspotPolygon needs at least 3 points to enclose an area (got ${rawPoints.length})`);
      }

      const points = rawPoints.map(({ x, y }) => ({ x: x / scale.x, y: y / scale.y }));

      // A pixel value passed as a fraction is stored happily and puts the
      // hotspot off the image, where no answer can ever be correct — silent,
      // and visible only to whoever sits the quiz.
      for (const [index, point] of points.entries()) {
        if (!inUnitRange(point.x) || !inUnitRange(point.y)) {
          const { x, y } = rawPoints[index];
          throw new Error(
            inPixels
              ? `hot-spot point (${x}, ${y}) is outside the ${input.imagePixelWidth}x${input.imagePixelHeight} image.`
              : `hot-spot coordinates are fractions of the image between 0 and 1, not pixels (got x=${x}, y=${y}). `
                + 'Either divide by the image width and height, or pass imagePixelWidth and imagePixelHeight '
                + 'and give the coordinates in pixels.'
          );
        }
      }

      return {
        ...base,
        calculator_type: 'none',
        interaction_data: { image_url: input.imageUrl, hotspots_count: 1 },
        scoring_data: { value: [{ id: 1, type: shapeType, coordinates: points }] },
        answer_feedback: {},
        scoring_algorithm: 'HotSpot',
      };
    }
  }
}

function inUnitRange(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A square or oval hotspot is TWO points — opposite corners of its bounding
 * box — not an outline. From UI exemplars 9321 (square) and 9320 (oval).
 *
 * The oval encoding was nearly got wrong. Its two points came back in
 * descending order, which reads convincingly as [center, radii] — a common way
 * to describe an ellipse. Checking the numbers against a known landmark in the
 * same image settled it: under that reading the "Salish Sea" oval would span
 * the entire width of Washington, while as a bounding box it lands on the
 * northwest corner and reaches slightly into Canada, which is where the Salish
 * Sea actually is. Two readings of the same two numbers, one of them silently
 * wrong — exactly the shape of bug this question type keeps producing.
 *
 * The editor does not normalise the corner order (it stores the drag as made),
 * so this emits min-then-max, matching the square exemplar.
 */
function boxCorners(
  box: { x: number; y: number; width: number; height: number },
  shape: string,
) {
  const name = shape === 'oval' ? 'hotspotOval' : 'hotspotRect';
  if (!(box.width > 0) || !(box.height > 0)) {
    throw new Error(`${name} needs a width and height greater than 0 (got ${box.width}x${box.height})`);
  }
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
  ];
}
