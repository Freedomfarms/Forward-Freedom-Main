import { withUserContext } from "../db/prisma.js";
import { AgentError, isAgentError } from "./errors.js";
import {
  CHAT_HISTORY_DEFAULT_LIMIT,
  decodeVisibleChatMessages,
  serializeChatHistoryMessages,
} from "./chatMessageCodec.js";

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const MESSAGES_MAX_LIMIT = 100;

// Sentinel used when AgentConversation / conversationId are not migrated yet.
// The multi-chat UI treats this as the single Original thread; message
// reads/writes omit conversationId and scope by agent XOR columns instead.
export const LEGACY_SINGLE_THREAD_ID = "legacy-single-thread";

/** True when the AgentConversation migration has not been applied yet. */
export function isMissingAgentConversationError(error) {
  const message = String(error?.message || "");
  return (
    (error?.code === "P2021" || error?.code === "P2022") &&
    (/AgentConversation/i.test(message) ||
      (/conversationId/i.test(message) &&
        /does not exist|Unknown column|column .* not found/i.test(message)))
  );
}

export function isLegacyConversationId(conversationId) {
  return conversationId == null || conversationId === LEGACY_SINGLE_THREAD_ID;
}

/** Fields to set on AgentChatMessage creates when multi-chat is available. */
export function chatMessageConversationData(conversationId) {
  if (isLegacyConversationId(conversationId)) return {};
  return { conversationId };
}

/**
 * Where-clause for AgentChatMessage history. Legacy mode scopes by the agent
 * XOR columns (pre-multi-chat single thread); migrated mode uses conversationId.
 */
export function chatMessageConversationWhere(
  conversationId,
  { userId, agentConfigId = null, ceoAgentConfigId = null }
) {
  if (isLegacyConversationId(conversationId)) {
    return {
      userId,
      agentConfigId: agentConfigId ?? null,
      ceoAgentConfigId: ceoAgentConfigId ?? null,
    };
  }
  return { userId, conversationId };
}

export function serializeLegacyConversation({
  agentConfigId = null,
  ceoAgentConfigId = null,
  isSystem = false,
  title = "Original thread",
} = {}) {
  return {
    id: LEGACY_SINGLE_THREAD_ID,
    agentConfigId: agentConfigId ?? null,
    ceoAgentConfigId: ceoAgentConfigId ?? null,
    title,
    isSystem: Boolean(isSystem),
    createdAt: null,
    updatedAt: null,
    archivedAt: null,
  };
}

function assertChatTarget({ agentConfigId = null, ceoAgentConfigId = null }) {
  if (Boolean(agentConfigId) === Boolean(ceoAgentConfigId)) {
    throw new AgentError(
      "Provide exactly one of agentConfigId or ceoAgentConfigId.",
      "INVALID_CHAT_TARGET",
      400
    );
  }
}

function clampLimit(raw, { fallback, max }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseBefore(raw) {
  if (raw == null || raw === "") return null;
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    throw new AgentError("before must be a valid ISO-8601 timestamp.", "INVALID_AGENT_PAYLOAD", 400);
  }
  return parsed;
}

function conversationsUnavailableError() {
  return new AgentError(
    "Multi-chat is temporarily unavailable while the database migration completes. Refresh and try again shortly.",
    "CONVERSATIONS_UNAVAILABLE",
    503
  );
}

/** JSON-safe conversation row for API responses. */
export function serializeConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentConfigId: row.agentConfigId ?? null,
    ceoAgentConfigId: row.ceoAgentConfigId ?? null,
    title: row.title ?? null,
    isSystem: Boolean(row.isSystem),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt ?? null,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt ?? null,
    archivedAt:
      row.archivedAt instanceof Date
        ? row.archivedAt.toISOString()
        : row.archivedAt ?? null,
  };
}

/**
 * Resolve the active default conversation for a CEO or sub-agent chat target.
 * Omits system conversations. Creates an "Original thread" when none exists.
 * When AgentConversation is unmigrated, returns the legacy single-thread sentinel.
 */
