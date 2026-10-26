// CHIEF budget caps — per-scope, per-period USD ceilings checked before a
// provider call.
//
// The cap idea is REFERENCE ONLY (jarvis-architecture has no license; nothing
// is copied). The check lives here, in the model layer, because every caller
// shares this engine — a user turn today and a scheduled tick later. See
// docs/adr/0003-chief-budget-phase.md. Phase 2 specified this check; Phase 3
// implements it. It is not a second budget system inside the turn machine.
//
// OpenJarvis (commit 5e5f5ef) publishes AGENT_BUDGET_EXCEEDED when a managed
// agent passes its budget. CHIEF keeps that event type (server/chief/core/events.js)
// and raises BudgetExceededError from this module so the caller can emit it.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";

export class BudgetExceededError extends Error {
  constructor(message, { scope, periodType, capUsd, spentUsd, estimateUsd = 0 } = {}) {
    super(message);
    this.name = "BudgetExceededError";
    this.scope = scope ?? null;
    this.periodType = periodType ?? null;
    this.capUsd = capUsd ?? null;
    this.spentUsd = spentUsd ?? null;
    this.estimateUsd = estimateUsd;
  }
}

export function estimateCallUsd(spec, { inputTokens = 0, outputTokens = 0 } = {}) {
  const pricingInput = Number(spec?.metadata?.pricing_input) || 0;
  const pricingOutput = Number(spec?.metadata?.pricing_output) || 0;
  return (inputTokens * pricingInput + outputTokens * pricingOutput) / 1_000_000;
}

export function estimateTokensFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    if (typeof message?.content === "string") chars += message.content.length;
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") chars += part.text.length;
        else if (typeof part?.delta === "string") chars += part.delta.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// Start of the current window in UTC. `run` does not roll on a calendar.
export function periodWindowStart(periodType, now) {
  const date = now instanceof Date ? now : new Date(now);
  if (periodType === "run") return null;
  if (periodType === "day") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rolledSpent(row, now) {
  const window = periodWindowStart(row.periodType, now);
  if (window && row.periodStart && new Date(row.periodStart).getTime() < window.getTime()) {
    return { spentUsd: 0, periodStart: window, rolled: true };
  }
  return {
    spentUsd: asNumber(row.spentUsd),
    periodStart: row.periodStart ? new Date(row.periodStart) : window,
    rolled: false,
  };
}

function exceeds(spentUsd, addition, capUsd) {
  return spentUsd + addition > capUsd + 1e-9;
}

function exceededError(row, spentUsd, estimateUsd) {
  return new BudgetExceededError(
    `CHIEF budget exceeded for ${row.scope}/${row.periodType}: ` +
      `spent ${spentUsd} + ${estimateUsd} over cap ${row.capUsd}`,
    {
      scope: row.scope,
      periodType: row.periodType,
      capUsd: asNumber(row.capUsd),
      spentUsd,
      estimateUsd,
    }
  );
}

export class MemoryBudgetStore {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({
      userId: row.userId,
      scope: row.scope ?? "global",
      periodType: row.periodType ?? "month",
      capUsd: asNumber(row.capUsd),
      spentUsd: asNumber(row.spentUsd),
      periodStart: row.periodStart ? new Date(row.periodStart) : null,
    }));
  }

  _rows(userId, now, { mutate } = {}) {
    const matched = [];
    for (const row of this.rows) {
      if (row.userId !== userId) continue;
      const view = rolledSpent(row, now);
      if (mutate && view.rolled) {
        row.spentUsd = 0;
        row.periodStart = view.periodStart;
      }
      matched.push(mutate ? row : { ...row, spentUsd: view.spentUsd, capUsd: row.capUsd });
    }
    return matched;
  }

  async assertCanSpend(userId, estimateUsd, { now = new Date() } = {}) {
    for (const row of this._rows(userId, now)) {
      if (exceeds(row.spentUsd, estimateUsd, row.capUsd)) {
        throw exceededError(row, row.spentUsd, estimateUsd);
      }
    }
  }

  async recordSpend(userId, amountUsd, { now = new Date() } = {}) {
    if (!(amountUsd > 0)) return [];
    const rows = this._rows(userId, now, { mutate: true });
    let trip = null;
    for (const row of rows) {
      row.spentUsd += amountUsd;
      if (!row.periodStart) row.periodStart = periodWindowStart(row.periodType, now);
      if (exceeds(row.spentUsd, 0, row.capUsd)) trip = row;
    }
    if (trip) throw exceededError(trip, trip.spentUsd, 0);
    return rows;
  }
}

