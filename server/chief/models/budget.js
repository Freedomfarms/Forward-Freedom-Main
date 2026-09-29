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
