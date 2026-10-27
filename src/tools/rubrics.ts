import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { Outcome, OutcomeLink, Rubric, RubricCriterion, RubricStat } from "../types.js";
import { calculateMedian, CriterionInput, fromCanvasCriteria, toCanvasCriteria } from "../rubricUtils.js";

const ratingInputSchema = z.object({
  id: z.string().optional().describe("Existing rating ID (from get-rubric); omit for a new rating"),
  description: z.string().describe("Rating label, e.g. 'Proficient'"),
  longDescription: z.string().optional().describe("Optional longer explanation"),
  points: z.number().describe("Points for this rating")
});

const criterionInputSchema = z.object({
  id: z.string().optional().describe("Existing criterion ID (from get-rubric). Keep it when editing so existing assessments stay attached; omit for a new criterion"),
  description: z.string().optional().describe("Criterion title. Optional when learningOutcomeId is set (defaults to the outcome's title)"),
  longDescription: z.string().optional().describe("Optional longer explanation. Canvas replaces it with the outcome's description on outcome-aligned criteria"),
  learningOutcomeId: z.string().nullable().optional().describe("Align this criterion to a learning outcome (standard) in the course. Omit or null for a plain criterion"),
  masteryPoints: z.number().optional().describe("Mastery threshold for an outcome-aligned criterion. Defaults to the outcome's mastery points"),
  useForScoring: z.boolean().optional().describe("For outcome-aligned criteria: whether the criterion counts toward the rubric score (default true)"),
  useRange: z.boolean().optional().describe("Score ratings as point ranges"),
  ratings: z.array(ratingInputSchema).optional().describe("Ratings, highest first. Optional when learningOutcomeId is set (defaults to the outcome's rating scale)")
});

// Canvas create/update responses wrap the rubric as { rubric, rubric_association }.
// A rejected save still comes back as HTTP 200 with { error: true, messages },
// so it has to be caught here rather than by the HTTP client.
function unwrapRubric(response: any): any {
  if (response?.error) {
    const messages = Array.isArray(response.messages) ? response.messages.join('; ') : JSON.stringify(response);
    throw new Error(`Canvas rejected the rubric: ${messages}`);
  }
  return response?.rubric ?? response;
}

function rubricCriteria(rubric: any): RubricCriterion[] {
  return rubric?.data ?? rubric?.criteria ?? [];
}

function formatRubricSummary(rubric: any): string {
  const criteria = rubricCriteria(rubric);
  const lines = [
    `Rubric: ${rubric.title}`,
    `ID: ${rubric.id}`,
    `Points Possible: ${rubric.points_possible}`,
    'Criteria:',
    ...criteria.map(c => {
      const outcome = c.learning_outcome_id
        ? ` — outcome ${c.learning_outcome_id}${c.ignore_for_scoring ? ' (not scored)' : ''}`
        : '';
      return `  [${c.id}] ${c.description} (${c.points} pts)${outcome}`;
    }),
  ];
  return lines.join('\n');
}

