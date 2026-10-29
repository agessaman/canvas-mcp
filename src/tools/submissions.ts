import { z } from "zod";
import { jsonObjectParam } from "../jsonObjectParam.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { buildRubricAssessment, getCourseRoster, letterFor, readSubmissionContent, resolveGradingScheme } from "../grading.js";
import { createRedactor, noopRedactor } from "../nameRedaction.js";
import { TOOL_BASE64_LIMIT_BYTES, TOOL_TEXT_LIMIT, extractFileForTool } from "../submissionContent.js";

export function registerSubmissionTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-assignment-submissions
  server.tool(
    "list-assignment-submissions",
    "Fetch every student's submission status & comments for an assignment.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      anonymous: z.boolean().default(true).describe("Whether to anonymize student names and emails (default: true for privacy)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, anonymous = true }: { courseId: string; assignmentId: string; anonymous?: boolean }) => {
      try {
        const raw = await canvas.listAssignmentSubmissions(courseId, assignmentId, {}, { anonymous });
        const submissions = (raw as any[]).map((s: any) => ({
          id: s.id,
          user_id: s.user_id,
          submitted_at: s.submitted_at,
          workflow_state: s.workflow_state,
          grade: s.grade,
          score: s.score,
          attempt: s.attempt,
          late: s.late || false,
          missing: s.missing || false,
          submission_type: s.submission_type,
          ...(s.submission_comments?.length ? {
            submission_comments: s.submission_comments.map((c: any) => ({
              comment: c.comment,
              author: c.author?.display_name,
              created_at: c.created_at,
            }))
          } : {}),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(submissions) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch assignment submissions: ${error.message}`);
        }
        throw new Error('Failed to fetch assignment submissions: Unknown error');
      }
    }
  );

  // Tool: grade-submission
  server.tool(
    "grade-submission",
    "Write a score, grade, rubric assessment and/or comment to a student's submission. Only call this after the teacher has approved the grade, and only include comment or rubric comments when the teacher has approved that exact feedback text. Prefer `rubric` (validated against the assignment's rubric; get IDs from get-grading-packet) over the raw `rubric_assessment`. Pass dryRun: true to validate a draft and see its total and letter grade without writing anything to Canvas.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().describe("The ID of the student/user"),
      posted_grade: z.string().optional().describe("Grade as Canvas accepts it: points (\"8\"), percentage (\"80%\"), letter grade (\"B+\"), or complete/incomplete"),
      score: z.number().optional().describe("Points score; shorthand for posted_grade with a number"),
      rubric: z.array(z.object({
        criterionId: z.string().describe("criterionId from get-grading-packet"),
        ratingId: z.string().optional().describe("ratingId from get-grading-packet; sets points to that rating's value"),
        points: z.number().optional().describe("Points for this criterion (needed for range or free-form criteria)"),
        comments: z.string().optional().describe("Feedback for this criterion. Students can see it, so include only text the teacher approved"),
      })).optional().describe("Rubric scores, checked against the assignment's rubric before anything is written"),
      rubric_assessment: jsonObjectParam("Raw Canvas rubric_assessment object, keyed by criterion id (advanced; unvalidated): {\"criterion_id\": {\"points\": 5, \"comments\": \"...\"}}").optional(),
      comment: z.string().optional().describe("Submission comment students can see. Include only text the teacher approved"),
      dryRun: z.boolean().default(false).describe("Validate and price the grade without writing it: returns would_write, the rubric total, the letter grade from the grading standard, and whether students would see it immediately. Makes no changes in Canvas (default: false)"),
    },
    { idempotentHint: true },
    async ({ courseId, assignmentId, userId, posted_grade, score, rubric, rubric_assessment, comment, dryRun = false }: {
      courseId: string;
      assignmentId: string;
      userId: string;
      posted_grade?: string;
      score?: number;
      rubric?: { criterionId: string; ratingId?: string; points?: number; comments?: string }[];
      rubric_assessment?: any;
      comment?: string;
      dryRun?: boolean;
    }) => {
      try {
        if (rubric && rubric_assessment !== undefined) {
          throw new Error("Pass either rubric or rubric_assessment, not both.");
        }
        if (posted_grade !== undefined && score !== undefined) {
          throw new Error("Pass either posted_grade or score, not both.");
        }
        // Canvas reads the grade from submission[posted_grade]; a top-level
        // posted_grade or score is silently ignored.
        const payload: any = {};
        const grade = posted_grade ?? (score !== undefined ? String(score) : undefined);
        if (grade !== undefined) payload.submission = { posted_grade: grade };
        if (comment !== undefined) payload.comment = { text_comment: comment };

        const notes: string[] = [];
        let rubricTotal: number | undefined;
        if (rubric) {
          const assignment: any = await canvas.getAssignment(courseId, assignmentId);
          const built = buildRubricAssessment(assignment, rubric);
          payload.rubric_assessment = built.assessment;
          rubricTotal = built.total;
          if (built.unscored.length) notes.push(`Criteria not scored: ${built.unscored.join('; ')}`);
          if (!assignment.use_rubric_for_grading && grade === undefined) {
            notes.push(`The rubric isn't set to calculate the grade, so the score was not changed. Pass score: ${rubricTotal} to set it.`);
          }
        } else if (rubric_assessment !== undefined) {
          payload.rubric_assessment = rubric_assessment;
        }
        if (Object.keys(payload).length === 0) {
          throw new Error("Nothing to write: pass posted_grade, score, rubric, rubric_assessment or comment.");
        }

        if (dryRun) {
          // Same validation as a real write, no request. Nothing below this
          // branch may call a write method on the client.
          const assignment: any = await canvas.getAssignment(courseId, assignmentId);
          const total = rubricTotal ?? (score !== undefined ? score : Number(posted_grade));
          const points = Number(assignment?.points_possible);
          let letter: string | undefined;
          let scheme: Record<string, unknown> | undefined;
          if (Number.isFinite(total) && Number.isFinite(points) && points > 0) {
            const resolved = await resolveGradingScheme(canvas, courseId, assignment);
            letter = letterFor(total / points, resolved);
            scheme = {
              name: resolved.name,
              source: resolved.source,
              ...(resolved.id !== undefined ? { id: resolved.id } : {}),
              // Say what was checked when the school's own scheme wasn't found,
              // so a surprising letter can be traced rather than trusted.
              ...(resolved.tried ? { fell_back_because: resolved.tried } : {}),
            };
          }
          const preview = {
            dry_run: true,
            would_write: payload,
            total: Number.isFinite(total) ? total : undefined,
            points_possible: Number.isFinite(points) ? points : undefined,
            letter_grade: letter,
            grading_type: assignment?.grading_type,
            ...(scheme ? { grading_standard: scheme } : {}),
            visible_immediately: !assignment?.post_manually,
            ...(notes.length ? { notes } : {}),
          };
          return { content: [{ type: "text", text: JSON.stringify(preview) }] };
        }

        const s = await canvas.gradeSubmission(courseId, assignmentId, userId, payload) as any;
        const result = {
          user_id: s.user_id,
          score: s.score,
          grade: s.grade,
          workflow_state: s.workflow_state,
          ...(rubricTotal !== undefined ? { rubric_total: rubricTotal } : {}),
          ...(comment !== undefined ? { comment_posted: true } : {}),
          ...(notes.length ? { notes } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          // Canvas answers a grade on an unpublished assignment with a bare
          // "not authorized", which reads like a token problem.
          if (/not authorized/i.test(error.message)) {
            const a: any = await canvas.getAssignment(courseId, assignmentId).catch(() => null);
            if (a && !a.published) {
              throw new Error(`Failed to grade submission: "${a.name}" is unpublished, and Canvas won't accept grades on unpublished assignments. Publish it first.`);
            }
          }
          throw new Error(`Failed to grade submission: ${error.message}`);
        }
        throw new Error('Failed to grade submission: Unknown error');
      }
    }
  );

  // Tool: post-submission-comment
  server.tool(
    "post-submission-comment",
    "Post a comment on a student's submission. Students can see it, so only post text the teacher has seen and approved.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().describe("The ID of the student/user"),
      comment: z.string().describe("The comment text to post")
    },
    { destructiveHint: false },
    async ({ courseId, assignmentId, userId, comment }: { courseId: string; assignmentId: string; userId: string; comment: string }) => {
      try {
        await canvas.put(
          `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
          { comment: { text_comment: comment } }
        );
        return {
          content: [{
            type: "text",
            text: `Comment posted on submission for user ${userId} (assignment ${assignmentId}).`
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to post submission comment: ${error.message}`);
        }
        throw new Error('Failed to post submission comment: Unknown error');
      }
    }
  );

  // Tool: get-submission-documents
  server.tool(
    "get-submission-documents",
    `List a student's submission attachments, with their extracted text when downloadFiles is on. Text comes back as text for PDFs, Word (.docx), HTML and plain-text files, truncated at ${TOOL_TEXT_LIMIT} characters with truncated: true; base64 only for images, media and formats with no extractor, or when forceBase64 is set (base64 limit: ${(TOOL_BASE64_LIMIT_BYTES / 1048576).toFixed(0)} MB). With anonymous (the default), names are redacted from the extracted text as well as the metadata. To read or grade the work, including photos and scanned handwriting, use get-submission-content instead.`,
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().describe("The ID of the student/user"),
      downloadFiles: z.boolean().default(false).describe("Download each attachment and return its extracted text (default: false, metadata only)"),
      forceBase64: z.boolean().default(false).describe("Return raw base64 instead of extracted text (default: false)"),
      maxChars: z.number().int().min(1000).default(TOOL_TEXT_LIMIT).describe(`Truncate extracted text per file beyond this length (default: ${TOOL_TEXT_LIMIT})`),
      anonymous: z.boolean().default(true).describe("Whether to anonymize student information (default: true for privacy)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, downloadFiles = false, forceBase64 = false, maxChars = TOOL_TEXT_LIMIT, anonymous = true }: {
      courseId: string;
      assignmentId: string;
      userId: string;
      downloadFiles?: boolean;
      forceBase64?: boolean;
      maxChars?: number;
      anonymous?: boolean;
    }) => {
      try {
        const result = await canvas.getSubmissionDocuments(courseId, assignmentId, userId, {
          downloadFiles,
          anonymous
        });

        // This tool now returns document text rather than opaque bytes, so
        // anonymous has to mean the text too, not just the metadata around it.
        const redactor = anonymous
          ? createRedactor({ roster: await getCourseRoster(canvas, courseId), submitterId: userId })
          : noopRedactor();
        const scrub = (t: unknown) => (typeof t === 'string' ? redactor.redact(t) : t);

        // A 192 KB PDF used to come back as "[FILE_TOO_LARGE_FOR_DISPLAY]",
        // which left the caller with nothing at all. Every readable file now
        // returns its text; only what has no extractor falls back to bytes.
        const downloaded = [];
        for (const file of (downloadFiles ? result.downloadedFiles : []) as any[]) {
          if (file.error) {
            downloaded.push({ id: file.id, filename: file.filename, error: file.error });
            continue;
          }
          const extracted = await extractFileForTool(
            Buffer.from(file.data), file.filename ?? '', file.contentType ?? '', { forceBase64, maxChars }
          );
          const redactions = { nameLine: 0, body: 0, unmatched: 0 };
          if (extracted.content_encoding === 'text' && extracted.content !== undefined) {
            extracted.content = scrub(extracted.content) as string;
            Object.assign(redactions, redactor.takeCounts());
          }
          if (extracted.integrity_signals) {
            extracted.integrity_signals = extracted.integrity_signals.map(sig => ({ ...sig, excerpt: scrub(sig.excerpt) as string }));
            redactor.takeCounts();
          }
          downloaded.push({
            id: file.id,
            filename: scrub(file.filename),
            content_type: file.contentType,
            size: file.size,
            ...extracted,
            ...(anonymous ? { redactions } : {}),
          });
        }

        const response = {
          submission: {
            id: result.submission.id,
            user_id: anonymous ? '[ANONYMIZED]' : result.submission.user_id,
            assignment_id: result.submission.assignment_id,
            submission_type: result.submission.submission_type,
            workflow_state: result.submission.workflow_state,
            submitted_at: result.submission.submitted_at,
            grade: result.submission.grade,
            score: result.submission.score,
            attempt: result.submission.attempt
          },
          text_content: scrub(result.textSubmission),
          attachments: result.attachments.map((attachment: any) => ({
            id: attachment.id,
            filename: scrub(attachment.filename || attachment.display_name),
            content_type: attachment.content_type,
            size: attachment.size,
            url: downloadFiles ? '[DOWNLOADED_BELOW]' : attachment.url,
            created_at: attachment.created_at
          })),
          downloaded_files: downloaded
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response)
            }
          ]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch submission documents: ${error.message}`);
        }
        throw new Error('Failed to fetch submission documents: Unknown error');
      }
    }
  );

  // Tool: get-submission-file-info
  server.tool(
    "get-submission-file-info",
    "Get detailed information about a specific file attached to a submission, including download URLs and metadata.",
    {
      fileId: z.string().describe("The ID of the file to retrieve information for")
    },
    { readOnlyHint: true },
    async ({ fileId }: { fileId: string }) => {
      try {
        const f = await canvas.getFileInfo(fileId) as any;
        const summary = {
          id: f.id,
          filename: f.filename || f.display_name,
          display_name: f.display_name,
          content_type: f['content-type'] || f.content_type,
          mime_class: f.mime_class,
          size: f.size,
          url: f.url,
          created_at: f.created_at,
          updated_at: f.updated_at,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary)
            }
          ]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch file information: ${error.message}`);
        }
        throw new Error('Failed to fetch file information: Unknown error');
      }
    }
  );

  // Tool: download-submission-file
  server.tool(
    "download-submission-file",
    `Read one submission file by its file ID. Returns extracted text for PDFs, Word (.docx), HTML and plain-text files, truncated at ${TOOL_TEXT_LIMIT} characters with truncated: true; base64 for images, media and formats with no extractor, or when forceBase64 is set (base64 limit: ${(TOOL_BASE64_LIMIT_BYTES / 1048576).toFixed(0)} MB). A file ID carries no course, so this tool cannot anonymize: use get-submission-content or get-submission-documents when names must be scrubbed.`,
    {
      fileId: z.string().describe("The ID of the file to download"),
      forceBase64: z.boolean().default(false).describe("Return raw base64 instead of extracted text (default: false)"),
      maxChars: z.number().int().min(1000).default(TOOL_TEXT_LIMIT).describe(`Truncate extracted text beyond this length (default: ${TOOL_TEXT_LIMIT})`)
    },
    { readOnlyHint: true },
    async ({ fileId, forceBase64 = false, maxChars = TOOL_TEXT_LIMIT }: { fileId: string; forceBase64?: boolean; maxChars?: number }) => {
      try {
        const fileData = await canvas.downloadFile(fileId);
        const buf = Buffer.from(fileData.data);
        const extracted = await extractFileForTool(buf, fileData.filename, fileData.contentType, { forceBase64, maxChars });

        const response = {
          filename: fileData.filename,
          content_type: fileData.contentType,
          size: buf.byteLength,
          ...extracted,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response)
            }
          ]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to download file: ${error.message}`);
        }
        throw new Error('Failed to download file: Unknown error');
      }
    }
  );

  // Tool: get-submission-content
  server.tool(
    "get-submission-content",
    "Read one student's submission content: the student work itself, for grading. This is the lightweight per-student reader — it extracts text from PDFs, Word (.docx), HTML and text files, returns photos and scanned or handwritten PDF pages as images, converts text-entry submissions to plain text, and includes submission comments. Use it rather than get-submission-documents, which only lists attachments. get-grading-packet returns the same student work, plus the rubric and queue; read the full packet once with get-grading-packet, then read each student with this tool or with get-grading-packet's userId.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().describe("The ID of the student/user"),
      attempt: z.union([z.number().int().positive(), z.literal("all")]).optional()
        .describe("Attempt number to read, or 'all' for every attempt (default: latest attempt)"),
      renderPdfPages: z.enum(["auto", "always", "never"]).default("auto")
        .describe("'auto' renders only PDF pages with no text layer (scans, handwriting) as images; 'always' renders every page, useful for worksheets with drawn or annotated answers"),
      maxPdfPagesToRender: z.number().int().min(0).max(30).default(10).describe("Maximum PDF pages to render as images per file (default: 10)"),
      ocr: z.boolean().default(true).describe("On macOS, run Apple Vision OCR on scanned PDF pages and photos and include the text alongside the image (default: true)"),
      maxImages: z.number().int().min(0).max(40).default(15).describe("Maximum images returned in this response across all files (default: 15)"),
      maxCharsPerFile: z.number().int().min(1000).default(60000).describe("Truncate extracted text per file beyond this length (default: 60000)"),
      maxFileMB: z.number().positive().default(25).describe("Skip downloading files larger than this (default: 25 MB)"),
      anonymous: z.boolean().default(true).describe("Replace every student's name with their pseudonym, including best-effort scrubbing inside document text. Names on a \"Names:\"/\"Partner:\" line are matched against the whole course roster, so a partner reads as their own pseudonym (default: true)"),
      scrubFirstNamesInBody: z.boolean().default(false).describe("Also redact bare first names from the roster in body text. Off by default, because course content is full of words that are also student names (a student called Henry would erase \"Prince Henry\")"),
      includePartners: z.boolean().default(true).describe("Report classmates named on the work's \"Names:\"/\"Partner:\" line, with whether they submitted (default: true)"),
      comparePartnerFiles: z.boolean().default(true).describe("Compare a partner's upload against this one to say whether both submitted the same work (default: true)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, attempt, renderPdfPages = "auto", maxPdfPagesToRender = 10, ocr = true, maxImages = 15, maxCharsPerFile = 60000, maxFileMB = 25, anonymous = true, scrubFirstNamesInBody = false, includePartners = true, comparePartnerFiles = true }: {
      courseId: string;
      assignmentId: string;
      userId: string;
      attempt?: number | "all";
      renderPdfPages?: "auto" | "always" | "never";
      maxPdfPagesToRender?: number;
      ocr?: boolean;
      maxImages?: number;
      maxCharsPerFile?: number;
      maxFileMB?: number;
      anonymous?: boolean;
      scrubFirstNamesInBody?: boolean;
      includePartners?: boolean;
      comparePartnerFiles?: boolean;
    }) => {
      try {
        const content = await readSubmissionContent(canvas, courseId, assignmentId, userId, {
          attempt, renderPdfPages, maxPdfPagesToRender, ocr, maxImages, maxCharsPerFile, maxFileMB, anonymous,
          scrubFirstNamesInBody, includePartners, comparePartnerFiles,
        });
        return { content };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to read submission content: ${error.message}`);
        }
        throw new Error('Failed to read submission content: Unknown error');
      }
    }
  );
} 