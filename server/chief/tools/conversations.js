// CHIEF conversation tools. ToolExecutor is the only caller. Reads use the
// existing checkpoint projection. Mutations use the same ChiefSession store.
// Permissions are independent and default off.

import { Capability } from "../core/capabilities.js";
import { searchOwnedConversations } from "../runtime/conversations.js";
import { projectInteractiveHistory } from "../runtime/history.js";
import { isScheduledSession, projectInteractiveSessions } from "../runtime/sessions.js";
import {
  CONVERSATION_DELETE_DISABLED,
  CONVERSATION_ORGANIZE_DISABLED,
  CONVERSATION_READ_DISABLED,
  conversationFlag,
} from "../security/conversation-access.js";
import { BaseTool } from "./spec.js";

const SESSION_ID = {
  type: "string",
  description: "Conversation id belonging to the authenticated user.",
};

function sessionIdOf(params) {
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
  return sessionId || null;
}

function notFound() {
  return { output: "session not found", isError: true };
}

function disabled(message) {
  return { output: message, isError: true };
}

function conversationList(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_list",
      description:
        "List this user's interactive CHIEF conversations: id, title, created, and updated. Read-only. Omits scheduled runs and archived conversations unless includeArchived is true. Does not enable access and does not return transcripts.",
      category: "conversation",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CONVERSATION_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          includeArchived: {
            type: "boolean",
            description: "When true, list archived conversations instead of active ones.",
          },
        },
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationRead"))) {
        return disabled(CONVERSATION_READ_DISABLED);
      }
      if (params?.includeArchived != null && typeof params.includeArchived !== "boolean") {
        return { output: "includeArchived must be a boolean", isError: true };
      }
      const rows = await store.listOwnedSessions(context.userId);
      const sessions = projectInteractiveSessions(rows, {
        archivedOnly: params?.includeArchived === true,
      });
      return { output: JSON.stringify({ sessions }) };
    },
  });
}

function conversationRead(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_read",
      description:
        "Read one of this user's interactive CHIEF conversations. Read-only. Returns the title and visible messages. Does not return scheduled runs, ciphertext, or approval state, and does not enable access.",
      category: "conversation",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CONVERSATION_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { sessionId: SESSION_ID },
        required: ["sessionId"],
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationRead"))) {
        return disabled(CONVERSATION_READ_DISABLED);
      }
      const sessionId = sessionIdOf(params);
      if (!sessionId) return { output: "sessionId is required", isError: true };
      const record = await store.load(context.userId, sessionId);
      if (!record || isScheduledSession(record)) return notFound();
      const history = projectInteractiveHistory(record);
      if (history.error) return notFound();
      return {
        output: JSON.stringify({
          sessionId: history.sessionId,
          title: typeof record.title === "string" ? record.title : null,
          messages: history.messages,
        }),
      };
    },
  });
}

function conversationSearch(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_search",
      description:
        "Search this user's interactive CHIEF conversations by title, date, or message text. Read-only. A date-only search returns titles and times, not full transcripts. Does not search scheduled runs or another user's conversations, and does not enable access.",
      category: "conversation",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CONVERSATION_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Text to match in the title or messages." },
          after: { type: "string", description: "Only conversations updated at or after this ISO date." },
          before: { type: "string", description: "Only conversations updated at or before this ISO date." },
          includeArchived: { type: "boolean" },
        },
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationRead"))) {
        return disabled(CONVERSATION_READ_DISABLED);
      }
      const found = await searchOwnedConversations(store, context.userId, params ?? {});
      if (found.error) return { output: found.error, isError: true };
      return { output: JSON.stringify({ results: found.results }) };
    },
  });
}

function mutationResult(result) {
  if (result?.error === "not_found") return notFound();
  if (result?.error === "pending_approval") {
    return {
      output: "This conversation is waiting for approval and cannot be archived.",
      isError: true,
    };
  }
  if (result?.error === "not_archived") {
    return { output: "That conversation is not archived.", isError: true };
  }
  if (result?.error === "invalid_title") {
    return { output: "A conversation title must be 1 to 120 characters.", isError: true };
  }
  if (!result?.ok) return { output: "conversation update failed", isError: true };
  return { output: JSON.stringify(result) };
}

function conversationRename(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_rename",
      description:
        "Rename one of this user's interactive CHIEF conversations. Requires Conversation Organize and confirmation. Does not delete, does not grant delete, and does not enable access.",
      category: "conversation",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.CONVERSATION_ORGANIZE],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: SESSION_ID,
          title: { type: "string", description: "New title, 1 to 120 characters." },
        },
        required: ["sessionId", "title"],
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationOrganize"))) {
        return disabled(CONVERSATION_ORGANIZE_DISABLED);
      }
      const sessionId = sessionIdOf(params);
      if (!sessionId) return { output: "sessionId is required", isError: true };
      return mutationResult(await store.renameSession(context.userId, sessionId, params?.title));
    },
  });
}

function conversationArchive(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_archive",
      description:
        "Archive one of this user's interactive CHIEF conversations. Requires Conversation Organize and confirmation. Refuses a conversation that is waiting for approval. Does not delete it.",
      category: "conversation",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.CONVERSATION_ORGANIZE],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { sessionId: SESSION_ID },
        required: ["sessionId"],
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationOrganize"))) {
        return disabled(CONVERSATION_ORGANIZE_DISABLED);
      }
      const sessionId = sessionIdOf(params);
      if (!sessionId) return { output: "sessionId is required", isError: true };
      return mutationResult(await store.archiveSession(context.userId, sessionId));
    },
  });
}

function conversationRestore(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_restore",
      description:
        "Restore one of this user's archived CHIEF conversations. Requires Conversation Organize and confirmation. Does not delete it.",
      category: "conversation",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.CONVERSATION_ORGANIZE],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { sessionId: SESSION_ID },
        required: ["sessionId"],
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationOrganize"))) {
        return disabled(CONVERSATION_ORGANIZE_DISABLED);
      }
      const sessionId = sessionIdOf(params);
      if (!sessionId) return { output: "sessionId is required", isError: true };
      return mutationResult(await store.restoreSession(context.userId, sessionId));
    },
  });
}

function conversationDelete(store, access) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "conversation_delete",
      description:
        "Permanently delete one of this user's interactive CHIEF conversations. Requires Conversation Delete and explicit confirmation. Organize access is not enough. This cannot be undone. A fork of the conversation is kept.",
      category: "conversation",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.CONVERSATION_DELETE],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { sessionId: SESSION_ID },
        required: ["sessionId"],
      },
    },
    async execute(params, context) {
      if (!(await conversationFlag(access, context.userId, "conversationDelete"))) {
        return disabled(CONVERSATION_DELETE_DISABLED);
      }
      const sessionId = sessionIdOf(params);
      if (!sessionId) return { output: "sessionId is required", isError: true };
      return mutationResult(await store.deleteSession(context.userId, sessionId));
    },
  });
}

export function createConversationTools({ store, access }) {
  return [
    conversationList(store, access),
    conversationRead(store, access),
    conversationSearch(store, access),
    conversationRename(store, access),
    conversationArchive(store, access),
    conversationRestore(store, access),
    conversationDelete(store, access),
  ];
}
