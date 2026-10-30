import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { DataAnonymizer } from "../anonymizer.js";
import {
  PREFERENCE_QUESTIONS,
  preferencesStorePath,
  resolvePreferences,
  setPreferences,
  unansweredPreferences,
} from "../gradingPreferences.js";
import {
  PlanEntry,
  deletePlan,
  getPlan,
  listPlans,
  markPosted,
  plansStorePath,
  savePlan,
} from "../gradingPlans.js";
import {
  buildRubricAssessment,
  describeScheme,
  letterFor,
  previewLateDeduction,
  resolveGradingScheme,
} from "../grading.js";

const KNOWN_KEYS = PREFERENCE_QUESTIONS.map(q => q.key).join(', ');
const PER_ASSIGNMENT_KEYS = PREFERENCE_QUESTIONS.filter(q => q.per_assignment).map(q => q.key).join(', ');

export function registerGradingPracticeTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-grading-preferences
  server.tool(
    "get-grading-preferences",
    "Read the grading practices this teacher has recorded, and the questions that are still open. This server ships no grading preferences of its own: comment length, what copied work is worth, how long a run of copied words has to be, whether a criterion may go below its lowest rating and the rest are the teacher's to decide. Call this before drafting scores or feedback, ask the teacher about anything unanswered when it first matters, and save the answer with set-grading-preferences so no later session asks again.",
    {
      courseId: z.string().optional().describe("Read the practices for one course, falling back to the teacher's defaults where the course says nothing. Omit for the defaults alone"),
      assignmentId: z.string().optional().describe("With courseId, also read the answers recorded against this assignment. Needed for the questions marked per_assignment, which are only ever answered for one assignment at a time"),
      unansweredOnly: z.boolean().default(false).describe("Return only the questions with no answer yet (default: false)"),
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, unansweredOnly = false }: { courseId?: string; assignmentId?: string; unansweredOnly?: boolean }) => {
      const preferences = unansweredOnly ? unansweredPreferences(courseId, assignmentId) : resolvePreferences(courseId, assignmentId);
      const open = preferences.filter(p => p.answer === undefined).length;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...(courseId ? { course_id: courseId } : {}),
            ...(assignmentId ? { assignment_id: assignmentId } : {}),
            preferences,
            open_questions: open,
            note: open
              ? "Ask about an open question at the moment it matters — one short question, with the examples as options the teacher can pick from or talk past — then record the answer. A question marked per_assignment is settled for one assignment only: an answer given for last week's worksheet says nothing about this one, so ask again and save it with that assignment's id. Never fill one in by guessing, and never carry an answer over from another teacher or another server."
              : "Everything on record. Apply these without re-asking unless the teacher reopens one.",
            stored_at: preferencesStorePath(),
          }),
        }],
      };
    }
  );

  // Tool: set-grading-preferences
  server.tool(
    "set-grading-preferences",
    `Record how this teacher grades, in their own words, so later sessions apply it instead of asking again. Save an answer only after the teacher has given it — never a guess, an inference from one assignment, or a default. Known keys: ${KNOWN_KEYS}. Any other key is stored too, for a practice this list does not cover. Pass a course id to record something that holds for one course only; without it the answer becomes the teacher's default. Pass a course id AND an assignment id for a decision that belongs to one assignment — ${PER_ASSIGNMENT_KEYS} are only ever saved that way, because what the teacher said about one assignment is not what they would say about the next. An empty value forgets that answer.`,
    {
      answers: z.record(z.string()).describe(`The teacher's answers, keyed by practice. Known keys: ${KNOWN_KEYS}. Values are the teacher's own words, not a code — "two or three sentences: one strength, the problem named, one next step" rather than "brief"`),
      courseId: z.string().optional().describe("Record these for one course only. Omit to record them as the teacher's default across courses"),
      assignmentId: z.string().optional().describe("With courseId, record these against this assignment alone. Required for the questions marked per_assignment, such as cross_check — an answer about one assignment is not an answer about the next"),
    },
    { destructiveHint: false },
    async ({ answers, courseId, assignmentId }: { answers: Record<string, string>; courseId?: string; assignmentId?: string }) => {
      if (!answers || Object.keys(answers).length === 0) {
        throw new Error("Nothing to record: pass at least one answer.");
      }
      if (assignmentId && !courseId) {
        throw new Error("assignmentId needs courseId: an assignment is only identified within its course.");
      }
      // A per-assignment answer saved at a wider scope would never be read
      // back, and would look recorded while the question kept being asked.
      const perAssignment = PREFERENCE_QUESTIONS.filter(q => q.per_assignment).map(q => q.key);
      const misplaced = Object.keys(answers).filter(k => perAssignment.includes(k) && !assignmentId);
      if (misplaced.length) {
        throw new Error(
          `${misplaced.join(', ')} ${misplaced.length === 1 ? 'is' : 'are'} decided per assignment, so the answer has to be saved with a courseId and an assignmentId. `
          + 'What the teacher said about one assignment is not what they would say about the next.'
        );
      }
      const result = setPreferences(answers, courseId, assignmentId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...(assignmentId
              ? { course_id: courseId, assignment_id: assignmentId, scope: 'assignment' }
              : courseId ? { course_id: courseId, scope: 'course' } : { scope: 'default' }),
            saved: result.saved,
            ...(result.cleared.length ? { cleared: result.cleared } : {}),
            still_open: unansweredPreferences(courseId, assignmentId).map(p => p.key),
            ...(result.warning ? { warning: result.warning } : {}),
            stored_at: preferencesStorePath(),
          }),
        }],
      };
    }
  );

  // Tool: save-grading-plan
  server.tool(
    "save-grading-plan",
    "Save the grades drafted for an assignment so a later session can read them back, price them and post them. Grading a class runs over several sittings and the rules change partway through; a plan kept here survives both, where a markdown file written for the session that made it did not. Entries merge by user id, so one student can be revised without resending the rest. Saving a plan writes nothing to Canvas — post-grading-plan does that, after the teacher has approved it.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      entries: z.array(z.object({
        userId: z.string().describe("The Canvas user ID of the student"),
        student: z.string().optional().describe("The pseudonym this student carries in the packet, for reading the plan back"),
        rubric: z.array(z.object({
          criterionId: z.string(),
          ratingId: z.string().optional(),
          points: z.number().optional(),
          comments: z.string().optional().describe("Criterion feedback. Students see it, so save only text the teacher approved"),
        })).optional().describe("Rubric scores, in the shape grade-submission takes"),
        score: z.number().optional().describe("Points, when the assignment is not graded by rubric"),
        posted_grade: z.string().optional().describe("Grade as Canvas accepts it, when points are not the right unit"),
        comment: z.string().optional().describe("Submission comment. Students see it, so save only text the teacher approved"),
        latePolicyStatus: z.enum(["none", "late", "missing", "extended"]).optional().describe("The late marker to set when this entry is posted"),
        excused: z.boolean().optional(),
        flags: z.array(z.string()).optional().describe("What the teacher still has to look at for this student — a source match, an unreadable file, a partner who did not submit"),
      })).describe("One entry per student"),
      note: z.string().optional().describe("What the plan as a whole assumes: the scoring rule in force, what the teacher decided about copied work, anything a later session would otherwise have to reconstruct"),
      replace: z.boolean().default(false).describe("Drop entries not named in this call instead of merging into them (default: false)"),
    },
    { destructiveHint: false },
    async ({ courseId, assignmentId, entries, note, replace = false }: any) => {
      const assignment: any = await canvas.getAssignment(courseId, assignmentId).catch(() => null);
      // What the plan was priced against, so a change can be spotted later.
      const policy: any = await canvas.getLatePolicy(courseId).catch(() => null);
      const scheme = assignment ? await resolveGradingScheme(canvas, courseId, assignment).catch(() => null) : null;

      const planEntries: PlanEntry[] = entries.map((e: any) => ({
        user_id: String(e.userId),
        ...(e.student ? { student: e.student } : {}),
        ...(e.rubric ? { rubric: e.rubric } : {}),
        ...(e.score !== undefined ? { score: e.score } : {}),
        ...(e.posted_grade !== undefined ? { posted_grade: e.posted_grade } : {}),
        ...(e.comment !== undefined ? { comment: e.comment } : {}),
        ...(e.latePolicyStatus ? { late_policy_status: e.latePolicyStatus } : {}),
        ...(e.excused !== undefined ? { excused: e.excused } : {}),
        ...(e.flags ? { flags: e.flags } : {}),
      }));

      const { plan, saved, warning } = savePlan({
        courseId: String(courseId),
        assignmentId: String(assignmentId),
        assignmentName: assignment?.name,
        note,
        entries: planEntries,
        latePolicySnapshot: policy?.late_policy ?? policy ?? null,
        gradingStandard: scheme?.name,
        replace,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            saved,
            entries_in_plan: Object.keys(plan.entries).length,
            posted: Object.values(plan.entries).filter(e => e.posted_at).length,
            assignment: plan.assignment_name,
            ...(warning ? { warning } : {}),
            stored_at: plansStorePath(),
            note: "Nothing was written to Canvas. Price the plan with get-grading-plan, then post it with post-grading-plan once the teacher has approved it.",
          }),
        }],
      };
    }
  );

  // Tool: get-grading-plan
  server.tool(
    "get-grading-plan",
    "Read back a saved grading plan, priced: each student's rubric total, the letter it earns on the course's own scale, what the late policy deducts and the score the student would see, plus the distribution across the class. It also reports what has changed since the plan was made — new submissions and new attempts, a late policy that no longer matches, students already graded — so nothing is posted against a stale picture. Writes nothing.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().optional().describe("The ID of the assignment. Omit to list the plans saved for this course"),
      anonymous: z.boolean().default(true).describe("Use pseudonyms for students (default: true)"),
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, anonymous = true }: { courseId: string; assignmentId?: string; anonymous?: boolean }) => {
      if (!assignmentId) {
        const plans = listPlans(courseId).map(p => ({
          assignment_id: p.assignment_id,
          assignment: p.assignment_name,
          entries: Object.keys(p.entries).length,
          posted: Object.values(p.entries).filter(e => e.posted_at).length,
          updated_at: p.updated_at,
          ...(p.note ? { note: p.note } : {}),
        }));
        return { content: [{ type: "text", text: JSON.stringify({ course_id: courseId, plans }) }] };
      }

      const plan = getPlan(courseId, assignmentId);
      if (!plan) {
        throw new Error(`No grading plan is saved for assignment ${assignmentId} in course ${courseId}. Draft one with save-grading-plan.`);
      }
      const assignment: any = await canvas.getAssignment(courseId, assignmentId);
      const points = Number(assignment?.points_possible);
      const scheme = await resolveGradingScheme(canvas, courseId, assignment);
      const policy: any = await canvas.getLatePolicy(courseId).catch(() => null);
      const livePolicy = policy?.late_policy ?? policy ?? null;
      const submissions: any[] = await canvas
        .listAssignmentSubmissions(courseId, assignmentId, {}, { anonymous })
        .catch(() => []);
      const byUser = new Map(submissions.map((s: any) => [String(s.user_id), s]));

      const rows: any[] = [];
      const letters = new Map<string, number>();
      const finals: number[] = [];
      for (const entry of Object.values(plan.entries)) {
        const submission = byUser.get(entry.user_id) ?? {};
        const row: any = {
          user_id: entry.user_id,
          student: entry.student ?? (anonymous ? DataAnonymizer.pseudonymFor(entry.user_id, courseId) : undefined),
          ...(entry.flags?.length ? { flags: entry.flags } : {}),
          ...(entry.posted_at ? { posted_at: entry.posted_at } : {}),
          ...(entry.post_error ? { post_error: entry.post_error } : {}),
        };
        let total: number | undefined;
        if (entry.rubric) {
          try {
            total = buildRubricAssessment(assignment, entry.rubric).total;
          } catch (e: any) {
            row.invalid = e?.message ?? String(e);
          }
        } else if (entry.score !== undefined) {
          total = entry.score;
        } else if (entry.posted_grade !== undefined && Number.isFinite(Number(entry.posted_grade))) {
          total = Number(entry.posted_grade);
        }
        if (total !== undefined) {
          row.total = total;
          if (Number.isFinite(points) && points > 0) {
            const late = previewLateDeduction(livePolicy, assignment, submission, total, entry.late_policy_status);
            row.letter = letterFor(total / points, scheme);
            if (late.points_deducted > 0) {
              row.points_deducted = late.points_deducted;
              row.final_score = late.final_score;
              row.letter_after_late = letterFor(late.final_score / points, scheme);
            }
            const finalScore = late.final_score;
            finals.push(finalScore);
            const letter = letterFor(finalScore / points, scheme);
            if (letter) letters.set(letter, (letters.get(letter) ?? 0) + 1);
          }
        }
        if (entry.comment) row.comment = entry.comment;
        if (entry.late_policy_status) row.late_policy_status = entry.late_policy_status;
        if (entry.excused) row.excused = true;
        rows.push(row);
      }

      // Everything that moved under the plan while it sat here.
      const changes: string[] = [];
      if (JSON.stringify(plan.late_policy_snapshot ?? null) !== JSON.stringify(livePolicy)) {
        changes.push("The course's late policy has changed since this plan was saved. Every score below has been re-priced against the policy in force now; check the ones with a deduction.");
      }
      if (plan.grading_standard && plan.grading_standard !== scheme.name) {
        changes.push(`The grading standard has changed from "${plan.grading_standard}" to "${scheme.name}"; the letters below come from the new one.`);
      }
      for (const [id, submission] of byUser) {
        const entry = plan.entries[id];
        if (!entry) {
          if (submission.submitted_at) changes.push(`A student not in the plan has a submission (user ${id}).`);
          continue;
        }
        if (submission.workflow_state === 'graded' && !entry.posted_at) {
          changes.push(`User ${id} is already graded in Canvas but is not marked posted in the plan.`);
        }
        if (entry.posted_at && submission.submitted_at && String(submission.submitted_at) > entry.posted_at) {
          changes.push(`User ${id} submitted again after this plan was posted for them.`);
        }
      }

      const sorted = [...finals].sort((a, b) => a - b);
      const median = sorted.length
        ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : undefined;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            assignment: { id: assignment?.id, name: assignment?.name, points_possible: points, post_manually: !!assignment?.post_manually },
            grading_standard: describeScheme(scheme, points),
            ...(plan.note ? { plan_note: plan.note } : {}),
            updated_at: plan.updated_at,
            entries: rows,
            distribution: {
              scored: finals.length,
              ...(median !== undefined ? { median } : {}),
              ...(finals.length ? { mean: Number((finals.reduce((a, b) => a + b, 0) / finals.length).toFixed(2)) } : {}),
              letters: Object.fromEntries([...letters.entries()].sort()),
            },
            posted: rows.filter(r => r.posted_at).length,
            unposted: rows.filter(r => !r.posted_at).length,
            ...(changes.length ? { changed_since_plan: changes, changed_note: "Show these to the teacher before posting." } : {}),
            ...(assignment?.post_manually
              ? { posting: "This assignment posts manually, so grades stay hidden until the teacher releases them." }
              : { posting: "This assignment posts automatically: every grade written becomes visible to that student at once. post-grading-plan can hold them first with hold: true." }),
          }),
        }],
      };
    }
  );

  // Tool: post-grading-plan
  server.tool(
    "post-grading-plan",
    "Write a saved grading plan to Canvas, one call instead of one per student. Only after the teacher has approved the plan — read it back with get-grading-plan, show them the totals, the distribution and anything that changed, and post only what they approved. A student whose write fails does not stop the others; the plan records who posted and who is left, so a second call finishes the job without redoing it. Students already posted are skipped unless their entry changed.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userIds: z.array(z.string()).optional().describe("Post only these students. Omit to post every entry not yet posted"),
      hold: z.boolean().default(false).describe("Switch the assignment to manual posting before writing, so grades stay hidden until the teacher releases them together. Changes an assignment setting, so ask the teacher first (default: false)"),
      includeComments: z.boolean().default(true).describe("Write the comments saved in the plan. Set false to post scores only (default: true)"),
      dryRun: z.boolean().default(false).describe("List exactly what would be written to each student, and write nothing (default: false)"),
    },
    { destructiveHint: false },
    async ({ courseId, assignmentId, userIds, hold = false, includeComments = true, dryRun = false }: any) => {
      const plan = getPlan(courseId, assignmentId);
      if (!plan) {
        throw new Error(`No grading plan is saved for assignment ${assignmentId} in course ${courseId}.`);
      }
      const assignment: any = await canvas.getAssignment(courseId, assignmentId);
      if (!assignment?.published) {
        throw new Error(`"${assignment?.name ?? assignmentId}" is unpublished, and Canvas will not accept grades on an unpublished assignment.`);
      }

      const wanted = userIds?.length ? new Set(userIds.map(String)) : null;
      const todo = Object.values(plan.entries).filter(e => (wanted ? wanted.has(e.user_id) : !e.posted_at));
      if (todo.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ posted: 0, note: "Nothing to post: every entry asked for is already marked posted." }) }] };
      }

      const payloads = todo.map(entry => {
        const submission: any = {};
        if (entry.posted_grade !== undefined) submission.posted_grade = entry.posted_grade;
        else if (entry.score !== undefined) submission.posted_grade = String(entry.score);
        if (entry.late_policy_status) submission.late_policy_status = entry.late_policy_status;
        if (entry.excused !== undefined) submission.excuse = entry.excused;
        const payload: any = {};
        if (Object.keys(submission).length) payload.submission = submission;
        if (entry.rubric) {
          const built = buildRubricAssessment(assignment, entry.rubric);
          payload.rubric_assessment = built.assessment;
          // A rubric that does not drive the grade leaves the score untouched,
          // which is how a plan posts a rubric and no grade without saying so.
          if (!assignment.use_rubric_for_grading && submission.posted_grade === undefined) {
            payload.submission = { ...payload.submission, posted_grade: String(built.total) };
          }
        }
        if (includeComments && entry.comment) payload.comment = { text_comment: entry.comment };
        return { entry, payload };
      });

      if (dryRun) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              dry_run: true,
              would_post: payloads.map(p => ({ user_id: p.entry.user_id, student: p.entry.student, would_write: p.payload })),
              count: payloads.length,
              ...(hold ? { would_hold: "The assignment would be switched to manual posting first." } : {}),
            }),
          }],
        };
      }

      let held: string | undefined;
      if (hold && !assignment.post_manually) {
        await canvas.updateAssignment(courseId, assignmentId, { assignment: { post_manually: true } });
        held = "Switched to manual posting: these grades are hidden until the teacher releases them in the Gradebook.";
      }

      const results: any[] = [];
      let posted = 0;
      for (const { entry, payload } of payloads) {
        try {
          const s: any = await canvas.gradeSubmission(courseId, assignmentId, entry.user_id, payload);
          markPosted(courseId, assignmentId, entry.user_id);
          posted++;
          results.push({
            user_id: entry.user_id,
            student: entry.student,
            score: s?.score,
            grade: s?.grade,
            ...(s?.points_deducted ? { points_deducted: s.points_deducted } : {}),
            ...(s?.entered_score !== undefined && s?.entered_score !== s?.score ? { entered_score: s.entered_score } : {}),
          });
        } catch (e: any) {
          // One failure must not cost the other thirty-four.
          const message = e?.message ?? String(e);
          markPosted(courseId, assignmentId, entry.user_id, message);
          results.push({ user_id: entry.user_id, student: entry.student, error: message });
        }
      }

      const remaining = Object.values(getPlan(courseId, assignmentId)?.entries ?? {}).filter(e => !e.posted_at);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            posted,
            failed: results.filter(r => r.error).length,
            results,
            still_unposted: remaining.map(e => e.user_id),
            ...(held ? { holding: held } : {}),
            ...(!held && !assignment.post_manually ? { visibility: "This assignment posts automatically, so these grades are visible to students now." } : {}),
          }),
        }],
      };
    }
  );

  // Tool: delete-grading-plan
  server.tool(
    "delete-grading-plan",
    "Forget a saved grading plan once the assignment is done. Removes only the local plan file's entry; grades already written to Canvas are untouched.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
    },
    { destructiveHint: true },
    async ({ courseId, assignmentId }: { courseId: string; assignmentId: string }) => {
      const existed = deletePlan(courseId, assignmentId);
      return {
        content: [{
          type: "text",
          text: existed
            ? `Forgot the grading plan for assignment ${assignmentId}. Grades already in Canvas are unchanged.`
            : `No grading plan was saved for assignment ${assignmentId}.`,
        }],
      };
    }
  );
}
