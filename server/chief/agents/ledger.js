// Durable execution approval and Cursor run ledger.
//
// ChiefApproval records a paused tool batch. It cannot name an objective,
// repository, ref, and execution scope, so this table is the execution
// approval. A conversational yes does not write a row.
//
// COMPLETED means Cursor returned FINISHED. verified stays false.
//
// Ambiguous recovery uses the reserved bc- id. GET /v1/agents/{id} either
// finds the agent Cursor accepted or reports that it was never created.
// That path does not call POST /v1/agents. A lost response cannot mint a
// second agent. A new explicit approval is required after a confirmed miss.
//
// Polling is not started here. runChiefTick is the host: listNonterminal
// with the service client, then withUserContext for each owner. It stays
// inactive until CURSOR_API_KEY and the repository allowlist are configured.

import { createHash, randomUUID } from "node:crypto";

import {
  ExecutionError,
  isExactRepositoryUrl,
  isProtectedRepository,
  isRunStatus,
} from "./execution.js";

export const EXECUTION_SCOPE = Object.freeze({
  effect: "execute",
  workOnCurrentBranch: false,
  autoCreatePR: false,
});

export const ExecutionState = Object.freeze({
  APPROVED: "APPROVED",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  AMBIGUOUS: "AMBIGUOUS",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
});

export const NONTERMINAL_STATES = Object.freeze([
  ExecutionState.SUBMITTING,
  ExecutionState.SUBMITTED,
  ExecutionState.AMBIGUOUS,
  ExecutionState.RUNNING,
]);

const TERMINAL_STATES = new Set([
  ExecutionState.COMPLETED,
  ExecutionState.FAILED,
  ExecutionState.CANCELLED,
  ExecutionState.EXPIRED,
]);

const PLATFORM_STATE = Object.freeze({
  CREATING: ExecutionState.SUBMITTED,
  RUNNING: ExecutionState.RUNNING,
  FINISHED: ExecutionState.COMPLETED,
  ERROR: ExecutionState.FAILED,
  CANCELLED: ExecutionState.CANCELLED,
  EXPIRED: ExecutionState.EXPIRED,
});

function fail(code, message) {
  throw new ExecutionError(code, message);
}

function hasControlChar(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function sealText(value, encrypt) {
  const sealed = encrypt(String(value));
  if (typeof sealed !== "string" || sealed.length === 0 || sealed === String(value)) {
    fail("ledger_invalid", "Execution text was not sealed");
  }
  return sealed;
}

function openText(payload, decrypt) {
  if (payload == null) return null;
  const opened = decrypt(payload);
  if (typeof opened !== "string") fail("ledger_invalid", "Execution text could not be read");
  return opened;
}

export function executionScopeHash(scope) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        userId: scope.userId,
        provider: scope.provider,
        objective: scope.objective,
        constraints: scope.constraints,
        repositoryUrl: scope.repositoryUrl,
        startingRef: scope.startingRef,
        effect: scope.scope.effect,
        workOnCurrentBranch: scope.scope.workOnCurrentBranch,
        autoCreatePR: scope.scope.autoCreatePR,
      })
    )
    .digest("hex");
}

export function mintPlatformAgentId() {
  return `bc-${randomUUID()}`;
}

function constraintsOf(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const items = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item !== item.trim() ||
      item.length === 0 ||
      item.length > 500
    ) {
      return null;
    }
    if (hasControlChar(item)) return null;
    items.push(item);
  }
  return items;
}

function grantInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("objective_invalid", "Execution objective is malformed");
  }
  if (
    typeof input.userId !== "string" ||
    input.userId.trim() === "" ||
    input.userId !== input.userId.trim()
  ) {
    fail("unauthorized", "Execution requires the authorized user");
  }
  if (input.provider !== "cursor-cloud")
    fail("provider_unsupported", "Execution provider is not supported");
  if (typeof input.objective !== "string" || input.objective !== input.objective.trim()) {
    fail("objective_invalid", "Execution objective is malformed");
  }
  if (
    input.objective.length === 0 ||
    input.objective.length > 8000 ||
    input.objective.includes("\u0000")
  ) {
    fail("objective_invalid", "Execution objective is malformed");
  }
  const constraints = constraintsOf(input.constraints);
  if (!constraints) fail("approval_mismatch", "Approval does not cover this execution scope");
  if (typeof input.repositoryUrl !== "string" || isProtectedRepository(input.repositoryUrl)) {
    fail(
      "repository_forbidden",
      "Freedom Financial and XRP repositories cannot be execution targets"
    );
  }
  if (!isExactRepositoryUrl(input.repositoryUrl)) {
    fail("repository_not_allowed", "Execution repository is not on the allowlist");
  }
  if (
    typeof input.startingRef !== "string" ||
    input.startingRef.trim() === "" ||
    input.startingRef !== input.startingRef.trim()
  ) {
    fail("ref_missing", "Execution requires an approved starting ref");
  }
  if (
    input.startingRef.length > 255 ||
    hasControlChar(input.startingRef) ||
    /\s/.test(input.startingRef) ||
    input.startingRef.includes("..") ||
    input.startingRef.startsWith("/") ||
    input.startingRef.endsWith("/")
  ) {
    fail("ref_invalid", "Execution starting ref is invalid");
  }
  const scope = input.scope;
  const keys = scope && typeof scope === "object" ? Object.keys(scope) : [];
  if (
    keys.length !== 3 ||
    scope.effect !== EXECUTION_SCOPE.effect ||
    scope.workOnCurrentBranch !== false ||
    scope.autoCreatePR !== false
  ) {
    fail("scope_rejected", "Execution scope does not match the approved scope");
  }
  if (
    input.intentionId != null &&
    (typeof input.intentionId !== "string" || input.intentionId.length > 200)
  ) {
    fail("approval_mismatch", "Approval does not cover this execution scope");
  }
  return {
    userId: input.userId,
    intentionId: input.intentionId ?? null,
    provider: "cursor-cloud",
    objective: input.objective,
    constraints,
    repositoryUrl: input.repositoryUrl,
    startingRef: input.startingRef,
    scope: {
      effect: EXECUTION_SCOPE.effect,
      workOnCurrentBranch: false,
      autoCreatePR: false,
    },
  };
}

function hashFromSnapshot(snapshot) {
  return executionScopeHash({
    userId: snapshot.userId,
    provider: snapshot.provider,
    objective: snapshot.objective,
    constraints: snapshot.constraints ?? [],
    repositoryUrl: snapshot.repositoryUrl,
    startingRef: snapshot.startingRef,
    scope: snapshot.scope ?? EXECUTION_SCOPE,
  });
}

export function classifyExecutionClaim(row, snapshot) {
  if (!row) return { action: "absent" };
  if (row.userId !== snapshot.userId) return { action: "unauthorized" };
  if (row.scopeHash !== hashFromSnapshot(snapshot)) return { action: "invalidated" };
  if (row.state === ExecutionState.APPROVED) return { action: "start" };
  if (row.state === ExecutionState.SUBMITTING || row.state === ExecutionState.AMBIGUOUS) {
    return { action: "blocked" };
  }
  return { action: "duplicate" };
}

export function stateForPlatformStatus(status) {
  return PLATFORM_STATE[status] ?? null;
}

function adapterState(state) {
  if (state === ExecutionState.SUBMITTING) return "pending";
  if (state === ExecutionState.AMBIGUOUS) return "ambiguous";
  if (state === ExecutionState.FAILED) return "rejected";
  return "submitted";
}

function copyRow(row) {
  return row ? structuredClone(row) : null;
}

