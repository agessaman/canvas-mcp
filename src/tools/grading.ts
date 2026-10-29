import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { DataAnonymizer } from "../anonymizer.js";
import { ContentBlock, ImageBudget, extractFile, htmlToText } from "../submissionContent.js";
import { GRADING_INSTRUCTIONS, describeRubric, getCourseRoster, needsGrading, readSubmissionContent } from "../grading.js";
import { formatInZone, resolveCourseZone } from "../courseTime.js";
import { templateVariants } from "../documentSignals.js";

// What a packet can contain. The split exists because grading 30 students used
// to mean resending the instructions, the description, the whole rubric and the
// whole queue 30 times — four or five thousand tokens of identical text per
// student, before any of their work.
const PACKET_SECTIONS = ["instructions", "assignment", "rubric", "queue", "work"] as const;
type PacketSection = (typeof PACKET_SECTIONS)[number];

const FULL_PACKET: PacketSection[] = ["instructions", "assignment", "rubric", "queue"];
const WORK_ONLY: PacketSection[] = ["work"];

// Reading more than a handful of students in one call tends to blow the
// client's context before the grader has scored any of them.
const DEFAULT_MAX_USER_IDS = 5;
function maxUserIds(): number {
  const raw = Number(process.env.CANVAS_MAX_GRADING_BATCH);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_USER_IDS;
}

const DEFAULT_QUEUE_LIMIT = 50;

const MAX_LINKED_FILES = 5;

