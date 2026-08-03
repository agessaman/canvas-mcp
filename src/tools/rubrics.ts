import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { Rubric, RubricStat } from "../types.js";
import { calculateMedian } from "../rubricUtils.js";

// Rubric reading and authoring.
//
// grade-submission already accepts a rubric_assessment, so until now the server
// could post scores against a rubric it had no way to read. get-rubric closes
// that loop: it hands back the criterion IDs a rubric_assessment has to be keyed
// by. create-rubric and update-rubric are the authoring half.
//
// Canvas's rubric endpoints are unusually hostile, and every quirk below was
// read out of the canvas-lms source (app/controllers/rubrics_controller.rb,
// app/models/rubric.rb, app/models/rubric_association.rb, lib/api/v1/rubric.rb)
// rather than guessed. NONE of it has been exercised against a live Canvas:
//
//   1. Criteria are an INDEXED HASH, not an array. Canvas iterates
//      `params[:criteria].each do |idx, criterion_data|` and sorts by idx.to_i,
//      so `{"0": {...}, "1": {...}}` is required. Handing it a JSON array makes
//      Ruby destructure each hash into (idx, nil) and die on nil — an
//      undiagnosable 500. Ratings nest the same way, consumed via `.values`.
//
//   2. Booleans are compared to the STRING "1". `free_form_criterion_comments`
//      is stored as `params[...] == "1"`, so a JSON `true` is stored as FALSE —
//      a silently inverted setting. Criterion-level `criterion_use_range` uses a
//      different list (`[true, "true"]`, no "1"), so the two cannot share an
//      encoding.
//
//   3. points_possible is NOT an input. Canvas recomputes it as the sum of the
//      criteria, and recomputes each criterion's points as its highest rating's
//      points. A criterion with no ratings silently becomes worth 0.
//
//   4. Creation without a rubric_association creates a rubric that is attached
//      to nothing. Canvas only builds an association when an association object
//      is resolved, and GET /courses/:id/rubrics/:id finds a rubric only through
//      a *bookmarked* association — so a rubric created without one is invisible
//      to the read tool and to the Canvas UI.
//
//   5. The write endpoints render `{ error: true, messages: [...] }` under HTTP
//      200 when validation fails, and answer with `{ rubric, rubric_association }`
//      rather than a Rubric. A 200 here means even less than usual.
//
//   6. update is a full REPLACE, not a patch: an omitted title renames the
//      rubric to "<Course> Rubric" and omitted criteria wipe every criterion.
//      update-rubric therefore re-reads the rubric and resends what it is not
//      changing.

const RATING_FIELDS = {
  description: z.string().min(1).describe("What this level of performance looks like, e.g. \"Proficient\""),
  longDescription: z.string().optional().describe("Longer explanation shown under the rating"),
  points: z.number().describe("Points awarded at this level"),
  id: z.string().optional().describe("Existing rating ID — only when editing a rubric, to keep prior assessments attached"),
};

const CRITERION_FIELDS = {
  description: z.string().min(1).describe("The criterion's name, e.g. \"Thesis and argument\""),
  longDescription: z.string().optional().describe("Longer explanation of the criterion"),
  ratings: z.array(z.object(RATING_FIELDS).passthrough()).min(1)
    .describe("The performance levels. At least one is required: Canvas sets the criterion's points to its highest rating, so a criterion with no ratings is stored as worth 0."),
  points: z.number().optional()
    .describe("Optional cross-check. Canvas always derives this from the highest rating, so a value that disagrees is refused rather than silently replaced."),
  id: z.string().optional().describe("Existing criterion ID — only when editing a rubric, to keep prior assessments attached"),
  criterionUseRange: z.boolean().optional().describe("Let graders pick any score in the range between two ratings, rather than only the listed values"),
};

const RATING_STRICT = z.object(RATING_FIELDS).strict();
const CRITERION_STRICT = z.object({ ...CRITERION_FIELDS, ratings: z.array(RATING_STRICT).min(1) }).strict();

type RatingInput = z.infer<typeof RATING_STRICT>;
type CriterionInput = z.infer<typeof CRITERION_STRICT>;

