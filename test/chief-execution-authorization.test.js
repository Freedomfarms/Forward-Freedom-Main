// Explicit execution approval is the only grant submitGranted will post.
// The transport is a mock. No Cursor API call is made.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createExecutionRuntime } from "../server/chief/agents/index.js";
import {
  ExecutionState,
  assessExplicitGrant,
  cancelGranted,
  createMemoryExecutionStore,
  reconcileGranted,
  submitGranted,
} from "../server/chief/agents/ledger.js";
import { settleDelegation } from "../server/chief/context/delegation.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";

const REPO = "https://github.com/example/forward-freedom";
const KEY = "cursor-test-key";
const RUN = "run-00000000-0000-0000-0000-0000000000bb";

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

function executionFor(executionStore, fetch, options = {}) {
  const calls = [];
  const runtime = createExecutionRuntime({
    apiKey: Object.hasOwn(options, "apiKey") ? options.apiKey : KEY,
    allowlist: options.allowlist ?? [REPO],
    ledger: executionStore.adapter(),
    now: options.now,
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
  return { runtime, calls };
}

function explicitGrant(record, overrides = {}) {
  return {
    action: "approve_execution",
    decision: "approved",
    approvalId: record.approvalId,
    executionId: record.id,
    userId: record.userId,
    provider: record.provider,
    objective: record.objective,
    constraints: record.constraints,
    repositoryUrl: record.repositoryUrl,
    startingRef: record.startingRef,
    scope: record.scope,
    scopeHash: record.scopeHash,
    expiresAt: record.expiresAt,
    ...overrides,
  };
}

async function granted(executionStore, overrides = {}) {
  return executionStore.grant({
    userId: "user-a",
    provider: "cursor-cloud",
    objective: "Ship the patch",
    constraints: ["Do not change Freedom Financial or XRP"],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { effect: "execute", workOnCurrentBranch: false, autoCreatePR: false },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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

function newStore(now) {
  return createMemoryExecutionStore({
    encrypt: seal,
    decrypt: open,
    ...(now ? { now } : {}),
  });
}

test("submission requires the explicit grant for that owner and scope", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  const { runtime, calls } = executionFor(executionStore, async () => {
    throw new Error("Cursor API was called");
  });
  const missing = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
    })
  );
  assert.equal(missing.code, "approval_required");

  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("_default", Capability.WORKFORCE_READ);
  assert.equal(policy.check("_default", Capability.WORKFORCE_READ), true);
  const readGrant = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: { action: "workforce:read", decision: "approved", capability: Capability.WORKFORCE_READ },
    })
  );
  assert.equal(readGrant.code, "approval_required");

  const record = await executionStore.get("user-a", approval.id);
  const wrongOwner = explicitGrant(record, { userId: "user-b" });
  const owner = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: wrongOwner,
    })
  );
  assert.equal(owner.code, "unauthorized");

  const wrongScope = explicitGrant(record, {
    objective: "Ship a different patch",
    scopeHash: "not-the-persisted-hash",
  });
  const scope = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: wrongScope,
    })
  );
  assert.equal(scope.code, "approval_mismatch");
  assert.equal(calls.length, 0);
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.APPROVED);
  assert.equal((await executionStore.get("user-a", approval.id)).attempt, 0);
  assert.equal(await executionStore.get("user-b", approval.id), null);
});

test("a conversational yes or a tool-batch approval does not submit", async () => {
  const pending = {
    disposition: "delegate",
    objective: "Ship the patch",
    constraints: ["Do not change Freedom Financial or XRP"],
    outcome: "Working change with tests passing",
    provider: "grokbot",
    agentId: "agent-1",
    effect: "change",
    confirm: true,
    status: "pending",
  };
  const settled = settleDelegation({
    userText: "yes",
    pending,
    transcript: [
      { role: "assistant", content: "I'd delegate: Ship the patch" },
      { role: "user", content: "yes" },
    ],
  });
  assert.equal(settled.delegation.status, "accepted");
  assert.match(settled.text, /nothing has been submitted/i);

  const executionStore = newStore();
  const approval = await granted(executionStore);
  const { runtime, calls } = executionFor(executionStore, async () => {
    throw new Error("Cursor API was called");
  });
  const conversational = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: "yes",
    })
  );
  assert.equal(conversational.code, "approval_required");
  const batch = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: {
        decision: "approved",
        action: "approve_execution",
        calls: [{ name: "memory_write", arguments: {} }],
        sessionId: "session-1",
      },
    })
  );
  assert.equal(batch.code, "approval_required");
  assert.equal(calls.length, 0);
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.APPROVED);

  const chat = readFileSync(new URL("../api/chief/chat.js", import.meta.url), "utf8");
  const approvals = readFileSync(new URL("../api/chief/approvals.js", import.meta.url), "utf8");
  const tick = readFileSync(new URL("../server/chief/scheduler/tick.js", import.meta.url), "utf8");
  assert.equal(chat.includes("submitGranted"), false);
  assert.equal(approvals.includes("submitGranted"), false);
  assert.equal(tick.includes("submitGranted"), false);
});

