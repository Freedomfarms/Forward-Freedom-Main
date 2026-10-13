// Owner-scoped external archive. Ciphertext is the stored transcript.
// The memory store is the test double. The Prisma store is the server path
// and always runs inside withUserContext, which sets app.current_user_id.

import { randomUUID } from "node:crypto";

import { Prisma, withUserContext } from "../../db/prisma.js";
import { decryptJson, encryptJson } from "../../security/envelope.js";
import { buildHistoricalBlock, parseSearchOptions, rankRecallRows } from "../runtime/recall.js";
import { fencesOutput, scanInjection } from "../security/injection.js";
import { ARCHIVE_EXCERPT_MESSAGES, MAX_LIST } from "./limits.js";

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
    sourceCreatedAt: timestamp(row.sourceCreatedAt),
    sourceUpdatedAt: timestamp(row.sourceUpdatedAt),
    messageCount: row.messageCount,
    unsupportedCount: row.unsupportedCount,
    omittedBranchCount: row.omittedBranchCount,
    importedAt: timestamp(row.importedAt),
    updatedAt: timestamp(row.updatedAt),
  };
}

function plainTitle(ciphertext) {
  try {
    const value = decryptJson(ciphertext);
    return typeof value === "string" && value.trim() ? value.trim() : "Untitled";
  } catch {
    return "Untitled";
  }
}