export class PrismaBudgetStore {
  constructor({ withUser = withUserContext, now = () => new Date() } = {}) {
    this._withUser = withUser;
    this._now = now;
  }

  async _load(userId, tx, now) {
    const rows = await tx.chiefBudget.findMany({ where: { userId } });
    return rows.map((row) => {
      const view = rolledSpent(
        {
          ...row,
          capUsd: asNumber(row.capUsd),
          spentUsd: asNumber(row.spentUsd),
        },
        now
      );
      return {
        row,
        ...view,
        capUsd: asNumber(row.capUsd),
        scope: row.scope,
        periodType: row.periodType,
      };
    });
  }

  async assertCanSpend(userId, estimateUsd, { now = this._now() } = {}) {
    await this._withUser(userId, async (tx) => {
      for (const view of await this._load(userId, tx, now)) {
        if (exceeds(view.spentUsd, estimateUsd, view.capUsd)) {
          throw exceededError(view, view.spentUsd, estimateUsd);
        }
      }
    });
  }

  async recordSpend(userId, amountUsd, { now = this._now() } = {}) {
    if (!(amountUsd > 0)) return [];
    // Throw after the transaction commits. A throw inside withUserContext
    // rolls the spend back, and the next call would be allowed again.
    const { views, trip } = await this._withUser(userId, async (tx) => {
      const loaded = await this._load(userId, tx, now);
      let exceeded = null;
      for (const view of loaded) {
        const spentUsd = view.spentUsd + amountUsd;
        const periodStart = view.periodStart ?? periodWindowStart(view.periodType, now);
        await tx.chiefBudget.update({
          where: { id: view.row.id },
          data: { spentUsd, periodStart },
        });
        if (exceeds(spentUsd, 0, view.capUsd)) exceeded = { ...view, spentUsd };
      }
      return { views: loaded, trip: exceeded };
    });
    if (trip) throw exceededError(trip, trip.spentUsd, 0);
    return views;
  }
}

// Unknown Cursor cost stays at this estimate. actualUsd is left null until a
// numeric cost arrives, and it is never stored as 0 to mean "unknown".
export const CURSOR_RUN_ESTIMATE_USD = 1;

const UNVERIFIED = Object.freeze({ ok: false, code: "budget_unverified" });

