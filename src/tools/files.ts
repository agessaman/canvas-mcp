import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageSize } from "../imageMeta.js";

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

// Canvas has no "published" field on a file. Availability is the combination of
// two flags, which is why the Files UI has three states rather than a checkbox:
//
//   locked=true              -> Unpublished. Students cannot see it at all.
//   locked=false hidden=true -> Published but not listed; reachable only by a
//                               direct link, e.g. from a page or assignment.
//   both false               -> Published and visible in Files.
//
// unlock_at / lock_at schedule the transition, and Canvas reports a file with
// dates set as 'scheduled' regardless of the flags.
type FileState = 'published' | 'unpublished' | 'link-only';

function describeState(file: any): string {
  if (file?.locked) return 'unpublished';
  if (file?.unlock_at || file?.lock_at) return 'scheduled';
  if (file?.hidden) return 'link-only';
  return 'published';
}

function flagsForState(state: FileState): { locked: boolean; hidden: boolean } {
  switch (state) {
    case 'unpublished': return { locked: true, hidden: false };
    case 'link-only': return { locked: false, hidden: true };
    case 'published': return { locked: false, hidden: false };
  }
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
    "Upload a local file into a course's Files area (syllabus PDFs, handouts, images). Give the path to a file on this machine. Folders are addressed by path, e.g. \"/Handouts/Unit 1\" — Canvas creates the folder if it does not exist. Whether an upload lands published varies by course and folder, so check with list-course-files and use set-file-availability if students need to see it.",
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

  // Tool: set-file-availability
  server.tool(
    "set-file-availability",
    "Publish or unpublish a file in a course's Files area, or make it available by direct link only. 'published' = visible in Files; 'unpublished' = hidden from students entirely; 'link-only' = not listed, but reachable from a link on a page or assignment. Find file IDs with list-course-files.",
    {
      fileId: z.string().describe("The file's ID (from list-course-files)"),
      state: z.enum(['published', 'unpublished', 'link-only']).describe("Desired availability"),
      availableFrom: z.string().optional().describe("Publish automatically at this time (ISO 8601). Only meaningful with state 'published'."),
      availableUntil: z.string().optional().describe("Stop being available at this time (ISO 8601). Only meaningful with state 'published'.")
    },
    { idempotentHint: true },
    async (args: any) => {
      try {
        const payload: any = flagsForState(args.state);
        if (args.availableFrom !== undefined) payload.unlock_at = args.availableFrom;
        if (args.availableUntil !== undefined) payload.lock_at = args.availableUntil;

        const updated: any = await canvas.updateFile(args.fileId, payload);

        // Canvas answers 200 on writes it has quietly not applied — that has
        // bitten this server three times — so confirm from what came back
        // rather than reporting the state that was asked for.
        const actual = describeState(updated);
        const name = updated?.display_name ?? updated?.filename ?? args.fileId;
        const scheduled = args.availableFrom || args.availableUntil;
        if (actual !== args.state && !(scheduled && actual === 'scheduled')) {
          return {
            content: [{
              type: "text",
              text: `WARNING: asked Canvas to set "${name}" to ${args.state}, but it reports "${actual}" `
                + `(locked=${updated?.locked}, hidden=${updated?.hidden}). The change may not have applied — `
                + `check the file in Canvas.`
            }]
          };
        }
        const window = scheduled
          ? ` Available ${args.availableFrom ?? 'now'}${args.availableUntil ? ` until ${args.availableUntil}` : ''}.`
          : '';
        return {
          content: [{ type: "text", text: `"${name}" is now ${actual}.${window}` }]
        };
      } catch (error: any) {
        throw new Error(`Failed to set file availability: ${error.message ?? 'Unknown error'}`);
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
        // A folder listing has to go to /folders/:id/files. Passing folder_id to
        // the course endpoint looks like it works and quietly returns the whole
        // course instead.
        const files = args.folderId
          ? await canvas.listFolderFiles(args.folderId, params)
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
          // Two flags decoded into the state the Canvas UI actually shows.
          state: describeState(file),
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

  // Tool: get-course-file
  //
  // Read-only counterpart to upload-course-file. Added because placing a
  // hot-spot on an image already in Canvas meant placing it blind: nothing in
  // this server could see the picture, and list-course-files does not even
  // return a URL. Guessing coordinates for an unseen image is how the first
  // round of hotspots came out well-formed and pointing at the wrong place.
  server.tool(
    "get-course-file",
    "Fetch a file from a course's Files area so it can be looked at — the read-only counterpart to upload-course-file. "
    + "For an image this returns the picture itself along with its PIXEL DIMENSIONS, which is what hot-spot coordinates "
    + "need: pass them to create-new-quiz-item as imagePixelWidth/imagePixelHeight and give the hotspot in pixels. "
    + "Use saveToPath to write the file to disk instead of returning it inline, which is much cheaper for a large image. "
    + "Find file IDs with list-course-files.",
    {
      fileId: z.string().describe("The file's ID (from list-course-files)"),
      saveToPath: z.string().optional().describe(
        "Absolute path to write the file to. When given, the file is saved and only a summary is returned — "
        + "use this for large images rather than pulling the whole thing inline."
      ),
    },
    { readOnlyHint: true },
    async ({ fileId, saveToPath }: { fileId: string; saveToPath?: string }) => {
      try {
        const file = await canvas.downloadFile(fileId);
        const buffer = Buffer.from(file.data);
        const size = readImageSize(buffer);

        // The dimensions are the point of this tool for quiz authoring, so
        // they lead. An image whose header this cannot read says so rather
        // than reporting a plausible-looking guess.
        const lines = [
          `File ${fileId}: ${file.filename}`,
          `Type: ${file.contentType}, ${buffer.length} bytes`,
          size
            ? `Dimensions: ${size.width} x ${size.height} px`
            : 'Dimensions: could not be read from the file header'
            + (file.contentType.startsWith('image/')
              ? ' — hot-spot coordinates would have to be given as fractions.'
              : ' (not a recognised image format).'),
        ];

        if (saveToPath) {
          if (!path.isAbsolute(saveToPath)) {
            throw new Error(`saveToPath must be an absolute path (got "${saveToPath}")`);
          }
          await writeFile(saveToPath, buffer);
          lines.push(`Saved to: ${saveToPath}`);
          return { content: [{ type: "text", text: lines.join('\n') }] };
        }

        // Hand back the actual picture when it is one, so it can be looked at
        // rather than described. A file that is not an image is summarised
        // instead of being dumped as base64 nobody can read.
        if (size) {
          return {
            content: [
              { type: "text", text: lines.join('\n') },
              { type: "image", data: buffer.toString('base64'), mimeType: `image/${size.format}` },
            ],
          };
        }
        lines.push('Not returned inline. Use saveToPath to write it to disk.');
        return { content: [{ type: "text", text: lines.join('\n') }] };
      } catch (error: any) {
        throw new Error(`Failed to get course file: ${error.message ?? 'Unknown error'}`);
      }
    }
  );
}
