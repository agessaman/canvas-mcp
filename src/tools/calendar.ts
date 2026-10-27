import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// Calendar events — meetings, exam dates, office hours, field trips. Anything
// on a course calendar that is not an assignment due date.
//
// Two things to hold on to:
//
//   1. These are immediately visible to students in a published course. There
//      is no draft state for a calendar event, unlike an assignment or a page.
//   2. One create call can produce up to 200 events. Recurring office hours are
//      the reason the parameter exists, and a mistyped count is a mess to clean
//      up one event at a time — so the tool says how many it is about to make.
//   3. Events made with duplicate[count] are INDEPENDENT events, not a linked
//      series. Verified live: creating 4 weekly events and deleting the first
//      with which=all removed exactly one, leaving three orphans behind while
//      Canvas answered 200. `which` only means anything for a true series —
//      one built from an rrule, as the Canvas UI does — and those carry a
//      series_uuid. So the series-wide claims are made only when that field is
//      actually present, and the absence of it is reported rather than assumed
//      away.

/** Canvas's own ceiling on duplicates from a single create call. */
const MAX_REPEATS = 200;

function summarize(event: any) {
  return {
    id: event?.id,
    title: event?.title,
    start_at: event?.start_at ?? null,
    end_at: event?.end_at ?? null,
    location_name: event?.location_name ?? null,
    all_day: !!event?.all_day,
    context_code: event?.context_code ?? null,
    // Present only on events that belong to a repeating series.
    series_uuid: event?.series_uuid ?? undefined,
  };
}