export function createMemoryExecutionStore({ encrypt, decrypt, now = () => new Date() } = {}) {
  if (typeof encrypt !== "function" || typeof decrypt !== "function") {
    fail("ledger_invalid", "Execution ledger requires sealed text");
  }
  const rows = new Map();

  function view(row) {
    if (!row || row.verified !== false) return null;
    let constraints = [];
    const openedConstraints = openText(row.constraintsCiphertext, decrypt);
    if (openedConstraints) constraints = JSON.parse(openedConstraints);
    return {
      id: row.id,
      approvalId: row.approvalId,
      userId: row.userId,
      intentionId: row.intentionId,
      provider: row.provider,
      objective: openText(row.objectiveCiphertext, decrypt),
      constraints,
      repositoryUrl: row.repositoryUrl,
      startingRef: row.startingRef,
      scope: structuredClone(row.scopeJson),
      state: row.state,
      platformStatus: row.platformStatus,
      platformCode: row.platformCode,
      agentId: row.agentId,
      runId: row.runId,
      attempt: row.attempt,
      ambiguousAt: row.ambiguousAt,
      submittedAt: row.submittedAt,
      terminalAt: row.terminalAt,
      statement: openText(row.statementCiphertext, decrypt),
      verified: false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function adapterRecord(row) {
    const opened = view(row);
    if (!opened) return null;
    return {
      ...opened,
      state: adapterState(row.state),
      status: row.platformStatus,
    };
  }

  function byApproval(approvalId) {
    for (const row of rows.values()) {
      if (row.approvalId === approvalId) return row;
    }
    return null;
  }

  function write(row) {
    if (row.verified !== false)
      fail("ledger_invalid", "Platform status does not verify the objective");
    rows.set(row.id, row);
    return row;
  }

  return {
    rows() {
      return [...rows.values()].map((row) => copyRow(row));
    },

    async grant(input) {
      const scope = grantInput(input);
      const at = now();
      const row = {
        id: `exec-${randomUUID()}`,
        userId: scope.userId,
        approvalId: `appr-${randomUUID()}`,
        intentionId: scope.intentionId,
        provider: scope.provider,
        objectiveCiphertext: sealText(scope.objective, encrypt),
        constraintsCiphertext: sealText(JSON.stringify(scope.constraints), encrypt),
        repositoryUrl: scope.repositoryUrl,
        startingRef: scope.startingRef,
        scopeJson: scope.scope,
        scopeHash: executionScopeHash(scope),
        state: ExecutionState.APPROVED,
        platformStatus: null,
        platformCode: null,
        agentId: null,
        runId: null,
        attempt: 0,
        ambiguousAt: null,
        submittedAt: null,
        terminalAt: null,
        statementCiphertext: null,
        verified: false,
        createdAt: at,
        updatedAt: at,
      };
      write(row);
      return view(row);
    },

    async get(userId, id) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      return view(row);
    },

    async listNonterminal(limit = 20) {
      const found = [];
      for (const row of rows.values()) {
        if (!NONTERMINAL_STATES.includes(row.state)) continue;
        found.push({ id: row.id, userId: row.userId, state: row.state, updatedAt: row.updatedAt });
      }
      found.sort((left, right) => new Date(left.updatedAt) - new Date(right.updatedAt));
      return found.slice(0, limit);
    },

    async notePlatformCode(userId, id, code) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      row.platformCode = code;
      row.updatedAt = now();
      write(row);
      return view(row);
    },

    adapter() {
      return {
        async begin(approvalId, snapshot) {
          const row = byApproval(approvalId);
          const decision = classifyExecutionClaim(row, snapshot);
          if (decision.action === "absent" || decision.action === "unauthorized") {
            return { action: decision.action };
          }
          if (decision.action === "start") {
            row.state = ExecutionState.SUBMITTING;
            row.attempt += 1;
            row.agentId = row.agentId ?? mintPlatformAgentId();
            row.updatedAt = now();
            write(row);
          }
          return { action: decision.action, record: adapterRecord(row) };
        },

        async finish(approvalId, expectedState, patch) {
          const row = byApproval(approvalId);
          if (!row || expectedState !== "pending" || row.state !== ExecutionState.SUBMITTING) {
            return { ok: false, record: adapterRecord(row) };
          }
          const at = now();
          if (patch.state === "submitted") {
            if (row.agentId && patch.agentId !== row.agentId) {
              row.state = ExecutionState.AMBIGUOUS;
              row.ambiguousAt = at;
            } else {
              row.state = ExecutionState.SUBMITTED;
              row.agentId = patch.agentId;
              row.runId = patch.runId;
              row.platformStatus = patch.status;
              row.submittedAt = at;
            }
          } else if (patch.state === "ambiguous") {
            row.state = ExecutionState.AMBIGUOUS;
            row.ambiguousAt = at;
            if (patch.agentId) row.agentId = patch.agentId;
          } else if (patch.state === "rejected") {
            row.state = ExecutionState.FAILED;
            row.terminalAt = at;
          }
          row.updatedAt = at;
          row.verified = false;
          write(row);
          return { ok: true, record: adapterRecord(row) };
        },

        async findRun(agentId, runId) {
          const matches = [];
          for (const row of rows.values()) {
            if (row.agentId === agentId && row.runId === runId && row.runId) matches.push(row);
          }
          if (matches.length !== 1) return null;
          return adapterRecord(matches[0]);
        },

        async findAgent(agentId) {
          const matches = [];
          for (const row of rows.values()) {
            if (row.agentId === agentId) matches.push(row);
          }
          if (matches.length !== 1) return null;
          return adapterRecord(matches[0]);
        },

        async attachRun(approvalId, { agentId, runId }) {
          const row = byApproval(approvalId);
          if (!row || row.agentId !== agentId) return null;
          if (row.state !== ExecutionState.AMBIGUOUS && row.state !== ExecutionState.SUBMITTING) {
            return adapterRecord(row);
          }
          if (row.runId && row.runId !== runId) return null;
          row.runId = runId;
          row.state = ExecutionState.SUBMITTED;
          row.platformStatus = row.platformStatus ?? "CREATING";
          row.submittedAt = row.submittedAt ?? now();
          row.updatedAt = now();
          row.verified = false;
          write(row);
          return adapterRecord(row);
        },

        async markStatus(approvalId, status, run) {
          const row = byApproval(approvalId);
          const next = stateForPlatformStatus(status);
          if (!row || !next || !isRunStatus(status)) return null;
          if (row.state === ExecutionState.APPROVED || row.state === ExecutionState.AMBIGUOUS)
            return null;
          row.state = next;
          row.platformStatus = status;
          if (typeof run?.result === "string" && run.result.trim() !== "") {
            row.statementCiphertext = sealText(run.result, encrypt);
          }
          if (TERMINAL_STATES.has(next)) row.terminalAt = row.terminalAt ?? now();
          row.verified = false;
          row.updatedAt = now();
          write(row);
          return adapterRecord(row);
        },
      };
    },
  };
}

