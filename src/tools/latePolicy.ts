import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// The course's late and missing submission policy.
//
// This is the only tool on this server that changes how EVERY grade in a course
// is computed, retroactively, without touching a single submission. That shapes
// most of what is below.
//
//   GET    /api/v1/courses/:id/late_policy   404s when no policy exists yet
//   POST   /api/v1/courses/:id/late_policy   create
//   PATCH  /api/v1/courses/:id/late_policy   update
//
// Two things about the API are worth knowing before reading the code:
//
// 1. THE MISSING FIELD IS A DEDUCTION, AND THE UI SHOWS ITS COMPLEMENT.
//    `missing_submission_deduction` is the percentage taken OFF, so 100 means
//    the student ends on 0. The Canvas UI asks for the grade a missing
//    submission RECEIVES — "Grade for missing submissions: 0%" is the same
//    setting, expressed the other way round. Anyone reading the UI and then
//    calling this API will get it exactly inverted, so this tool takes the
//    UI's framing and converts.
//
// 2. A PERCENTAGE WITHOUT ITS `_enabled` FLAG DOES NOTHING. Canvas stores the
//    number and ignores it. A teacher who set a 10% late penalty and saw it
//    read back would have every reason to think it was on.

const PERCENT = (what: string) => z.number().min(0).max(100).describe(what);

/** Canvas's own field names, so the diff and the payload cannot drift apart. */
const FIELDS = [
  'missing_submission_deduction_enabled',
  'missing_submission_deduction',
  'late_submission_deduction_enabled',
  'late_submission_deduction',
  'late_submission_interval',
  'late_submission_minimum_percent_enabled',
  'late_submission_minimum_percent',
] as const;

const policyOf = (response: any): any => response?.late_policy ?? response ?? {};

const pct = (value: any): string => `${Number(value ?? 0)}%`;

/**
 * Render a policy the way a teacher thinks about it, not the way Canvas stores
 * it — the missing-submission field especially, which is a deduction in the API
 * and a resulting grade in the UI.
 */
function formatPolicy(policy: any): string {
  if (!policy || Object.keys(policy).length === 0) {
    return 'This course has no late policy: missing work is not auto-graded, and late work is not deducted.';
  }

  const lines: string[] = [];

  if (policy.missing_submission_deduction_enabled) {
    const deduction = Number(policy.missing_submission_deduction ?? 0);
    lines.push(
      `Missing submissions: automatically graded ${pct(100 - deduction)} of the assignment's points `
      + `(Canvas stores this as a ${pct(deduction)} deduction).`
    );
  } else {
    lines.push('Missing submissions: not automatically graded.');
  }

  if (policy.late_submission_deduction_enabled) {
    const interval = policy.late_submission_interval === 'hour' ? 'hour' : 'day';
    lines.push(`Late submissions: ${pct(policy.late_submission_deduction)} deducted per ${interval} late.`);
    if (policy.late_submission_minimum_percent_enabled) {
      lines.push(
        `  Floor: the deduction stops once the grade reaches `
        + `${pct(policy.late_submission_minimum_percent)} of the assignment's points.`
      );
    } else {
      lines.push('  Floor: none — a late enough submission can be deducted to zero.');
    }
  } else {
    lines.push('Late submissions: no automatic deduction.');
  }

  return lines.join('\n');
}

/** Diff what was asked for against what a re-read says Canvas stored. */
function verifyPolicy(sent: Record<string, any>, stored: any): string {
  const problems: string[] = [];
  for (const field of FIELDS) {
    if (!(field in sent)) continue;
    const want = sent[field];
    const got = stored?.[field];
    const same = typeof want === 'boolean' ? !!got === want : Number(got) === Number(want);
    if (!same && !(typeof want === 'string' && String(got) === want)) {
      problems.push(`${field}: sent ${JSON.stringify(want)}, Canvas stored ${JSON.stringify(got ?? null)}`);
    }
  }
  return problems.length > 0
    ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
    : '';
}

