import { z } from "zod";
import { jsonObjectParam } from "../jsonObjectParam.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

/**
 * Canvas is asymmetric about grading rules: `GET` returns them as an object,
 * `PUT` documents the parameter as a **string** of newline-separated
 * `key:value` pairs, with `never_drop` repeated once per assignment. Callers
 * get to pass the object shape they can read back, and it is serialised here.
 *
 * The encoding is inferred from the spec's type rather than from a UI
 * exemplar, so it is treated as unproven: the tool re-reads the group and
 * reports what Canvas actually stored. If the format is wrong the caller is
 * told, rather than getting a cheerful 200 over a rule that was dropped —
 * which is exactly how create-assignment-group hid a bug for months.
 */
function serialiseRules(rules: Record<string, any>): string {
  const lines: string[] = [];
  for (const key of ['drop_lowest', 'drop_highest'] as const) {
    if (rules[key] === undefined) continue;
    const value = Number(rules[key]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`rules.${key} must be a whole number of assignments (got ${JSON.stringify(rules[key])})`);
    }
    lines.push(`${key}:${value}`);
  }
  if (rules.never_drop !== undefined) {
    const ids = Array.isArray(rules.never_drop) ? rules.never_drop : [rules.never_drop];
    for (const id of ids) lines.push(`never_drop:${id}`);
  }

  const known = new Set(['drop_lowest', 'drop_highest', 'never_drop']);
  const unknown = Object.keys(rules).filter(k => !known.has(k));
  if (unknown.length) {
    throw new Error(
      `rules only supports drop_lowest, drop_highest and never_drop (got ${unknown.join(', ')}). `
      + 'Canvas would ignore anything else without saying so.'
    );
  }
  return lines.join('\n');
}

// Compare what was asked for against what Canvas stored. A 200 is not
// evidence — trusting one is how create-assignment-group shipped ignoring
// every field it was given.
function describeDrift(sent: Record<string, any>, stored: any): string[] {
  const problems: string[] = [];
  if (sent.name !== undefined && stored.name !== sent.name) {
    problems.push(`asked for name "${sent.name}", Canvas stored "${stored.name}"`);
  }
  if (sent.group_weight !== undefined && Number(stored.group_weight ?? 0) !== Number(sent.group_weight)) {
    problems.push(`asked for weight ${sent.group_weight}, Canvas stored ${stored.group_weight ?? 0}`);
  }
  if (sent.position !== undefined && stored.position !== undefined && Number(stored.position) !== Number(sent.position)) {
    problems.push(`asked for position ${sent.position}, Canvas stored ${stored.position}`);
  }
  return problems;
}