/**
 * The criteria parameter.
 *
 * Same hazard, and the same remedy, as `jsonObjectParam` in
 * ../jsonObjectParam.ts: a parameter typed loosely enough that a client may hand
 * it over as a JSON *string* goes to Canvas verbatim and comes back as a bare,
 * undiagnosable 500. jsonObjectParam itself is not reusable here because it
 * rejects arrays by design, and an array is the shape a caller naturally writes
 * a rubric in. So this declares the full nested structure, and additionally
 * accepts:
 *
 *   - a JSON string containing either shape, parsed rather than forwarded;
 *   - Canvas's own indexed-hash spelling ({"0": {...}}), because a caller
 *     working from the Canvas docs will reasonably produce that.
 *
 * Everything is normalized to an ordered array here; toCanvasCriteria puts it
 * back into the indexed hash Canvas actually requires.
 */
function criteriaParam(description: string) {
  return z
    .union([
      z.array(z.object(CRITERION_FIELDS).passthrough()),
      z.record(z.string(), z.object(CRITERION_FIELDS).passthrough()),
      z.string(),
    ])
    .transform((value, ctx): CriterionInput[] => {
      const fail = (message: string) => {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER as unknown as CriterionInput[];
      };

      let raw: unknown = value;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          return fail("Expected a list of criteria, or a string containing one; this string is not valid JSON.");
        }
      }

      let list: unknown[];
      if (Array.isArray(raw)) {
        list = raw;
      } else if (raw !== null && typeof raw === "object") {
        // Canvas's indexed-hash spelling. Sorted by numeric key, matching
        // Canvas's own `sort_by { |c| c.first.to_i }`.
        list = Object.entries(raw as Record<string, unknown>)
          .sort(([a], [b]) => (Number(a) || 0) - (Number(b) || 0))
          .map(([, criterion]) => criterion);
      } else {
        return fail(`Expected a list of criteria, got ${typeof raw}.`);
      }

      const parsed = z.array(CRITERION_STRICT).min(1).safeParse(list);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map(issue => `criteria[${issue.path.join('.')}]: ${issue.message}`)
          .join('; ');
        return fail(
          `${detail}. A criterion is { description, ratings: [{ description, points }] }, plus optional `
          + `longDescription, criterionUseRange and id. Outcome-aligned criteria are not supported by this tool `
          + `— build those in the Canvas UI.`
        );
      }
      return parsed.data;
    })
    .describe(description);
}

const points = (value: any): string => String(Number(value ?? 0));

/** Canvas overwrites a criterion's points with its highest rating's points. */
function derivedPoints(criterion: { ratings: RatingInput[] }): number {
  return criterion.ratings.reduce((max, rating) => Math.max(max, Number(rating.points) || 0), 0);
}

function expectedTotal(criteria: CriterionInput[]): number {
  return criteria.reduce((sum, criterion) => sum + derivedPoints(criterion), 0);
}

/**
 * Build the indexed nested hash Canvas requires. This is the single most
 * likely thing to get wrong, so it is the thing the tests assert on.
 */
function toCanvasCriteria(criteria: CriterionInput[]): Record<string, any> {
  const out: Record<string, any> = {};
  criteria.forEach((criterion, index) => {
    const ratings: Record<string, any> = {};
    criterion.ratings.forEach((rating, ratingIndex) => {
      const entry: any = { description: rating.description, points: rating.points };
      if (rating.longDescription !== undefined) entry.long_description = rating.longDescription;
      if (rating.id !== undefined) entry.id = rating.id;
      ratings[String(ratingIndex)] = entry;
    });

    const entry: any = {
      description: criterion.description,
      // Sent as the value Canvas is going to derive anyway, so the request and
      // the stored record agree. Sending the caller's number instead would make
      // every points mismatch look like a Canvas failure in the readback.
      points: derivedPoints(criterion),
      ratings,
    };
    if (criterion.longDescription !== undefined) entry.long_description = criterion.longDescription;
    if (criterion.id !== undefined) entry.id = criterion.id;
    // Sent as a boolean: Canvas tests this one against [true, "true"] and does
    // NOT accept "1" here, unlike the rubric-level booleans.
    if (criterion.criterionUseRange !== undefined) entry.criterion_use_range = criterion.criterionUseRange;
    out[String(index)] = entry;
  });
  return out;
}

/**
 * Canvas stores `free_form_criterion_comments` as `params[...] == "1"`, so a
 * JSON boolean `true` is stored as false — an inverted setting reported as a
 * success. Rubric-level booleans go over the wire as "1"/"0" for that reason.
 */
const canvasBool = (value: boolean): string => (value ? "1" : "0");