export function registerLatePolicyTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-late-policy
  server.tool(
    "get-late-policy",
    "Read the course's late and missing submission policy — whether Canvas automatically grades missing work, "
    + "and how much it deducts per day or hour for late work. This is what silently changes grades across a whole "
    + "course, so it is worth checking before wondering why a student's score is lower than the marks entered.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const response: any = await canvas.getLatePolicy(courseId);
        return { content: [{ type: "text", text: formatPolicy(policyOf(response)) }] };
      } catch (error: any) {
        const message = String(error?.message ?? 'Unknown error');
        // A course that has never had a policy 404s here. That is a normal
        // state, not a failure, and reporting it as an error would send a
        // teacher looking for a broken course ID.
        if (/\b404\b/.test(message)) {
          return {
            content: [{
              type: "text",
              text: 'This course has no late policy: missing work is not auto-graded, and late work is not '
                + 'deducted. Use set-late-policy to create one.'
            }]
          };
        }
        throw new Error(`Failed to read the late policy: ${message}`);
      }
    }
  );

  // Tool: set-late-policy
  server.tool(
    "set-late-policy",
    "Set the course's policy for missing and late work — the automatic grade for work never handed in, and the "
    + "penalty per day or hour for work handed in late. Creates the policy if the course has none. "
    + "WARNING: this changes how grades are computed across the ENTIRE course, including work already submitted, "
    + "so scores students have already seen can change. Percentages here are of the assignment's total points.",
    {
      courseId: z.string().describe("The ID of the course"),
      missingSubmissionGrade: PERCENT(
        "The grade a missing submission automatically receives, as a percentage of the assignment's points — "
        + "0 means a zero. This is the Canvas UI's framing; the API stores the complement as a deduction, and "
        + "this tool converts. Setting this turns the missing policy ON."
      ).optional(),
      applyMissingPolicy: z.boolean().optional().describe(
        "Turn the missing-submission policy off (false) or on. Only needed to turn it OFF — setting "
        + "missingSubmissionGrade turns it on by itself."
      ),
      lateDeductionPercent: PERCENT(
        "How much to deduct per late interval, as a percentage of the assignment's points. Setting this turns "
        + "the late policy ON."
      ).optional(),
      lateDeductionInterval: z.enum(["day", "hour"]).optional().describe(
        "Whether the late deduction accrues per day or per hour (default: day)"
      ),
      lateMinimumPercent: PERCENT(
        "Floor for late deductions — deducting stops once the grade falls to this percentage of the "
        + "assignment's points. Setting this turns the floor ON. Without a floor, late enough work reaches zero."
      ).optional(),
      applyLatePolicy: z.boolean().optional().describe(
        "Turn the late-submission policy off (false) or on. Only needed to turn it OFF — setting "
        + "lateDeductionPercent turns it on by itself."
      )
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        const policy: Record<string, any> = {};

        // Canvas stores a percentage whether or not the matching _enabled flag
        // is set, and ignores it when it is not — so a value alone is a silent
        // no-op. Setting a number is taken as intent to apply it, unless the
        // caller has explicitly said otherwise, which is a contradiction worth
        // refusing rather than resolving.
        if (args.missingSubmissionGrade !== undefined) {
          if (args.applyMissingPolicy === false) {
            throw new Error(
              'missingSubmissionGrade sets the automatic grade for missing work, but applyMissingPolicy: false '
              + 'turns that policy off — Canvas would store the number and ignore it. Pass one or the other.'
            );
          }
          // The API field is the DEDUCTION; the UI (and this tool) name the
          // resulting grade. 0% grade == 100% deduction.
          policy.missing_submission_deduction = 100 - args.missingSubmissionGrade;
          policy.missing_submission_deduction_enabled = true;
        } else if (args.applyMissingPolicy !== undefined) {
          policy.missing_submission_deduction_enabled = args.applyMissingPolicy;
        }

        if (args.lateDeductionPercent !== undefined) {
          if (args.applyLatePolicy === false) {
            throw new Error(
              'lateDeductionPercent sets the per-interval penalty, but applyLatePolicy: false turns the late '
              + 'policy off — Canvas would store the number and ignore it. Pass one or the other.'
            );
          }
          policy.late_submission_deduction = args.lateDeductionPercent;
          policy.late_submission_deduction_enabled = true;
        } else if (args.applyLatePolicy !== undefined) {
          policy.late_submission_deduction_enabled = args.applyLatePolicy;
        }

        if (args.lateDeductionInterval !== undefined) {
          policy.late_submission_interval = args.lateDeductionInterval;
        }
        if (args.lateMinimumPercent !== undefined) {
          policy.late_submission_minimum_percent = args.lateMinimumPercent;
          policy.late_submission_minimum_percent_enabled = true;
        }

        if (Object.keys(policy).length === 0) {
          throw new Error(
            'Nothing to change. Pass missingSubmissionGrade, lateDeductionPercent, lateMinimumPercent, or one of '
            + 'the applyMissingPolicy / applyLatePolicy switches.'
          );
        }

        // An interval on its own is inert: it says how often a deduction that
        // is not happening would accrue.
        if (args.lateDeductionInterval !== undefined
          && args.lateDeductionPercent === undefined
          && args.applyLatePolicy === undefined) {
          throw new Error(
            'lateDeductionInterval only says how often the late deduction accrues; on its own it changes nothing '
            + 'a student would notice. Pass lateDeductionPercent too, or turn the policy on with applyLatePolicy.'
          );
        }

        // Whether the course already has a policy decides the verb. A teacher
        // should not have to know, so it is established rather than asked for.
        let exists = true;
        let before: any = null;
        try {
          before = policyOf(await canvas.getLatePolicy(args.courseId));
          if (!before || Object.keys(before).length === 0) exists = false;
        } catch (error: any) {
          if (!/\b404\b/.test(String(error?.message ?? ''))) throw error;
          exists = false;
        }

        await canvas.setLatePolicy(args.courseId, { late_policy: policy }, exists);

        // Verify by re-reading. The write's own response is not proof, and this
        // setting is too consequential to report from an echo.
        let stored: any = null;
        let readbackNote = '';
        try {
          stored = policyOf(await canvas.getLatePolicy(args.courseId));
        } catch (error: any) {
          readbackNote = `\n\nWARNING — the write returned successfully but the policy could not be read back, so `
            + `what Canvas stored is unconfirmed. Canvas said: ${error?.message ?? 'unknown error'}`;
        }

        const retroactive = policy.missing_submission_deduction_enabled === true
          || policy.late_submission_deduction_enabled === true
          ? `\n\nThis applies to the whole course, not just future work: Canvas recomputes affected grades, so `
            + `scores students have already seen may change. Check a few in the gradebook.`
          : '';

        return {
          content: [{
            type: "text",
            text: `${exists ? 'Updated' : 'Created'} the late policy for course ${args.courseId}.\n\n`
              + `${stored ? formatPolicy(stored) : '(could not be read back)'}`
              + retroactive
              + readbackNote
              + (stored ? verifyPolicy(policy, stored) : '')
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set the late policy: ${error?.message ?? 'Unknown error'}`);
      }
    }
  );
}