test("an expired, revoked, or replayed grant does not post again", async () => {
  let clock = new Date("2026-10-12T12:00:00.000Z");
  const executionStore = newStore(() => clock);
  const approval = await granted(executionStore, {
    expiresAt: new Date("2026-10-12T12:10:00.000Z"),
  });
  const { runtime, calls } = executionFor(
    executionStore,
    async (request) => createdFrom(request),
    { now: () => clock }
  );
  const record = await executionStore.get("user-a", approval.id);
  clock = new Date("2026-10-12T12:11:00.000Z");
  const expired = await rejection(
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: explicitGrant(record),
      now: () => clock,
    })
  );
  assert.equal(expired.code, "approval_expired");
  assert.equal((await executionStore.get("user-a", approval.id)).state, ExecutionState.EXPIRED);
  assert.equal(calls.length, 0);

  clock = new Date("2026-10-12T12:00:00.000Z");
  const liveStore = newStore(() => clock);
  const live = await granted(liveStore, { expiresAt: new Date("2026-10-12T13:00:00.000Z") });
  const liveRuntime = executionFor(liveStore, async (request) => createdFrom(request), {
    now: () => clock,
  });
  await liveStore.revoke("user-a", live.id);
  const revokedRecord = await liveStore.get("user-a", live.id);
  const revoked = await rejection(
    submitGranted({
      store: liveStore,
      runtime: liveRuntime.runtime,
      userId: "user-a",
      executionId: live.id,
      grant: explicitGrant(revokedRecord),
      now: () => clock,
    })
  );
  assert.equal(revoked.code, "approval_revoked");
  assert.equal(liveRuntime.calls.length, 0);
  assert.equal((await liveStore.get("user-a", live.id)).state, ExecutionState.APPROVED);
  assert.equal(await liveStore.revoke("user-b", live.id), null);

  const replayStore = newStore();
  const created = await granted(replayStore);
  const replay = executionFor(replayStore, async (request) => createdFrom(request));
  const first = await submitGranted({
    store: replayStore,
    runtime: replay.runtime,
    userId: "user-a",
    executionId: created.id,
    grant: explicitGrant(await replayStore.get("user-a", created.id)),
  });
  const second = await submitGranted({
    store: replayStore,
    runtime: replay.runtime,
    userId: "user-a",
    executionId: created.id,
    grant: explicitGrant(await replayStore.get("user-a", created.id)),
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.agentId, first.agentId);
  assert.equal(replay.calls.length, 1);
  assert.equal((await replayStore.get("user-a", created.id)).attempt, 1);
});