/** The criteria of a rubric as Canvas returns them, under either key. */
function criteriaOf(rubric: any): any[] {
  const criteria = rubric?.criteria ?? rubric?.data;
  return Array.isArray(criteria) ? criteria : [];
}

/** Turn a rubric Canvas returned back into the input shape, for resend-on-update. */
function storedAsInput(rubric: any): CriterionInput[] {
  return criteriaOf(rubric).map((criterion: any) => ({
    description: criterion.description ?? '',
    longDescription: criterion.long_description || undefined,
    id: criterion.id !== undefined ? String(criterion.id) : undefined,
    criterionUseRange: criterion.criterion_use_range ?? undefined,
    ratings: (Array.isArray(criterion.ratings) ? criterion.ratings : []).map((rating: any) => ({
      description: rating.description ?? '',
      longDescription: rating.long_description || undefined,
      points: Number(rating.points ?? 0),
      id: rating.id !== undefined ? String(rating.id) : undefined,
    })),
  }));
}

/**
 * The write endpoints answer `{ error: true, messages: [...] }` with HTTP 200
 * when the rubric fails validation, so the status line proves nothing.
 */
function assertNotSilentFailure(response: any, what: string): void {
  if (response?.error) {
    const messages = response.messages ?? response.errors ?? response;
    throw new Error(
      `Canvas refused to ${what} but answered HTTP 200. Canvas said: ${JSON.stringify(messages).slice(0, 600)}`
    );
  }
}

/**
 * Diff what was asked for against what a re-GET says Canvas stored.
 *
 * Same discipline as verifyApplied in overrides.ts, for the same reason: Canvas
 * answers 200 to writes it has not applied. Rubrics add a second failure mode on
 * top of that — Canvas rewrites points from the ratings — so a rubric can be
 * stored successfully and still not be the rubric that was asked for.
 */
function verifyRubric(
  requested: { title?: string; criteria: CriterionInput[]; freeFormComments?: boolean },
  stored: any
): string {
  const problems: string[] = [];

  if (requested.title !== undefined && stored?.title !== requested.title) {
    problems.push(`title: asked for "${requested.title}", Canvas stored "${stored?.title ?? 'nothing'}"`);
  }

  if (requested.freeFormComments !== undefined
    && !!stored?.free_form_criterion_comments !== requested.freeFormComments) {
    problems.push(
      `free-form comments: asked for ${requested.freeFormComments}, Canvas stored `
      + `${!!stored?.free_form_criterion_comments}`
    );
  }

  const storedCriteria = criteriaOf(stored);
  if (storedCriteria.length !== requested.criteria.length) {
    problems.push(
      `criteria: sent ${requested.criteria.length}, Canvas stored ${storedCriteria.length}`
    );
  }

  requested.criteria.forEach((criterion, index) => {
    const got = storedCriteria[index];
    if (!got) {
      problems.push(`criterion ${index + 1} ("${criterion.description}") is missing from the stored rubric`);
      return;
    }
    if (got.description !== criterion.description) {
      problems.push(
        `criterion ${index + 1}: sent "${criterion.description}", Canvas stored "${got.description}" `
        + `(criteria may have been reordered)`
      );
    }
    const wantPoints = derivedPoints(criterion);
    if (Number(got.points ?? 0) !== wantPoints) {
      problems.push(
        `criterion ${index + 1} ("${criterion.description}"): expected ${wantPoints} points, Canvas stored `
        + `${points(got.points)}`
      );
    }
    const gotRatings = Array.isArray(got.ratings) ? got.ratings : [];
    if (gotRatings.length !== criterion.ratings.length) {
      problems.push(
        `criterion ${index + 1} ("${criterion.description}"): sent ${criterion.ratings.length} rating(s), `
        + `Canvas stored ${gotRatings.length}`
      );
    }
    // Canvas re-sorts ratings by points descending, so compare as sets of
    // points rather than positionally — a reorder is expected, a missing or
    // altered value is not.
    const wantSet = [...criterion.ratings.map(r => Number(r.points))].sort((a, b) => b - a);
    const gotSet = [...gotRatings.map((r: any) => Number(r.points ?? 0))].sort((a, b) => b - a);
    if (JSON.stringify(wantSet) !== JSON.stringify(gotSet)) {
      problems.push(
        `criterion ${index + 1} ("${criterion.description}"): sent rating points [${wantSet.join(', ')}], `
        + `Canvas stored [${gotSet.join(', ')}]`
      );
    }
  });

  const want = expectedTotal(requested.criteria);
  if (storedCriteria.length === requested.criteria.length && Number(stored?.points_possible ?? 0) !== want) {
    problems.push(
      `points possible: the criteria sum to ${want}, Canvas stored ${points(stored?.points_possible)}`
    );
  }

  return problems.length > 0
    ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
    : '';
}

