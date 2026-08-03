import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// Course attributes — the syllabus, the landing page, the publish state.
//
// All of it goes through PUT /api/v1/courses/:id, which is why none of it was
// reachable before: the syllabus in particular looks like a page but is a course
// attribute, so update-page-content could never touch it.
//
// Two things here are sharper than they look:
//
//   1. The syllabus has NO revision history. Wiki pages do — this server can
//      list and revert their revisions — but course[syllabus_body] is a plain
//      column. An overwrite is gone, so update-syllabus reads before it writes
//      and hands the old content back rather than trusting the caller to have
//      kept a copy.
//   2. course[event] can delete the entire course, enrollments and all. That
//      value is deliberately not exposed; see the note on set-course-publish-state.

/** Rough plain-text length of an HTML body, for describing what is being replaced. */
function summarizeHtml(html: string | null | undefined): string {
  if (!html) return 'empty';
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'markup only, no text';
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `${text.length} characters, starting "${preview}"`;
}

export function registerCourseSettingsTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-syllabus
  server.tool(
    "get-syllabus",
    "Read a course's syllabus. The syllabus is a course attribute rather than a page, so it does not appear in list-pages and get-page-content cannot reach it. Read it before editing: unlike a page, it has no revision history to fall back on.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const course: any = await canvas.getCourse(courseId, { 'include[]': 'syllabus_body' });
        const body = course?.syllabus_body;

        if (!body) {
          return {
            content: [{
              type: "text",
              text: `"${course?.name ?? courseId}" has no syllabus content yet. Add one with update-syllabus.`
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `Syllabus for "${course?.name ?? courseId}" (${summarizeHtml(body)}):\n\n${body}`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to get syllabus: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-syllabus
  server.tool(
    "update-syllabus",
    "Write a course's syllabus (the Syllabus page in Canvas). Takes HTML. Appends by default; replacing existing content requires replace: true, because the syllabus has no revision history and an overwrite cannot be undone.",
    {
      courseId: z.string().describe("The ID of the course"),
      body: z.string().describe("HTML for the syllabus. Canvas renders this as-is."),
      replace: z.boolean().default(false).describe("Overwrite the existing syllabus instead of appending to it. Irreversible — Canvas keeps no previous version."),
      prepend: z.boolean().default(false).describe("When appending, put the new content at the top instead of the bottom")
    },
    { destructiveHint: false },
    async ({ courseId, body, replace = false, prepend = false }: { courseId: string; body: string; replace?: boolean; prepend?: boolean }) => {
      try {
        const course: any = await canvas.getCourse(courseId, { 'include[]': 'syllabus_body' });
        const existing: string = course?.syllabus_body ?? '';

        // Refuse rather than destroy — and hand back the current content in the
        // refusal, so the one copy that exists is not lost by asking.
        if (existing && !replace && !prepend && body === existing) {
          return { content: [{ type: "text", text: "The syllabus already contains exactly this content; nothing was changed." }] };
        }

        let next: string;
        if (!existing) {
          next = body;
        } else if (replace) {
          next = body;
        } else {
          next = prepend ? `${body}\n${existing}` : `${existing}\n${body}`;
        }

        const updated: any = await canvas.updateCourse(courseId, { syllabus_body: next });

        // Canvas answers 200 to writes it has not applied, and the syllabus has
        // no other record to check against, so confirm from the response.
        const stored: string = updated?.syllabus_body ?? '';
        const landed = stored.includes(body.trim().slice(0, 40));
        const verdict = stored
          ? (landed ? '' : `\n\nWARNING: Canvas returned a syllabus that does not contain the text just sent. Re-read it with get-syllabus before assuming this worked.`)
          : `\n\nWARNING: Canvas returned an empty syllabus after this write. Nothing may have been saved — check with get-syllabus.`;

        const action = !existing
          ? 'Set the syllabus'
          : replace
            ? `Replaced the syllabus (the previous version was ${summarizeHtml(existing)}, and Canvas keeps no copy of it)`
            : `${prepend ? 'Prepended to' : 'Appended to'} the syllabus`;

        return {
          content: [{
            type: "text",
            text: `${action} for "${course?.name ?? courseId}". It is now ${summarizeHtml(stored)}.`
              + (replace && existing ? `\n\nThe replaced content is reproduced below in case it is still wanted — this is the only copy:\n\n${existing}` : '')
              + verdict
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update syllabus: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: update-course-settings
  server.tool(
    "update-course-settings",
    "Change a course's settings: its name, the page students land on, and who can see the course or its syllabus. Use set-course-publish-state to publish or unpublish, and update-syllabus for syllabus content.",
    {
      courseId: z.string().describe("The ID of the course"),
      name: z.string().optional().describe("The course's name"),
      courseCode: z.string().optional().describe("Short course code"),
      defaultView: z.enum(['feed', 'wiki', 'modules', 'assignments', 'syllabus']).optional()
        .describe("The page students land on: 'feed' recent activity, 'wiki' the front page, 'modules', 'assignments', or 'syllabus'. 'wiki' requires a front page to exist — set one with set-front-page first."),
      isPublic: z.boolean().optional().describe("Make the whole course visible to the public, including people not logged in"),
      publicSyllabus: z.boolean().optional().describe("Make just the syllabus publicly visible, without opening the rest of the course"),
      startAt: z.string().optional().describe("Course start date (ISO 8601)"),
      endAt: z.string().optional().describe("Course end date (ISO 8601)"),
      timeZone: z.string().optional().describe("IANA time zone, e.g. \"America/Los_Angeles\"")
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const payload: any = {};
        if (args.name !== undefined) payload.name = args.name;
        if (args.courseCode !== undefined) payload.course_code = args.courseCode;
        if (args.defaultView !== undefined) payload.default_view = args.defaultView;
        if (args.isPublic !== undefined) payload.is_public = args.isPublic;
        if (args.publicSyllabus !== undefined) payload.public_syllabus = args.publicSyllabus;
        if (args.startAt !== undefined) payload.start_at = args.startAt;
        if (args.endAt !== undefined) payload.end_at = args.endAt;
        if (args.timeZone !== undefined) payload.time_zone = args.timeZone;

        if (Object.keys(payload).length === 0) {
          return { content: [{ type: "text", text: "No settings provided; nothing was changed." }] };
        }

        const updated: any = await canvas.updateCourse(args.courseId, payload);

        // Report field by field rather than claiming success wholesale: Canvas
        // ignores settings it will not accept without saying so.
        const rows = Object.entries(payload).map(([key, wanted]) => {
          const got = updated?.[key];
          const applied = String(got ?? '') === String(wanted);
          return `- ${key}: ${applied ? `now ${JSON.stringify(got)}` : `asked for ${JSON.stringify(wanted)}, Canvas reports ${JSON.stringify(got ?? null)}`}`;
        });
        const problems = Object.entries(payload).filter(([key, wanted]) => String(updated?.[key] ?? '') !== String(wanted));

        // A wiki landing page with no front page set leaves students on an error.
        const frontPageNote = args.defaultView === 'wiki'
          ? `\n\nNote: 'wiki' shows the course's front page. If no page is marked as the front page, students land on an error instead — set one with set-front-page.`
          : '';

        return {
          content: [{
            type: "text",
            text: `Updated "${updated?.name ?? args.courseId}":\n${rows.join('\n')}`
              + frontPageNote
              + (problems.length > 0
                ? `\n\nWARNING: ${problems.length} setting(s) did not come back as requested. Canvas silently ignores settings it will not accept — check the course in Canvas before relying on these.`
                : '')
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update course settings: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: set-course-publish-state
  //
  // course[event] also takes 'delete', which removes the course and every
  // enrollment in it, and 'undelete', which only sometimes gets it back. Neither
  // is exposed. Deleting a course is not an accident worth enabling from a chat
  // prompt, and Canvas offers no confirmation step of its own — the same
  // reasoning that keeps a conversation-send tool off this server.
  server.tool(
    "set-course-publish-state",
    "Publish a course so students can see it, unpublish it back to a private shell, or conclude it to make it read-only. Publishing is the step that makes a built course real to students; concluding is the end-of-term one. This tool cannot delete a course.",
    {
      courseId: z.string().describe("The ID of the course"),
      state: z.enum(['published', 'unpublished', 'concluded']).describe(
        "'published' makes the course visible to students; 'unpublished' hides it again (only possible before students have submitted work); 'concluded' ends it — read-only for everyone, no new enrollments."
      )
    },
    { destructiveHint: false },
    async ({ courseId, state }: { courseId: string; state: 'published' | 'unpublished' | 'concluded' }) => {
      try {
        const event = state === 'published' ? 'offer' : state === 'unpublished' ? 'claim' : 'conclude';
        const before: any = await canvas.getCourse(courseId);
        const updated: any = await canvas.updateCourse(courseId, { event });

        // workflow_state is the only honest confirmation. Canvas will refuse to
        // unpublish a course that has student submissions, and says so in the
        // state rather than in an error.
        const now = updated?.workflow_state ?? 'unknown';
        const expected = state === 'published' ? 'available' : state === 'unpublished' ? 'unpublished' : 'completed';
        const applied = now === expected;

        const consequence = state === 'published'
          ? 'Students can now see it.'
          : state === 'unpublished'
            ? 'It is a private shell again; students cannot see it.'
            : 'It is read-only for everyone and accepts no new enrollments.';

        return {
          content: [{
            type: "text",
            text: `"${updated?.name ?? courseId}" was ${before?.workflow_state ?? 'unknown'}, now ${now}. ${applied ? consequence : ''}`
              + (applied
                ? ''
                : `\n\nWARNING: asked for ${expected}, Canvas reports ${now}. Canvas refuses to unpublish a course once students have submitted work, and reports that by leaving the state alone rather than by erroring.`)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set course publish state: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: set-front-page
  server.tool(
    "set-front-page",
    "Mark a page as the course's front page, and optionally make it the page students land on. The front page is what 'wiki' means in update-course-settings' defaultView.",
    {
      courseId: z.string().describe("The ID of the course"),
      pageUrl: z.string().describe("The page's URL slug, from list-pages"),
      makeLandingPage: z.boolean().default(false).describe("Also set the course to open on this page instead of the activity feed")
    },
    { idempotentHint: true },
    async ({ courseId, pageUrl, makeLandingPage = false }: { courseId: string; pageUrl: string; makeLandingPage?: boolean }) => {
      try {
        // Canvas refuses to make an unpublished page the front page, and says so
        // in a way worth passing along rather than swallowing.
        const page: any = await canvas.updateOrCreatePage(courseId, pageUrl, {
          wiki_page: { front_page: true }
        });

        if (!page?.front_page) {
          throw new Error(
            `Canvas did not mark "${pageUrl}" as the front page. An unpublished page cannot be the front page — `
            + `publish it first, then try again.`
          );
        }

        let landing = '';
        if (makeLandingPage) {
          const course: any = await canvas.updateCourse(courseId, { default_view: 'wiki' });
          landing = course?.default_view === 'wiki'
            ? ` The course now opens on it.`
            : `\n\nWARNING: the front page was set, but Canvas did not change the landing page (default_view is ${JSON.stringify(course?.default_view ?? null)}).`;
        }

        return {
          content: [{
            type: "text",
            text: `"${page?.title ?? pageUrl}" is now the front page of course ${courseId}.${landing}`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set front page: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
