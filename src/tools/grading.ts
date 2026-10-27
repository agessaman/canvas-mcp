import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { DataAnonymizer } from "../anonymizer.js";
import { ContentBlock, ImageBudget, extractFile, htmlToText } from "../submissionContent.js";
import { GRADING_INSTRUCTIONS, describeRubric, needsGrading, readSubmissionContent } from "../grading.js";

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
    "Start grading an assignment. Returns the grading instructions to follow, the assignment's description and the materials linked in it, the rubric with the criterion and rating IDs needed by grade-submission, the resubmission and posting settings, and the queue of students who need grading. Pass userId to also include that student's work. Read the instructions block first and follow it.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().optional().describe("Also include this student's submitted work (same output as get-submission-content)"),
      includeMaterials: z.boolean().default(true).describe("Read Canvas files linked in the assignment description, such as handouts and sources (default: true)"),
      anonymous: z.boolean().default(true).describe("Use pseudonyms for students (default: true)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, includeMaterials = true, anonymous = true }: {
      courseId: string;
      assignmentId: string;
      userId?: string;
      includeMaterials?: boolean;
      anonymous?: boolean;
    }) => {
      try {
        const a: any = await canvas.getAssignment(courseId, assignmentId);
        const subs: any[] = await canvas.listAssignmentSubmissions(courseId, assignmentId, {}, { anonymous });

        const queue = subs
          .filter(needsGrading)
          .sort((x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)))
          .map(s => ({
            user_id: s.user_id,
            student: anonymous ? DataAnonymizer.pseudonymFor(s.user_id) : undefined,
            submitted_at: s.submitted_at,
            attempt: s.attempt,
            late: s.late || false,
            ...(s.grade_matches_current_submission === false ? { resubmitted_after_grading: true } : {}),
          }));
        const counts = {
          students: subs.length,
          needs_grading: queue.length,
          graded: subs.filter(s => s.workflow_state === 'graded' && s.grade_matches_current_submission !== false).length,
          not_submitted: subs.filter(s => !s.submitted_at && !s.excused).length,
          excused: subs.filter(s => s.excused).length,
        };

        const summary = {
          assignment: {
            id: a.id,
            name: a.name,
            points_possible: a.points_possible,
            grading_type: a.grading_type,
            due_at: a.due_at,
            lock_at: a.lock_at,
            submission_types: a.submission_types,
            // -1 means unlimited attempts in Canvas
            allowed_attempts: a.allowed_attempts,
            post_manually: !!a.post_manually,
            published: !!a.published,
          },
          ...(a.published ? {} : { warning: "This assignment is unpublished. Canvas won't accept grades until it's published; ask the teacher before publishing it." }),
          rubric: describeRubric(a),
          ...(a.rubric ? {} : { rubric_note: "No rubric is attached. Grade with score/posted_grade, and ask the teacher for the criteria they want applied." }),
          counts,
          queue,
        };

        const content: ContentBlock[] = [
          { type: "text", text: GRADING_INSTRUCTIONS },
          { type: "text", text: JSON.stringify(summary) },
          { type: "text", text: `--- Assignment description ---\n${htmlToText(a.description ?? '') || '(no description)'}` },
        ];

        if (includeMaterials) {
          const { blocks, materials } = await linkedMaterials(canvas, a.description ?? '', 6);
          if (materials.length) content.push({ type: "text", text: `--- Linked materials ---\n${JSON.stringify(materials)}` });
          content.push(...blocks);
        }

        if (userId) {
          content.push({ type: "text", text: "--- Student work ---" });
          content.push(...await readSubmissionContent(canvas, courseId, assignmentId, userId, {
            maxCharsPerFile: 60000, renderPdfPages: 'auto', maxPdfPagesToRender: 10, ocr: true,
            maxImages: 15, maxFileMB: 25, anonymous,
          }));
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
