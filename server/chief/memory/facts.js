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

  async write({ userId, content, trustTier, source }) {
    const dedupeKey = factDedupeKey(content);
    const existing = this.rows.find((row) => row.userId === userId && row.dedupeKey === dedupeKey);
    if (existing) return { ...existing };
    const owned = this.rows.filter((row) => row.userId === userId).length;
    if (owned >= MAX_FACTS_PER_USER) {
      const error = new Error("fact cap reached");
      error.code = "FACT_CAP";
      throw error;
    }
    const row = {
      id: randomUUID(),
      userId,
      content: String(content),
      dedupeKey,
      trustTier,
      source: source ?? null,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async read({ userId, query = "", limit = 20 }) {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    return this.rows
      .filter(
        (row) => row.userId === userId && (!needle || row.content.toLowerCase().includes(needle))
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
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

  async write({ userId, content, trustTier, source }) {
    const dedupeKey = factDedupeKey(content);
    return this._withUser(userId, async (tx) => {
      const existing = await tx.chiefFact.findUnique({
        where: { userId_dedupeKey: { userId, dedupeKey } },
      });
      if (existing) {
        return {
          id: existing.id,
          userId,
          content: this._decrypt(existing.contentCiphertext),
          dedupeKey,
          trustTier: existing.trustTier,
          source: existing.source,
        };
      }
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
        },
      });
      return { id: created.id, userId, content: String(content), dedupeKey, trustTier, source };
    });
  }

  async read({ userId, query = "", limit = 20 }) {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    const rows = await this._withUser(userId, (tx) =>
      tx.chiefFact.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_FACTS_PER_USER,
      })
    );
    const facts = [];
    for (const row of rows) {
      const content = this._decrypt(row.contentCiphertext);
      if (needle && !String(content).toLowerCase().includes(needle)) continue;
      facts.push({
        id: row.id,
        userId,
        content,
        dedupeKey: row.dedupeKey,
        trustTier: row.trustTier,
        source: row.source,
        createdAt: row.createdAt,
      });
      if (facts.length >= limit) break;
    }
    return facts;
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
