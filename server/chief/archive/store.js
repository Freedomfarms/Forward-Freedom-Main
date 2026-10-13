// Owner-scoped external archive. Ciphertext is the stored transcript.
// The memory store is the test double. The Prisma store is the server path
// and always runs inside withUserContext, which sets app.current_user_id.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { decryptJson, encryptJson } from "../../security/envelope.js";
import { MAX_LIST } from "./limits.js";

function messageData(userId, conversationId, message) {
  return {
    id: randomUUID(),
    userId,
    conversationId,
    ordinal: message.ordinal,
    externalId: message.externalId,
    role: message.role,
    model: message.model,
    parentExternalId: message.parentExternalId,
    sourceCreatedAt: message.sourceCreatedAt ? new Date(message.sourceCreatedAt) : null,
    contentCiphertext: encryptJson(message.blocks),
    hasUnsupported: message.hasUnsupported,
  };
}

function conversationData(userId, conversation) {
  return {
    userId,
    provider: conversation.provider,
    externalId: conversation.externalId,
    titleCiphertext: encryptJson(conversation.title),
    sourceUrl: conversation.sourceUrl,
    model: conversation.model,
    sourceCreatedAt: conversation.sourceCreatedAt ? new Date(conversation.sourceCreatedAt) : null,
    sourceUpdatedAt: conversation.sourceUpdatedAt ? new Date(conversation.sourceUpdatedAt) : null,
    contentHash: conversation.contentHash,
    messageCount: conversation.messageCount,
    unsupportedCount: conversation.unsupportedCount,
    omittedBranchCount: conversation.omittedBranchCount,
    recallDocument: conversation.recallDocument,
  };
}

function publicSummary(row, title) {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    title,
    sourceUrl: row.sourceUrl ?? null,
    model: row.model ?? null,
    sourceCreatedAt: row.sourceCreatedAt ? new Date(row.sourceCreatedAt).toISOString() : null,
    sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
    messageCount: row.messageCount,
    unsupportedCount: row.unsupportedCount,
    omittedBranchCount: row.omittedBranchCount,
    importedAt: new Date(row.importedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function publicDetail(row, title, messages) {
  return {
    ...publicSummary(row, title),
    messages: messages
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((message) => ({
        ordinal: message.ordinal,
        externalId: message.externalId ?? null,
        role: message.role,
        model: message.model ?? null,
        parentExternalId: message.parentExternalId ?? null,
        sourceCreatedAt: message.sourceCreatedAt
          ? new Date(message.sourceCreatedAt).toISOString()
          : null,
        hasUnsupported: Boolean(message.hasUnsupported),
        blocks: decryptJson(message.contentCiphertext),
      })),
  };
}

export class MemoryExternalArchive {
  constructor() {
    this.conversations = new Map();
    this.messages = [];
  }

  async upsert(userId, conversation) {
    const existing = [...this.conversations.values()].find(
      (row) =>
        row.userId === userId &&
        row.provider === conversation.provider &&
        row.externalId === conversation.externalId
    );
    if (existing && existing.contentHash === conversation.contentHash) return "duplicate";
    const now = new Date();
    if (existing) {
      this.messages = this.messages.filter((message) => message.conversationId !== existing.id);
      const next = {
        ...existing,
        ...conversationData(userId, conversation),
        id: existing.id,
        importedAt: existing.importedAt,
        updatedAt: now,
      };
      this.conversations.set(existing.id, next);
      this.messages.push(
        ...conversation.messages.map((message) => messageData(userId, existing.id, message))
      );
      return "updated";
    }
    const id = randomUUID();
    this.conversations.set(id, {
      id,
      ...conversationData(userId, conversation),
      importedAt: now,
      updatedAt: now,
    });
    this.messages.push(...conversation.messages.map((message) => messageData(userId, id, message)));
    return "imported";
  }

  async list(userId) {
    return [...this.conversations.values()]
      .filter((row) => row.userId === userId)
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt))
      .slice(0, MAX_LIST)
      .map((row) => publicSummary(row, decryptJson(row.titleCiphertext) || "Untitled"));
  }

  async get(userId, id) {
    const row = this.conversations.get(id);
    if (!row || row.userId !== userId) return null;
    const messages = this.messages.filter(
      (message) => message.userId === userId && message.conversationId === id
    );
    return publicDetail(row, decryptJson(row.titleCiphertext) || "Untitled", messages);
  }

  async delete(userId, id) {
    const row = this.conversations.get(id);
    if (!row || row.userId !== userId) return false;
    this.conversations.delete(id);
    this.messages = this.messages.filter((message) => message.conversationId !== id);
    return true;
  }
}

export class PrismaExternalArchive {
  constructor({ withUser = withUserContext } = {}) {
    this._withUser = withUser;
  }

  async upsert(userId, conversation) {
    return this._withUser(userId, async (tx) => {
      const existing = await tx.externalConversation.findUnique({
        where: {
          userId_provider_externalId: {
            userId,
            provider: conversation.provider,
            externalId: conversation.externalId,
          },
        },
      });
      if (existing && existing.contentHash === conversation.contentHash) return "duplicate";
      const data = conversationData(userId, conversation);
      if (existing) {
        await tx.externalMessage.deleteMany({
          where: { conversationId: existing.id, userId },
        });
        await tx.externalConversation.update({
          where: { id: existing.id },
          data,
        });
        await tx.externalMessage.createMany({
          data: conversation.messages.map((message) => messageData(userId, existing.id, message)),
        });
        return "updated";
      }
      const created = await tx.externalConversation.create({ data });
      await tx.externalMessage.createMany({
        data: conversation.messages.map((message) => messageData(userId, created.id, message)),
      });
      return "imported";
    });
  }

  async list(userId) {
    const rows = await this._withUser(userId, (tx) =>
      tx.externalConversation.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: MAX_LIST,
      })
    );
    return rows.map((row) => publicSummary(row, decryptJson(row.titleCiphertext) || "Untitled"));
  }

  async get(userId, id) {
    return this._withUser(userId, async (tx) => {
      const row = await tx.externalConversation.findFirst({
        where: { id, userId },
      });
      if (!row) return null;
      const messages = await tx.externalMessage.findMany({
        where: { conversationId: id, userId },
        orderBy: { ordinal: "asc" },
      });
      return publicDetail(row, decryptJson(row.titleCiphertext) || "Untitled", messages);
    });
  }

  async delete(userId, id) {
    return this._withUser(userId, async (tx) => {
      const row = await tx.externalConversation.findFirst({ where: { id, userId } });
      if (!row) return false;
      await tx.externalConversation.delete({ where: { id } });
      return true;
    });
  }
}
