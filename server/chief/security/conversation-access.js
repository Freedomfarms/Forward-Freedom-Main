// Per-user CHIEF conversation permissions. A missing row is off for read,
// organize, and delete. The flags are independent. They are not Module 02
// access and they are not capability-grant rows.

import { withUserContext } from "../../db/prisma.js";

export const CONVERSATION_ACCESS_KEYS = Object.freeze([
  "conversationRead",
  "conversationOrganize",
  "conversationDelete",
]);

export const CONVERSATION_READ_DISABLED =
  "Conversation read access is currently disabled. CHIEF cannot view this user's conversations.";

export const CONVERSATION_ORGANIZE_DISABLED =
  "Conversation organize access is currently disabled. CHIEF cannot rename, archive, or restore conversations.";

export const CONVERSATION_DELETE_DISABLED =
  "Conversation delete access is currently disabled. CHIEF cannot delete conversations.";

export function emptyConversationAccess() {
  return {
    conversationRead: false,
    conversationOrganize: false,
    conversationDelete: false,
  };
}

function requireUserId(userId) {
  const id = typeof userId === "string" ? userId.trim() : "";
  if (!id) {
    const error = new Error("authenticated user is required");
    error.status = 401;
    throw error;
  }
  return id;
}

function isMissingConversationAccessTable(error) {
  return error?.code === "P2021" || /chief_conversation_access/i.test(String(error?.message || ""));
}

function applyPatch(current, patch) {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    const error = new Error("conversation permission must be a boolean");
    error.status = 400;
    throw error;
  }
  const present = CONVERSATION_ACCESS_KEYS.filter((key) => Object.hasOwn(patch, key));
  if (present.length === 0) {
    const error = new Error("conversation permission must be a boolean");
    error.status = 400;
    throw error;
  }
  const next = { ...current };
  for (const key of present) {
    if (typeof patch[key] !== "boolean") {
      const error = new Error("conversation permission must be a boolean");
      error.status = 400;
      throw error;
    }
    next[key] = patch[key];
  }
  return next;
}

export class MemoryConversationAccess {
  constructor(seed = []) {
    this.rows = new Map(seed);
  }

  async get(userId) {
    const id = requireUserId(userId);
    return { ...emptyConversationAccess(), ...(this.rows.get(id) ?? {}) };
  }

  async set(userId, patch) {
    const id = requireUserId(userId);
    const next = applyPatch(await this.get(id), patch);
    this.rows.set(id, next);
    return { userId: id, ...next };
  }
}

export class PrismaConversationAccess {
  constructor({ withUser = withUserContext } = {}) {
    this.withUser = withUser;
  }

  async get(userId) {
    const id = requireUserId(userId);
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefConversationAccess.findUnique({
          where: { userId: id },
          select: {
            conversationRead: true,
            conversationOrganize: true,
            conversationDelete: true,
          },
        })
      );
      return { ...emptyConversationAccess(), ...(row ?? {}) };
    } catch (error) {
      if (isMissingConversationAccessTable(error)) return emptyConversationAccess();
      throw error;
    }
  }

  async set(userId, patch) {
    const id = requireUserId(userId);
    const current = await this.get(id);
    const next = applyPatch(current, patch);
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefConversationAccess.upsert({
          where: { userId: id },
          create: { userId: id, ...next },
          update: next,
          select: {
            userId: true,
            conversationRead: true,
            conversationOrganize: true,
            conversationDelete: true,
          },
        })
      );
      return {
        userId: row.userId,
        conversationRead: row.conversationRead === true,
        conversationOrganize: row.conversationOrganize === true,
        conversationDelete: row.conversationDelete === true,
      };
    } catch (error) {
      if (isMissingConversationAccessTable(error)) {
        const wrapped = new Error("Conversation access storage is not available.");
        wrapped.status = 503;
        throw wrapped;
      }
      throw error;
    }
  }
}

export async function conversationFlag(access, userId, key) {
  try {
    const row = await access.get(userId);
    return row?.[key] === true;
  } catch {
    return false;
  }
}