test("concurrent claims post once and a pre-POST failure does not consume the grant", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const { runtime, calls } = executionFor(executionStore, async (request) => {
    entered += 1;
    if (entered === 1) await gate;
    return createdFrom(request);
  });
  const grant = explicitGrant(await executionStore.get("user-a", approval.id));
  const pending = Promise.allSettled([
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant,
    }),
    submitGranted({
      store: executionStore,
      runtime,
      userId: "user-a",
      executionId: approval.id,
      grant,
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const results = await pending;
  const posted = calls.filter((call) => call.method === "POST" && call.url.endsWith("/v1/agents"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.workOnCurrentBranch, false);
  assert.equal(posted[0].body.autoCreatePR, false);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const blocked = results.find((result) => result.status === "rejected");
  assert.equal(blocked.reason.code, "submission_in_progress");
  assert.equal((await executionStore.get("user-a", approval.id)).attempt, 1);

  const earlyStore = newStore();
  const early = await granted(earlyStore);
  const earlyRuntime = executionFor(earlyStore, async () => {
    throw new Error("Cursor API was called");
  }, { apiKey: null });
  const audit = {
    entries: [],
    async write(entry) {
      this.entries.push(entry);
      return entry;
    },
  };
  const before = await rejection(
    submitGranted({
      store: earlyStore,
      runtime: earlyRuntime.runtime,
      userId: "user-a",
      executionId: early.id,
      grant: explicitGrant(await earlyStore.get("user-a", early.id)),
      audit,
    })
  );
  assert.equal(before.code, "api_key_missing");
  assert.equal(earlyRuntime.calls.length, 0);
  const held = await earlyStore.get("user-a", early.id);
  assert.equal(held.state, ExecutionState.APPROVED);
  assert.equal(held.attempt, 0);
  assert.equal(audit.entries.at(-1).action, "execution.submit_rejected");
  assert.equal(audit.entries.at(-1).summary, "api_key_missing");
  assert.equal(JSON.stringify(audit.entries).includes(KEY), false);
  assert.equal(JSON.stringify(audit.entries).includes("Ship the patch"), false);
});

test("a lost create is reconciled from the reserved id and a miss is not posted again", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  const first = executionFor(executionStore, async () => {
    throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
  });
  const lost = await rejection(
    submitGranted({
      store: executionStore,
      runtime: first.runtime,
      userId: "user-a",
      executionId: approval.id,
      grant: explicitGrant(await executionStore.get("user-a", approval.id)),
    })
  );
  assert.equal(lost.code, "reconciliation_required");
  const reserved = (await executionStore.get("user-a", approval.id)).agentId;
  assert.equal(first.calls.length, 1);

  const found = executionFor(executionStore, async (request) => {
    if (request.url.endsWith(`/runs/${RUN}`)) {
      return jsonResponse(200, { id: RUN, agentId: reserved, status: "RUNNING" });
    }
    return jsonResponse(200, { id: reserved, latestRunId: RUN });
  });
  const reconciled = await reconcileGranted({
    store: executionStore,
    runtime: found.runtime,
    userId: "user-a",
    executionId: approval.id,
  });
  assert.equal(found.calls.some((call) => call.method === "POST"), false);
  assert.equal(reconciled.record.state, ExecutionState.RUNNING);
  assert.equal(reconciled.record.agentId, reserved);
  assert.equal(reconciled.record.runId, RUN);
  assert.equal(reconciled.record.verified, false);

  const missedStore = newStore();
  const missedApproval = await granted(missedStore);
  const missedPost = executionFor(missedStore, async () => jsonResponse(409, { code: "agent_id_conflict" }));
  const conflict = await rejection(
    submitGranted({
      store: missedStore,
      runtime: missedPost.runtime,
      userId: "user-a",
      executionId: missedApproval.id,
      grant: explicitGrant(await missedStore.get("user-a", missedApproval.id)),
    })
  );
  assert.equal(conflict.code, "reconciliation_required");
  assert.equal(missedPost.calls.length, 1);
  const missedId = (await missedStore.get("user-a", missedApproval.id)).agentId;
  const missing = executionFor(missedStore, async (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, `https://api.cursor.com/v1/agents/${missedId}`);
    return jsonResponse(404, { code: "not_found" });
  });
  const absent = await reconcileGranted({
    store: missedStore,
    runtime: missing.runtime,
    userId: "user-a",
    executionId: missedApproval.id,
  });
  assert.equal(absent.reason, "not_created");
  assert.equal(missing.calls.some((call) => call.method === "POST"), false);
  assert.equal((await missedStore.get("user-a", missedApproval.id)).state, ExecutionState.AMBIGUOUS);

  const other = await rejection(
    reconcileGranted({
      store: missedStore,
      runtime: missing.runtime,
      userId: "user-b",
      executionId: missedApproval.id,
    })
  );
  assert.equal(other.code, "unknown_run");
});

test("another owner cannot submit or cancel, and a matching grant still refuses a changed scope hash", async () => {
  const executionStore = newStore();
  const approval = await granted(executionStore);
  const { runtime, calls } = executionFor(executionStore, async (request) => createdFrom(request));
  const submitted = await submitGranted({
    store: executionStore,
    runtime,
    userId: "user-a",
    executionId: approval.id,
    grant: explicitGrant(await executionStore.get("user-a", approval.id)),
  });
  const foreign = await rejection(
    cancelGranted({
      store: executionStore,
      runtime,
      userId: "user-b",
      executionId: approval.id,
    })
  );
  assert.equal(foreign.code, "unknown_run");
  assert.equal(calls.filter((call) => call.url.endsWith("/cancel")).length, 0);
  assert.equal(submitted.duplicate, false);

  const fresh = newStore();
  const row = await granted(fresh);
  const stored = await fresh.get("user-a", row.id);
  const decision = assessExplicitGrant(
    stored,
    explicitGrant(stored, { scopeHash: `${stored.scopeHash}ff` }),
    "user-a"
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "approval_mismatch");
});