// Files and links the teacher put in the assignment description: handouts,
// readings, source documents. Canvas files are pulled in; other links are
// listed so the grader knows they exist.
async function linkedMaterials(canvas: CanvasClient, descriptionHtml: string, maxImages: number) {
  const blocks: ContentBlock[] = [];
  const materials: any[] = [];
  if (!descriptionHtml) return { blocks, materials };

  const fileIds = [...new Set([...descriptionHtml.matchAll(/\/files\/(\d+)/g)].map(m => m[1]))];
  const budget = new ImageBudget(maxImages);
  for (const id of fileIds.slice(0, MAX_LINKED_FILES)) {
    try {
      const info: any = await canvas.getFileInfo(id);
      const filename = info.display_name || info.filename || `file_${id}`;
      const { data, contentType } = await canvas.downloadUrl(info.url);
      const { summary, blocks: fileBlocks } = await extractFile(
        data, filename, info['content-type'] || contentType,
        { maxCharsPerFile: 30000, renderPdfPages: 'auto', maxPdfPagesToRender: 4, ocr: true }, budget
      );
      materials.push({ fileId: id, ...summary });
      if (fileBlocks.length) {
        blocks.push({ type: "text", text: `--- Assignment material · ${filename} ---` }, ...fileBlocks);
      }
    } catch (e: any) {
      materials.push({ fileId: id, status: "error", note: `Could not read linked file: ${e?.message ?? e}` });
    }
  }
  if (fileIds.length > MAX_LINKED_FILES) {
    materials.push({ note: `${fileIds.length - MAX_LINKED_FILES} more linked file(s) not read: ${fileIds.slice(MAX_LINKED_FILES).join(', ')}` });
  }

  const links = [...descriptionHtml.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(m => !/\/files\/\d+/.test(m[1]))
    .map(m => ({ label: m[2].replace(/<[^>]+>/g, '').trim(), url: m[1] }));
  if (links.length) {
    materials.push({ links, note: "Links in the description were not fetched. Ask the teacher if they are needed for grading." });
  }
  return { blocks, materials };
}

export function registerGradingTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-grading-packet
  server.tool(
    "get-grading-packet",
    "Start grading an assignment, then read each student's work. Call it ONCE with no userId to get the grading instructions, the assignment, its linked materials, the rubric with the criterion and rating IDs grade-submission needs, and the queue of students to grade. After that, call it per student with userId (or userIds for up to 5 at once): those calls return only that student's work plus a one-line header, because the instructions, rubric and queue do not change between students and resending them costs thousands of tokens each time. Use `include` to override what comes back. get-submission-content reads one student's work on its own, with more control over images and PDF rendering.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().optional().describe("Read this student's submitted work (same output as get-submission-content)"),
      userIds: z.array(z.string()).optional().describe(`Read several students' work in one call, in the order given (max ${DEFAULT_MAX_USER_IDS})`),
      include: z.array(z.enum(PACKET_SECTIONS)).optional()
        .describe("Which sections to return. Default with no userId: instructions, assignment, rubric, queue. Default with a userId: work only, plus a one-line header naming the assignment, its points and the rubric criterion IDs."),
      queueLimit: z.number().int().min(1).max(500).default(DEFAULT_QUEUE_LIMIT).describe(`Maximum students listed in the grading queue (default: ${DEFAULT_QUEUE_LIMIT}); queue_truncated is set when there are more`),
      includeMaterials: z.boolean().default(true).describe("Read Canvas files linked in the assignment description, such as handouts and sources (default: true)"),
      anonymous: z.boolean().default(true).describe("Use pseudonyms for students (default: true)"),
      scrubFirstNamesInBody: z.boolean().default(false).describe("Also redact bare first names from the roster in body text. Off by default, because course content is full of words that are also student names (a student called Henry would erase \"Prince Henry\"). Names on a \"Names:\" line are always redacted when anonymous."),
      includePartners: z.boolean().default(true).describe("Report classmates named on the work's \"Names:\"/\"Partner:\" line, with whether they submitted (default: true)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, userIds, include, queueLimit = DEFAULT_QUEUE_LIMIT, includeMaterials = true, anonymous = true, scrubFirstNamesInBody = false, includePartners = true }: {
      courseId: string;
      assignmentId: string;
      userId?: string;
      userIds?: string[];
      include?: PacketSection[];
      queueLimit?: number;
      includeMaterials?: boolean;
      anonymous?: boolean;
      scrubFirstNamesInBody?: boolean;
      includePartners?: boolean;
    }) => {
      try {
        const students = [...(userId ? [userId] : []), ...(userIds ?? [])]
          .filter((id, i, all) => all.indexOf(id) === i);
        const limit = maxUserIds();
        if (students.length > limit) {
          throw new Error(`Asked for ${students.length} students in one call; the limit is ${limit}. Split the batch, or raise CANVAS_MAX_GRADING_BATCH.`);
        }
        const wanted = new Set<PacketSection>(include ?? (students.length ? WORK_ONLY : FULL_PACKET));
        if (students.length === 0 && wanted.has("work")) {
          throw new Error("include asks for work, but no userId or userIds was given.");
        }

        const a: any = await canvas.getAssignment(courseId, assignmentId);
        const { timeZone, source: zoneSource } = await resolveCourseZone(canvas, courseId);
        const local = (iso: unknown) => formatInZone(iso, timeZone);
        const content: ContentBlock[] = [];

        if (wanted.has("instructions")) {
          content.push({ type: "text", text: GRADING_INSTRUCTIONS });
        }

        const summary: any = {};
        if (wanted.has("assignment")) {
          summary.assignment = {
            id: a.id,
            name: a.name,
            points_possible: a.points_possible,
            grading_type: a.grading_type,
            due_at: a.due_at,
            ...(local(a.due_at) ? { due_at_local: local(a.due_at) } : {}),
            lock_at: a.lock_at,
            ...(local(a.lock_at) ? { lock_at_local: local(a.lock_at) } : {}),
            unlock_at: a.unlock_at,
            ...(local(a.unlock_at) ? { unlock_at_local: local(a.unlock_at) } : {}),
            submission_types: a.submission_types,
            // -1 means unlimited attempts in Canvas
            allowed_attempts: a.allowed_attempts,
            post_manually: !!a.post_manually,
            published: !!a.published,
          };
          summary.time_zone = { zone: timeZone, from: zoneSource };
          if (!a.published) {
            summary.warning = "This assignment is unpublished. Canvas won't accept grades until it's published; ask the teacher before publishing it.";
          }
        }
        if (wanted.has("rubric")) {
          summary.rubric = describeRubric(a);
          if (!a.rubric) {
            summary.rubric_note = "No rubric is attached. Grade with score/posted_grade, and ask the teacher for the criteria they want applied.";
          }
        }

        if (wanted.has("queue")) {
          const subs: any[] = await canvas.listAssignmentSubmissions(courseId, assignmentId, {}, { anonymous });
          const all = subs
            .filter(needsGrading)
            .sort((x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)));
          summary.counts = {
            students: subs.length,
            needs_grading: all.length,
            graded: subs.filter(s => s.workflow_state === 'graded' && s.grade_matches_current_submission !== false).length,
            not_submitted: subs.filter(s => !s.submitted_at && !s.excused).length,
            excused: subs.filter(s => s.excused).length,
          };
          summary.queue = all.slice(0, queueLimit).map(s => ({
            user_id: s.user_id,
            student: anonymous ? DataAnonymizer.pseudonymFor(s.user_id) : undefined,
            submitted_at: s.submitted_at,
            ...(local(s.submitted_at) ? { submitted_at_local: local(s.submitted_at) } : {}),
            attempt: s.attempt,
            late: s.late || false,
            ...(s.grade_matches_current_submission === false ? { resubmitted_after_grading: true } : {}),
          }));
          if (all.length > queueLimit) {
            summary.queue_truncated = true;
            summary.queue_note = `Showing ${queueLimit} of ${all.length} students needing grading; raise queueLimit for the rest.`;
          }
          // Only covers students already read in this session — fingerprinting
          // every submission up front would mean downloading every file.
          const variants = templateVariants(String(a.id ?? assignmentId));
          if (variants) {
            summary.template_variants = variants;
            summary.template_variants_note = "Worksheet versions seen so far, from the students read in this session. Students not yet read are not listed.";
          }
        }

        if (Object.keys(summary).length) {
          content.push({ type: "text", text: JSON.stringify(summary) });
        }

        if (wanted.has("assignment")) {
          content.push({ type: "text", text: `--- Assignment description ---\n${htmlToText(a.description ?? '') || '(no description)'}` });
          if (includeMaterials) {
            const { blocks, materials } = await linkedMaterials(canvas, a.description ?? '', 6);
            if (materials.length) content.push({ type: "text", text: `--- Linked materials ---\n${JSON.stringify(materials)}` });
            content.push(...blocks);
          }
        }

        if (students.length) {
          // The header a work-only call still needs: which assignment, how many
          // points, and the criterion IDs grade-submission must be keyed by.
          if (!wanted.has("assignment") && !wanted.has("rubric")) {
            const criterionIds = (a.rubric ?? []).map((c: any) => `${c.id}=${c.description} (${c.points}pts)`).join('; ');
            content.push({
              type: "text",
              text: `Assignment ${a.id} "${a.name}" · ${a.points_possible} points · ${a.grading_type}`
                + (criterionIds ? ` · rubric criteria: ${criterionIds}` : ' · no rubric'),
            });
          }
          // Built once for the whole batch rather than per student.
          const roster = (anonymous || includePartners) ? await getCourseRoster(canvas, courseId) : [];
          for (const id of students) {
            content.push({ type: "text", text: `--- Student work · user ${id} ---` });
            try {
              content.push(...await readSubmissionContent(canvas, courseId, assignmentId, id, {
                maxCharsPerFile: 60000, renderPdfPages: 'auto', maxPdfPagesToRender: 10, ocr: true,
                maxImages: 15, maxFileMB: 25, anonymous, scrubFirstNamesInBody, includePartners,
                roster, timeZone,
              }));
            } catch (e: any) {
              // One unreadable student must not lose the rest of the batch.
              content.push({ type: "text", text: JSON.stringify({ user_id: id, error: e?.message ?? String(e) }) });
            }
          }
        }

        return { content };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to build grading packet: ${error.message}`);
        }
        throw new Error('Failed to build grading packet: Unknown error');
      }
    }
  );
}
