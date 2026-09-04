import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import type { CanvasFolder } from "../types.js";

function formatBytes(bytes: number | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function folderFlags(folder: any): string {
  const flags: string[] = [];
  if (folder.hidden || folder.hidden_for_user) flags.push("hidden");
  if (folder.locked || folder.locked_for_user) flags.push("locked");
  if (folder.for_submissions) flags.push("submissions");
  return flags.length ? ` [${flags.join(", ")}]` : "";
}

function fileFlags(file: any): string {
  const flags: string[] = [];
  if (file.hidden || file.hidden_for_user) flags.push("hidden");
  if (file.locked || file.locked_for_user) flags.push("locked");
  return flags.length ? ` [${flags.join(", ")}]` : "";
}

function fileContentType(file: any): string {
  return file["content-type"] || file.content_type || "unknown";
}

function formatFolderLine(folder: any, indent = ""): string {
  return `${indent}${folder.name} (ID: ${folder.id}) — ${folder.files_count ?? 0} files, ${folder.folders_count ?? 0} folders${folderFlags(folder)}`;
}

function formatFileLine(file: any, folderPath?: string, indent = ""): string {
  const name = file.display_name || file.filename || "Untitled";
  const path = folderPath ? ` | ${folderPath}` : "";
  return `${indent}${name} (ID: ${file.id})${path} | ${fileContentType(file)} | ${formatBytes(file.size)}${fileFlags(file)}`;
}

function buildFolderTree(folders: CanvasFolder[]): string {
  if (folders.length === 0) return "No folders found.";

  const byParent = new Map<number | null, CanvasFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parent_folder_id ?? null;
    const siblings = byParent.get(parentId) || [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
  }

  const knownIds = new Set(folders.map(f => f.id));
  const roots = (byParent.get(null) || []).concat(
    [...byParent.entries()]
      .filter(([parentId]) => parentId != null && !knownIds.has(parentId as number))
      .flatMap(([, children]) => children)
  );

  const seen = new Set<number>();
  const lines: string[] = [];

  const walk = (folder: CanvasFolder, depth: number) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    lines.push(formatFolderLine(folder, "  ".repeat(depth)));
    const children = byParent.get(folder.id) || [];
    for (const child of children) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);

  for (const folder of folders) {
    if (!seen.has(folder.id)) walk(folder, 0);
  }

  return lines.join("\n");
}

function fileListParams(searchTerm?: string, contentTypes?: string[]) {
  const params: any = {};
  if (searchTerm) params.search_term = searchTerm;
  if (contentTypes && contentTypes.length > 0) params["content_types[]"] = contentTypes;
  return params;
}

async function resolveTargetFolder(
  canvas: CanvasClient,
  courseId: string,
  folderId?: string,
  path?: string
): Promise<any> {
  if (path && path.trim().length > 0) {
    const chain = (await canvas.resolveFolderPath(courseId, path.trim())) as any[];
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new Error(`No folder found at path "${path}"`);
    }
    return chain[chain.length - 1];
  }
  return canvas.getFolder(courseId, folderId || "root");
}

