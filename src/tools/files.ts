import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// Course files — the Files area of a course, where syllabi, handouts and
// images live. Uploading is a three-step handshake; see uploadCourseFile in
// canvasClient.ts for what Canvas actually requires.

// Enough to cover what a teacher actually uploads. Canvas will sniff anything
// it doesn't recognise, so an unknown extension is not fatal.
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.rtf': 'application/rtf',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
};

function guessContentType(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function registerFileTools(server: McpServer, canvas: CanvasClient) {
  // Tool: upload-course-file
  server.tool(
    "upload-course-file",
    "Upload a local file into a course's Files area (syllabus PDFs, handouts, images). Give the path to a file on this machine. Folders are addressed by path, e.g. \"/Handouts/Unit 1\" — Canvas creates the folder if it does not exist. Uploaded files are unpublished by default in most courses, so students may not see them until published in Canvas.",
    {
      courseId: z.string().describe("The ID of the course"),
      filePath: z.string().describe("Absolute path to the file on this machine"),
      fileName: z.string().optional().describe("Name to store it under in Canvas (defaults to the local file name)"),
      folderPath: z.string().optional().describe("Destination folder path within the course, e.g. \"/Handouts\". Defaults to the course's root folder."),
      folderId: z.string().optional().describe("Destination folder by ID instead of path — takes precedence over folderPath"),
      onDuplicate: z.enum(['rename', 'overwrite']).optional().describe("What to do if a file of that name already exists in the folder. Default 'rename' keeps both; 'overwrite' replaces the existing file and CANNOT be undone."),
      contentType: z.string().optional().describe("MIME type override; guessed from the extension when omitted")
    },
    { destructiveHint: false },
    async (args: any) => {
      try {
        let info;
        try {
          info = await stat(args.filePath);
        } catch {
          throw new Error(`No file at ${args.filePath} (the path must be on the machine running this server, and absolute).`);
        }
        if (!info.isFile()) {
          throw new Error(`${args.filePath} is a directory, not a file.`);
        }

        const name = args.fileName ?? path.basename(args.filePath);
        const contents = await readFile(args.filePath);
        const uploaded = await canvas.uploadCourseFile(
          args.courseId,
          {
            name,
            size: info.size,
            contentType: args.contentType ?? guessContentType(name),
            parentFolderPath: args.folderPath,
            parentFolderId: args.folderId,
            onDuplicate: args.onDuplicate,
          },
          contents
        );

        const where = uploaded?.folder_id ? ` in folder ${uploaded.folder_id}` : '';
        // Canvas renames rather than clobbers by default, so say what it ended
        // up called — a silently renamed file is a link that won't resolve.
        const renamed = uploaded?.display_name && uploaded.display_name !== name
          ? ` Canvas stored it as "${uploaded.display_name}" because that name was taken.`
          : '';
        return {
          content: [{
            type: "text",
            text: `Uploaded "${name}" (${humanSize(info.size)}) to course ${args.courseId}${where}. `
              + `File ID ${uploaded?.id ?? 'unknown'}.${renamed}`
              + (uploaded?.url ? `\nURL: ${uploaded.url}` : '')
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to upload file: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-course-files
  server.tool(
    "list-course-files",
    "List files in a course's Files area, so you can find a file's ID or check what is already there before uploading.",
    {
      courseId: z.string().describe("The ID of the course"),
      searchTerm: z.string().optional().describe("Only return files whose name contains this (Canvas requires at least 3 characters)"),
      folderId: z.string().optional().describe("Only list files in this folder")
    },
    { readOnlyHint: true },
    async (args: any) => {
      try {
        const params: any = {};
        if (args.searchTerm) params.search_term = args.searchTerm;
        const files = args.folderId
          ? await canvas.listCourseFiles(args.courseId, { ...params, folder_id: args.folderId })
          : await canvas.listCourseFiles(args.courseId, params);

        if (files.length === 0) {
          return { content: [{ type: "text", text: "No files found." }] };
        }
        const rows = files.map((file: any) => ({
          id: file.id,
          name: file.display_name ?? file.filename,
          size: humanSize(file.size ?? 0),
          content_type: file['content-type'] ?? file.content_type,
          folder_id: file.folder_id,
          locked: file.locked ?? false,
          updated_at: file.updated_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to list course files: ${error.message ?? 'Unknown error'}`);
      }
    }
  );

  // Tool: list-course-folders
  server.tool(
    "list-course-folders",
    "List the folders in a course's Files area, with their full paths — use this to pick a destination for upload-course-file.",
    {
      courseId: z.string().describe("The ID of the course")
    },
    { readOnlyHint: true },
    async ({ courseId }: { courseId: string }) => {
      try {
        const folders = await canvas.listCourseFolders(courseId);
        if (folders.length === 0) {
          return { content: [{ type: "text", text: "No folders found." }] };
        }
        const rows = folders.map((folder: any) => ({
          id: folder.id,
          path: folder.full_name,
          files: folder.files_count,
          locked: folder.locked ?? false,
        }));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (error: any) {
        throw new Error(`Failed to list course folders: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
