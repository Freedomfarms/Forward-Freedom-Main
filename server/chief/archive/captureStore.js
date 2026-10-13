// One capture credential per user. Plaintext tokens are not stored.
// Provider switches default off. This is not a second archive.

import { withUserContext } from "../../db/prisma.js";
import { captureTokenMatches, hashCaptureToken } from "./captureToken.js";

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function publicCaptureStatus(row) {
  if (!row) {
    return {
      issued: false,
      issuedAt: null,
      revokedAt: null,
      claudeEnabled: false,
      chatgptEnabled: false,
      paused: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastProvider: null,
    };
  }
  return {
    issued: Boolean(row.tokenHash) && !row.revokedAt,
    issuedAt: iso(row.issuedAt),
    revokedAt: iso(row.revokedAt),
    claudeEnabled: Boolean(row.claudeEnabled),
    chatgptEnabled: Boolean(row.chatgptEnabled),
    paused: Boolean(row.paused),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastErrorAt: iso(row.lastErrorAt),
    lastErrorCode: row.lastErrorCode ?? null,
    lastProvider: row.lastProvider ?? null,
  };
}

function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function blankRow(userId, now) {
  return {
    userId,
    tokenHash: null,
    issuedAt: null,
    revokedAt: null,
    claudeEnabled: false,
    chatgptEnabled: false,
    paused: false,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastProvider: null,
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryCaptureCredential {
  constructor() {
    this.rows = new Map();
    this.accounts = new Map();
  }

  async status(userId) {
    return publicCaptureStatus(this.rows.get(userId) ?? null);
  }

  async issue(userId, token, now = new Date()) {
    const existing = this.rows.get(userId);
    const row = {
      ...(existing ?? blankRow(userId, now)),
      tokenHash: hashCaptureToken(token),
      issuedAt: now,
      revokedAt: null,
      updatedAt: now,
    };
    this.rows.set(userId, row);
    if (!this.accounts.has(userId)) this.accounts.set(userId, { isDisabled: false });
    return publicCaptureStatus(row);
  }

  async revoke(userId, now = new Date()) {
    const existing = this.rows.get(userId);
    if (!existing) return publicCaptureStatus(null);
    const row = { ...existing, tokenHash: null, revokedAt: now, updatedAt: now };
    this.rows.set(userId, row);
    return publicCaptureStatus(row);
  }

  async updateControls(userId, controls = {}, now = new Date()) {
    const existing = this.rows.get(userId) ?? blankRow(userId, now);
    const row = {
      ...existing,
      claudeEnabled: pickBool(controls.claudeEnabled, existing.claudeEnabled),
      chatgptEnabled: pickBool(controls.chatgptEnabled, existing.chatgptEnabled),
      paused: pickBool(controls.paused, existing.paused),
      updatedAt: now,
    };
    this.rows.set(userId, row);
    return publicCaptureStatus(row);
  }

  async authenticate(userId, token) {
    const account = this.accounts.get(userId);
    if (account?.missing) return { ok: false, code: "AUTH" };
    if (account?.isDisabled) return { ok: false, code: "AUTH", disabled: true };
    const row = this.rows.get(userId);
    if (!row?.tokenHash || row.revokedAt) return { ok: false, code: "AUTH" };
    if (!captureTokenMatches(token, row.tokenHash)) return { ok: false, code: "AUTH" };
    return { ok: true };
  }

  async gate(userId, provider) {
    const row = this.rows.get(userId);
    if (!row?.tokenHash || row.revokedAt) return { ok: false, code: "AUTH" };
    if (row.paused) return { ok: false, code: "PAUSED" };
    if (provider !== "claude" && provider !== "chatgpt") return { ok: false, code: "DISABLED" };
    const enabled = provider === "claude" ? row.claudeEnabled : row.chatgptEnabled;
    if (!enabled) return { ok: false, code: "DISABLED" };
    return { ok: true };
  }

  async recordSuccess(userId, provider, now = new Date()) {
    const row = this.rows.get(userId);
    if (!row) return;
    this.rows.set(userId, {
      ...row,
      lastSuccessAt: now,
      lastErrorAt: null,
      lastErrorCode: null,
      lastProvider: provider,
      updatedAt: now,
    });
  }

  async recordError(userId, provider, code, now = new Date()) {
    const row = this.rows.get(userId);
    if (!row) return;
    const safeProvider =
      provider === "claude" || provider === "chatgpt" ? provider : row.lastProvider;
    this.rows.set(userId, {
      ...row,
      lastErrorAt: now,
      lastErrorCode: typeof code === "string" ? code.slice(0, 40) : "STORE",
      lastProvider: safeProvider ?? null,
      updatedAt: now,
    });
  }
}

export class PrismaCaptureCredential {
  constructor({ withUser = withUserContext } = {}) {
    this._withUser = withUser;
  }

  async status(userId) {
    const row = await this._withUser(userId, (tx) =>
      tx.externalCaptureCredential.findUnique({ where: { userId } })
    );
    return publicCaptureStatus(row);
  }

  async issue(userId, token, now = new Date()) {
    const tokenHash = hashCaptureToken(token);
    const row = await this._withUser(userId, async (tx) => {
      const existing = await tx.externalCaptureCredential.findUnique({ where: { userId } });
      if (existing) {
        return tx.externalCaptureCredential.update({
          where: { userId },
          data: { tokenHash, issuedAt: now, revokedAt: null },
        });
      }
      return tx.externalCaptureCredential.create({
        data: { userId, tokenHash, issuedAt: now, revokedAt: null },
      });
    });
    return publicCaptureStatus(row);
  }

  async revoke(userId, now = new Date()) {
    const row = await this._withUser(userId, async (tx) => {
      const existing = await tx.externalCaptureCredential.findUnique({ where: { userId } });
      if (!existing) return null;
      return tx.externalCaptureCredential.update({
        where: { userId },
        data: { tokenHash: null, revokedAt: now },
      });
    });
    return publicCaptureStatus(row);
  }

  async updateControls(userId, controls = {}, now = new Date()) {
    const row = await this._withUser(userId, async (tx) => {
      const existing = await tx.externalCaptureCredential.findUnique({ where: { userId } });
      const data = {
        claudeEnabled: pickBool(controls.claudeEnabled, existing?.claudeEnabled ?? false),
        chatgptEnabled: pickBool(controls.chatgptEnabled, existing?.chatgptEnabled ?? false),
        paused: pickBool(controls.paused, existing?.paused ?? false),
      };
      if (existing) {
        return tx.externalCaptureCredential.update({ where: { userId }, data });
      }
      return tx.externalCaptureCredential.create({ data: { userId, ...data } });
    });
    void now;
    return publicCaptureStatus(row);
  }

  async authenticate(userId, token) {
    return this._withUser(userId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isDisabled: true },
      });
      if (!user) return { ok: false, code: "AUTH" };
      if (user.isDisabled) return { ok: false, code: "AUTH", disabled: true };
      const row = await tx.externalCaptureCredential.findUnique({ where: { userId } });
      if (!row?.tokenHash || row.revokedAt) return { ok: false, code: "AUTH" };
      if (!captureTokenMatches(token, row.tokenHash)) return { ok: false, code: "AUTH" };
      return { ok: true };
    });
  }

  async gate(userId, provider) {
    return this._withUser(userId, async (tx) => {
      const row = await tx.externalCaptureCredential.findUnique({ where: { userId } });
      if (!row?.tokenHash || row.revokedAt) return { ok: false, code: "AUTH" };
      if (row.paused) return { ok: false, code: "PAUSED" };
      if (provider !== "claude" && provider !== "chatgpt") return { ok: false, code: "DISABLED" };
      const enabled = provider === "claude" ? row.claudeEnabled : row.chatgptEnabled;
      if (!enabled) return { ok: false, code: "DISABLED" };
      return { ok: true };
    });
  }

  async recordSuccess(userId, provider, now = new Date()) {
    await this._withUser(userId, (tx) =>
      tx.externalCaptureCredential.update({
        where: { userId },
        data: {
          lastSuccessAt: now,
          lastErrorAt: null,
          lastErrorCode: null,
          lastProvider: provider,
        },
      })
    );
  }

  async recordError(userId, provider, code, now = new Date()) {
    const safeProvider = provider === "claude" || provider === "chatgpt" ? provider : null;
    await this._withUser(userId, (tx) =>
      tx.externalCaptureCredential.update({
        where: { userId },
        data: {
          lastErrorAt: now,
          lastErrorCode: typeof code === "string" ? code.slice(0, 40) : "STORE",
          ...(safeProvider ? { lastProvider: safeProvider } : {}),
        },
      })
    );
  }
}
