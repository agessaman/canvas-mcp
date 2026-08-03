import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { jsonObjectParam } from "../jsonObjectParam.js";

// Course copy — "pull last semester into this shell", the August job.
//
// Canvas models it as a content migration: POST a migration_type of
// course_copy_importer with a source course, and it runs asynchronously while a
// progress record ticks up. Two properties shape these tools:
//
//   1. A copy MERGES. It does not replace. Copying into a course that already
//      has content leaves you with two of everything, and Canvas offers no
//      undo — the only repair is deleting the duplicates by hand. So the
//      destination is checked first and a non-empty one is refused unless the
//      caller says they meant it.
//   2. A migration can finish "completed" and still have dropped things. That
//      is recorded only in migration_issues, which is therefore part of
//      reporting the result rather than an optional extra.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Canvas reports migrations through workflow_state; these are the terminal ones. */
const FINISHED = new Set(['completed', 'failed']);

function describeState(state: string): string {
  switch (state) {
    case 'pre_processing': return 'queued, not started yet';
    case 'pre_processed': return 'prepared, about to run';
    case 'running': return 'running now';
    case 'waiting_for_select': return 'waiting for a selection (selective import — not supported by this server)';
    case 'completed': return 'finished';
    case 'failed': return 'FAILED';
    default: return state;
  }
}