export function commandForGrant(record) {
  const scope = {
    effect: "execute",
    workOnCurrentBranch: false,
    autoCreatePR: false,
  };
  return {
    userId: record.userId,
    provider: record.provider,
    objective: record.objective,
    constraints: record.constraints,
    repositoryUrl: record.repositoryUrl,
    startingRef: record.startingRef,
    approval: {
      id: record.approvalId,
      decision: "approved",
      userId: record.userId,
      provider: record.provider,
      objective: record.objective,
      constraints: record.constraints,
      repositoryUrl: record.repositoryUrl,
      startingRef: record.startingRef,
      scope,
    },
  };
}

export async function submitGranted({ store, runtime, userId, executionId }) {
  const record = await store.get(userId, executionId);
  if (!record) fail("unknown_run", "Cursor run reference is not a stored execution");
  return runtime.submit(commandForGrant(record), { userId });
}

export async function reconcileGranted({ store, runtime, userId, executionId }) {
  const record = await store.get(userId, executionId);
  if (!record) fail("unknown_run", "Cursor run reference is not a stored execution");
  if (record.state !== ExecutionState.AMBIGUOUS && record.state !== ExecutionState.SUBMITTING) {
    return { changed: false, record };
  }
  if (!record.agentId) return { changed: false, record, reason: "no_platform_identity" };
  const looked = await runtime.lookupPlatformAgent(record.agentId, { userId });
  if (!looked.found) {
    return { changed: false, record: await store.get(userId, executionId), reason: "not_created" };
  }
  if (looked.runId) {
    await runtime.getStatus({ agentId: record.agentId, runId: looked.runId }, { userId });
  }
  return { changed: Boolean(looked.runId), record: await store.get(userId, executionId) };
}

export async function cancelGranted({ store, runtime, userId, executionId }) {
  const record = await store.get(userId, executionId);
  if (!record) fail("unknown_run", "Cursor run reference is not a stored execution");
  if (!record.agentId || !record.runId) {
    fail("unknown_run", "Cursor run reference is not a stored execution");
  }
  const reference = { agentId: record.agentId, runId: record.runId };
  try {
    const cancelled = await runtime.cancel(reference, { userId });
    return { cancelled: true, result: cancelled, record: await store.get(userId, executionId) };
  } catch (error) {
    if (error?.code !== "run_not_cancellable") throw error;
    await store.notePlatformCode(userId, executionId, "run_not_cancellable");
    const status = await runtime.getStatus(reference, { userId });
    return {
      cancelled: false,
      reconciled: true,
      status,
      record: await store.get(userId, executionId),
    };
  }
}