// Validates that newly aligned outcomes are available in the course and fills
// in a missing title, rating scale, or mastery threshold from the outcome, the
// same way the Canvas rubric editor does when an outcome is picked. Alignments
// the rubric already had are trusted, so an old alignment (e.g. from a course
// copy) doesn't block unrelated edits.
async function resolveOutcomeCriteria(
  canvas: CanvasClient,
  courseId: string,
  criteria: CriterionInput[],
  alreadyAligned: CriterionInput[] = []
): Promise<CriterionInput[]> {
  const existing = new Set(alreadyAligned.map(c => c.learningOutcomeId).filter(Boolean));
  const outcomeIds = [...new Set(criteria.map(c => c.learningOutcomeId).filter((id): id is string => !!id && !existing.has(id)))];
  // The course-scoped listing is also the only place Canvas reports an
  // outcome's rating scale, so it doubles as the source for filling criteria.
  const seen = new Map<string, number>();
  criteria.forEach((c, i) => {
    if (!c.learningOutcomeId) return;
    if (seen.has(c.learningOutcomeId)) {
      throw new Error(`Outcome ${c.learningOutcomeId} is aligned to both criterion ${seen.get(c.learningOutcomeId)! + 1} and criterion ${i + 1}; Canvas allows each outcome only once per rubric`);
    }
    seen.set(c.learningOutcomeId, i);
  });
  const outcomes = new Map<string, Outcome>();
  if (criteria.some(c => c.learningOutcomeId)) {
    const links = await canvas.listOutcomeGroupLinks(courseId) as OutcomeLink[];
    links.forEach(l => outcomes.set(String(l.outcome.id), l.outcome));
    const missing = outcomeIds.filter(id => !outcomes.has(id));
    if (missing.length > 0) {
      throw new Error(`Outcome(s) ${missing.join(', ')} are not in course ${courseId}. Add them with link-outcome first.`);
    }
  }
  const resolved: CriterionInput[] = [];
  for (const [i, c] of criteria.entries()) {
    const criterion = { ...c };
    if (criterion.learningOutcomeId) {
      const needsFill = !criterion.description || !criterion.ratings?.length
        || (criterion.masteryPoints === undefined && !existing.has(criterion.learningOutcomeId));
      const outcome = outcomes.get(criterion.learningOutcomeId);
      if (needsFill && outcome) {
        criterion.description ||= outcome.title;
        if (!criterion.ratings?.length) criterion.ratings = outcome.ratings?.map(r => ({ description: r.description, points: r.points }));
        if (criterion.masteryPoints === undefined) criterion.masteryPoints = outcome.mastery_points;
      }
    } else {
      delete criterion.learningOutcomeId;
    }
    if (!criterion.description) throw new Error(`Criterion ${i + 1} needs a description`);
    if (!criterion.ratings?.length) throw new Error(`Criterion ${i + 1} ("${criterion.description}") needs at least one rating`);
    resolved.push(criterion);
  }
  return resolved;
}

// Saves criteria to an existing rubric and reports whether Canvas forked it
// into a new rubric, which it does for rubrics shared or already assessed.
async function saveRubric(canvas: CanvasClient, courseId: string, rubricId: string, rubric: {
  title: string; freeFormCriterionComments: boolean; criteria: CriterionInput[];
}): Promise<{ text: string }> {
  const response = await canvas.updateRubric(courseId, rubricId, {
    rubric: {
      title: rubric.title,
      free_form_criterion_comments: rubric.freeFormCriterionComments ? '1' : '0',
      criteria: toCanvasCriteria(rubric.criteria),
    },
  });
  const saved = unwrapRubric(response);
  const forked = saved?.id !== undefined && String(saved.id) !== String(rubricId)
    ? `Note: Canvas saved this as a new rubric (ID ${saved.id}) because rubric ${rubricId} is shared or already assessed. Attach the new rubric where the change should apply.\n\n`
    : '';
  return { text: `${forked}${formatRubricSummary(saved)}` };
}

