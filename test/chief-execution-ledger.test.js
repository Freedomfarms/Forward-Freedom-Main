// Durable execution approval. The transport is a mock. No Cursor API call is made.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createExecutionRuntime } from "../server/chief/agents/index.js";
import {
  ExecutionState,
  NONTERMINAL_STATES,
  PrismaExecutionStore,
  cancelGranted,
  classifyExecutionClaim,
  commandForGrant,
  createMemoryExecutionStore,
  reconcileGranted,
  submitGranted,
} from "../server/chief/agents/ledger.js";

const REPO = "https://github.com/example/forward-freedom";
const KEY = "cursor-test-key";
const RUN = "run-00000000-0000-0000-0000-0000000000aa";

function seal(value) {
  return `sealed:${Buffer.from(String(value), "utf8").toString("base64")}`;
}

function open(value) {
  if (typeof value !== "string" || !value.startsWith("sealed:")) throw new Error("unreadable");
  return Buffer.from(value.slice("sealed:".length), "base64").toString("utf8");
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body ?? {});
    },
  };
}

function createdFrom(request) {
  return jsonResponse(200, {
    agent: { id: request.body.agentId, latestRunId: RUN },
    run: { id: RUN, agentId: request.body.agentId, status: "CREATING" },
  });
}

function executionFor(executionStore, fetch) {
  const calls = [];
  const runtime = createExecutionRuntime({
    apiKey: KEY,
    allowlist: [REPO, "https://github.com/example/other"],
    ledger: executionStore.adapter(),
    fetch: async (url, init) => {
      const request = {
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : null,
      };
      calls.push(request);
      return fetch(request);
    },
  });
  return { runtime, calls, store: executionStore };
}

function newStore() {
  return createMemoryExecutionStore({ encrypt: seal, decrypt: open });
}