export async function ensureDefaultConversation(
  tx,
  { userId, agentConfigId = null, ceoAgentConfigId = null, title = "Original thread" }
) {
  if (!userId) {
    throw new AgentError("ensureDefaultConversation requires userId.", "INVALID_ARGUMENT", 400);
  }
  assertChatTarget({ agentConfigId, ceoAgentConfigId });

  try {
    const existing = await tx.agentConversation.findFirst({
      where: {
        userId,
        agentConfigId: agentConfigId ?? null,
        ceoAgentConfigId: ceoAgentConfigId ?? null,
        isSystem: false,
        archivedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (existing) return existing;

    return await tx.agentConversation.create({
      data: {
        userId,
        agentConfigId: agentConfigId ?? null,
        ceoAgentConfigId: ceoAgentConfigId ?? null,
        title,
        isSystem: false,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isMissingAgentConversationError(error)) {
      return { id: LEGACY_SINGLE_THREAD_ID };
    }
    throw error;
  }
}

/**
 * CEO-only system conversation for "+ New Agent" creation. Hidden from list
 * APIs (isSystem=true). One per CEO config; reused across creation sessions.
 * Falls back to the legacy sentinel when AgentConversation is unmigrated.
 */
export async function ensureSystemConversation(tx, { userId, ceoAgentConfigId }) {
  if (!userId || !ceoAgentConfigId) {
    throw new AgentError(
      "ensureSystemConversation requires userId and ceoAgentConfigId.",
      "INVALID_ARGUMENT",
      400
    );
  }

  try {
    const existing = await tx.agentConversation.findFirst({
      where: {
        userId,
        ceoAgentConfigId,
        agentConfigId: null,
        isSystem: true,
      },
      select: { id: true },
    });
    if (existing) return existing;

    return await tx.agentConversation.create({
      data: {
        userId,
        ceoAgentConfigId,
        agentConfigId: null,
        title: "New Agent",
        isSystem: true,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isMissingAgentConversationError(error)) {
      return { id: LEGACY_SINGLE_THREAD_ID };
    }
    throw error;
  }
}

/**
 * Resolve which conversation a message write should use.
 * Explicit conversationId must belong to the user, match the chat target,
 * and (unless allowSystem) must not be the system creation thread.
 */
export async function resolveConversationForWrite(
  tx,
  {
    userId,
    agentConfigId = null,
    ceoAgentConfigId = null,
    conversationId = null,
    allowSystem = false,
  }
) {
  assertChatTarget({ agentConfigId, ceoAgentConfigId });

  if (isLegacyConversationId(conversationId)) {
    if (conversationId === LEGACY_SINGLE_THREAD_ID) {
      return { id: LEGACY_SINGLE_THREAD_ID };
    }
    return ensureDefaultConversation(tx, { userId, agentConfigId, ceoAgentConfigId });
  }

  try {
    const row = await tx.agentConversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!row) {
      throw new AgentError("Conversation not found.", "CONVERSATION_NOT_FOUND", 404);
    }

    const targetAgent = agentConfigId ?? null;
    const targetCeo = ceoAgentConfigId ?? null;
    if (row.agentConfigId !== targetAgent || row.ceoAgentConfigId !== targetCeo) {
      throw new AgentError(
        "Conversation does not belong to this agent chat.",
        "CONVERSATION_TARGET_MISMATCH",
        400
      );
    }
    if (row.isSystem && !allowSystem) {
      throw new AgentError(
        "System conversations cannot be used for regular chat.",
        "CONVERSATION_SYSTEM_FORBIDDEN",
        400
      );
    }
    if (row.archivedAt) {
      throw new AgentError(
        "This conversation is archived. Unarchive it before sending messages.",
        "CONVERSATION_ARCHIVED",
        400
      );
    }

    return { id: row.id };
  } catch (error) {
    if (isAgentError(error)) throw error;
    if (isMissingAgentConversationError(error)) {
      return { id: LEGACY_SINGLE_THREAD_ID };
    }
    throw error;
  }
}

/** Bump conversation activity timestamp (list ordering). No-op in legacy mode. */
export async function touchConversation(tx, conversationId) {
  if (isLegacyConversationId(conversationId)) return;
  try {
    await tx.agentConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    if (isMissingAgentConversationError(error)) return;
    throw error;
  }
}

async function assertAgentTargetOwned(tx, userId, { agentConfigId = null, ceoAgentConfigId = null }) {
  assertChatTarget({ agentConfigId, ceoAgentConfigId });
  if (agentConfigId) {
    const agent = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
      select: { id: true },
    });
    if (!agent) throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    return;
  }
  const ceo = await tx.ceoAgentConfig.findFirst({
    where: { id: ceoAgentConfigId, userId },
    select: { id: true },
  });
  if (!ceo) throw new AgentError("CEO Agent not found.", "CEO_AGENT_NOT_FOUND", 404);
}

/** Create a new (empty) non-system conversation for an agent target. */
export async function createConversation({
  userId,
  agentConfigId = null,
  ceoAgentConfigId = null,
  title = null,
} = {}) {
  if (!userId) {
    throw new AgentError("createConversation requires userId.", "INVALID_ARGUMENT", 400);
  }

  return withUserContext(userId, async (tx) => {
    await assertAgentTargetOwned(tx, userId, { agentConfigId, ceoAgentConfigId });
    try {
      const row = await tx.agentConversation.create({
        data: {
          userId,
          agentConfigId: agentConfigId ?? null,
          ceoAgentConfigId: ceoAgentConfigId ?? null,
          title: typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : null,
          isSystem: false,
        },
      });
      return serializeConversation(row);
    } catch (error) {
      if (isMissingAgentConversationError(error)) {
        // Pre-migration: surface the single legacy thread instead of 500ing.
        return serializeLegacyConversation({
          agentConfigId,
          ceoAgentConfigId,
          title:
            typeof title === "string" && title.trim()
              ? title.trim().slice(0, 120)
              : "Original thread",
        });
      }
      throw error;
    }
  });
}

/**
 * List non-system conversations for an agent target.
 * Default: archived excluded. Pagination: limit + before(updatedAt) + hasMore.
 * When AgentConversation is unmigrated, returns one synthetic Original thread.
 */
export async function listConversations({
  userId,
  agentConfigId = null,
  ceoAgentConfigId = null,
  limit = LIST_DEFAULT_LIMIT,
  before = null,
  includeArchived = false,
} = {}) {
  if (!userId) {
    throw new AgentError("listConversations requires userId.", "INVALID_ARGUMENT", 400);
  }
  const take = clampLimit(limit, { fallback: LIST_DEFAULT_LIMIT, max: LIST_MAX_LIMIT });
  const beforeDate = parseBefore(before);

  return withUserContext(userId, async (tx) => {
    await assertAgentTargetOwned(tx, userId, { agentConfigId, ceoAgentConfigId });
    try {
      const rows = await tx.agentConversation.findMany({
        where: {
          userId,
          agentConfigId: agentConfigId ?? null,
          ceoAgentConfigId: ceoAgentConfigId ?? null,
          isSystem: false,
          ...(includeArchived ? {} : { archivedAt: null }),
          ...(beforeDate ? { updatedAt: { lt: beforeDate } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take,
      });
      return {
        conversations: rows.map(serializeConversation),
        hasMore: rows.length === take,
      };
    } catch (error) {
      if (isMissingAgentConversationError(error)) {
        return {
          conversations: [
            serializeLegacyConversation({ agentConfigId, ceoAgentConfigId }),
          ],
          hasMore: false,
        };
      }
      throw error;
    }
  });
}

async function loadOwnedConversation(tx, userId, conversationId) {
  if (conversationId === LEGACY_SINGLE_THREAD_ID) {
    throw new AgentError("Conversation not found.", "CONVERSATION_NOT_FOUND", 404);
  }
  try {
    const row = await tx.agentConversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!row) {
      throw new AgentError("Conversation not found.", "CONVERSATION_NOT_FOUND", 404);
    }
    return row;
  } catch (error) {
    if (isAgentError(error)) throw error;
    if (isMissingAgentConversationError(error)) throw conversationsUnavailableError();
    throw error;
  }
}

/** Rename and/or archive/unarchive a non-system conversation. */
export async function updateConversation({
  userId,
  conversationId,
  title,
  archived,
} = {}) {
  if (!userId || !conversationId) {
    throw new AgentError(
      "updateConversation requires userId and conversationId.",
      "INVALID_ARGUMENT",
      400
    );
  }
  if (conversationId === LEGACY_SINGLE_THREAD_ID) {
    throw conversationsUnavailableError();
  }
  if (title === undefined && archived === undefined) {
    throw new AgentError(
      "Provide title and/or archived to update the conversation.",
      "INVALID_AGENT_PAYLOAD",
      400
    );
  }

  return withUserContext(userId, async (tx) => {
    const existing = await loadOwnedConversation(tx, userId, conversationId);
    if (existing.isSystem) {
      throw new AgentError(
        "System conversations cannot be modified.",
        "CONVERSATION_SYSTEM_FORBIDDEN",
        400
      );
    }

    const data = {};
    if (title !== undefined) {
      if (title === null) {
        data.title = null;
      } else if (typeof title === "string") {
        const trimmed = title.trim();
        data.title = trimmed ? trimmed.slice(0, 120) : null;
      } else {
        throw new AgentError("title must be a string or null.", "INVALID_AGENT_PAYLOAD", 400);
      }
    }
    if (archived !== undefined) {
      if (typeof archived !== "boolean") {
        throw new AgentError("archived must be a boolean.", "INVALID_AGENT_PAYLOAD", 400);
      }
      data.archivedAt = archived ? existing.archivedAt || new Date() : null;
    }

    try {
      const row = await tx.agentConversation.update({
        where: { id: existing.id },
        data,
      });
      return serializeConversation(row);
    } catch (error) {
      if (isMissingAgentConversationError(error)) throw conversationsUnavailableError();
      throw error;
    }
  });
}

/** Hard-delete a non-system conversation (CASCADE removes its messages). */
export async function deleteConversation({ userId, conversationId } = {}) {
  if (!userId || !conversationId) {
    throw new AgentError(
      "deleteConversation requires userId and conversationId.",
      "INVALID_ARGUMENT",
      400
    );
  }
  if (conversationId === LEGACY_SINGLE_THREAD_ID) {
    throw conversationsUnavailableError();
  }

  return withUserContext(userId, async (tx) => {
    const existing = await loadOwnedConversation(tx, userId, conversationId);
    if (existing.isSystem) {
      throw new AgentError(
        "System conversations cannot be deleted.",
        "CONVERSATION_SYSTEM_FORBIDDEN",
        400
      );
    }
    try {
      await tx.agentConversation.delete({ where: { id: existing.id } });
      return { deleted: true, id: existing.id };
    } catch (error) {
      if (isMissingAgentConversationError(error)) throw conversationsUnavailableError();
      throw error;
    }
  });
}

/**
 * Paginated visible messages for one conversation (creation-state rows hidden).
 * Pagination: limit + before(createdAt) + hasMore.
 * agentConfigId / ceoAgentConfigId are required for the legacy-sentinel path
 * (when AgentConversation is unmigrated) so messages can be scoped by agent XOR.
 */
export async function listConversationMessages({
  userId,
  conversationId,
  agentConfigId = null,
  ceoAgentConfigId = null,
  limit = CHAT_HISTORY_DEFAULT_LIMIT,
  before = null,
} = {}) {
  if (!userId || !conversationId) {
    throw new AgentError(
      "listConversationMessages requires userId and conversationId.",
      "INVALID_ARGUMENT",
      400
    );
  }
  const take = clampLimit(limit, {
    fallback: CHAT_HISTORY_DEFAULT_LIMIT,
    max: MESSAGES_MAX_LIMIT,
  });
  const beforeDate = parseBefore(before);
  // Fetch extra rows so hidden creation-state / undecryptable rows don't
  // starve the visible page (same approach as listChatHistory).
  const fetchTake = Math.min(MESSAGES_MAX_LIMIT * 2, Math.max(take * 3, take));

  return withUserContext(userId, async (tx) => {
    let conversation;
    if (conversationId === LEGACY_SINGLE_THREAD_ID) {
      assertChatTarget({ agentConfigId, ceoAgentConfigId });
      conversation = serializeLegacyConversation({ agentConfigId, ceoAgentConfigId });
    } else {
      conversation = await loadOwnedConversation(tx, userId, conversationId);
      if (conversation.isSystem) {
        throw new AgentError(
          "System conversations are not readable via the messages API.",
          "CONVERSATION_SYSTEM_FORBIDDEN",
          400
        );
      }
    }

    try {
      const rows = await tx.agentChatMessage.findMany({
        where: {
          ...chatMessageConversationWhere(conversation.id, {
            userId,
            agentConfigId: conversation.agentConfigId,
            ceoAgentConfigId: conversation.ceoAgentConfigId,
          }),
          ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: fetchTake,
        select: { id: true, role: true, contentCiphertext: true, createdAt: true },
      });

      const messages = decodeVisibleChatMessages(rows, { limit: take });
      return {
        conversation:
          conversationId === LEGACY_SINGLE_THREAD_ID
            ? conversation
            : serializeConversation(conversation),
        messages: serializeChatHistoryMessages(messages),
        hasMore: messages.length === take || rows.length === fetchTake,
      };
    } catch (error) {
      if (isMissingAgentConversationError(error)) {
        // conversationId column missing — retry with agent-scoped legacy where.
        const rows = await tx.agentChatMessage.findMany({
          where: {
            userId,
            agentConfigId: (conversation.agentConfigId ?? agentConfigId) ?? null,
            ceoAgentConfigId: (conversation.ceoAgentConfigId ?? ceoAgentConfigId) ?? null,
            ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: fetchTake,
          select: { id: true, role: true, contentCiphertext: true, createdAt: true },
        });
        const messages = decodeVisibleChatMessages(rows, { limit: take });
        return {
          conversation: serializeLegacyConversation({
            agentConfigId: conversation.agentConfigId ?? agentConfigId,
            ceoAgentConfigId: conversation.ceoAgentConfigId ?? ceoAgentConfigId,
          }),
          messages: serializeChatHistoryMessages(messages),
          hasMore: messages.length === take || rows.length === fetchTake,
        };
      }
      throw error;
    }
  });
}

/**
 * Ensure a conversation belongs to the given chat target (CEO or sub-agent).
 * Used by nested routes so /ceo/conversations/:id cannot mutate a sub-agent thread.
 */
export async function assertConversationMatchesTarget(
  tx,
  { userId, conversationId, agentConfigId = null, ceoAgentConfigId = null }
) {
  assertChatTarget({ agentConfigId, ceoAgentConfigId });
  if (conversationId === LEGACY_SINGLE_THREAD_ID) {
    return serializeLegacyConversation({ agentConfigId, ceoAgentConfigId });
  }
  const row = await loadOwnedConversation(tx, userId, conversationId);
  if (
    row.agentConfigId !== (agentConfigId ?? null) ||
    row.ceoAgentConfigId !== (ceoAgentConfigId ?? null)
  ) {
    throw new AgentError(
      "Conversation does not belong to this agent chat.",
      "CONVERSATION_TARGET_MISMATCH",
      400
    );
  }
  return row;
}