export function registerAssignmentGroupTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-assignment-groups
  server.tool(
    "list-assignment-groups",
    "List all assignment groups (buckets) in a course.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const groups = await canvas.listAssignmentGroups(courseId) as any[];
        const summary = groups.map((g: any) => ({
          id: g.id,
          name: g.name,
          position: g.position,
          group_weight: g.group_weight,
          rules: g.rules ?? null,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch assignment groups: ${error.message}`);
        }
        throw new Error('Failed to fetch assignment groups: Unknown error');
      }
    }
  );

  // Tool: create-assignment-group
  server.tool(
    "create-assignment-group",
    "Create a new assignment group (bucket) in a course, e.g. \"Homework\" weighted 20%. All fields optional except courseId.",
    {
      courseId: z.string().describe("The ID of the course"),
      name: z.string().optional().describe("The group's name, e.g. \"Homework\". Canvas names it \"Assignments\" if omitted."),
      position: z.number().optional(),
      group_weight: z.number().optional().describe("This group's percentage of the final grade. Only has an effect when the course is set to weight its assignment groups."),
      sis_source_id: z.string().optional(),
      integration_data: jsonObjectParam("Arbitrary integration key/value data").optional()
    },
    { destructiveHint: false },
    async (args: any) => {
      const { courseId, ...fields } = args;
      try {
        // These parameters are FLAT, not wrapped in assignment_group[...] the
        // way assignments and quizzes are. Sending the wrapper meant Canvas saw
        // no fields at all: it silently ignored every one, returned 200, and
        // created a default group called "Assignments" with weight 0. Reported
        // by Adam and reproduced live 2026-08-05 (group 25049). The instance
        // spec lists these as bare `name`, `position`, `group_weight`.
        const g = await canvas.createAssignmentGroup(courseId, fields) as any;

        // Same bug would be invisible again if the spelling ever drifts, so
        // check what Canvas actually stored rather than trusting the 200.
        const problems = describeDrift(fields, g);
        const warning = problems.length
          ? `\n\nWARNING: Canvas did not apply everything it was sent — ${problems.join('; ')}.`
          : '';

        return {
          content: [{ type: "text", text: `Assignment group created: id=${g.id}, name="${g.name}", position=${g.position}, weight=${g.group_weight}${warning}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to create assignment group: ${error.message}`);
        }
        throw new Error('Failed to create assignment group: Unknown error');
      }
    }
  );

  // Tool: update-assignment-group
  server.tool(
    "update-assignment-group",
    "Rename an assignment group, change its weight or position, or set its grading rules (drop the lowest N scores, "
    + "and so on). Rules can ONLY be set here — Canvas's create endpoint accepts no rules at all. Only the fields "
    + "you pass are changed.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentGroupId: z.string().describe("The group's ID, from list-assignment-groups"),
      name: z.string().optional().describe("New name for the group"),
      position: z.number().optional(),
      group_weight: z.number().optional().describe("This group's percentage of the final grade. Only has an effect when the course is set to weight its assignment groups."),
      sis_source_id: z.string().optional(),
      integration_data: jsonObjectParam("Arbitrary integration key/value data").optional(),
      rules: jsonObjectParam(
        "Grading rules as an object: {\"drop_lowest\": 1}, {\"drop_highest\": 1}, and/or "
        + "{\"never_drop\": [assignmentId, ...]} to exempt specific assignments from dropping. "
        + "Pass {} to clear all rules. Note drop rules apply to this group only."
      ).optional()
    },
    { idempotentHint: true },
    async (args: any) => {
      const { courseId, assignmentGroupId, rules, ...fields } = args;
      try {
        if (Object.keys(fields).length === 0 && rules === undefined) {
          throw new Error('Nothing to update — pass at least one of name, position, group_weight, sis_source_id, integration_data or rules.');
        }

        const payload: any = { ...fields };
        // An empty object is a deliberate "clear the rules", which is an empty
        // string to Canvas — distinct from omitting the parameter, which
        // leaves existing rules alone.
        if (rules !== undefined) payload.rules = serialiseRules(rules);

        const g = await canvas.updateAssignmentGroup(courseId, assignmentGroupId, payload) as any;

        const problems = describeDrift(fields, g);

        // The rules encoding is inferred from the spec, not from an exemplar,
        // so it gets checked rather than assumed. Canvas hands rules back as
        // an object even though it takes them as a string.
        if (rules !== undefined) {
          const stored = g.rules ?? {};
          for (const key of ['drop_lowest', 'drop_highest'] as const) {
            const want = rules[key];
            if (want !== undefined && Number(stored[key] ?? 0) !== Number(want)) {
              problems.push(`asked for ${key} ${want}, Canvas stored ${stored[key] ?? 'nothing'}`);
            }
          }
          if (rules.never_drop !== undefined) {
            const want = (Array.isArray(rules.never_drop) ? rules.never_drop : [rules.never_drop]).map(String).sort();
            const got = (stored.never_drop ?? []).map(String).sort();
            if (want.join(',') !== got.join(',')) {
              problems.push(`asked to never drop [${want.join(', ')}], Canvas stored [${got.join(', ')}]`);
            }
          }
          if (Object.keys(rules).length === 0 && Object.keys(stored).length > 0) {
            problems.push(`asked to clear the rules, Canvas still has ${JSON.stringify(stored)}`);
          }
        }

        const warning = problems.length
          ? `\n\nWARNING: Canvas did not apply everything it was sent — ${problems.join('; ')}.`
          : '';
        const ruleLine = g.rules && Object.keys(g.rules).length
          ? `\nRules: ${JSON.stringify(g.rules)}`
          : '\nRules: none';

        return {
          content: [{
            type: "text",
            text: `Assignment group updated: id=${g.id}, name="${g.name}", position=${g.position}, weight=${g.group_weight}${ruleLine}${warning}`
          }]
        };
      } catch (error: any) {
        // never_drop reliably answers a bare 500 on gfalls.instructure.com —
        // tested 2026-08-05 with the assignment published and unpublished,
        // with and without a drop rule alongside it, and with more assignments
        // in the group than the rules could consume. drop_lowest and
        // drop_highest go through the same serialiser and both work, so the
        // string format is not the problem. An opaque 500 usually means the
        // shape is wrong (gotcha 10), but here the same shape succeeds without
        // never_drop, so this looks like Canvas rather than the payload.
        //
        // Passing the bare 500 along would tell the caller nothing at all,
        // which is worse than saying what is known.
        const hitNeverDrop = rules !== undefined && rules.never_drop !== undefined;
        const isServerError = /Canvas API 5\d\d/.test(error?.message ?? '');
        if (hitNeverDrop && isServerError) {
          throw new Error(
            `Failed to update assignment group: ${error.message}\n\n`
            + 'This is the known never_drop failure: Canvas answers a bare 500 for it on this instance, while '
            + 'drop_lowest and drop_highest work through the identical code path. Set the never-drop exemption in '
            + 'the Canvas UI (Assignments > the group\'s menu > Edit), or retry without never_drop — any '
            + 'drop_lowest/drop_highest rules in the same call were NOT applied.'
          );
        }
        throw new Error(`Failed to update assignment group: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: bulk-update-assignment-dates
  server.tool(
    "bulk-update-assignment-dates",
    "Bulk update due/unlock/lock dates for assignments in a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentDates: z.array(z.object({
        assignment_id: z.string().describe("The ID of the assignment"),
        due_at: z.string().optional().describe("New due date (ISO 8601)"),
        unlock_at: z.string().optional().describe("New unlock date (ISO 8601)"),
        lock_at: z.string().optional().describe("New lock date (ISO 8601)")
      })).describe("Array of assignment date updates")
    },
    { idempotentHint: true },
    async ({ courseId, assignmentDates }: { courseId: string; assignmentDates: any[] }) => {
      try {
        // Note: A specific client method for this bulk update could be added to CanvasClient
        // For now, using the generic put method directly.
        await canvas.put(
          `/api/v1/courses/${courseId}/assignments/bulk_update`,
          { assignment_dates: assignmentDates }
        );
        return {
          content: [{ type: "text", text: `Bulk date update applied to ${assignmentDates.length} assignment(s) in course ${courseId}.` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to bulk update assignment dates: ${error.message}`);
        }
        throw new Error('Failed to bulk update assignment dates: Unknown error');
      }
    }
  );
} 