export function registerRubricTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-rubrics
  server.tool(
    "list-rubrics",
    "List all rubrics in a course. Returns rubric title, ID, and description for each rubric.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const rubrics = (await canvas.listRubrics(courseId) as any) as Rubric[];
        const formattedRubrics = rubrics.map((rubric: Rubric) => 
          `Rubric: ${rubric.title}\nID: ${rubric.id}\nDescription: ${rubric.description || 'No description'}\n---`
        ).join('\n');
        return {
          content: [
            {
              type: "text",
              text: formattedRubrics || "No rubrics found for this course",
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch rubrics: ${error.message}`);
        }
        throw new Error('Failed to fetch rubrics: Unknown error');
      }
    }
  );

  // Tool: get-rubric-statistics
  server.tool(
    "get-rubric-statistics",
    "Get statistics for rubric assessments on an assignment",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      includePointDistribution: z.boolean().default(true).describe("Whether to include point distribution for each criterion")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, includePointDistribution = true }: { courseId: string; assignmentId: string; includePointDistribution?: boolean }) => {
      try {
        const response = (await canvas.getRubricStatistics(courseId, assignmentId, {
          include: ['rubric']
        }) as any);
        if (!response.rubric) {
          throw new Error('No rubric found for this assignment');
        }

        const submissions = await canvas.fetchAllPages(
          `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
          { include: ['rubric_assessment'], per_page: 100 }
        );

        const rubricStats = (response.rubric as any[]).map((criterion: any) => {
          const scores = submissions
            .filter((sub: any) => sub.rubric_assessment?.[criterion.id]?.points !== undefined)
            .map((sub: any) => sub.rubric_assessment[criterion.id].points);
          const stats: RubricStat = {
            id: criterion.id,
            description: criterion.description,
            points_possible: criterion.points,
            total_assessments: scores.length,
            average_score: 0,
            median_score: 0,
            min_score: 0,
            max_score: 0
          };
          if (scores.length > 0) {
            stats.average_score = Number((scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(2));
            stats.median_score = calculateMedian(scores);
            stats.min_score = Math.min(...scores);
            stats.max_score = Math.max(...scores);
          }
          if (includePointDistribution) {
            const distribution: { [key: number]: number } = {};
            scores.forEach((score: number) => {
              distribution[score] = (distribution[score] || 0) + 1;
            });
            stats.point_distribution = distribution;
          }
          return stats;
        });
        // Calculate overall statistics
        const totalScores = submissions
          .filter((sub: any) => sub.rubric_assessment)
          .map((sub: any) => {
            return Object.values(sub.rubric_assessment)
              .reduce((sum: number, assessment: any) => sum + (assessment.points || 0), 0);
          });
        const overallStats = {
          total_submissions: submissions.length,
          submissions_with_assessment: totalScores.length,
          overall_average: 0,
          overall_median: 0,
          overall_min: 0,
          overall_max: 0
        };
        if (totalScores.length > 0) {
          overallStats.overall_average = Number((totalScores.reduce((a, b) => a + b, 0) / totalScores.length).toFixed(2));
          overallStats.overall_median = calculateMedian(totalScores);
          overallStats.overall_min = Math.min(...totalScores);
          overallStats.overall_max = Math.max(...totalScores);
        }
        const formattedStats = [
          'Overall Statistics:',
          `Total Submissions: ${overallStats.total_submissions}`,
          `Submissions with Assessment: ${overallStats.submissions_with_assessment}`,
          `Average Score: ${overallStats.overall_average}`,
          `Median Score: ${overallStats.overall_median}`,
          `Min Score: ${overallStats.overall_min}`,
          `Max Score: ${overallStats.overall_max}`,
          '\nCriterion Statistics:',
          ...rubricStats.map((stat: any) => {
            const parts = [
              `\nCriterion: ${stat.description}`,
              `Points Possible: ${stat.points_possible}`,
              `Total Assessments: ${stat.total_assessments}`,
              `Average Score: ${stat.average_score}`,
              `Median Score: ${stat.median_score}`,
              `Min Score: ${stat.min_score}`,
              `Max Score: ${stat.max_score}`
            ];
            if (includePointDistribution && stat.point_distribution) {
              parts.push('\nPoint Distribution:');
              Object.entries(stat.point_distribution)
                .sort(([a], [b]) => Number(b) - Number(a))
                .forEach(([score, count]) => {
                  const percentage = (((count as number) / stat.total_assessments) * 100).toFixed(1);
                  parts.push(`  ${score} points: ${count} submissions (${percentage}%)`);
                });
            }
            return parts.join('\n');
          })
        ].join('\n');
        return {
          content: [
            {
              type: "text",
              text: formattedStats
            }
          ]
        };
      } catch (error: any) {
        if (error.response?.status === 404) {
          throw new Error(`Assignment ${assignmentId} not found in course ${courseId}`);
        }
        if (error.response?.errors) {
          throw new Error(`Failed to fetch rubric statistics: ${JSON.stringify(error.response.errors)}`);
        }
        throw new Error(`Failed to fetch rubric statistics: ${error.message}`);
      }
    }
  );

  // Tool: list-rubric-assessments
  server.tool(
    "list-rubric-assessments",
    "List all rubric assessments for an assignment.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      anonymous: z.boolean().default(true).describe("Whether to anonymize student names and emails (default: true for privacy)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, anonymous = true }: { courseId: string; assignmentId: string; anonymous?: boolean }) => {
      try {
        const raw = (await canvas.listRubricAssessments(courseId, assignmentId, { 'include[]': 'rubric_assessment' }, { anonymous }) as any[]);
        const assessments = raw.map((s: any) => ({
          id: s.id,
          user_id: s.user_id,
          workflow_state: s.workflow_state,
          score: s.score,
          attempt: s.attempt,
          submitted_at: s.submitted_at,
          rubric_assessment: s.rubric_assessment ?? null,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(assessments) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch rubric assessments: ${error.message}`);
        }
        throw new Error('Failed to fetch rubric assessments: Unknown error');
      }
    }
  );

  // Tool: attach-rubric-to-assignment
  server.tool(
    "attach-rubric-to-assignment",
    "Attach a rubric to an assignment.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      rubricId: z.string().describe("The ID of the rubric to attach")
    },
    { idempotentHint: true },
    async ({ courseId, assignmentId, rubricId }: { courseId: string; assignmentId: string; rubricId: string }) => {
      try {
        await canvas.attachRubricToAssignment(courseId, assignmentId, rubricId);
        return {
          content: [{ type: "text", text: `Rubric ${rubricId} attached to assignment ${assignmentId} in course ${courseId}.` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to attach rubric: ${error.message}`);
        }
        throw new Error('Failed to attach rubric: Unknown error');
      }
    }
  );

  // Tool: get-rubric
  server.tool(
    "get-rubric",
    "Get a rubric's criteria, ratings, and outcome alignments as JSON. The criteria array can be edited and passed straight back to update-rubric.",
    {
      courseId: z.string().describe("The ID of the course"),
      rubricId: z.string().describe("The ID of the rubric")
    },
    { readOnlyHint: true },
    async ({ courseId, rubricId }: { courseId: string; rubricId: string }) => {
      try {
        const rubric = await canvas.getRubric(courseId, rubricId) as any;
        const result = {
          id: rubric.id,
          title: rubric.title,
          pointsPossible: rubric.points_possible,
          freeFormCriterionComments: !!rubric.free_form_criterion_comments,
          associations: (rubric.associations || []).map((a: any) => ({
            type: a.association_type,
            id: a.association_id,
            purpose: a.purpose,
            useForGrading: a.use_for_grading,
          })),
          criteria: fromCanvasCriteria(rubricCriteria(rubric)),
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch rubric: ${error.message}`);
        }
        throw new Error('Failed to fetch rubric: Unknown error');
      }
    }
  );

  // Tool: create-rubric
  server.tool(
    "create-rubric",
    "Create a rubric in a course, optionally aligning criteria to learning outcomes and attaching it to an assignment.",
    {
      courseId: z.string().describe("The ID of the course"),
      title: z.string().describe("Rubric title"),
      criteria: z.array(criterionInputSchema).min(1).describe("Rubric criteria, in display order"),
      freeFormCriterionComments: z.boolean().optional().describe("Let graders write free-form comments instead of picking ratings"),
      assignmentId: z.string().optional().describe("Attach the new rubric to this assignment. If omitted, the rubric is saved to the course's rubric list"),
      useForGrading: z.boolean().default(false).describe("With assignmentId: use the rubric score for the assignment grade (this sets the assignment's points to the rubric total)"),
      hideScoreTotal: z.boolean().optional().describe("With assignmentId: hide the rubric's score total from students")
    },
    { destructiveHint: false },
    async ({ courseId, title, criteria, freeFormCriterionComments, assignmentId, useForGrading = false, hideScoreTotal }: {
      courseId: string; title: string; criteria: CriterionInput[]; freeFormCriterionComments?: boolean;
      assignmentId?: string; useForGrading?: boolean; hideScoreTotal?: boolean;
    }) => {
      try {
        const resolved = await resolveOutcomeCriteria(canvas, courseId, criteria);
        const rubricAssociation = assignmentId
          ? {
              association_type: 'Assignment',
              association_id: assignmentId,
              purpose: 'grading',
              use_for_grading: useForGrading,
              ...(hideScoreTotal !== undefined ? { hide_score_total: hideScoreTotal } : {}),
            }
          : { association_type: 'Course', association_id: courseId, purpose: 'bookmark' };
        const response = await canvas.createRubric(courseId, {
          rubric: {
            title,
            free_form_criterion_comments: freeFormCriterionComments ? '1' : '0',
            criteria: toCanvasCriteria(resolved),
          },
          rubric_association: rubricAssociation,
        });
        const rubric = unwrapRubric(response);
        const attached = assignmentId ? `\nAttached to assignment ${assignmentId}${useForGrading ? ' (used for grading)' : ''}.` : '';
        return { content: [{ type: "text", text: `Rubric created.${attached}\n\n${formatRubricSummary(rubric)}` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to create rubric: ${error.message}`);
        }
        throw new Error('Failed to create rubric: Unknown error');
      }
    }
  );

  // Tool: update-rubric
  server.tool(
    "update-rubric",
    "Update a rubric's title, comment setting, or criteria. When criteria is given it replaces the whole list, so start from get-rubric and keep criterion IDs. If the rubric is used in several places or already assessed, Canvas may save the edit as a new rubric with a new ID.",
    {
      courseId: z.string().describe("The ID of the course"),
      rubricId: z.string().describe("The ID of the rubric"),
      title: z.string().optional().describe("New rubric title"),
      freeFormCriterionComments: z.boolean().optional().describe("Let graders write free-form comments instead of picking ratings"),
      criteria: z.array(criterionInputSchema).min(1).optional().describe("Complete replacement criteria list (from get-rubric, edited). Omit to keep the current criteria")
    },
    { idempotentHint: true },
    async ({ courseId, rubricId, title, freeFormCriterionComments, criteria }: {
      courseId: string; rubricId: string; title?: string; freeFormCriterionComments?: boolean; criteria?: CriterionInput[];
    }) => {
      try {
        if (title === undefined && freeFormCriterionComments === undefined && criteria === undefined) {
          throw new Error('No changes were provided');
        }
        // Canvas rebuilds title and criteria from each update, so unchanged
        // fields have to be sent back as they are.
        const current = await canvas.getRubric(courseId, rubricId) as any;
        const currentCriteria = fromCanvasCriteria(rubricCriteria(current));
        const resolved = await resolveOutcomeCriteria(canvas, courseId, criteria ?? currentCriteria, currentCriteria);
        const rubric = await saveRubric(canvas, courseId, rubricId, {
          title: title ?? current.title,
          freeFormCriterionComments: freeFormCriterionComments ?? !!current.free_form_criterion_comments,
          criteria: resolved,
        });
        return { content: [{ type: "text", text: rubric.text }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to update rubric: ${error.message}`);
        }
        throw new Error('Failed to update rubric: Unknown error');
      }
    }
  );

  // Tool: set-rubric-criterion-outcome
  server.tool(
    "set-rubric-criterion-outcome",
    "Align one rubric criterion to a learning outcome (standard), or remove its alignment, leaving the rest of the rubric unchanged. Use get-rubric for criterion IDs and list-outcomes for outcome IDs.",
    {
      courseId: z.string().describe("The ID of the course"),
      rubricId: z.string().describe("The ID of the rubric"),
      criterionId: z.string().describe("The criterion ID (from get-rubric)"),
      outcomeId: z.string().nullable().describe("Outcome to align to, or null to remove the alignment"),
      useOutcomeRatings: z.boolean().default(true).describe("Replace the criterion's title, ratings, and mastery points with the outcome's, as the Canvas rubric editor does. Set false to keep the criterion's own ratings"),
      useForScoring: z.boolean().default(true).describe("Whether the aligned criterion counts toward the rubric score")
    },
    { idempotentHint: true },
    async ({ courseId, rubricId, criterionId, outcomeId, useOutcomeRatings = true, useForScoring = true }: {
      courseId: string; rubricId: string; criterionId: string; outcomeId: string | null; useOutcomeRatings?: boolean; useForScoring?: boolean;
    }) => {
      try {
        const current = await canvas.getRubric(courseId, rubricId) as any;
        const criteria = fromCanvasCriteria(rubricCriteria(current));
        // Snapshot alignments before editing so only the targeted change is validated
        const before = criteria.map(c => ({ ...c }));
        const index = criteria.findIndex(c => c.id === criterionId);
        if (index === -1) {
          throw new Error(`Criterion ${criterionId} not found. Available: ${criteria.map(c => `${c.id} (${c.description})`).join(', ')}`);
        }
        const target = criteria[index];
        if (outcomeId) {
          target.learningOutcomeId = outcomeId;
          target.useForScoring = useForScoring;
          target.masteryPoints = undefined;
          if (useOutcomeRatings) {
            target.description = undefined;
            target.ratings = undefined;
          }
        } else {
          target.learningOutcomeId = null;
          target.masteryPoints = undefined;
          target.useForScoring = undefined;
        }
        const resolved = await resolveOutcomeCriteria(canvas, courseId, criteria, before.filter((_, i) => i !== index));
        const rubric = await saveRubric(canvas, courseId, rubricId, {
          title: current.title,
          freeFormCriterionComments: !!current.free_form_criterion_comments,
          criteria: resolved,
        });
        const action = outcomeId ? `Aligned criterion ${criterionId} to outcome ${outcomeId}.` : `Removed the outcome alignment from criterion ${criterionId}.`;
        return { content: [{ type: "text", text: `${action}\n\n${rubric.text}` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to set criterion outcome: ${error.message}`);
        }
        throw new Error('Failed to set criterion outcome: Unknown error');
      }
    }
  );
}
