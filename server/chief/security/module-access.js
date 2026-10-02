// Per-user Module 02 read switch. A missing row is off. The model never
// writes this table: the UI route and module02_access_set both call this
// store, and the set tool still has to clear ToolExecutor confirmation.
// finance:read does not imply this flag.

import { withUserContext } from "../../db/prisma.js";

export const MODULE02_READ_DISABLED =
  "Freedom Financial read access is currently disabled. CHIEF cannot view this user's financial data.";

export const MODULE02_WRITE_UNAVAILABLE =
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

  async isModule02ReadEnabled(userId) {
    return this.rows.get(requireUserId(userId)) === true;
  }

  async setModule02ReadEnabled(userId, enabled) {
    const id = requireUserId(userId);
    if (typeof enabled !== "boolean") {
      const error = new Error("module02Read must be a boolean");
      error.status = 400;
      throw error;
    }
    this.rows.set(id, enabled);
    return { userId: id, module02Read: enabled, writeAccess: false };
  }
}

export class PrismaModuleAccess {
  constructor({ withUser = withUserContext } = {}) {
    this.withUser = withUser;
  }

  async isModule02ReadEnabled(userId) {
    const id = requireUserId(userId);
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefModuleAccess.findUnique({
          where: { userId: id },
          select: { module02Read: true },
        })
      );
      return row?.module02Read === true;
    } catch (error) {
      if (isMissingModuleAccessTable(error)) return false;
      throw error;
    }
  }

  async setModule02ReadEnabled(userId, enabled) {
    const id = requireUserId(userId);
    if (typeof enabled !== "boolean") {
      const error = new Error("module02Read must be a boolean");
      error.status = 400;
      throw error;
    }
    try {
      const row = await this.withUser(id, (tx) =>
        tx.chiefModuleAccess.upsert({
          where: { userId: id },
          create: { userId: id, module02Read: enabled },
          update: { module02Read: enabled },
          select: { userId: true, module02Read: true },
        })
      );
      return { userId: row.userId, module02Read: row.module02Read === true, writeAccess: false };
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

// Returns a tool error when this user has not turned Module 02 reads on.
// A thrown permission read fails closed and does not load financial data.
export async function denyUnlessModule02Read(access, userId) {
  try {
    if ((await access.isModule02ReadEnabled(userId)) === true) return null;
  } catch {
    return { output: MODULE02_READ_DISABLED, isError: true };
  }
  return { output: MODULE02_READ_DISABLED, isError: true };
}
