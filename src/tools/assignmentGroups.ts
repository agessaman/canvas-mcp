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
        // never_drop reliably answers a bare 500 on example.instructure.com —
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
  //
  // Canvas's bulk_update endpoint is unlike the rest of the v1 API: the body is
  // a BARE JSON ARRAY (wrapping it in an object gets a 400 "expected array"),
  // each item is { id, all_dates: [...] }, and the base dates live in the
  // all_dates entry flagged base:true. Any date left out of that entry is
  // cleared, so the current values are read first and carried forward. The
  // call returns a Progress, not the assignments, so the job is polled and each
  // assignment re-read: a 200 here only means "queued".
  server.tool(
    "bulk-update-assignment-dates",
    "Bulk update the class-wide due/unlock/lock dates (and optionally existing override dates) for many "
      + "assignments in one Canvas job. Dates you leave out keep their current value; pass null to clear one. "
      + "An assignment that can't be updated is skipped and reported; the rest still apply. Waits for the job and re-reads each assignment, reporting any that did not take.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentDates: z.array(z.object({
        assignment_id: z.string().describe("The ID of the assignment"),
        due_at: z.string().nullable().optional().describe("New class-wide due date (ISO 8601); null clears it; omit to keep"),
        unlock_at: z.string().nullable().optional().describe("New class-wide available-from date (ISO 8601); null clears; omit to keep"),
        lock_at: z.string().nullable().optional().describe("New class-wide available-until date (ISO 8601); null clears; omit to keep"),
        overrides: z.array(z.object({
          override_id: z.string().describe("ID of an EXISTING override on this assignment (see list-assignment-overrides)"),
          due_at: z.string().nullable().optional(),
          unlock_at: z.string().nullable().optional(),
          lock_at: z.string().nullable().optional(),
        })).optional().describe(
          "Date changes for existing overrides (student/section-specific dates). Overrides not listed are left as they are."
        ),
      })).min(1).describe("Array of assignment date updates")
    },
    { idempotentHint: true },
    async ({ courseId, assignmentDates }: { courseId: string; assignmentDates: any[] }) => {
      const FIELDS = ['due_at', 'unlock_at', 'lock_at'] as const;
      const sameDate = (a: any, b: any) =>
        (a ?? null) === null || (b ?? null) === null ? (a ?? null) === (b ?? null) : Date.parse(a) === Date.parse(b);
      // A failed read is recorded per assignment rather than thrown, so one
      // deleted or mistyped ID does not sink the rest of the batch.
      const fetchAll = async (ids: string[]) => {
        const out = new Map<string, { a?: any; error?: string }>();
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++];
            try {
              out.set(id, { a: await canvas.getAssignment(courseId, id, { 'include[]': 'all_dates' }) });
            } catch (e: any) {
              out.set(id, { error: e?.message ?? String(e) });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
        return out;
      };
      const baseEntry = (a: any) => {
        const allDates: any[] = a?.all_dates ?? [];
        return allDates.find(d => d.base) ?? (allDates.length === 0 && !a?.has_overrides ? a : undefined);
      };
      const ordered = (d: Record<string, any>): string | undefined => {
        const t = (f: string) => (d[f] ? Date.parse(d[f]) : undefined);
        for (const f of FIELDS) {
          if (d[f] && Number.isNaN(Date.parse(d[f]))) return `${f} "${d[f]}" is not a valid date`;
        }
        const [due, un, lock] = [t('due_at'), t('unlock_at'), t('lock_at')];
        if (un !== undefined && due !== undefined && un > due) return `unlock_at ${d.unlock_at} is after due_at ${d.due_at}`;
        if (lock !== undefined && due !== undefined && lock < due) return `lock_at ${d.lock_at} is before due_at ${d.due_at}`;
        if (un !== undefined && lock !== undefined && un > lock) return `unlock_at ${d.unlock_at} is after lock_at ${d.lock_at}`;
        return undefined;
      };

      // Canvas runs a bulk update as one job and fails all of it if any item
      // is invalid, so every check that can be made here is made per
      // assignment, and the offender is skipped instead.
      const submit = async (body: any[]) => {
        const created: any = await canvas.put(`/api/v1/courses/${courseId}/assignments/bulk_update`, body);
        canvas.invalidateAssignments(courseId);
        let progress: any = created;
        const progressId = progress?.id;
        if (progressId === undefined) {
          throw new Error(`Canvas did not return a progress job: ${JSON.stringify(created).slice(0, 300)}`);
        }
        const deadline = Date.now() + 90_000;
        while (progress?.workflow_state !== 'completed' && progress?.workflow_state !== 'failed') {
          if (Date.now() >= deadline) return { progress, timedOut: true };
          await new Promise(r => setTimeout(r, 1500));
          progress = await canvas.getProgress(String(progressId));
        }
        return { progress, timedOut: false };
      };

      try {
        const ids = assignmentDates.map(a => String(a.assignment_id));
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length) throw new Error(`assignment_id listed more than once: ${[...new Set(dupes)].join(', ')}`);

        // Read current dates so nothing we don't mean to change is cleared.
        // The assignment's top-level due_at is the date for the requesting
        // user, not the base date, once overrides exist — all_dates has the base.
        const current = await fetchAll(ids);
        const skipped: { id: string; name?: string; reason: string }[] = [];
        let items: { id: string; name: string; body: any; expected: { entryKey: string; dates: Record<string, any> }[] }[] = [];

        for (const req of assignmentDates) {
          const id = String(req.assignment_id);
          const { a, error } = current.get(id) ?? {};
          if (!a) { skipped.push({ id, reason: `could not read it: ${error ?? 'not found'}` }); continue; }
          const allDates: any[] = a.all_dates ?? [];
          const base = baseEntry(a);
          if (!base) {
            skipped.push({
              id, name: a.name,
              reason: 'it has no class-wide dates (every student is on an override); change its overrides instead',
            });
            continue;
          }
          const baseDates: Record<string, any> = {};
          for (const f of FIELDS) baseDates[f] = req[f] !== undefined ? req[f] : (base[f] ?? null);
          const entries: any[] = [{ base: true, ...baseDates }];
          const expected = [{ entryKey: 'base', dates: baseDates }];
          let problem = ordered(baseDates);

          for (const o of req.overrides ?? []) {
            if (problem) break;
            const existing = allDates.find(d => !d.base && String(d.id) === String(o.override_id));
            if (!existing) {
              const known = allDates.filter(d => !d.base).map(d => `${d.id}${d.title ? ` (${d.title})` : ''}`);
              problem = `override ${o.override_id} is not on this assignment`
                + (known.length ? `; its overrides are ${known.join(', ')}` : '; it has no overrides');
              break;
            }
            const od: Record<string, any> = {};
            for (const f of FIELDS) od[f] = o[f] !== undefined ? o[f] : (existing[f] ?? null);
            const bad = ordered(od);
            if (bad) { problem = `override ${o.override_id}: ${bad}`; break; }
            entries.push({ id: Number(o.override_id), ...od });
            expected.push({ entryKey: String(o.override_id), dates: od });
          }
          if (problem) { skipped.push({ id, name: a.name, reason: problem }); continue; }
          items.push({ id, name: a.name, body: { id: Number(id), all_dates: entries }, expected });
        }

        const lines: string[] = [];
        const skipLines = () => skipped.length
          ? [`Skipped ${skipped.length} assignment(s), nothing changed on them:`,
             ...skipped.map(s => `  ${s.id}${s.name ? ` "${s.name}"` : ''}: ${s.reason}`)]
          : [];
        if (!items.length) {
          throw new Error(['No assignment in the batch could be updated.', ...skipLines()].join('\n'));
        }

        // Bare array, JSON — not { assignments: [...] }.
        let { progress, timedOut } = await submit(items.map(i => i.body));

        // If Canvas still rejects the job and names the assignments at fault,
        // drop those and try the rest once more.
        if (!timedOut && progress.workflow_state === 'failed') {
          const results = Array.isArray(progress.results) ? progress.results : [];
          const failedIds = new Set(results.filter((r: any) => r?.errors).map((r: any) => String(r.assignment_id)));
          const rest = items.filter(i => !failedIds.has(i.id));
          if (failedIds.size && rest.length && rest.length < items.length) {
            for (const i of items.filter(i => failedIds.has(i.id))) {
              const r = results.find((x: any) => String(x.assignment_id) === i.id);
              skipped.push({ id: i.id, name: i.name, reason: `Canvas rejected it: ${JSON.stringify(r?.errors)}` });
            }
            items = rest;
            ({ progress, timedOut } = await submit(items.map(i => i.body)));
          }
        }

        if (timedOut) {
          return {
            content: [{
              type: "text",
              text: [
                `Bulk date update queued as progress ${progress?.id} but still ${progress?.workflow_state ?? 'running'} `
                  + `(${progress?.completion ?? 0}%) after 90s. Re-check the assignments with get-assignment before retrying.`,
                ...skipLines(),
              ].join('\n'),
            }]
          };
        }

        if (progress.workflow_state === 'failed') {
          lines.push(`Canvas reported the bulk update FAILED: ${progress.message ?? 'no message'}.`);
          const results = Array.isArray(progress.results) ? progress.results : [];
          for (const r of results) {
            if (r?.errors) lines.push(`  assignment ${r.assignment_id}: ${JSON.stringify(r.errors)}`);
          }
          if (!results.length && progress.results) lines.push(`  details: ${JSON.stringify(progress.results).slice(0, 500)}`);
          lines.push('Re-reading to confirm what was stored:');
        }

        // Verify against what Canvas now holds.
        const sentIds = items.map(i => i.id);
        const after = await fetchAll(sentIds);
        const mismatches: string[] = [];
        for (const item of items) {
          const a = after.get(item.id)?.a;
          const allDates: any[] = a?.all_dates ?? [];
          for (const exp of item.expected) {
            const entry = exp.entryKey === 'base'
              ? baseEntry(a)
              : allDates.find(d => !d.base && String(d.id) === exp.entryKey);
            const label = `${item.id} "${item.name}"${exp.entryKey === 'base' ? '' : ` override ${exp.entryKey}`}`;
            if (!entry) { mismatches.push(`${label}: date entry missing after update`); continue; }
            const bad = FIELDS.filter(f => !sameDate(exp.dates[f], entry[f]))
              .map(f => `${f} expected ${exp.dates[f] ?? 'none'}, stored ${entry[f] ?? 'none'}`);
            if (bad.length) mismatches.push(`${label}: ${bad.join('; ')}`);
          }
        }

        if (progress.workflow_state === 'completed' && !mismatches.length) {
          lines.push(`Bulk date update completed for ${items.length} assignment(s) in course ${courseId}; every date verified.`);
        } else if (!mismatches.length) {
          lines.push('All requested dates are nonetheless stored as asked.');
        } else {
          if (progress.workflow_state === 'completed') {
            lines.push(`Canvas reported the job complete, but ${mismatches.length} date set(s) did not match:`);
          }
          lines.push(...mismatches.map(m => `  ${m}`));
        }
        lines.push(...skipLines());

        const withOverrides = items.filter(item => {
          const req = assignmentDates.find(a => String(a.assignment_id) === item.id);
          const extra = (after.get(item.id)?.a?.all_dates ?? []).filter((d: any) => !d.base);
          const touched = new Set((req.overrides ?? []).map((o: any) => String(o.override_id)));
          return extra.some((d: any) => !touched.has(String(d.id)));
        });
        if (withOverrides.length) {
          lines.push(
            `Note: ${withOverrides.length} assignment(s) have overrides that were left unchanged and still carry their own dates: `
            + withOverrides.map(i => `${i.id} "${i.name}"`).join(', ')
            + '. Pass them in `overrides` (or use update-assignment-override) if they should move too.'
          );
        }
        return { content: [{ type: "text", text: lines.join('\n') }] };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to bulk update assignment dates: ${error.message}`);
        }
        throw new Error('Failed to bulk update assignment dates: Unknown error');
      }
    }
  );
} 