function plainBlocks(ciphertext) {
  try {
    const value = decryptJson(ciphertext);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "code" && typeof block.code === "string") return block.code;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function visibleText(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return { text: "", omit: false };
  if (fencesOutput(scanInjection(value).threatLevel)) return { text: "", omit: true };
  return { text: value, omit: false };
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function archiveRecallRow(row) {
  const updatedAt = row.sourceUpdatedAt ?? row.updatedAt ?? null;
  return {
    id: row.id,
    title: plainTitle(row.titleCiphertext),
    createdAt: row.sourceCreatedAt ?? row.importedAt ?? null,
    updatedAt,
    archivedAt: null,
    recallDocument: typeof row.recallDocument === "string" ? row.recallDocument : "",
    provider: row.provider,
    externalId: row.externalId ?? null,
    sourceUrl: row.sourceUrl ?? null,
  };
}

function projectExcerpt(row, messages, { query, truncated }) {
  const title = plainTitle(row.titleCiphertext);
  const titleText = visibleText(title);
  const safeTitle = titleText.omit ? "Untitled" : titleText.text || "Untitled";
  const transcript = [];
  const originals = [];
  for (const message of messages) {
    const text = blockText(plainBlocks(message.contentCiphertext));
    const readable = visibleText(text);
    originals.push({
      id: message.externalId ?? null,
      role: message.role ?? "unknown",
      content: readable.omit ? "" : readable.text,
      ...(readable.omit ? { omitted: "untrusted-instruction" } : {}),
      sourceCreatedAt: timestamp(message.sourceCreatedAt),
    });
    if (
      !readable.omit &&
      readable.text &&
      (message.role === "user" || message.role === "assistant")
    ) {
      transcript.push({ role: message.role, content: readable.text });
    }
  }
  const block = buildHistoricalBlock({
    record: {
      id: row.id,
      title: safeTitle,
      updatedAt: row.sourceUpdatedAt ?? row.updatedAt,
      archivedAt: null,
      checkpoint: { transcript },
    },
    query,
  });
  return {
    ...block,
    provider: row.provider,
    externalId: row.externalId ?? null,
    sourceUrl: row.sourceUrl ?? null,
    messageKind: "original",
    truncated: Boolean(truncated || block.truncated),
    messages: originals,
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
        sourceCreatedAt: timestamp(message.sourceCreatedAt),
        hasUnsupported: Boolean(message.hasUnsupported),
        blocks: plainBlocks(message.contentCiphertext),
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
      .map((row) => publicSummary(row, plainTitle(row.titleCiphertext)));
  }

  async get(userId, id) {
    const row = this.conversations.get(id);
    if (!row || row.userId !== userId) return null;
    const messages = this.messages.filter(
      (message) => message.userId === userId && message.conversationId === id
    );
    return publicDetail(row, plainTitle(row.titleCiphertext), messages);
  }

  async delete(userId, id) {
    const row = this.conversations.get(id);
    if (!row || row.userId !== userId) return false;
    this.conversations.delete(id);
    this.messages = this.messages.filter((message) => message.conversationId !== id);
    return true;
  }

  async searchConversations(userId, options = {}) {
    const parsed = parseSearchOptions(options);
    if (parsed.error) return { error: parsed.error };
    if (!userId) return { conversations: [] };
    const rows = [];
    for (const row of this.conversations.values()) {
      if (row.userId !== userId || !row.id) continue;
      rows.push(archiveRecallRow(row));
    }
    return { conversations: rankRecallRows(rows, parsed, options.now ?? new Date()) };
  }

  async excerpt(userId, id, { query } = {}) {
    if (!userId || typeof id !== "string" || !id.trim()) return { error: "session not found" };
    const row = this.conversations.get(id.trim());
    if (!row || row.userId !== userId) return { error: "session not found" };
    const owned = this.messages
      .filter((message) => message.userId === userId && message.conversationId === row.id)
      .sort((left, right) => left.ordinal - right.ordinal);
    const truncated = owned.length > ARCHIVE_EXCERPT_MESSAGES;
    const slice = truncated ? owned.slice(-ARCHIVE_EXCERPT_MESSAGES) : owned;
    return projectExcerpt(row, slice, { query, truncated });
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
    return rows.map((row) => publicSummary(row, plainTitle(row.titleCiphertext)));
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
      return publicDetail(row, plainTitle(row.titleCiphertext), messages);
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

  async searchConversations(userId, options = {}) {
    const parsed = parseSearchOptions(options);
    if (parsed.error) return { error: parsed.error };
    if (!userId) return { conversations: [] };
    const take = parsed.offset + parsed.limit;
    const rows = await this._withUser(userId, (tx) =>
      archiveRecallCandidates(tx, userId, parsed, take)
    );
    return {
      conversations: rankRecallRows(rows.map(archiveRecallRow), parsed, options.now ?? new Date()),
    };
  }

  async excerpt(userId, id, { query } = {}) {
    if (!userId || typeof id !== "string" || !id.trim()) return { error: "session not found" };
    return this._withUser(userId, async (tx) => {
      const row = await tx.externalConversation.findFirst({
        where: { id: id.trim(), userId },
      });
      if (!row) return { error: "session not found" };
      const newest = await tx.externalMessage.findMany({
        where: { conversationId: row.id, userId },
        orderBy: { ordinal: "desc" },
        take: ARCHIVE_EXCERPT_MESSAGES,
      });
      const messages = newest.reverse();
      return projectExcerpt(row, messages, {
        query,
        truncated: row.messageCount > messages.length,
      });
    });
  }
}

async function archiveRecallCandidates(tx, userId, parsed, take) {
  const conditions = [Prisma.sql`"userId" = ${userId}`];
  if (!parsed.list) {
    conditions.push(
      Prisma.sql`to_tsvector('simple', coalesce("recallDocument", '')) @@ plainto_tsquery('simple', ${parsed.query})`
    );
  }
  if (parsed.after) {
    conditions.push(
      Prisma.sql`COALESCE("sourceUpdatedAt", "updatedAt") >= CAST(${parsed.after} AS timestamp)`
    );
  }
  if (parsed.before) {
    conditions.push(
      Prisma.sql`COALESCE("sourceUpdatedAt", "updatedAt") <= CAST(${parsed.before} AS timestamp)`
    );
  }
  return tx.$queryRaw`
    SELECT
      "id",
      "provider"::text AS "provider",
      "externalId",
      "titleCiphertext",
      "sourceUrl",
      "sourceCreatedAt",
      "sourceUpdatedAt",
      "importedAt",
      "updatedAt",
      "recallDocument"
    FROM "external_conversation"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY (
      CASE
        WHEN ${parsed.list === true}
        THEN 0.0
        ELSE ts_rank(
          to_tsvector('simple', coalesce("recallDocument", '')),
          plainto_tsquery('simple', ${parsed.list ? " " : parsed.query})
        )
      END
    ) DESC, COALESCE("sourceUpdatedAt", "updatedAt") DESC, "id" ASC
    LIMIT ${take}
  `;
}
