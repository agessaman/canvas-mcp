import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { Outcome, OutcomeGroup, OutcomeLink } from "../types.js";

const ratingSchema = z.object({
  description: z.string().describe("Rating label, e.g. 'Exceeds Mastery'"),
  points: z.number().describe("Points for this rating")
});

const calculationMethods = ["decaying_average", "standard_decaying_average", "n_mastery", "latest", "highest", "average"] as const;

const outcomeFields = {
  title: z.string().describe("Outcome title, e.g. the standard's name"),
  displayName: z.string().optional().describe("Optional friendly name shown to students"),
  description: z.string().optional().describe("Full text of the standard (HTML allowed)"),
  vendorGuid: z.string().optional().describe("External identifier, e.g. a standard code such as 'CCSS.MATH.6.RP.A.1'"),
  masteryPoints: z.number().optional().describe("Score at or above which a student has mastered the outcome. Not settable when the account uses account-level mastery scales"),
  ratings: z.array(ratingSchema).optional().describe("Mastery scale, highest first. Not settable when the account uses account-level mastery scales"),
  calculationMethod: z.enum(calculationMethods).optional().describe("How results combine into a mastery score. Not settable when the account uses account-level mastery scales"),
  calculationInt: z.number().int().optional().describe("Parameter for the calculation method: weight 1-99 for decaying_average / standard_decaying_average, attempt count for n_mastery. Not settable when the account uses account-level mastery scales")
};

type OutcomeFieldArgs = {
  title?: string;
  displayName?: string;
  description?: string;
  vendorGuid?: string;
  masteryPoints?: number;
  ratings?: { description: string; points: number }[];
  calculationMethod?: string;
  calculationInt?: number;
};

const scaleFields = ['masteryPoints', 'ratings', 'calculationMethod', 'calculationInt'] as const;

function requestedScaleFields(args: OutcomeFieldArgs): string[] {
  return scaleFields.filter(f => args[f] !== undefined);
}

// GET /outcomes/:id omits the rating scale, mastery points, and calculation;
// Canvas only resolves them (including any account-level mastery scale) in a
// course-scoped listing. Falls back to the bare outcome if it isn't in the course.
export async function getCourseOutcome(canvas: CanvasClient, courseId: string, outcomeId: string): Promise<Outcome | undefined> {
  const links = await canvas.listOutcomeGroupLinks(courseId) as OutcomeLink[];
  return links.find(l => String(l.outcome.id) === String(outcomeId))?.outcome;
}