function asEstimate(value) {
  if (value == null) return CURSOR_RUN_ESTIMATE_USD;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function readRows(query, text, params) {
  const result = await query(text, params);
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

const EXPOSURE_SQL = `
  SELECT COALESCE(SUM(
    CASE
      WHEN "operatorAdjusted" THEN COALESCE("actualUsd", "estimateUsd")
      WHEN "actualUsd" IS NULL THEN "estimateUsd"
      WHEN "actualUsd" > "estimateUsd" THEN "actualUsd"
      ELSE "estimateUsd"
    END
  ), 0) AS exposure
  FROM "chief_budget_hold"
  WHERE "userId" = $1 AND "scope" = $2 AND "periodType" = $3 AND "releasedAt" IS NULL
`;

async function reserveInside(db, input) {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  const operationId = typeof input.operationId === "string" ? input.operationId.trim() : "";
  const scope = input.scope || "cursor";
  const periodType = input.periodType || "run";
  const estimate = asEstimate(input.estimateUsd);
  if (!userId || !operationId || estimate == null) return { ...UNVERIFIED };
  const caps = await db.read(
    `SELECT "id", "capUsd" FROM "chief_budget" WHERE "userId" = $1 AND "scope" = $2 AND "periodType" = $3 FOR UPDATE`,
    [userId, scope, periodType]
  );
  if (caps.length !== 1) return { ...UNVERIFIED };
  const existing = await db.read(
    `SELECT "id", "operationId", "estimateUsd", "actualUsd", "releasedAt" FROM "chief_budget_hold" WHERE "operationId" = $1 FOR UPDATE`,
    [operationId]
  );
  if (existing.length === 1) {
    if (existing[0].releasedAt) return { ok: false, code: "hold_released", reused: true };
    return { ok: true, reused: true, hold: existing[0] };
  }
  const exposureRows = await db.read(EXPOSURE_SQL, [userId, scope, periodType]);
  const exposure = Number(exposureRows[0]?.exposure || 0);
  const cap = Number(caps[0].capUsd);
  if (exposure + estimate > cap + 1e-9) return { ok: false, code: "budget_exceeded" };
  const id = `hold_${randomUUID()}`;
  await db.write(
    `INSERT INTO "chief_budget_hold"
      ("id", "userId", "operationId", "scope", "periodType", "estimateUsd", "actualUsd", "operatorAdjusted", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NULL, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, userId, operationId, scope, periodType, estimate]
  );
  return {
    ok: true,
    reused: false,
    hold: { id, operationId, estimateUsd: estimate, actualUsd: null },
  };
}

function pgDb(connection) {
  return {
    read: async (text, params) =>
      readRows((sql, values) => connection.query(sql, values), text, params),
    write: (text, params) => connection.query(text, params),
  };
}

async function withSqlClient(client, run) {
  if (!client?.query) return { ...UNVERIFIED };
  const owned = typeof client.totalCount === "number";
  let connection = client;
  try {
    if (owned) connection = await client.connect();
    await connection.query("BEGIN");
    const outcome = await run(pgDb(connection));
    if (!outcome?.ok) {
      await connection.query("ROLLBACK");
      return outcome || { ...UNVERIFIED };
    }
    await connection.query("COMMIT");
    return outcome;
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    return { ...UNVERIFIED };
  } finally {
    if (owned && connection !== client) connection.release();
  }
}

export async function reserveHold(input = {}) {
  return withSqlClient(input.client, (query) => reserveInside(query, input));
}

export async function releaseHold(input = {}) {
  return withSqlClient(input.client, async (db) => {
    const operationId = typeof input.operationId === "string" ? input.operationId.trim() : "";
    if (!operationId) return { ...UNVERIFIED };
    await db.write(
      `UPDATE "chief_budget_hold" SET "releasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationId" = $1 AND "releasedAt" IS NULL`,
      [operationId]
    );
    return { ok: true, released: true, operationId };
  });
}

export async function attributeActual(input = {}) {
  return withSqlClient(input.client, async (db) => {
    const operationId = typeof input.operationId === "string" ? input.operationId.trim() : "";
    if (!operationId) return { ...UNVERIFIED };
    if (input.actualUsd == null || !Number.isFinite(Number(input.actualUsd))) {
      return { ok: true, unchanged: true, reason: "unknown_cost" };
    }
    const actual = Number(input.actualUsd);
    const rows = await db.read(
      `SELECT "id", "estimateUsd", "actualUsd" FROM "chief_budget_hold" WHERE "operationId" = $1 FOR UPDATE`,
      [operationId]
    );
    if (rows.length !== 1) return { ...UNVERIFIED };
    const estimate = Number(rows[0].estimateUsd);
    if (actual + 1e-9 < estimate && input.operator !== true) {
      return { ok: true, unchanged: true, reason: "below_estimate" };
    }
    const operatorAdjusted = input.operator === true && actual + 1e-9 < estimate;
    await db.write(
      `UPDATE "chief_budget_hold" SET "actualUsd" = $2, "operatorAdjusted" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationId" = $1`,
      [operationId, actual, operatorAdjusted]
    );
    return { ok: true, actualUsd: actual, operatorAdjusted };
  });
}

function prismaDb(tx) {
  return {
    read: (text, params) => tx.$queryRawUnsafe(text, ...(params || [])),
    write: (text, params) => tx.$executeRawUnsafe(text, ...(params || [])),
  };
}

export function createPrismaReserveHold(withUser = withUserContext) {
  return async (input) => {
    try {
      return await withUser(input.userId, (tx) => reserveInside(prismaDb(tx), input));
    } catch {
      return { ...UNVERIFIED };
    }
  };
}

export function createPrismaReleaseHold(withUser = withUserContext) {
  return async (input) => {
    const operationId = typeof input.operationId === "string" ? input.operationId.trim() : "";
    if (!input.userId || !operationId) return { ...UNVERIFIED };
    try {
      await withUser(input.userId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "chief_budget_hold" SET "releasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationId" = $1 AND "releasedAt" IS NULL AND "userId" = $2`,
          operationId,
          input.userId
        )
      );
      return { ok: true, released: true, operationId };
    } catch {
      return { ...UNVERIFIED };
    }
  };
}
