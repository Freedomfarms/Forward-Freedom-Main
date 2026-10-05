// CHIEF fact store used by the memory tools.
//
// PORT/ADAPT of OpenJarvis FactStore semantics (trust tier, dedupe, cap)
// onto chief_fact. Hybrid FTS + pgvector retrieval and the extraction task
// are not this module. Content is encrypted at rest in the Prisma store.
// A tool cannot promote a fact to TRUSTED.

import { createHash, randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { decryptJson, encryptJson } from "../../security/envelope.js";

export const MAX_FACTS_PER_USER = 500;

const TRUST_TIERS = new Set(["AUTO", "TRUSTED", "UNTRUSTED"]);

function expired(row, now) {
  if (!row?.expiresAt) return false;
  return new Date(row.expiresAt).getTime() <= now.getTime();
}

function projectFact(row, content, userId) {
  return {
    id: row.id,
    userId,
    content,
    dedupeKey: row.dedupeKey,
    trustTier: row.trustTier,
    source: row.source,
    importance: row.importance,
    confidence: row.confidence,
    expiresAt: row.expiresAt ?? null,
    lastAccessedAt: row.lastAccessedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertTrustTier(trustTier) {
  if (!TRUST_TIERS.has(trustTier)) {
    throw new TypeError(`unknown fact trust tier '${trustTier}'`);
  }
}

export function factDedupeKey(content) {
  const normalized = String(content ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export class MemoryFactStore {
  constructor() {
    this.rows = [];
  }

  async write({
    userId,
    content,
    trustTier,
    source,
    importance = 0.5,
    confidence = 0.5,
    expiresAt = null,
  }) {
    const dedupeKey = factDedupeKey(content);
    const existing = this.rows.find((row) => row.userId === userId && row.dedupeKey === dedupeKey);
    if (existing) return { ...existing };
    const owned = this.rows.filter((row) => row.userId === userId).length;
    if (owned >= MAX_FACTS_PER_USER) {
      const error = new Error("fact cap reached");
      error.code = "FACT_CAP";
      throw error;
    }
    const now = new Date();
    const row = {
      id: randomUUID(),
      userId,
      content: String(content),
      dedupeKey,
      trustTier,
      source: source ?? null,
      importance: importance ?? 0.5,
      confidence: confidence ?? 0.5,
      expiresAt: expiresAt ?? null,
      lastAccessedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async read({ userId, query = "", limit = 20, now = new Date() }) {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    return this.rows
      .filter((row) => row.userId === userId && !expired(row, now))
      .filter((row) => !needle || row.content.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async update({ userId, id, content }) {
    const row = this.rows.find((item) => item.id === id && item.userId === userId);
    if (!row || row.source === "identity") return null;
    const dedupeKey = factDedupeKey(content);
    const clash = this.rows.find(
      (item) => item.userId === userId && item.dedupeKey === dedupeKey && item.id !== id
    );
    if (clash) return { duplicate: true, id: clash.id };
    row.content = String(content);
    row.dedupeKey = dedupeKey;
    row.updatedAt = new Date();
    return { ...row };
  }

  async forget({ userId, id = null, content = null }) {
    const needle = String(content ?? "")
      .trim()
      .toLowerCase();
    const key = needle ? factDedupeKey(needle) : null;
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => {
      if (row.userId !== userId || row.source === "identity") return true;
      if (id) return row.id !== id;
      if (!needle) return true;
      return row.dedupeKey !== key && !row.content.toLowerCase().includes(needle);
    });
    return { deleted: before - this.rows.length };
  }

  async touch({ userId, ids = [], now = new Date() }) {
    let touched = 0;
    for (const row of this.rows) {
      if (row.userId !== userId || !ids.includes(row.id)) continue;
      row.lastAccessedAt = now;
      touched += 1;
    }
    return { touched };
  }

  async setTrust({ userId, id, trustTier }) {
    assertTrustTier(trustTier);
    const row = this.rows.find((item) => item.id === id && item.userId === userId);
    if (!row) return null;
    row.trustTier = trustTier;
    return { ...row };
  }
}

export class PrismaFactStore {
  constructor({ withUser = withUserContext, encrypt = encryptJson, decrypt = decryptJson } = {}) {
    this._withUser = withUser;
    this._encrypt = encrypt;
    this._decrypt = decrypt;
  }

  async write({
    userId,
    content,
    trustTier,
    source,
    importance = 0.5,
    confidence = 0.5,
    expiresAt = null,
  }) {
    const dedupeKey = factDedupeKey(content);
    return this._withUser(userId, async (tx) => {
      const existing = await tx.chiefFact.findUnique({
        where: { userId_dedupeKey: { userId, dedupeKey } },
      });
      if (existing) return projectFact(existing, this._decrypt(existing.contentCiphertext), userId);
      const owned = await tx.chiefFact.count({ where: { userId } });
      if (owned >= MAX_FACTS_PER_USER) {
        const error = new Error("fact cap reached");
        error.code = "FACT_CAP";
        throw error;
      }
      const created = await tx.chiefFact.create({
        data: {
          userId,
          contentCiphertext: this._encrypt(String(content)),
          dedupeKey,
          trustTier,
          source: source ?? null,
          importance,
          confidence,
          expiresAt,
        },
      });
      return projectFact(created, String(content), userId);
    });
  }

  async read({ userId, query = "", limit = 20, now = new Date() }) {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    const rows = await this._withUser(userId, (tx) =>
      tx.chiefFact.findMany({
        where: {
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { createdAt: "desc" },
        take: MAX_FACTS_PER_USER,
      })
    );
    const facts = [];
    for (const row of rows) {
      const content = this._decrypt(row.contentCiphertext);
      if (needle && !String(content).toLowerCase().includes(needle)) continue;
      facts.push(projectFact(row, content, userId));
      if (facts.length >= limit) break;
    }
    return facts;
  }

  async update({ userId, id, content }) {
    const dedupeKey = factDedupeKey(content);
    return this._withUser(userId, async (tx) => {
      const existing = await tx.chiefFact.findFirst({ where: { id, userId } });
      if (!existing || existing.source === "identity") return null;
      const clash = await tx.chiefFact.findUnique({
        where: { userId_dedupeKey: { userId, dedupeKey } },
      });
      if (clash && clash.id !== id) return { duplicate: true, id: clash.id };
      const updated = await tx.chiefFact.update({
        where: { id },
        data: { contentCiphertext: this._encrypt(String(content)), dedupeKey },
      });
      return projectFact(updated, String(content), userId);
    });
  }

  async forget({ userId, id = null, content = null }) {
    const needle = String(content ?? "")
      .trim()
      .toLowerCase();
    return this._withUser(userId, async (tx) => {
      if (id) {
        const existing = await tx.chiefFact.findFirst({ where: { id, userId } });
        if (!existing || existing.source === "identity") return { deleted: 0 };
        await tx.chiefFact.delete({ where: { id } });
        return { deleted: 1 };
      }
      if (!needle) return { deleted: 0 };
      const key = factDedupeKey(needle);
      const rows = await tx.chiefFact.findMany({ where: { userId } });
      const ids = [];
      for (const row of rows) {
        if (row.source === "identity") continue;
        const text = String(this._decrypt(row.contentCiphertext) ?? "").toLowerCase();
        if (row.dedupeKey === key || text.includes(needle)) ids.push(row.id);
      }
      if (ids.length === 0) return { deleted: 0 };
      const result = await tx.chiefFact.deleteMany({ where: { userId, id: { in: ids } } });
      return { deleted: result.count };
    });
  }

  async touch({ userId, ids = [], now = new Date() }) {
    if (!ids.length) return { touched: 0 };
    return this._withUser(userId, async (tx) => {
      const result = await tx.chiefFact.updateMany({
        where: { userId, id: { in: ids } },
        data: { lastAccessedAt: now },
      });
      return { touched: result.count };
    });
  }

  async setTrust({ userId, id, trustTier }) {
    assertTrustTier(trustTier);
    return this._withUser(userId, async (tx) => {
      const existing = await tx.chiefFact.findFirst({ where: { id, userId } });
      if (!existing) return null;
      const updated = await tx.chiefFact.update({ where: { id }, data: { trustTier } });
      return { id: updated.id, userId, trustTier: updated.trustTier };
    });
  }
}