async function granted(executionStore, overrides = {}) {
  return executionStore.grant({
    userId: "user-a",
    intentionId: "intention-1",
    provider: "cursor-cloud",
    objective: "Ship the patch",
    constraints: ["Do not change Freedom Financial or XRP"],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { effect: "execute", workOnCurrentBranch: false, autoCreatePR: false },
    apiKey: KEY,
    ...overrides,
  });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("a granted execution survives a new runtime and does not submit twice", async () => {
  const executionStore = newStore();
  const first = executionFor(executionStore, async (request) => createdFrom(request));
  const approval = await granted(executionStore);
  const submitted = await submitGranted({
    store: executionStore,
    runtime: first.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].method, "POST");
  assert.equal(first.calls[0].url, "https://api.cursor.com/v1/agents");
  assert.equal(first.calls[0].body.workOnCurrentBranch, false);
  assert.equal(first.calls[0].body.autoCreatePR, false);
  assert.equal(first.calls[0].body.env, undefined);
  assert.equal(first.calls[0].body.agentId, submitted.agentId);
  assert.equal(submitted.runId, RUN);
  assert.equal(submitted.duplicate, false);

  const stored = await executionStore.get("user-a", approval.id);
  assert.equal(stored.state, ExecutionState.SUBMITTED);
  assert.equal(stored.platformStatus, "CREATING");
  assert.equal(stored.agentId, submitted.agentId);
  assert.equal(stored.runId, RUN);
  assert.equal(stored.attempt, 1);
  assert.equal(stored.verified, false);
  assert.equal(stored.intentionId, "intention-1");
  const sealed = executionStore.rows()[0];
  assert.equal(sealed.objectiveCiphertext.includes("Ship the patch"), false);
  assert.equal(JSON.stringify(sealed).includes(KEY), false);

  const second = executionFor(executionStore, async () => {
    throw new Error("Cursor API was called");
  });
  const resumed = await submitGranted({
    store: executionStore,
    runtime: second.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(second.calls.length, 0);
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.agentId, stored.agentId);
  assert.equal(resumed.runId, RUN);
  assert.equal((await executionStore.get("user-a", approval.id)).attempt, 1);
});

test("one user cannot read or cancel another user's execution", async () => {
  const executionStore = newStore();
  const { runtime, calls } = executionFor(executionStore, async (request) => createdFrom(request));
  const approval = await granted(executionStore);
  await submitGranted({
    store: executionStore,
    runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(await executionStore.get("user-b", approval.id), null);
  const before = calls.length;
  const error = await rejection(
    cancelGranted({
      store: executionStore,
      runtime,
      userId: "user-b",
      executionId: approval.id,
    })
  );
  assert.equal(error.code, "unknown_run");
  assert.equal(calls.length, before);

  const forged = commandForGrant(approval);
  forged.userId = "user-b";
  forged.approval.userId = "user-b";
  const mismatch = await rejection(runtime.submit(forged, { userId: "user-b" }));
  assert.equal(mismatch.code, "unauthorized");
  assert.equal(calls.length, before);
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.SUBMITTED);
});

test("a changed objective, repository, ref, constraint, or scope invalidates that approval", async () => {
  const cases = [
    (command) => {
      command.objective = "Ship a different patch";
      command.approval.objective = command.objective;
    },
    (command) => {
      const repositoryUrl = "https://github.com/example/other";
      command.repositoryUrl = repositoryUrl;
      command.approval.repositoryUrl = repositoryUrl;
    },
    (command) => {
      command.startingRef = "release";
      command.approval.startingRef = "release";
    },
    (command) => {
      command.constraints = ["Touch a different system"];
      command.approval.constraints = ["Touch a different system"];
    },
    (command) => {
      command.approval.scope = {
        effect: "execute",
        workOnCurrentBranch: true,
        autoCreatePR: false,
      };
    },
  ];
  for (const change of cases) {
    const executionStore = newStore();
    const { runtime, calls } = executionFor(executionStore, async () => {
      throw new Error("Cursor API was called");
    });
    const approval = await granted(executionStore);
    const command = commandForGrant(await executionStore.get("user-a", approval.id));
    change(command);
    const error = await rejection(runtime.submit(command, { userId: "user-a" }));
    assert.equal(error.code, "approval_mismatch");
    assert.equal(calls.length, 0);
    const stored = await executionStore.get("user-a", approval.id);
    assert.equal(stored.state, ExecutionState.APPROVED);
    assert.equal(stored.objective, "Ship the patch");
    assert.equal(stored.attempt, 0);
  }
});

test("an ambiguous submission keeps its reserved agent and is not retried", async () => {
  const executionStore = newStore();
  const first = executionFor(executionStore, async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  const approval = await granted(executionStore);
  const error = await rejection(
    submitGranted({
      store: executionStore,
      runtime: first.runtime,
      userId: "user-a",
      executionId: approval.id,
    })
  );
  assert.equal(error.code, "reconciliation_required");
  assert.equal(error.message.includes(KEY), false);
  const ambiguous = await executionStore.get("user-a", approval.id);
  assert.equal(ambiguous.state, ExecutionState.AMBIGUOUS);
  assert.match(ambiguous.agentId, /^bc-/);
  assert.equal(ambiguous.runId, null);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].body.agentId, ambiguous.agentId);

  const second = executionFor(executionStore, async () => {
    throw new Error("Cursor API was called");
  });
  const again = await rejection(
    submitGranted({
      store: executionStore,
      runtime: second.runtime,
      userId: "user-a",
      executionId: approval.id,
    })
  );
  assert.equal(again.code, "reconciliation_required");
  assert.equal(second.calls.length, 0);

  const lookup = executionFor(executionStore, async (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, `https://api.cursor.com/v1/agents/${ambiguous.agentId}`);
    return jsonResponse(404, { code: "not_found" });
  });
  const reconciled = await reconcileGranted({
    store: executionStore,
    runtime: lookup.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(reconciled.reason, "not_created");
  assert.equal(
    lookup.calls.some((call) => call.method === "POST"),
    false
  );
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.AMBIGUOUS);
});

test("reconciling a lost create response stores the platform run without posting again", async () => {
  const executionStore = newStore();
  const first = executionFor(executionStore, async () => {
    throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
  });
  const approval = await granted(executionStore);
  await rejection(
    submitGranted({
      store: executionStore,
      runtime: first.runtime,
      userId: "user-a",
      executionId: approval.id,
    })
  );
  const reserved = (await executionStore.get("user-a", approval.id)).agentId;
  const lookup = executionFor(executionStore, async (request) => {
    if (request.url.endsWith(`/runs/${RUN}`)) {
      return jsonResponse(200, {
        id: RUN,
        agentId: reserved,
        status: "RUNNING",
      });
    }
    return jsonResponse(200, { id: reserved, latestRunId: RUN });
  });
  const reconciled = await reconcileGranted({
    store: executionStore,
    runtime: lookup.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(
    lookup.calls.some((call) => call.method === "POST"),
    false
  );
  assert.equal(reconciled.record.state, ExecutionState.RUNNING);
  assert.equal(reconciled.record.runId, RUN);
  assert.equal(reconciled.record.agentId, reserved);
  assert.equal(reconciled.record.verified, false);
});

test("terminal platform status is durable and is not objective success", async () => {
  const executionStore = newStore();
  const { runtime, calls } = executionFor(executionStore, async (request) => {
    if (request.method === "POST") return createdFrom(request);
    return jsonResponse(200, {
      id: RUN,
      agentId: request.url.split("/agents/")[1].split("/runs/")[0],
      status: "FINISHED",
      result: "All tests passed. I opened a pull request.",
    });
  });
  const approval = await granted(executionStore);
  const submitted = await submitGranted({
    store: executionStore,
    runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  await runtime.getResult({ agentId: submitted.agentId, runId: RUN }, { userId: "user-a" });
  const stored = await executionStore.get("user-a", approval.id);
  assert.equal(stored.state, ExecutionState.COMPLETED);
  assert.equal(stored.platformStatus, "FINISHED");
  assert.equal(stored.verified, false);
  assert.match(stored.statement, /All tests passed/);
  assert.equal(executionStore.rows()[0].verified, false);
  assert.equal(NONTERMINAL_STATES.includes(stored.state), false);
  assert.equal(
    (await executionStore.listNonterminal()).some((row) => row.id === approval.id),
    false
  );
  assert.equal(calls.at(-1).method, "GET");

  const reread = await new Promise((resolve) => resolve(executionStore.get("user-a", approval.id)));
  assert.equal((await reread).state, ExecutionState.COMPLETED);
  assert.equal((await reread).platformStatus, "FINISHED");
});

test("cancel uses the stored run and a terminal race reconciles the platform status", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  const created = executionFor(executionStore, async (request) => createdFrom(request));
  const submitted = await submitGranted({
    store: executionStore,
    runtime: created.runtime,
    userId: "user-a",
    executionId: approval.id,
  });

  const cancelling = executionFor(executionStore, async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      `https://api.cursor.com/v1/agents/${submitted.agentId}/runs/${RUN}/cancel`
    );
    return jsonResponse(200, { id: RUN });
  });
  const cancelled = await cancelGranted({
    store: executionStore,
    runtime: cancelling.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.CANCELLED);
  assert.equal((await executionStore.get("user-a", approval.id)).platformStatus, "CANCELLED");

  const racedStore = newStore();
  const racedApproval = await granted(racedStore);
  const racedCreate = executionFor(racedStore, async (request) => createdFrom(request));
  const racedSubmitted = await submitGranted({
    store: racedStore,
    runtime: racedCreate.runtime,
    userId: "user-a",
    executionId: racedApproval.id,
  });
  const raced = executionFor(racedStore, async (request) => {
    if (request.url.endsWith("/cancel")) return jsonResponse(409, { code: "run_not_cancellable" });
    return jsonResponse(200, {
      id: RUN,
      agentId: racedSubmitted.agentId,
      status: "FINISHED",
      result: "Already finished.",
    });
  });
  const outcome = await cancelGranted({
    store: racedStore,
    runtime: raced.runtime,
    userId: "user-a",
    executionId: racedApproval.id,
  });
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.reconciled, true);
  assert.equal(outcome.record.state, ExecutionState.COMPLETED);
  assert.equal(outcome.record.platformStatus, "FINISHED");
  assert.equal(outcome.record.platformCode, "run_not_cancellable");
  assert.equal(outcome.record.verified, false);
  assert.equal(
    raced.calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/agents")),
    false
  );
});

test("nonterminal rows are queryable and a protected repository cannot be granted", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  assert.deepEqual(await executionStore.listNonterminal(), []);
  const running = executionFor(executionStore, async (request) => {
    if (request.method === "POST") return createdFrom(request);
    return jsonResponse(200, {
      id: RUN,
      agentId: request.url.split("/agents/")[1].split("/runs/")[0],
      status: "RUNNING",
    });
  });
  const submitted = await submitGranted({
    store: executionStore,
    runtime: running.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  await running.runtime.getStatus({ agentId: submitted.agentId, runId: RUN }, { userId: "user-a" });
  assert.deepEqual(await executionStore.listNonterminal(), [
    {
      id: approval.id,
      userId: "user-a",
      state: ExecutionState.RUNNING,
      updatedAt: (await executionStore.get("user-a", approval.id)).updatedAt,
    },
  ]);
  const forbidden = await rejection(
    granted(executionStore, { repositoryUrl: "https://github.com/example/xrp" })
  );
  assert.equal(forbidden.code, "repository_forbidden");
  const decision = classifyExecutionClaim(
    { userId: "user-a", state: ExecutionState.APPROVED, scopeHash: "original" },
    {
      userId: "user-a",
      provider: "cursor-cloud",
      objective: "Ship the patch",
      constraints: [],
      repositoryUrl: REPO,
      startingRef: "main",
      scope: { effect: "execute", workOnCurrentBranch: false, autoCreatePR: true },
    }
  );
  assert.equal(decision.action, "invalidated");
});

test("the execution table is owner-scoped and tool approval is unchanged", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20261012160000_workforce_execution_ledger/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(schema, /model WorkforceExecution/);
  assert.match(schema, /approvalId\s+String\s+@unique/);
  assert.match(schema, /objectiveCiphertext/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "workforce_execution"/);
  assert.match(migration, /workforce_execution_approvalId_key/);
  assert.match(migration, /workforce_execution_verified_false/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /app\.current_user_id/);
  for (const state of [
    "APPROVED",
    "SUBMITTING",
    "SUBMITTED",
    "AMBIGUOUS",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
  ]) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.match(schema, /callsCiphertext/);
  const turn = readFileSync(new URL("../server/chief/runtime/turn.js", import.meta.url), "utf8");
  const delegation = readFileSync(
    new URL("../server/chief/context/delegation.js", import.meta.url),
    "utf8"
  );
  assert.equal(turn.includes("submitGranted"), false);
  assert.equal(turn.includes("workforceExecution"), false);
  assert.equal(delegation.includes("cursor-cloud"), false);
  assert.equal(delegation.includes("submitGranted"), false);
});

test("a database claim updates only an approved row for that owner", async () => {
  const rows = [];
  const updates = [];
  function match(row, where) {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && Array.isArray(value.in))
        return value.in.includes(row[key]);
      if (value && typeof value === "object" && Array.isArray(value.notIn))
        return !value.notIn.includes(row[key]);
      return row[key] === value;
    });
  }
  const tx = {
    workforceExecution: {
      async create({ data }) {
        const row = { ...data, verified: false, createdAt: new Date(), updatedAt: new Date() };
        rows.push(row);
        return row;
      },
      async findFirst({ where }) {
        return rows.find((row) => match(row, where)) ?? null;
      },
      async updateMany({ where, data }) {
        updates.push({ where, data });
        const matched = rows.filter((row) => match(row, where));
        for (const row of matched) {
          const next = { ...data };
          if (data.attempt?.increment) next.attempt = row.attempt + data.attempt.increment;
          Object.assign(row, next, { verified: false });
        }
        return { count: matched.length };
      },
      async findMany({ where }) {
        return rows.filter((row) => match(row, where));
      },
    },
  };
  const database = new PrismaExecutionStore({
    withUser: async (_userId, fn) => fn(tx),
    service: () => tx,
    encrypt: seal,
    decrypt: open,
  });
  const approval = await database.grant({
    userId: "user-a",
    provider: "cursor-cloud",
    objective: "Ship the patch",
    constraints: ["Do not change Freedom Financial or XRP"],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { effect: "execute", workOnCurrentBranch: false, autoCreatePR: false },
  });
  assert.equal(approval.objective, "Ship the patch");
  assert.equal(rows[0].objectiveCiphertext.includes("Ship the patch"), false);
  const begun = await database.adapter().begin(approval.approvalId, commandForGrant(approval));
  assert.equal(begun.action, "start");
  assert.equal(updates[0].where.state, ExecutionState.APPROVED);
  assert.equal(updates[0].where.userId, "user-a");
  assert.equal(updates[0].where.scopeHash, rows[0].scopeHash);
  const again = await database.adapter().begin(approval.approvalId, commandForGrant(approval));
  assert.equal(again.action, "blocked");
  assert.equal(rows[0].state, ExecutionState.SUBMITTING);
  const listed = await database.listNonterminal();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, approval.id);
  assert.equal(await database.get("user-b", approval.id), null);
});
