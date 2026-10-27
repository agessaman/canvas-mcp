import type { RubricCriterion } from "./types.js";

// Helper for rubric/statistics calculations
export function calculateMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
  }
  return Number(sorted[middle].toFixed(2));
} 
// Tool-facing criterion shape. get-rubric emits it and create/update-rubric
// accept it, so a rubric can be read, edited, and sent back unchanged.
export interface RatingInput {
  id?: string;
  description: string;
  longDescription?: string;
  points: number;
}

export interface CriterionInput {
  id?: string;
  description?: string;
  longDescription?: string;
  learningOutcomeId?: string | null;
  masteryPoints?: number;
  useForScoring?: boolean;
  useRange?: boolean;
  ratings?: RatingInput[];
}

export function fromCanvasCriteria(data: RubricCriterion[] = []): CriterionInput[] {
  return data.map(c => {
    const criterion: CriterionInput = {
      id: c.id,
      description: c.description,
      longDescription: c.long_description || undefined,
      ratings: (c.ratings || []).map(r => ({
        id: r.id,
        description: r.description,
        longDescription: r.long_description || undefined,
        points: r.points,
      })),
    };
    if (c.criterion_use_range) criterion.useRange = true;
    if (c.learning_outcome_id) {
      criterion.learningOutcomeId = String(c.learning_outcome_id);
      criterion.masteryPoints = c.mastery_points;
      criterion.useForScoring = !c.ignore_for_scoring;
    }
    return criterion;
  });
}

// Canvas's Rubric#update_criteria iterates criteria and ratings as hashes
// keyed by position ("0", "1", ...) and compares flags against the string "1",
// so arrays and JSON booleans are silently mishandled.
export function toCanvasCriteria(criteria: CriterionInput[]): Record<string, any> {
  const result: Record<string, any> = {};
  criteria.forEach((c, i) => {
    const ratings: Record<string, any> = {};
    (c.ratings || []).forEach((r, j) => {
      ratings[String(j)] = {
        ...(r.id ? { id: r.id } : {}),
        description: r.description,
        long_description: r.longDescription || '',
        points: r.points,
      };
    });
    const criterion: any = {
      ...(c.id ? { id: c.id } : {}),
      description: c.description,
      long_description: c.longDescription || '',
      criterion_use_range: !!c.useRange,
      ratings,
    };
    if (c.learningOutcomeId) {
      criterion.learning_outcome_id = c.learningOutcomeId;
      if (c.masteryPoints !== undefined) criterion.mastery_points = c.masteryPoints;
      criterion.ignore_for_scoring = c.useForScoring === false ? '1' : '0';
    }
    result[String(i)] = criterion;
  });
  return result;
}
