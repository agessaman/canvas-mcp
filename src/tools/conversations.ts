import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

// Read-only by design. Canvas supports POST /api/v1/conversations, but this
// server deliberately does not expose it: a message from a student deserves a
// human-written reply. These tools are for triage and turning the inbox into
// action items, not for sending.

export function registerConversationTools(server: McpServer, canvas: CanvasClient) {
  // Tool: list-conversations
  server.tool(
    "list-conversations",
    "List messages in the Canvas inbox (read-only). Returns participants, subject, a preview, and read state — use get-conversation for the full thread. Does not send anything.",
    {
      scope: z.enum(['inbox', 'unread', 'starred', 'archived', 'sent']).default('inbox').describe("Which mailbox to read"),
      courseId: z.string().optional().describe("Optional: only conversations scoped to this course"),
      limit: z.number().default(25).describe("Maximum conversations to return")
    },
    { readOnlyHint: true },
    async ({ scope = 'inbox', courseId, limit = 25 }: { scope?: string; courseId?: string; limit?: number }) => {
      try {
        const params: any = { per_page: Math.min(Math.max(limit, 1), 100) };
        // 'inbox' is the API default and is rejected as an explicit scope value.
        if (scope !== 'inbox') params.scope = scope;
        if (courseId) params.filter = [`course_${courseId}`];

        const conversations = (await canvas.listConversations(params)) ?? [];

        const rows = conversations.slice(0, limit).map((c: any) => ({
          id: c.id,
          subject: c.subject || '(no subject)',
          participants: (c.participants ?? []).map((p: any) => p.name),
          message_count: c.message_count,
          unread: c.workflow_state === 'unread',
          starred: c.starred ?? false,
          last_message_at: c.last_message_at,
          context_name: c.context_name ?? null,
          preview: c.last_message ?? null,
        }));

        const unreadCount = rows.filter(r => r.unread).length;

        return {
          content: [{
            type: "text",
            text: rows.length > 0
              ? `${rows.length} conversation(s) in ${scope} (${unreadCount} unread):\n\n${JSON.stringify(rows, null, 2)}`
              : `No conversations found in ${scope}.`
          }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to list conversations: ${error.message}`);
        }
        throw new Error('Failed to list conversations: Unknown error');
      }
    }
  );

  // Tool: get-conversation
  server.tool(
    "get-conversation",
    "Read the full message thread of a single conversation, including every message body and author (read-only). Use this to draft action items from what a student actually wrote.",
    {
      conversationId: z.string().describe("The ID of the conversation"),
      markAsRead: z.boolean().default(false).describe("Whether opening the thread should mark it read in Canvas (default: false, leaves your inbox untouched)")
    },
    { readOnlyHint: true },
    async ({ conversationId, markAsRead = false }: { conversationId: string; markAsRead?: boolean }) => {
      try {
        // auto_mark_as_read defaults to true server-side, so send it explicitly.
        const conversation = await canvas.getConversation(conversationId, {
          auto_mark_as_read: markAsRead
        }) as any;

        const participantById = new Map<string, string>(
          (conversation.participants ?? []).map((p: any) => [String(p.id), p.name])
        );

        const thread = (conversation.messages ?? []).map((m: any) => ({
          author: participantById.get(String(m.author_id)) ?? `User ${m.author_id}`,
          created_at: m.created_at,
          body: m.body,
          attachments: (m.attachments ?? []).map((a: any) => a.display_name),
        }));

        const summary = {
          id: conversation.id,
          subject: conversation.subject || '(no subject)',
          context_name: conversation.context_name ?? null,
          participants: [...participantById.values()],
          message_count: thread.length,
          messages: thread,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch conversation: ${error.message}`);
        }
        throw new Error('Failed to fetch conversation: Unknown error');
      }
    }
  );

  // Tool: get-unread-message-count
  server.tool(
    "get-unread-message-count",
    "Get the number of unread Canvas inbox messages.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const result = await canvas.getConversationsUnreadCount() as any;
        return {
          content: [{ type: "text", text: `Unread conversations: ${result.unread_count ?? 0}` }]
        };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch unread count: ${error.message}`);
        }
        throw new Error('Failed to fetch unread count: Unknown error');
      }
    }
  );
}
