#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import * as dotenv from "dotenv";
import { CanvasConfig } from './types.js';
import { CanvasClient } from './canvasClient.js';
import { registerCourseTools } from './tools/courses.js';
import { registerStudentTools } from './tools/students.js';
import { registerAssignmentTools } from './tools/assignments.js';
import { registerAssignmentGroupTools } from './tools/assignmentGroups.js';
import { registerModuleTools } from './tools/modules.js';
import { registerPageTools } from './tools/pages.js';
import { registerSectionTools } from './tools/sections.js';
import { registerSubmissionTools } from './tools/submissions.js';
import { registerRubricTools } from './tools/rubrics.js';
import { registerPrompts } from "./tools/prompts.js";
import { registerQuizTools } from "./tools/quizzes.js";
import { registerEportfolioTools } from './tools/eportfolios.js';
import { registerTodoTools } from './tools/todo.js';
import { registerNewQuizTools } from './tools/newQuizzes.js';
import { registerGradeTools } from './tools/grades.js';
import { registerConversationTools } from './tools/conversations.js';
import { registerFileTools } from './tools/files.js';
import { registerOverrideTools } from './tools/overrides.js';
import { registerQuizExtensionTools } from './tools/quizExtensions.js';
import { registerCourseSettingsTools } from './tools/courseSettings.js';
import { registerCourseCopyTools } from './tools/courseCopy.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerLatePolicyTools } from './tools/latePolicy.js';
import { registerAssignmentExtensionTools } from './tools/assignmentExtensions.js';
// Load environment variables
dotenv.config();

// Single source of truth for the version. Hardcoding it here let the server
// report 1.2.0 while the package and the extension manifest both said 1.4.0,
// which makes it impossible to tell which build is actually running.
// Resolves to the package root from both dist/ (packaged) and src/ (tsx dev).
const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

// Create the MCP server
const server = new McpServer({
  name: "Canvas MCP Server",
  version: VERSION
});

// Tool: get-server-version — lets you confirm which build a client has loaded
// without guessing from tool behaviour.
server.tool(
  "get-server-version",
  "Report the version of this Canvas MCP server build. Use it to confirm which build a client has actually loaded after installing or upgrading the extension.",
  {},
  { readOnlyHint: true },
  async () => ({
    content: [{ type: "text", text: `Canvas MCP Server v${VERSION}` }]
  })
);

// Read configuration from environment variables
const config: CanvasConfig = {
  apiToken: process.env.CANVAS_API_TOKEN || "",
  baseUrl: process.env.CANVAS_BASE_URL || "https://fhict.instructure.com",
};

// Validate configuration
if (!config.apiToken) {
  console.error("Error: CANVAS_API_TOKEN environment variable is required");
  process.exit(1);
}

// Create the CanvasClient instance
const canvas = new CanvasClient(config.baseUrl, config.apiToken);

// Tool: refresh-canvas-data — the only way to defeat the read cache.
//
// Reads are cached for 60 seconds without any network call, then revalidated
// with an ETag. Write tools invalidate what they touch, so edits made THROUGH
// this server are always reflected. Edits made anywhere else are not, and a
// stale read looks exactly like the thing not existing — this cost a wrong
// conclusion about the Canvas API during the 1.14 work.
//
// No read tool can force a refresh on its own: parameters that only change
// formatting (list-new-quiz-items' `full`) share a cache key with the plain
// call and are not a way around it.
server.tool(
  "refresh-canvas-data",
  "Discard everything this server has cached from Canvas, so the next read fetches fresh data. "
  + "Use it when Canvas was changed somewhere other than this conversation — you edited a quiz or page "
  + "in the Canvas UI, a co-teacher changed something, or a long-running job (course copy, assignment "
  + "duplication) has finished — and a read still shows the old state. Changes made by this server's own "
  + "tools do not need it. Harmless to call: it only discards cached copies, never Canvas data.",
  {},
  { readOnlyHint: true },
  async () => {
    const dropped = canvas.clearCache();
    return {
      content: [{
        type: "text",
        text: dropped === 0
          ? "Nothing was cached, so reads were already going to hit Canvas directly."
          : `Discarded ${dropped} cached response(s). The next read of each will fetch fresh data from Canvas.`
      }]
    };
  }
);

// Register course-related tools
registerCourseTools(server, canvas);
registerStudentTools(server, canvas);
registerAssignmentTools(server, canvas);
registerAssignmentGroupTools(server, canvas);
registerModuleTools(server, canvas);
registerPageTools(server, canvas);
registerSectionTools(server, canvas);
registerSubmissionTools(server, canvas);
registerRubricTools(server, canvas);
registerPrompts(server, canvas);
registerQuizTools(server, canvas);
registerEportfolioTools(server, canvas);
registerTodoTools(server, canvas);
registerNewQuizTools(server, canvas);
registerGradeTools(server, canvas);
registerConversationTools(server, canvas);
registerFileTools(server, canvas);
registerOverrideTools(server, canvas);
registerQuizExtensionTools(server, canvas);
registerCourseSettingsTools(server, canvas);
registerCourseCopyTools(server, canvas);
registerCalendarTools(server, canvas);
registerLatePolicyTools(server, canvas);
registerAssignmentExtensionTools(server, canvas);
// Start the server
async function startServer() {
  try {
    console.error("Starting Canvas MCP Server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Canvas MCP Server running on stdio");
  } catch (error) {
  console.error("Fatal error:", error);
  process.exit(1);
  }
}

startServer();