function toOutcomePayload(args: OutcomeFieldArgs): Record<string, any> {
  const payload: Record<string, any> = {
    title: args.title,
    display_name: args.displayName,
    description: args.description,
    vendor_guid: args.vendorGuid,
    mastery_points: args.masteryPoints,
    ratings: args.ratings,
    calculation_method: args.calculationMethod,
    calculation_int: args.calculationInt,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
}

function formatOutcome(o: Outcome): string {
  const parts = [
    `Outcome: ${o.title}`,
    `ID: ${o.id}`,
  ];
  if (o.display_name) parts.push(`Display Name: ${o.display_name}`);
  if (o.vendor_guid) parts.push(`Code: ${o.vendor_guid}`);
  if (o.context_type) parts.push(`Owner: ${o.context_type} ${o.context_id}`);
  if (o.mastery_points !== undefined) parts.push(`Mastery: ${o.mastery_points} of ${o.points_possible ?? '?'} points`);
  if (o.calculation_method) {
    parts.push(`Calculation: ${o.calculation_method}${o.calculation_int != null ? ` (${o.calculation_int})` : ''}`);
  }
  if (o.ratings?.length) {
    parts.push('Ratings:');
    o.ratings.forEach(r => parts.push(`  ${r.points}: ${r.description}`));
  }
  if (o.proficiency_context_type) {
    parts.push(`Mastery scale and calculation: set by ${o.proficiency_context_type} ${o.proficiency_context_id} (can't be changed per outcome)`);
  }
  if (o.can_edit !== undefined) parts.push(`Editable here: ${o.can_edit ? 'yes' : 'no'}`);
  if (o.assessed !== undefined) parts.push(`Assessed: ${o.assessed ? 'yes' : 'no'}`);
  if (o.description) parts.push(`Description: ${o.description}`);
  return parts.join('\n');
}

async function resolveGroupId(canvas: CanvasClient, courseId: string, groupId?: string): Promise<string> {
  if (groupId) return groupId;
  const root = await canvas.getRootOutcomeGroup(courseId) as OutcomeGroup;
  return String(root.id);
}

export function registerOutcomeTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-outcomes
  server.tool(
    "list-outcomes",
    "List all learning outcomes (standards) in a course, organised by outcome group. Shows the group IDs needed to create or unlink outcomes and the outcome IDs needed to align them to rubric criteria.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const [groups, links] = await Promise.all([
          canvas.listOutcomeGroups(courseId) as Promise<OutcomeGroup[]>,
          canvas.listOutcomeGroupLinks(courseId) as Promise<OutcomeLink[]>,
        ]);
        const byGroup = new Map<number, OutcomeLink[]>();
        for (const link of links) {
          const id = link.outcome_group.id;
          if (!byGroup.has(id)) byGroup.set(id, []);
          byGroup.get(id)!.push(link);
        }
        const sections = groups.map(group => {
          const header = `Group: ${group.title} (ID: ${group.id})${group.parent_outcome_group ? ` — inside "${group.parent_outcome_group.title}"` : ' — root'}`;
          const outcomes = (byGroup.get(group.id) || []).map(({ outcome: o }) => {
            const extras = [
              o.vendor_guid,
              o.mastery_points !== undefined ? `mastery ${o.mastery_points}/${o.points_possible ?? '?'}` : undefined,
              o.context_type && o.context_type !== 'Course' ? `${o.context_type.toLowerCase()}-level` : undefined,
              o.can_edit === false ? 'read-only' : undefined,
            ].filter(Boolean);
            return `  - [${o.id}] ${o.title}${extras.length ? ` (${extras.join(', ')})` : ''}`;
          });
          return [header, ...(outcomes.length ? outcomes : ['  (no outcomes)'])].join('\n');
        });
        return {
          content: [{
            type: "text",
            text: groups.length
              ? `${sections.join('\n\n')}\n\nTotal outcomes: ${links.length}`
              : "No outcome groups found for this course.",
          }]
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch outcomes: ${error.message}`);
        }
        throw new Error('Failed to fetch outcomes: Unknown error');
      }
    }
  );

  // Tool: get-outcome
  server.tool(
    "get-outcome",
    "Get full details for a learning outcome: description, mastery points, rating scale, and calculation method as they apply in a course.",
    {
      courseId: z.string().describe("The ID of the course (Canvas only reports the rating scale in a course's context)"),
      outcomeId: z.string().describe("The ID of the outcome")
    },
    { readOnlyHint: true },
    async ({ courseId, outcomeId }: { courseId: string; outcomeId: string }) => {
      try {
        const outcome = await getCourseOutcome(canvas, courseId, outcomeId) ?? await canvas.getOutcome(outcomeId) as Outcome;
        return { content: [{ type: "text", text: formatOutcome(outcome) }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch outcome: ${error.message}`);
        }
        throw new Error('Failed to fetch outcome: Unknown error');
      }
    }
  );

  // Tool: create-outcome
  server.tool(
    "create-outcome",
    "Create a new learning outcome (standard) in a course's outcome group.",
    {
      courseId: z.string().describe("The ID of the course"),
      groupId: z.string().optional().describe("Outcome group to create it in (from list-outcomes). Defaults to the course's root group"),
      ...outcomeFields
    },
    { destructiveHint: false },
    async ({ courseId, groupId, ...fields }: { courseId: string; groupId?: string } & OutcomeFieldArgs) => {
      try {
        const targetGroup = await resolveGroupId(canvas, courseId, groupId);
        const link = await canvas.createOutcome(courseId, targetGroup, toOutcomePayload(fields)) as OutcomeLink;
        let text = `Created outcome ${link.outcome.id} "${link.outcome.title}" in group ${link.outcome_group?.id ?? targetGroup}.`;
        // Canvas accepts but silently ignores scale fields under an account-level mastery scale
        const requested = requestedScaleFields(fields);
        if (requested.length > 0) {
          const saved = await getCourseOutcome(canvas, courseId, String(link.outcome.id));
          if (saved?.proficiency_context_type) {
            text += `\n\nNote: ${requested.join(', ')} were ignored because this ${saved.proficiency_context_type.toLowerCase()} uses its own mastery scale.\n\n${formatOutcome(saved)}`;
          }
        }
        return { content: [{ type: "text", text }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to create outcome: ${error.message}`);
        }
        throw new Error('Failed to create outcome: Unknown error');
      }
    }
  );

  // Tool: update-outcome
  server.tool(
    "update-outcome",
    "Update a learning outcome. Only the fields provided are changed. Account-level outcomes can't be edited from a course, and Canvas may refuse scale changes once students have been assessed.",
    {
      courseId: z.string().describe("The ID of the course the outcome is used in"),
      outcomeId: z.string().describe("The ID of the outcome"),
      ...outcomeFields,
      title: outcomeFields.title.optional()
    },
    { idempotentHint: true },
    async ({ courseId, outcomeId, ...fields }: { courseId: string; outcomeId: string } & OutcomeFieldArgs) => {
      try {
        const payload = toOutcomePayload(fields);
        if (Object.keys(payload).length === 0) {
          throw new Error('No fields to update were provided');
        }
        // Canvas answers scale changes with a bare 403 under an account-level
        // mastery scale, so check first and explain instead.
        const requested = requestedScaleFields(fields);
        if (requested.length > 0) {
          const current = await getCourseOutcome(canvas, courseId, outcomeId);
          if (current?.proficiency_context_type) {
            throw new Error(`${requested.join(', ')} can't be changed: the mastery scale and calculation are set by ${current.proficiency_context_type} ${current.proficiency_context_id}. Title, display name, description, and code can still be updated.`);
          }
        }
        const updated = await canvas.updateOutcome(courseId, outcomeId, payload) as Outcome;
        // The update response omits the scale; show the outcome as the course sees it
        const outcome = await getCourseOutcome(canvas, courseId, outcomeId) ?? updated;
        return { content: [{ type: "text", text: `Outcome updated.\n\n${formatOutcome(outcome)}` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to update outcome: ${error.message}`);
        }
        throw new Error('Failed to update outcome: Unknown error');
      }
    }
  );

  // Tool: create-outcome-group
  server.tool(
    "create-outcome-group",
    "Create an outcome group (folder) for organising outcomes in a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      parentGroupId: z.string().optional().describe("Group to nest it inside. Defaults to the course's root group"),
      title: z.string().describe("Group title, e.g. 'Ratios & Proportional Relationships'"),
      description: z.string().optional().describe("Optional description"),
      vendorGuid: z.string().optional().describe("Optional external identifier")
    },
    { destructiveHint: false },
    async ({ courseId, parentGroupId, title, description, vendorGuid }: { courseId: string; parentGroupId?: string; title: string; description?: string; vendorGuid?: string }) => {
      try {
        const parent = await resolveGroupId(canvas, courseId, parentGroupId);
        const group = await canvas.createOutcomeGroup(courseId, parent, {
          title,
          ...(description !== undefined ? { description } : {}),
          ...(vendorGuid !== undefined ? { vendor_guid: vendorGuid } : {}),
        }) as OutcomeGroup;
        return { content: [{ type: "text", text: `Created outcome group ${group.id} "${group.title}" inside group ${parent}.` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to create outcome group: ${error.message}`);
        }
        throw new Error('Failed to create outcome group: Unknown error');
      }
    }
  );

  // Tool: link-outcome
  server.tool(
    "link-outcome",
    "Add an existing outcome (e.g. an account- or state-level standard) to a course's outcome group so it can be used in that course's rubrics.",
    {
      courseId: z.string().describe("The ID of the course"),
      outcomeId: z.string().describe("The ID of the existing outcome"),
      groupId: z.string().optional().describe("Course outcome group to link it into. Defaults to the course's root group")
    },
    { idempotentHint: true },
    async ({ courseId, outcomeId, groupId }: { courseId: string; outcomeId: string; groupId?: string }) => {
      try {
        const targetGroup = await resolveGroupId(canvas, courseId, groupId);
        const link = await canvas.linkOutcome(courseId, targetGroup, outcomeId) as OutcomeLink;
        return { content: [{ type: "text", text: `Linked outcome ${link.outcome.id} "${link.outcome.title}" into group ${targetGroup}.` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to link outcome: ${error.message}`);
        }
        throw new Error('Failed to link outcome: Unknown error');
      }
    }
  );

  // Tool: unlink-outcome
  server.tool(
    "unlink-outcome",
    "Remove an outcome from a course outcome group. If this was the outcome's last link anywhere in Canvas, the outcome itself is deleted; Canvas refuses that case when the outcome is aligned to content.",
    {
      courseId: z.string().describe("The ID of the course"),
      groupId: z.string().describe("The outcome group the outcome is linked in (from list-outcomes)"),
      outcomeId: z.string().describe("The ID of the outcome")
    },
    { destructiveHint: true },
    async ({ courseId, groupId, outcomeId }: { courseId: string; groupId: string; outcomeId: string }) => {
      try {
        await canvas.unlinkOutcome(courseId, groupId, outcomeId);
        return { content: [{ type: "text", text: `Unlinked outcome ${outcomeId} from group ${groupId}.` }] };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to unlink outcome: ${error.message}`);
        }
        throw new Error('Failed to unlink outcome: Unknown error');
      }
    }
  );
}
