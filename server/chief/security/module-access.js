// Per-user Freedom Financial read switch. A missing row is off. The model never
// writes this table: the UI route and freedom_financial_access_set both call this
// store, and the set tool still has to clear ToolExecutor confirmation.
// finance:read does not imply this flag.

import { withUserContext } from "../../db/prisma.js";

export const FREEDOM_FINANCIAL_READ_DISABLED =
  "Freedom Financial read access is currently disabled. CHIEF cannot view this user's financial data.";

export const FREEDOM_FINANCIAL_WRITE_UNAVAILABLE =
  "Freedom Financial write access is not currently available. CHIEF cannot change financial data.";

function requireUserId(userId) {
  const id = typeof userId === "string" ? userId.trim() : "";
  if (!id) {
    const error = new Error("authenticated user is required");
    error.status = 401;
    throw error;
  }
  return id;
}

function isMissingModuleAccessTable(error) {
  return error?.code === "P2021" || /chief_module_access/i.test(String(error?.message || ""));
}

export class MemoryModuleAccess {
  constructor(seed = []) {
    this.rows = new Map(seed);
  }

  async isFreedomFinancialReadEnabled(userId) {
    return this.rows.get(requireUserId(userId)) === true;
  }

  async setFreedomFinancialReadEnabled(userId, enabled) {
    const id = requireUserId(userId);
    if (typeof enabled !== "boolean") {
      const error = new Error("freedomFinancialRead must be a boolean");
      error.status = 400;
      throw error;
    }
    this.rows.set(id, enabled);
    return { userId: id, freedomFinancialRead: enabled, writeAccess: false };
  }
}

export class PrismaModuleAccess {
  constructor({ withUser = withUserContext } = {}) {
    this.withUser = withUser;
  }

  async isFreedomFinancialReadEnabled(userId) {
    const id = requireUserId(userId);
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefModuleAccess.findUnique({
          where: { userId: id },
          select: { freedomFinancialRead: true },
        })
      );
      return row?.freedomFinancialRead === true;
    } catch (error) {
      if (isMissingModuleAccessTable(error)) return false;
      throw error;
    }
  }

  async setFreedomFinancialReadEnabled(userId, enabled) {
    const id = requireUserId(userId);
    if (typeof enabled !== "boolean") {
      const error = new Error("freedomFinancialRead must be a boolean");
      error.status = 400;
      throw error;
    }
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefModuleAccess.upsert({
          where: { userId: id },
          create: { userId: id, freedomFinancialRead: enabled },
          update: { freedomFinancialRead: enabled },
          select: { userId: true, freedomFinancialRead: true },
        })
      );
      return {
        userId: row.userId,
        freedomFinancialRead: row.freedomFinancialRead === true,
        writeAccess: false,
      };
    } catch (error) {
      if (isMissingModuleAccessTable(error)) {
        const wrapped = new Error("Freedom Financial access storage is not available.");
        wrapped.status = 503;
        throw wrapped;
      }
      throw error;
    }
  }
}

// Returns a tool error when this user has not turned Freedom Financial reads on.
// A thrown permission read fails closed and does not load financial data.
export async function denyUnlessFreedomFinancialRead(access, userId) {
  try {
    if ((await access.isFreedomFinancialReadEnabled(userId)) === true) return null;
  } catch {
    return { output: FREEDOM_FINANCIAL_READ_DISABLED, isError: true };
  }
  return { output: FREEDOM_FINANCIAL_READ_DISABLED, isError: true };
}
