// CHIEF security audit log. Writes gate denials and output fences to
// chief_audit_log. This is not a second approval system.

import { withUserContext } from "../../db/prisma.js";

export class MemoryAuditLog {
  constructor() {
    this.entries = [];
  }

  async write(entry) {
    const row = {
      userId: entry.userId ?? null,
      actor: entry.actor ?? null,
      action: entry.action,
      resource: entry.resource ?? null,
      summary: entry.summary ?? null,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(row);
    return row;
  }
}

export class PrismaAuditLog {
  constructor({ withUser = withUserContext } = {}) {
    this._withUser = withUser;
  }

  async write(entry) {
    if (!entry?.userId) return null;
    return this._withUser(entry.userId, (tx) =>
      tx.chiefAuditLog.create({
        data: {
          userId: entry.userId,
          actor: entry.actor ?? null,
          action: entry.action,
          resource: entry.resource ?? null,
          summary: entry.summary ?? null,
        },
      })
    );
  }
}