export function registerCourseCopyTools(server: McpServer, canvas: CanvasClient) {
  // Tool: copy-course-content
  server.tool(
    "copy-course-content",
    "Copy an entire course into another one — last semester's assignments, pages, modules, quizzes and files into this term's shell. Optionally shifts every date forward so the old due dates land on the new term's calendar. This ADDS to the destination rather than replacing it, and Canvas cannot undo a copy, so a destination that already has content is refused unless you confirm you want to merge.",
    {
      sourceCourseId: z.string().describe("The course to copy FROM (last term's course)"),
      destinationCourseId: z.string().describe("The course to copy INTO (this term's shell)"),
      allowExistingContent: z.boolean().default(false)
        .describe("Proceed even though the destination already has content. Leave this off unless you intend to merge — a copy duplicates rather than replaces, and there is no undo."),
      shiftDates: z.boolean().default(false)
        .describe("Move every due, unlock and lock date from the old term's calendar onto the new one"),
      oldStartDate: z.string().optional().describe("The source course's first day (ISO 8601 date), required when shiftDates is on"),
      newStartDate: z.string().optional().describe("The destination course's first day (ISO 8601 date), required when shiftDates is on"),
      oldEndDate: z.string().optional().describe("The source course's last day (ISO 8601 date). With the start dates, this scales the term rather than merely offsetting it."),
      newEndDate: z.string().optional().describe("The destination course's last day (ISO 8601 date)"),
      daySubstitutions: jsonObjectParam(
        "Remap weekdays while shifting, for when the timetable changes — e.g. {\"1\":\"2\"} moves everything that fell on Monday to Tuesday. Keys and values are 0=Sunday through 6=Saturday."
      ).optional(),
      removeDates: z.boolean().default(false)
        .describe("Strip all dates from the copied content instead of shifting them, leaving everything undated. Mutually exclusive with shiftDates.")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        if (String(args.sourceCourseId) === String(args.destinationCourseId)) {
          throw new Error('Source and destination are the same course. A course cannot be copied into itself.');
        }
        if (args.shiftDates && args.removeDates) {
          throw new Error('shiftDates and removeDates are mutually exclusive: one moves the dates, the other deletes them.');
        }
        if (args.shiftDates && (!args.oldStartDate || !args.newStartDate)) {
          throw new Error(
            'shiftDates needs oldStartDate and newStartDate — without them Canvas has nothing to shift between and '
            + 'the copy silently arrives with last term\'s dates intact.'
          );
        }

        // Refuse to merge by accident. Canvas will happily create a second copy
        // of every assignment, and unpicking that is manual work.
        const [assignments, modules, pages] = await Promise.all([
          canvas.listCourseAssignments(args.destinationCourseId, { per_page: 100 }, { anonymous: false }) as Promise<any[]>,
          canvas.listModules(args.destinationCourseId) as Promise<any[]>,
          canvas.listPages(args.destinationCourseId) as Promise<any[]>,
        ]);
        const existing = [
          assignments?.length ? `${assignments.length} assignment(s)` : null,
          modules?.length ? `${modules.length} module(s)` : null,
          pages?.length ? `${pages.length} page(s)` : null,
        ].filter(Boolean);

        if (existing.length > 0 && !args.allowExistingContent) {
          throw new Error(
            `Destination course ${args.destinationCourseId} is not empty — it already has ${existing.join(', ')}. `
            + `A course copy ADDS to what is there rather than replacing it, so this would leave two of everything, `
            + `and Canvas has no undo for a copy. If you meant to merge, pass allowExistingContent: true. If you `
            + `meant to start clean, empty the destination first.`
          );
        }

        const payload: any = {
          migration_type: 'course_copy_importer',
          settings: { source_course_id: String(args.sourceCourseId) },
        };

        if (args.shiftDates) {
          const options: any = {
            shift_dates: true,
            old_start_date: args.oldStartDate,
            new_start_date: args.newStartDate,
          };
          if (args.oldEndDate) options.old_end_date = args.oldEndDate;
          if (args.newEndDate) options.new_end_date = args.newEndDate;
          if (args.daySubstitutions) options.day_substitutions = args.daySubstitutions;
          payload.date_shift_options = options;
        } else if (args.removeDates) {
          payload.date_shift_options = { remove_dates: true };
        }

        const migration: any = await canvas.createContentMigration(args.destinationCourseId, payload);

        if (!migration?.id) {
          throw new Error(`Canvas did not return a migration: ${JSON.stringify(migration).slice(0, 300)}`);
        }

        const shiftNote = args.shiftDates
          ? `\nDates shift from ${args.oldStartDate} to ${args.newStartDate}`
            + (args.newEndDate ? ` (through ${args.newEndDate})` : '')
            + (args.daySubstitutions
              ? `, moving ${Object.entries(args.daySubstitutions)
                  .map(([from, to]) => `${DAY_NAMES[Number(from)] ?? from} to ${DAY_NAMES[Number(to)] ?? to}`)
                  .join(' and ')}`
              : '')
            + '.'
          : args.removeDates
            ? `\nAll dates are being stripped; the copied content will arrive undated.`
            : `\nDates are being copied unchanged — everything will still carry last term's due dates.`;

        return {
          content: [{
            type: "text",
            text: `Started copying course ${args.sourceCourseId} into ${args.destinationCourseId}.\n`
              + `Migration ${migration.id}, currently ${describeState(migration.workflow_state)}.`
              + shiftNote
              + (existing.length > 0
                ? `\n\nNOTE: the destination already had ${existing.join(', ')}, and this copy is being added on top of `
                  + `them as you asked. Expect duplicates where names overlap.`
                : '')
              + `\n\nThis runs in the background and can take several minutes for a full course. Check it with `
              + `get-content-migration (course ${args.destinationCourseId}, migration ${migration.id}) — a copy can `
              + `finish and still have dropped content, which only shows up there.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to start course copy: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: get-content-migration
  server.tool(
    "get-content-migration",
    "Check how a course copy is going, and what it did or didn't bring across. A migration can report itself finished and still have dropped content, so this reports Canvas's migration issues alongside the status.",
    {
      courseId: z.string().describe("The course being copied INTO"),
      migrationId: z.string().describe("The migration's ID, from copy-course-content or list-content-migrations")
    },
    { readOnlyHint: true },
    async ({ courseId, migrationId }: { courseId: string; migrationId: string }) => {
      try {
        const migration: any = await canvas.getContentMigration(courseId, migrationId);
        const state = migration?.workflow_state ?? 'unknown';

        // The migration record itself only says which phase it is in; the
        // percentage lives on the linked progress record.
        let progressNote = '';
        if (!FINISHED.has(state) && migration?.progress_url) {
          try {
            const progress: any = await canvas.getProgressByUrl(migration.progress_url);
            if (progress?.completion !== undefined) {
              progressNote = ` — ${Math.round(progress.completion)}% complete`;
            }
          } catch {
            // A progress record that cannot be read is not worth failing the
            // status check over; the workflow_state is still the answer.
          }
        }

        let issuesNote = '';
        if (FINISHED.has(state)) {
          const issues: any[] = await canvas.listMigrationIssues(courseId, migrationId);
          if (issues.length > 0) {
            const rows = issues.map(issue =>
              `- [${issue.issue_type ?? 'issue'}] ${issue.description ?? 'no description'}`
            );
            issuesNote = `\n\n${issues.length} migration issue(s) — content that did not come across cleanly:\n`
              + `${rows.join('\n')}`;
          } else if (state === 'completed') {
            issuesNote = `\n\nCanvas reported no migration issues.`;
          }
        }

        const guidance = state === 'completed'
          ? `\n\nThe copy is done. Check the destination course — a copy adds content, so anything that was already `
            + `there is still there too.`
          : state === 'failed'
            ? `\n\nThe copy FAILED. Nothing further will happen on its own; the issues above are the only explanation `
              + `Canvas gives.`
            : state === 'waiting_for_select'
              ? `\n\nThis migration is waiting for a content selection, which this server does not support — finish it `
                + `in the Canvas UI, or start a full copy instead.`
              : `\n\nStill working. Check again in a minute.`;

        return {
          content: [{
            type: "text",
            text: `Migration ${migrationId} in course ${courseId}: ${describeState(state)}${progressNote}.\n`
              + `Type: ${migration?.migration_type ?? 'unknown'}`
              + (migration?.settings?.source_course_id ? `, copying from course ${migration.settings.source_course_id}` : '')
              + (migration?.started_at ? `\nStarted: ${migration.started_at}` : '')
              + (migration?.finished_at ? `\nFinished: ${migration.finished_at}` : '')
              + issuesNote
              + guidance
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to get content migration: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-content-migrations
  server.tool(
    "list-content-migrations",
    "List the course copies and imports run into a course, newest first. Use it to find a migration ID, or to see whether a shell has already had content copied into it before copying again.",
    {
      courseId: z.string().describe("The course that content was copied INTO")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const migrations: any[] = await canvas.listContentMigrations(courseId);

        if (migrations.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No content has ever been copied or imported into course ${courseId}.`
            }]
          };
        }

        const rows = migrations
          .slice()
          .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
          .map(m => ({
            id: m.id,
            type: m.migration_type,
            state: m.workflow_state,
            source_course_id: m.settings?.source_course_id ?? null,
            created_at: m.created_at ?? null,
            finished_at: m.finished_at ?? null,
          }));

        return {
          content: [{
            type: "text",
            text: `${migrations.length} migration(s) into course ${courseId}, newest first:\n\n`
              + `${JSON.stringify(rows, null, 2)}\n\n`
              + `Details and any dropped content: get-content-migration.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list content migrations: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