export function registerCalendarTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-calendar-events
  server.tool(
    "list-calendar-events",
    "List a course's calendar events — meetings, exams, office hours, anything dated that is not an assignment. By default this covers the next 60 days; widen it with startDate and endDate, or set allEvents to ignore dates entirely.",
    {
      courseId: z.string().describe("The ID of the course"),
      startDate: z.string().optional().describe("Include events from this date on (ISO 8601 date). Defaults to today."),
      endDate: z.string().optional().describe("Include events up to this date (ISO 8601 date). Defaults to 60 days out."),
      allEvents: z.boolean().default(false).describe("Ignore the date range and return every event in the course"),
      includeAssignments: z.boolean().default(false).describe("Also include assignment due dates, which Canvas treats as calendar entries of their own type")
    },
    { readOnlyHint: true },
    async ({ courseId, startDate, endDate, allEvents = false, includeAssignments = false }: any) => {
      try {
        const params: any = {
          'context_codes[]': `course_${courseId}`,
          per_page: 100,
        };
        if (allEvents) {
          params.all_events = true;
        } else {
          params.start_date = startDate ?? new Date().toISOString().slice(0, 10);
          params.end_date = endDate ?? new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
        }

        // Canvas has no filter meaning "either", so covering assignments as
        // well as events is two calls.
        const events: any[] = await canvas.listCalendarEvents({ ...params, type: 'event' });
        const assignments: any[] = includeAssignments
          ? await canvas.listCalendarEvents({ ...params, type: 'assignment' })
          : [];
        const all = [...events, ...assignments];

        const window = allEvents
          ? 'the whole course'
          : `${params.start_date} to ${params.end_date}`;

        if (all.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No calendar events in course ${courseId} for ${window}.`
                + (allEvents ? '' : ` Widen the range with startDate/endDate, or set allEvents to see everything.`)
            }]
          };
        }

        const rows = all
          .slice()
          .sort((a, b) => String(a.start_at ?? '').localeCompare(String(b.start_at ?? '')))
          .map(summarize);

        return {
          content: [{
            type: "text",
            text: `${all.length} calendar event(s) in course ${courseId} (${window}):\n\n${JSON.stringify(rows, null, 2)}`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list calendar events: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: create-calendar-event
  server.tool(
    "create-calendar-event",
    "Put an event on a course calendar — a review session, an exam date, a field trip, or recurring office hours. Students in a published course see it immediately; calendar events have no draft state. Set repeatCount and repeatFrequency to create repeating events in one call — note Canvas creates those as INDEPENDENT events rather than a linked series, so removing them later means deleting each one.",
    {
      courseId: z.string().describe("The ID of the course whose calendar this goes on"),
      title: z.string().describe("What students will see, e.g. \"Midterm review session\""),
      startAt: z.string().describe("When it starts (ISO 8601). For an all-day event, the date is enough."),
      endAt: z.string().optional().describe("When it ends (ISO 8601). Omit for a point in time."),
      description: z.string().optional().describe("HTML description shown when a student opens the event"),
      locationName: z.string().optional().describe("Where it happens, e.g. \"Room 214\" or a meeting link"),
      allDay: z.boolean().default(false).describe("Mark it as an all-day event rather than a timed one"),
      repeatCount: z.number().int().min(0).max(MAX_REPEATS).optional()
        .describe(`How many ADDITIONAL copies to create after the first, e.g. 9 gives 10 events in total. Canvas caps this at ${MAX_REPEATS}.`),
      repeatFrequency: z.enum(['daily', 'weekly', 'monthly']).optional()
        .describe("How often the copies repeat. Required when repeatCount is set."),
      repeatInterval: z.number().int().min(1).optional()
        .describe("Gap between copies in units of repeatFrequency — 2 with 'weekly' means fortnightly. Default 1.")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        if (args.repeatCount && !args.repeatFrequency) {
          throw new Error('repeatCount needs repeatFrequency (daily, weekly or monthly) — Canvas cannot infer the rhythm.');
        }
        if (args.repeatFrequency && !args.repeatCount) {
          throw new Error('repeatFrequency needs repeatCount, otherwise only a single event is created and the frequency is silently ignored.');
        }

        const event: any = {
          context_code: `course_${args.courseId}`,
          title: args.title,
          start_at: args.startAt,
        };
        if (args.endAt !== undefined) event.end_at = args.endAt;
        if (args.description !== undefined) event.description = args.description;
        if (args.locationName !== undefined) event.location_name = args.locationName;
        if (args.allDay) event.all_day = true;
        if (args.repeatCount) {
          event.duplicate = {
            count: args.repeatCount,
            frequency: args.repeatFrequency,
            interval: args.repeatInterval ?? 1,
          };
        }

        const created: any = await canvas.createCalendarEvent({ calendar_event: event });

        // Canvas returns the first event of a series, not the whole series, so
        // the count is worth stating rather than implying.
        const total = (args.repeatCount ?? 0) + 1;
        const seriesNote = args.repeatCount
          ? `\n\nThis created ${total} events, repeating ${args.repeatFrequency}`
            + (args.repeatInterval && args.repeatInterval !== 1 ? ` every ${args.repeatInterval} intervals` : '')
            + `. Canvas returns only the first; list-calendar-events shows the rest.`
            + `\n\nIMPORTANT: Canvas creates these as INDEPENDENT events, not a linked series — deleting one does `
            + `not touch the others, and 'which: all' will not gather them up. Removing them means deleting each in `
            + `turn. (Verified live: deleting the first of four with which=all removed exactly one and left three `
            + `behind.) Only series built in the Canvas UI behave as a group.`
          : '';

        // A start date Canvas did not store means the event exists on a
        // different day from the one asked for, which nobody would notice.
        const asked = new Date(args.startAt).getTime();
        const stored = created?.start_at ? new Date(created.start_at).getTime() : NaN;
        const drift = Number.isNaN(stored) || Number.isNaN(asked) || stored !== asked
          ? `\n\nWARNING: asked for a start of ${args.startAt}, Canvas stored ${created?.start_at ?? 'nothing'}. `
            + `Check the course time zone — Canvas interprets a bare date in the course's zone, not yours.`
          : '';

        return {
          content: [{
            type: "text",
            text: `Created "${created?.title ?? args.title}" on the calendar for course ${args.courseId}.\n`
              + `${JSON.stringify(summarize(created), null, 2)}`
              + seriesNote
              + drift
              + `\n\nStudents in a published course can see this now — calendar events have no unpublished state.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to create calendar event: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-calendar-event
  server.tool(
    "update-calendar-event",
    "Change a calendar event — move an exam, rename a session, change the room. For an event in a repeating series, 'which' decides whether this touches that one occurrence, the whole series, or that one and everything after it.",
    {
      eventId: z.string().describe("The event's ID, from list-calendar-events"),
      title: z.string().optional(),
      startAt: z.string().optional().describe("New start (ISO 8601)"),
      endAt: z.string().optional().describe("New end (ISO 8601)"),
      description: z.string().optional().describe("New HTML description"),
      locationName: z.string().optional().describe("New location"),
      which: z.enum(['one', 'all', 'following']).default('one')
        .describe("For a recurring series: 'one' changes just this occurrence (the default, and the safe one), 'all' changes every event in the series, 'following' changes this one and all later ones. Ignored for a standalone event.")
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const event: any = {};
        if (args.title !== undefined) event.title = args.title;
        if (args.startAt !== undefined) event.start_at = args.startAt;
        if (args.endAt !== undefined) event.end_at = args.endAt;
        if (args.description !== undefined) event.description = args.description;
        if (args.locationName !== undefined) event.location_name = args.locationName;

        if (Object.keys(event).length === 0) {
          return { content: [{ type: "text", text: "No fields provided; nothing was changed." }] };
        }

        const updated: any = await canvas.updateCalendarEvent(
          args.eventId,
          { calendar_event: event },
          args.which && args.which !== 'one' ? { which: args.which } : {}
        );

        const problems = Object.entries(event)
          .filter(([key, wanted]) => {
            const got = updated?.[key];
            if (key === 'start_at' || key === 'end_at') {
              return new Date(String(got)).getTime() !== new Date(String(wanted)).getTime();
            }
            return String(got ?? '') !== String(wanted);
          })
          .map(([key, wanted]) => `${key}: asked for ${JSON.stringify(wanted)}, Canvas stored ${JSON.stringify(updated?.[key] ?? null)}`);

        // Same caution as the delete path: `which` is silently ignored unless
        // the event really belongs to a series.
        const inSeries = !!updated?.series_uuid;
        const scope = args.which === 'one' || !inSeries
          ? ''
          : args.which === 'all'
            ? ' Every event in its series was changed.'
            : ' This event and every later one in its series were changed.';

        const notASeries = args.which && args.which !== 'one' && !inSeries
          ? `\n\nNOTE: which="${args.which}" had no effect — this event is not part of a linked series, so only it `
            + `was changed. Repeating events created through create-calendar-event are independent; edit the others `
            + `individually.`
          : '';

        return {
          content: [{
            type: "text",
            text: `Updated event ${args.eventId}.${scope}\n${JSON.stringify(summarize(updated), null, 2)}`
              + notASeries
              + (problems.length > 0
                ? `\n\nWARNING — Canvas did not store this as requested:\n- ${problems.join('\n- ')}`
                : '')
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update calendar event: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: delete-calendar-event
  server.tool(
    "delete-calendar-event",
    "Remove an event from a course calendar. Defaults to deleting only the one occurrence. 'which' applies only to a true series (one built in the Canvas UI): repeating events made by create-calendar-event are independent and must be deleted one at a time, and the tool says so rather than reporting a series-wide delete that did not happen.",
    {
      eventId: z.string().describe("The event's ID, from list-calendar-events"),
      which: z.enum(['one', 'all', 'following']).default('one')
        .describe("For a recurring series: 'one' deletes just this occurrence (default), 'all' deletes the entire series, 'following' deletes this one and every later one."),
      cancelReason: z.string().optional().describe("Reason for the cancellation, shown to students who had it on their calendar")
    },
    { destructiveHint: true },
    async ({ eventId, which = 'one', cancelReason }: any) => {
      try {
        const params: any = {};
        if (which && which !== 'one') params.which = which;
        if (cancelReason) params.cancel_reason = cancelReason;

        const deleted: any = await canvas.deleteCalendarEvent(eventId, params);

        // Canvas ignores `which` on an event that is not part of a true series,
        // and still answers 200 — so claiming a series-wide delete on the
        // strength of the request alone reports a deletion that did not happen.
        // The deleted event's own series_uuid is the evidence.
        const inSeries = !!deleted?.series_uuid;
        const scope = which === 'one' || !inSeries
          ? ''
          : which === 'all'
            ? ' The entire series was deleted.'
            : ' That occurrence and every later one in the series were deleted.';

        const notASeries = which !== 'one' && !inSeries
          ? `\n\nNOTE: which="${which}" had no effect — this event is not part of a linked series, so only it was `
            + `deleted. Repeating events created through create-calendar-event are independent of one another; `
            + `delete the rest individually, and use list-calendar-events to find them.`
          : '';

        return {
          content: [{
            type: "text",
            text: `Deleted "${deleted?.title ?? eventId}" from the calendar.${scope}`
              + (deleted?.start_at ? ` It had been set for ${deleted.start_at}.` : '')
              + notASeries
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to delete calendar event: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