export function registerFileTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-folders
  server.tool(
    "list-folders",
    "List folders in a course Files section. Without folderId, returns the full folder tree. With folderId, returns only immediate subfolders of that folder.",
    {
      courseId: z.string().describe("The ID of the course"),
      folderId: z.string().optional().describe("If set, list only immediate subfolders of this folder instead of the full tree")
    },
    { readOnlyHint: true },
    async ({ courseId, folderId }: { courseId: string; folderId?: string }) => {
      try {
        if (folderId) {
          const parent = (await canvas.getFolder(courseId, folderId)) as any;
          const folders = (await canvas.listFolderFolders(String(parent.id))) as any[];
          const formatted = folders.length
            ? folders
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)))
                .map((folder: any) => formatFolderLine(folder))
                .join("\n")
            : "No subfolders.";
          return {
            content: [{
              type: "text",
              text: `Subfolders of "${parent.full_name || parent.name}" (ID: ${parent.id}) in course ${courseId}:\n\n${formatted}`
            }]
          };
        }

        const folders = (await canvas.listCourseFolders(courseId)) as CanvasFolder[];
        return {
          content: [{
            type: "text",
            text: folders.length
              ? `Folders in course ${courseId} Files section:\n\n${buildFolderTree(folders)}`
              : `No folders found in course ${courseId}.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list folders: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  // Tool: list-files
  server.tool(
    "list-files",
    "List files in a course Files section. Without folderId, returns all files (with folder paths). With folderId, returns only files in that folder. Optional searchTerm and contentTypes filters.",
    {
      courseId: z.string().describe("The ID of the course"),
      folderId: z.string().optional().describe("If set, list only files in this folder"),
      searchTerm: z.string().optional().describe("Partial filename to match"),
      contentTypes: z.array(z.string()).optional().describe("Filter by content type, e.g. ['image', 'application/pdf']")
    },
    { readOnlyHint: true },
    async ({ courseId, folderId, searchTerm, contentTypes }: {
      courseId: string;
      folderId?: string;
      searchTerm?: string;
      contentTypes?: string[];
    }) => {
      try {
        const params = fileListParams(searchTerm, contentTypes);
        const files = folderId
          ? (await canvas.listFolderFiles(folderId, params)) as any[]
          : (await canvas.listCourseFiles(courseId, params)) as any[];

        let folderNames = new Map<number, string>();
        if (!folderId && files.length > 0) {
          const folders = (await canvas.listCourseFolders(courseId)) as CanvasFolder[];
          folderNames = new Map(folders.map(f => [f.id, f.full_name]));
        }

        const formatted = files
          .map((file: any) => formatFileLine(file, folderNames.get(file.folder_id)))
          .join("\n");

        const scope = folderId ? `folder ${folderId}` : `course ${courseId}`;
        return {
          content: [{
            type: "text",
            text: files.length
              ? `Files in ${scope} (${files.length}):\n\n${formatted}`
              : `No files found in ${scope}.`
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list files: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  // Tool: list-folder-contents
  server.tool(
    "list-folder-contents",
    "Browse one folder in the course Files section like the Canvas Files UI: subfolders and files together. Defaults to the course root folder. Use path relative to course files (do not include 'course files').",
    {
      courseId: z.string().describe("The ID of the course"),
      folderId: z.string().optional().describe("Folder ID to browse. Use 'root' or omit for the course Files root"),
      path: z.string().optional().describe("Folder path relative to the course root, e.g. 'Workshops/Slides'. Overrides folderId when set")
    },
    { readOnlyHint: true },
    async ({ courseId, folderId, path }: { courseId: string; folderId?: string; path?: string }) => {
      try {
        const folder = await resolveTargetFolder(canvas, courseId, folderId, path);
        const [subfolders, files] = await Promise.all([
          canvas.listFolderFolders(String(folder.id)) as Promise<any[]>,
          canvas.listFolderFiles(String(folder.id)) as Promise<any[]>
        ]);

        const lines = [
          `Folder: ${folder.name}`,
          `ID: ${folder.id}`,
          `Path: ${folder.full_name}`,
          `Files: ${files.length} | Subfolders: ${subfolders.length}${folderFlags(folder)}`,
          ""
        ];

        if (subfolders.length > 0) {
          lines.push("Subfolders:");
          const sorted = [...subfolders].sort(
            (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name))
          );
          for (const sub of sorted) lines.push(`  - ${formatFolderLine(sub)}`);
          lines.push("");
        }

        if (files.length > 0) {
          lines.push("Files:");
          for (const file of files) lines.push(`  - ${formatFileLine(file)}`);
        }

        if (subfolders.length === 0 && files.length === 0) {
          lines.push("This folder is empty.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error: any) {
        throw new Error(`Failed to list folder contents: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );
}