/** Render a rubric for a teacher, including the IDs grade-submission needs. */
function formatRubric(rubric: any): string {
  const criteria = criteriaOf(rubric);
  const header = [
    `Rubric: ${rubric?.title ?? '(untitled)'}`,
    `ID: ${rubric?.id}`,
    `Points possible: ${points(rubric?.points_possible)}`,
    `Free-form comments: ${rubric?.free_form_criterion_comments ? 'on (graders type their own comment per criterion)' : 'off (graders pick a rating)'}`,
  ].join('\n');

  if (criteria.length === 0) {
    return `${header}\n\nThis rubric has no criteria.`;
  }

  const body = criteria.map((criterion: any, index: number) => {
    const ratings = (Array.isArray(criterion.ratings) ? criterion.ratings : [])
      .map((rating: any) =>
        `    ${points(rating.points)} pts — ${rating.description ?? ''}`
        + `${rating.long_description ? `: ${rating.long_description}` : ''}`
        + ` [rating id ${rating.id}]`
      )
      .join('\n');
    return `\n${index + 1}. ${criterion.description ?? ''} — ${points(criterion.points)} points`
      + ` [criterion id ${criterion.id}]`
      + `${criterion.long_description ? `\n    ${criterion.long_description}` : ''}`
      + `${criterion.criterion_use_range ? `\n    (graders may pick any score in the range between ratings)` : ''}`
      + `${ratings ? `\n${ratings}` : '\n    (no ratings — Canvas scores this criterion 0)'}`;
  }).join('\n');

  const ids = criteria.map((criterion: any) => `"${criterion.id}"`).join(', ');
  return `${header}\n${body}\n\n`
    + `To grade against this rubric, pass grade-submission a rubric_assessment keyed by CRITERION ID, not by `
    + `name — for this rubric that is ${ids}. Each entry takes { "points": n, "comments": "..." }, e.g. `
    + `{ "${criteria[0]?.id}": { "points": ${points(criteria[0]?.points)}, "comments": "..." } }.`;
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
    "Read one rubric in full — every criterion, every rating, and the points attached to each. This is the tool "
    + "to use before grading against a rubric, because it returns the criterion IDs that grade-submission's "
    + "rubric_assessment has to be keyed by; list-rubrics gives you only titles and IDs. Use it to check what a "
    + "rubric actually says before applying it to a class set of essays.",
    {
      courseId: z.string().describe("The ID of the course"),
      rubricId: z.string().describe("The rubric's ID (from list-rubrics)")
    },
    { readOnlyHint: true },
    async ({ courseId, rubricId }: { courseId: string; rubricId: string }) => {
      try {
        const rubric: any = await canvas.getRubric(courseId, rubricId);
        return { content: [{ type: "text", text: formatRubric(rubric) }] };
      } catch (error: any) {
        const message = String(error?.message ?? 'Unknown error');
        // Canvas resolves this endpoint through a *bookmarked* rubric
        // association in the course, not through the rubric row, so a rubric
        // can exist and still 404 here. Saying "not found" alone would send a
        // teacher hunting for a rubric that is sitting right there.
        if (/\b404\b/.test(message)) {
          throw new Error(
            `Rubric ${rubricId} could not be read in course ${courseId}. Canvas looks this up through the rubric's `
            + `association with the course, so this means either the ID is wrong, or the rubric exists but is not `
            + `linked to this course (it may belong to another course or to the account). Check list-rubrics for `
            + `IDs that are readable here. Canvas said: ${message}`
          );
        }
        throw new Error(`Failed to fetch rubric: ${message}`);
      }
    }
  );

  // Tool: create-rubric
  server.tool(
    "create-rubric",
    "Write a new rubric — criteria, performance levels and points — either as a reusable course rubric or "
    + "attached to one assignment for grading. This is the tool for \"draft me a rubric for this DBQ\". To put an "
    + "EXISTING rubric on another assignment use attach-rubric-to-assignment instead; to change a rubric you "
    + "already made use update-rubric. Canvas works out each criterion's points from its highest rating and the "
    + "rubric's total from the criteria, so those are not yours to set.",
    {
      courseId: z.string().describe("The ID of the course the rubric belongs to"),
      title: z.string().min(1).describe("The rubric's name, e.g. \"DBQ Essay Rubric\""),
      criteria: criteriaParam(
        "The rows of the rubric, in the order they should appear. Each is { description, ratings: [{ description, "
        + "points }] } with optional longDescription and criterionUseRange. Canvas sets each criterion's points to "
        + "its highest rating and the rubric's total to the sum of the criteria."
      ),
      assignmentId: z.string().optional().describe(
        "Attach the rubric to this assignment for grading. Omit to create a reusable course-level rubric that is "
        + "not tied to any assignment yet."
      ),
      useForGrading: z.boolean().optional().describe(
        "Let rubric scores drive the assignment's grade, rather than the rubric being a scoring guide alongside a "
        + "separately-entered grade. Requires assignmentId. WARNING: Canvas also rewrites the assignment's total "
        + "points to match the rubric's when this is on."
      ),
      keepAssignmentPoints: z.boolean().optional().describe(
        "Stop Canvas from rewriting the assignment's points_possible to match the rubric total. Only meaningful "
        + "with useForGrading, which is the only case where Canvas rewrites it."
      ),
      freeFormComments: z.boolean().optional().describe(
        "Let graders type their own comment on each criterion instead of only picking one of its ratings"
      )
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const criteria: CriterionInput[] = args.criteria;

        // Canvas derives criterion points from the ratings and would quietly
        // replace a number that disagrees. Refusing beats reporting the
        // caller's number back as if it had been stored.
        const disagreements = criteria
          .map((criterion, index) => ({ criterion, index, derived: derivedPoints(criterion) }))
          .filter(({ criterion, derived }) => criterion.points !== undefined && Number(criterion.points) !== derived);
        if (disagreements.length > 0) {
          const detail = disagreements
            .map(({ criterion, index, derived }) =>
              `criterion ${index + 1} ("${criterion.description}") says ${criterion.points} but its highest rating is ${derived}`)
            .join('; ');
          throw new Error(
            `A criterion's points must equal its highest rating's points — Canvas overwrites the field with that `
            + `value, so any other number is silently discarded. ${detail}. Fix the ratings, or drop the points `
            + `field and let it be derived.`
          );
        }

        if (args.useForGrading && !args.assignmentId) {
          throw new Error(
            'useForGrading only means something for a rubric attached to an assignment, since there is no grade '
            + 'for a course-level rubric to drive. Pass assignmentId, or drop useForGrading.'
          );
        }
        if (args.keepAssignmentPoints && !args.useForGrading) {
          throw new Error(
            'keepAssignmentPoints only means something with useForGrading — Canvas only rewrites an assignment\'s '
            + 'points_possible when the rubric is driving the grade. Drop it, or turn on useForGrading.'
          );
        }

        // The association is what decides whether this rubric exists anywhere a
        // teacher can see it. Without one Canvas saves the rubric and attaches
        // it to nothing, and the result is invisible in the UI and unreadable
        // through get-rubric, so one is always sent.
        const association: any = args.assignmentId
          ? { association_id: args.assignmentId, association_type: 'Assignment', purpose: 'grading' }
          : { association_id: args.courseId, association_type: 'Course', purpose: 'bookmark' };
        if (args.useForGrading !== undefined) association.use_for_grading = canvasBool(args.useForGrading);

        const payload: any = {
          rubric: {
            title: args.title,
            criteria: toCanvasCriteria(criteria),
          },
          rubric_association: association,
        };
        if (args.freeFormComments !== undefined) {
          payload.rubric.free_form_criterion_comments = canvasBool(args.freeFormComments);
        }
        if (args.keepAssignmentPoints) {
          // Top level, not under rubric[], and the string "true". The Canvas
          // docs place this at rubric[skip_updating_points_possible], but the
          // controller reads params[:skip_updating_points_possible] and matches
          // it against /true/i, so the documented spelling is inert. Sent the
          // way the implementation reads it. Unverified against live Canvas.
          payload.skip_updating_points_possible = 'true';
        }

        const response: any = await canvas.createRubric(args.courseId, payload);
        assertNotSilentFailure(response, 'create this rubric');

        // The write response is not a readback: it is a non-standard
        // { rubric, rubric_association } envelope from a controller that also
        // rewrites points behind your back. Re-GET the rubric instead.
        const created = response?.rubric ?? response;
        const rubricId = created?.id;
        if (!rubricId) {
          throw new Error(
            `Canvas answered 200 but returned no rubric ID, so nothing can be confirmed. Canvas said: `
            + `${JSON.stringify(response).slice(0, 600)}`
          );
        }

        let stored: any = null;
        let readbackNote = '';
        try {
          stored = await canvas.getRubric(args.courseId, String(rubricId));
        } catch (error: any) {
          // This is the invisible-rubric case, and it is worth shouting about:
          // Canvas only finds a rubric here through a bookmarked association,
          // so a rubric that cannot be read back is one that will not show up
          // in the course's rubric list either.
          readbackNote = `\n\nWARNING — the rubric was created (ID ${rubricId}) but could not be read back from `
            + `course ${args.courseId}. Canvas resolves a rubric through its course association, so this usually `
            + `means the association did not take and the rubric may not appear in the Canvas UI. Check the `
            + `course's Rubrics page before relying on it. Canvas said: ${error?.message ?? 'unknown error'}`;
        }

        const where = args.assignmentId
          ? `attached to assignment ${args.assignmentId} for grading`
          : `as a course-level rubric (not attached to an assignment — use attach-rubric-to-assignment for that)`;

        const gradingNote = args.useForGrading
          ? (args.keepAssignmentPoints
            ? `\n\nRubric scores will drive the grade. Canvas was asked NOT to change the assignment's own points `
              + `total; confirm it on the assignment, since this is the one option Canvas documents in a place it `
              + `does not read.`
            : `\n\nRubric scores will drive the grade, and Canvas rewrites the assignment's points total to match `
              + `the rubric (${points(expectedTotal(criteria))}). If the assignment was worth something else, it is `
              + `not any more — pass keepAssignmentPoints to prevent that.`)
          : '';

        const associationNote = response?.rubric_association
          ? ''
          : `\n\nWARNING — Canvas's response contained no rubric_association. A rubric with no association is not `
            + `linked to the course or the assignment and will not appear in the Canvas UI.`;

        return {
          content: [{
            type: "text",
            text: `Created rubric "${created?.title ?? args.title}" (ID ${rubricId}) in course ${args.courseId}, `
              + `${where}.\n\n${stored ? formatRubric(stored) : '(could not be read back)'}`
              + gradingNote
              + associationNote
              + readbackNote
              + (stored ? verifyRubric({ title: args.title, criteria, freeFormComments: args.freeFormComments }, stored) : '')
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create rubric: ${error?.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-rubric
  server.tool(
    "update-rubric",
    "Change an existing rubric's title, criteria or comment style. Criteria are REPLACED wholesale, not merged: "
    + "pass the complete list you want the rubric to end up with, which is most easily got by reading it with "
    + "get-rubric first and editing from there. Anything you leave out is re-sent unchanged rather than wiped. "
    + "Note that editing a rubric that has already been used to grade can detach existing scores from the criteria "
    + "they belong to, so prefer create-rubric for a new version once marking has started.",
    {
      courseId: z.string().describe("The ID of the course"),
      rubricId: z.string().describe("The rubric's ID"),
      title: z.string().min(1).optional().describe("New name. Omit to keep the current one."),
      criteria: criteriaParam(
        "The complete new list of criteria, replacing every existing one. Keep each criterion's existing `id` "
        + "(from get-rubric) on the rows you are keeping, or Canvas issues new IDs and any grading already done "
        + "against those criteria stops lining up. Omit this parameter entirely to leave the criteria alone."
      ).optional(),
      freeFormComments: z.boolean().optional().describe(
        "Let graders type their own comment on each criterion. Omit to keep the current setting."
      )
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        // Canvas's update is a full replace: it rebuilds the rubric from what
        // this request contains and nothing else. An omitted title renames the
        // rubric to "<Course> Rubric"; omitted criteria delete every criterion
        // and set the rubric to 0 points. So read first and resend whatever is
        // not being changed. Refusing to write blind is the point of the GET —
        // a failure here means we cannot tell what a partial update would
        // destroy.
        let current: any;
        try {
          current = await canvas.getRubric(args.courseId, args.rubricId);
        } catch (error: any) {
          throw new Error(
            `Could not read rubric ${args.rubricId} in course ${args.courseId} before updating it, so this update `
            + `was not attempted. Canvas's rubric update replaces the whole rubric — writing without knowing what `
            + `is there would delete any criterion this call does not mention. Canvas said: `
            + `${error?.message ?? 'unknown error'}`
          );
        }

        const criteria: CriterionInput[] = args.criteria ?? storedAsInput(current);
        const title: string = args.title ?? current?.title;
        if (!title) {
          throw new Error(
            `Rubric ${args.rubricId} has no title in Canvas and none was given. Canvas would rename it to a `
            + `default; pass title explicitly.`
          );
        }

        const disagreements = criteria
          .map((criterion, index) => ({ criterion, index, derived: derivedPoints(criterion) }))
          .filter(({ criterion, derived }) => criterion.points !== undefined && Number(criterion.points) !== derived);
        if (disagreements.length > 0) {
          const detail = disagreements
            .map(({ criterion, index, derived }) =>
              `criterion ${index + 1} ("${criterion.description}") says ${criterion.points} but its highest rating is ${derived}`)
            .join('; ');
          throw new Error(
            `A criterion's points must equal its highest rating's points — Canvas overwrites the field with that `
            + `value, so any other number is silently discarded. ${detail}.`
          );
        }

        const freeForm: boolean | undefined = args.freeFormComments
          ?? (typeof current?.free_form_criterion_comments === 'boolean'
            ? current.free_form_criterion_comments
            : undefined);

        const payload: any = {
          id: args.rubricId,
          rubric: {
            title,
            criteria: toCanvasCriteria(criteria),
          },
        };
        if (freeForm !== undefined) payload.rubric.free_form_criterion_comments = canvasBool(freeForm);
        // Canvas assigns hide_score_total unconditionally from this request, so
        // an omitted value clears it. Resent when Canvas gave us one to resend.
        if (typeof current?.hide_score_total === 'boolean') {
          payload.rubric.hide_score_total = canvasBool(current.hide_score_total);
        }

        const response: any = await canvas.updateRubric(args.courseId, args.rubricId, payload);
        assertNotSilentFailure(response, 'update this rubric');

        const returned = response?.rubric ?? response;
        // Canvas's own comment on this controller: updating a rubric that is
        // used in more than one place CLONES it and returns the copy, leaving
        // the original — and everything pointing at it — untouched. A teacher
        // who is told "updated" in that case has been misled.
        const clonedTo = returned?.id !== undefined && String(returned.id) !== String(args.rubricId)
          ? `\n\nWARNING — Canvas did not edit rubric ${args.rubricId}. It created a COPY (ID ${returned.id}) and `
            + `applied the changes there, which is what it does when a rubric is in use in more than one place. `
            + `The original is unchanged, and any assignment using it is still using the old version. Attach the `
            + `new rubric where you want it with attach-rubric-to-assignment.`
          : '';

        const readId = String(returned?.id ?? args.rubricId);
        let stored: any = null;
        let readbackNote = '';
        try {
          stored = await canvas.getRubric(args.courseId, readId);
        } catch (error: any) {
          readbackNote = `\n\nWARNING — the update returned 200 but rubric ${readId} could not be read back, so `
            + `what Canvas actually stored is unconfirmed. Canvas said: ${error?.message ?? 'unknown error'}`;
        }

        const preserved: string[] = [];
        if (args.criteria === undefined) preserved.push('criteria');
        if (args.title === undefined) preserved.push('title');
        const preservedNote = preserved.length > 0
          ? `\n\nCanvas's rubric update replaces the whole rubric, so the existing ${preserved.join(' and ')} `
            + `${preserved.length > 1 ? 'were' : 'was'} read back and re-sent unchanged rather than being wiped.`
          : '';

        return {
          content: [{
            type: "text",
            text: `Updated rubric ${readId} in course ${args.courseId}.\n\n`
              + `${stored ? formatRubric(stored) : '(could not be read back)'}`
              + preservedNote
              + clonedTo
              + readbackNote
              + (stored ? verifyRubric({ title, criteria, freeFormComments: freeForm }, stored) : '')
              + `\n\nNote: Canvas clears a rubric's "hide points" display setting on every update and does not `
              + `return it through the API, so it cannot be preserved here. Re-check it in the UI if you use it.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update rubric: ${error?.message ?? 'Unknown error'}`);
      }
    }
  );
}