import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { buildRubricAssessment, readSubmissionContent } from "../grading.js";

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
    "Write a score, grade, rubric assessment and/or comment to a student's submission. Only call this after the teacher has approved the grade, and only include comment or rubric comments when the teacher has approved that exact feedback text. Prefer `rubric` (validated against the assignment's rubric; get IDs from get-grading-packet) over the raw `rubric_assessment`.",
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
      rubric_assessment: z.any().optional().describe("Raw Canvas rubric_assessment object (advanced; unvalidated)"),
      comment: z.string().optional().describe("Submission comment students can see. Include only text the teacher approved"),
    },
    { idempotentHint: true },
    async ({ courseId, assignmentId, userId, posted_grade, score, rubric, rubric_assessment, comment }: {
      courseId: string;
      assignmentId: string;
      userId: string;
      posted_grade?: string;
      score?: number;
      rubric?: { criterionId: string; ratingId?: string; points?: number; comments?: string }[];
      rubric_assessment?: any;
      comment?: string;
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
    "Retrieve a student's submission with attachment metadata and optional file downloads. Returns submission details, file information, and optionally the actual file content.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().describe("The ID of the student/user"),
      downloadFiles: z.boolean().default(false).describe("Whether to download the actual file content (default: false, only returns metadata)"),
      anonymous: z.boolean().default(true).describe("Whether to anonymize student information (default: true for privacy)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, downloadFiles = false, anonymous = true }: { 
      courseId: string; 
      assignmentId: string; 
      userId: string; 
      downloadFiles?: boolean;
      anonymous?: boolean; 
    }) => {
      try {
        const result = await canvas.getSubmissionDocuments(courseId, assignmentId, userId, { 
          downloadFiles, 
          anonymous 
        });
        
        // Format the response nicely
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
          text_content: result.textSubmission,
          attachments: result.attachments.map((attachment: any) => ({
            id: attachment.id,
            filename: attachment.filename || attachment.display_name,
            content_type: attachment.content_type,
            size: attachment.size,
            url: downloadFiles ? '[DOWNLOADED_BELOW]' : attachment.url,
            created_at: attachment.created_at
          })),
          downloaded_files: downloadFiles ? result.downloadedFiles.map((file: any) => ({
            id: file.id,
            filename: file.filename,
            content_type: file.contentType,
            size: file.size,
            // Only include base64 data for small files or text files
            has_content: !!file.data,
            content_base64: (file.contentType?.includes('text') || file.size < 1024 * 100) // < 100KB
              ? file.dataBase64 
              : '[FILE_TOO_LARGE_FOR_DISPLAY]',
            error: file.error
          })) : []
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
    "Download the actual content of a file attached to a submission. Returns file content as base64 for binary files or as text for text files.",
    {
      fileId: z.string().describe("The ID of the file to download"),
      forceBase64: z.boolean().default(false).describe("Force return content as base64 even for text files (default: false)")
    },
    { readOnlyHint: true },
    async ({ fileId, forceBase64 = false }: { fileId: string; forceBase64?: boolean }) => {
      try {
        const fileData = await canvas.downloadFile(fileId);
        
        let content: string;
        let contentType = 'base64';
        
        // For text files, try to decode as text unless forceBase64 is true
        if (!forceBase64 && fileData.contentType.includes('text')) {
          try {
            content = Buffer.from(fileData.data).toString('utf-8');
            contentType = 'text';
          } catch {
            // If text decoding fails, fall back to base64
            content = Buffer.from(fileData.data).toString('base64');
            contentType = 'base64';
          }
        } else {
          content = Buffer.from(fileData.data).toString('base64');
          contentType = 'base64';
        }

        const response = {
          filename: fileData.filename,
          content_type: fileData.contentType,
          content_encoding: contentType,
          size: fileData.data.byteLength,
          content: content
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
    "Read a student's submitted work for grading. Extracts text from PDFs, Word (.docx), HTML and text files, returns photos and scanned/handwritten PDF pages as images, converts text-entry submissions to plain text, and includes submission comments. Use this rather than get-submission-documents when you need to read or grade the work.",
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
      anonymous: z.boolean().default(true).describe("Replace the student's name with a pseudonym, including best-effort scrubbing inside document text (default: true)")
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, attempt, renderPdfPages = "auto", maxPdfPagesToRender = 10, ocr = true, maxImages = 15, maxCharsPerFile = 60000, maxFileMB = 25, anonymous = true }: {
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
    }) => {
      try {
        const content = await readSubmissionContent(canvas, courseId, assignmentId, userId, {
          attempt, renderPdfPages, maxPdfPagesToRender, ocr, maxImages, maxCharsPerFile, maxFileMB, anonymous,
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