export class PrismaExecutionStore {
  constructor({ withUser, service, encrypt, decrypt, now = () => new Date() } = {}) {
    if (
      typeof withUser !== "function" ||
      typeof encrypt !== "function" ||
      typeof decrypt !== "function"
    ) {
      fail("ledger_invalid", "Execution ledger requires a user-scoped database");
    }
    this._withUser = withUser;
    this._service = service;
    this._encrypt = encrypt;
    this._decrypt = decrypt;
    this._now = now;
  }

  _view(row) {
    if (!row) return null;
    const constraints = JSON.parse(openText(row.constraintsCiphertext, this._decrypt) ?? "[]");
    return {
      id: row.id,
      approvalId: row.approvalId,
      userId: row.userId,
      intentionId: row.intentionId,
      provider: row.provider,
      objective: openText(row.objectiveCiphertext, this._decrypt),
      constraints,
      repositoryUrl: row.repositoryUrl,
      startingRef: row.startingRef,
      scope: row.scopeJson,
      state: row.state,
      platformStatus: row.platformStatus,
      platformCode: row.platformCode,
      agentId: row.agentId,
      runId: row.runId,
      attempt: row.attempt,
      ambiguousAt: row.ambiguousAt,
      submittedAt: row.submittedAt,
      terminalAt: row.terminalAt,
      statement: openText(row.statementCiphertext, this._decrypt),
      verified: false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async grant(input) {
    const scope = grantInput(input);
    return this._withUser(scope.userId, async (tx) => {
      const created = await tx.workforceExecution.create({
        data: {
          id: `exec-${randomUUID()}`,
          userId: scope.userId,
          approvalId: `appr-${randomUUID()}`,
          intentionId: scope.intentionId,
          provider: scope.provider,
          objectiveCiphertext: sealText(scope.objective, this._encrypt),
          constraintsCiphertext: sealText(JSON.stringify(scope.constraints), this._encrypt),
          repositoryUrl: scope.repositoryUrl,
          startingRef: scope.startingRef,
          scopeJson: scope.scope,
          scopeHash: executionScopeHash(scope),
          state: ExecutionState.APPROVED,
          verified: false,
        },
      });
      return this._view(created);
    });
  }

  async get(userId, id) {
    return this._withUser(userId, async (tx) => {
      const row = await tx.workforceExecution.findFirst({ where: { id, userId } });
      return this._view(row);
    });
  }

  async listNonterminal(limit = 20) {
    const client = this._service?.();
    if (!client) fail("ledger_invalid", "Execution ledger requires a user-scoped database");
    return client.workforceExecution.findMany({
      where: { state: { in: [...NONTERMINAL_STATES] } },
      select: { id: true, userId: true, state: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  }

  async notePlatformCode(userId, id, code) {
    return this._withUser(userId, async (tx) => {
      const { count } = await tx.workforceExecution.updateMany({
        where: { id, userId },
        data: { platformCode: code },
      });
      if (count !== 1) return null;
      const row = await tx.workforceExecution.findFirst({ where: { id, userId } });
      return this._view(row);
    });
  }

  async _owned(where) {
    const client = this._service?.();
    if (!client) return null;
    const located = await client.workforceExecution.findFirst({ where });
    if (!located) return null;
    return this._withUser(located.userId, async (tx) =>
      tx.workforceExecution.findFirst({ where: { id: located.id, userId: located.userId } })
    );
  }

  adapter() {
    const store = this;
    return {
      async begin(approvalId, snapshot) {
        return store._withUser(snapshot.userId, async (tx) => {
          const row = await tx.workforceExecution.findFirst({
            where: { approvalId, userId: snapshot.userId },
          });
          const decision = classifyExecutionClaim(row, snapshot);
          if (decision.action === "absent" || decision.action === "unauthorized") {
            return { action: decision.action };
          }
          if (decision.action !== "start") {
            return { action: decision.action, record: store._adapterRecord(row) };
          }
          const agentId = row.agentId ?? mintPlatformAgentId();
          const { count } = await tx.workforceExecution.updateMany({
            where: {
              id: row.id,
              userId: snapshot.userId,
              state: ExecutionState.APPROVED,
              scopeHash: row.scopeHash,
            },
            data: { state: ExecutionState.SUBMITTING, attempt: { increment: 1 }, agentId },
          });
          const current = await tx.workforceExecution.findFirst({
            where: { id: row.id, userId: snapshot.userId },
          });
          if (count !== 1) {
            const again = classifyExecutionClaim(current, snapshot);
            const action = again.action === "start" ? "blocked" : again.action;
            return { action, record: store._adapterRecord(current) };
          }
          return { action: "start", record: store._adapterRecord(current) };
        });
      },

      async finish(approvalId, expectedState, patch) {
        const located = await store._owned({ approvalId });
        if (
          !located ||
          expectedState !== "pending" ||
          located.state !== ExecutionState.SUBMITTING
        ) {
          return { ok: false, record: located ? store._adapterRecord(located) : null };
        }
        return store._withUser(located.userId, async (tx) => {
          const at = store._now();
          const data = { verified: false };
          if (patch.state === "submitted" && located.agentId && patch.agentId !== located.agentId) {
            data.state = ExecutionState.AMBIGUOUS;
            data.ambiguousAt = at;
          } else if (patch.state === "submitted") {
            data.state = ExecutionState.SUBMITTED;
            data.agentId = patch.agentId;
            data.runId = patch.runId;
            data.platformStatus = patch.status;
            data.submittedAt = at;
          } else if (patch.state === "ambiguous") {
            data.state = ExecutionState.AMBIGUOUS;
            data.ambiguousAt = at;
            if (patch.agentId) data.agentId = patch.agentId;
          } else if (patch.state === "rejected") {
            data.state = ExecutionState.FAILED;
            data.terminalAt = at;
          }
          const { count } = await tx.workforceExecution.updateMany({
            where: { id: located.id, userId: located.userId, state: ExecutionState.SUBMITTING },
            data,
          });
          const current = await tx.workforceExecution.findFirst({
            where: { id: located.id, userId: located.userId },
          });
          return { ok: count === 1, record: store._adapterRecord(current) };
        });
      },

      async findRun(agentId, runId) {
        const row = await store._owned({ agentId, runId });
        if (!row?.runId) return null;
        return store._adapterRecord(row);
      },

      async findAgent(agentId) {
        const row = await store._owned({ agentId });
        if (!row) return null;
        return store._adapterRecord(row);
      },

      async attachRun(approvalId, { agentId, runId }) {
        const located = await store._owned({ approvalId });
        if (!located || located.agentId !== agentId) return null;
        if (
          located.state !== ExecutionState.AMBIGUOUS &&
          located.state !== ExecutionState.SUBMITTING
        ) {
          return store._adapterRecord(located);
        }
        if (located.runId && located.runId !== runId) return null;
        return store._withUser(located.userId, async (tx) => {
          const at = store._now();
          await tx.workforceExecution.updateMany({
            where: {
              id: located.id,
              userId: located.userId,
              agentId,
              state: { in: [ExecutionState.AMBIGUOUS, ExecutionState.SUBMITTING] },
            },
            data: {
              runId,
              state: ExecutionState.SUBMITTED,
              platformStatus: located.platformStatus ?? "CREATING",
              submittedAt: located.submittedAt ?? at,
              verified: false,
            },
          });
          const current = await tx.workforceExecution.findFirst({
            where: { id: located.id, userId: located.userId },
          });
          return store._adapterRecord(current);
        });
      },

      async markStatus(approvalId, status, run) {
        const next = stateForPlatformStatus(status);
        if (!next || !isRunStatus(status)) return null;
        const located = await store._owned({ approvalId });
        if (
          !located ||
          located.state === ExecutionState.APPROVED ||
          located.state === ExecutionState.AMBIGUOUS
        ) {
          return null;
        }
        return store._withUser(located.userId, async (tx) => {
          const data = { state: next, platformStatus: status, verified: false };
          if (typeof run?.result === "string" && run.result.trim() !== "") {
            data.statementCiphertext = sealText(run.result, store._encrypt);
          }
          if (TERMINAL_STATES.has(next)) data.terminalAt = located.terminalAt ?? store._now();
          const { count } = await tx.workforceExecution.updateMany({
            where: {
              id: located.id,
              userId: located.userId,
              state: { notIn: [ExecutionState.APPROVED, ExecutionState.AMBIGUOUS] },
            },
            data,
          });
          if (count !== 1) return null;
          const current = await tx.workforceExecution.findFirst({
            where: { id: located.id, userId: located.userId },
          });
          return store._adapterRecord(current);
        });
      },
    };
  }

  _adapterRecord(row) {
    const opened = this._view(row);
    if (!opened) return null;
    return { ...opened, state: adapterState(row.state), status: row.platformStatus };
  }
}
