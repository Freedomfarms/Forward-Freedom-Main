// Cursor Cloud Agent execution stays behind an explicit scope approval.
// These tests use a mock transport. They do not call api.cursor.com.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertExecutionRuntime,
  assertReadRuntime,
  createAgentRuntime,
  createExecutionRuntime,
} from "../server/chief/agents/index.js";
import { peekDelegation } from "../server/chief/context/delegation.js";

const REPO = "https://github.com/example/forward-freedom";
const KEY = "cursor-test-key";
const AGENT = "bc-00000000-0000-0000-0000-000000000001";
const RUN = "run-00000000-0000-0000-0000-000000000001";
const ACTOR = { userId: "user-a" };

function pick(source, key, fallback) {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback;
}

function approval(overrides = {}) {
  const scope = {
    effect: "execute",
    workOnCurrentBranch: false,
    autoCreatePR: false,
    ...(overrides.scope ?? {}),
  };
  return {
    id: "approval-1",
    decision: "approved",
    userId: "user-a",
    provider: "cursor-cloud",
    objective: "Ship the patch",
    repositoryUrl: REPO,
    startingRef: "main",
    ...overrides,
    scope,
  };
}

function command(overrides = {}) {
  const grant = approval(overrides.approval ?? {});
  return {
    userId: pick(overrides, "userId", grant.userId),
    provider: pick(overrides, "provider", "cursor-cloud"),
    objective: pick(overrides, "objective", grant.objective),
    repositoryUrl: pick(overrides, "repositoryUrl", grant.repositoryUrl),
    startingRef: pick(overrides, "startingRef", grant.startingRef),
    approval: grant,
    environment: pick(overrides, "environment", undefined),
    env: pick(overrides, "env", undefined),
    prUrl: pick(overrides, "prUrl", undefined),
    workOnCurrentBranch: pick(overrides, "workOnCurrentBranch", undefined),
    autoCreatePR: pick(overrides, "autoCreatePR", undefined),
  };
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

function createdRun() {
  return jsonResponse(200, {
    agent: { id: AGENT, latestRunId: RUN },
    run: { id: RUN, agentId: AGENT, status: "CREATING" },
  });
}

function runtime(fetch, options = {}) {
  const calls = [];
  const transport =
    fetch ??
    (async () => {
      throw new Error("Cursor API was called");
    });
  const execution = createExecutionRuntime({
    apiKey: pick(options, "apiKey", KEY),
    allowlist: pick(options, "allowlist", [REPO]),
    now: options.now,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : null,
        authorization: init.headers.Authorization,
      });
      return transport(url, init);
    },
  });
  return { execution, calls };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

async function expectCode(promise, code) {
  const error = await rejection(promise);
  assert.equal(error.code, code);
  assert.equal(String(error.message).includes(KEY), false);
  assert.equal(JSON.stringify(error).includes(KEY), false);
  return error;
}

test("factory selects the cursor execution provider and leaves grok read-only", () => {
  const { execution, calls } = runtime();
  assert.equal(execution.provider, "cursor-cloud");
  assert.deepEqual([...execution.effects], ["execute"]);
  assert.equal(typeof execution.submit, "function");
  assert.equal(typeof execution.getStatus, "function");
  assert.equal(typeof execution.getResult, "function");
  assert.equal(typeof execution.cancel, "function");
  assert.equal(execution.picture, undefined);
  assert.equal(calls.length, 0);

  assert.throws(() => createAgentRuntime({ provider: "cursor-cloud" }), {
    code: "AGENT_RUNTIME_NOT_CONNECTED",
  });
  assert.throws(() => createExecutionRuntime({ provider: "grokbot" }), {
    code: "AGENT_EXECUTION_NOT_CONNECTED",
  });

  const read = createAgentRuntime({ provider: "grokbot", withUser: async () => {} });
  assert.equal(read.provider, "grokbot");
  assert.deepEqual([...read.effects], ["read"]);
  assert.equal(read.submit, undefined);
  assert.equal(read.getStatus, undefined);
  assert.equal(read.getResult, undefined);
  assert.equal(read.cancel, undefined);
  assert.throws(() => assertExecutionRuntime(read), /execute only/);
  assert.throws(
    () =>
      assertReadRuntime({
        provider: "grokbot",
        effects: ["read"],
        listAgents() {},
        getAgent() {},
        listEvents() {},
        picture() {},
        submit() {},
      }),
    /cannot execute/
  );
});

test("missing configuration and unsafe commands never reach the API", async () => {
  const absentKey = runtime(undefined, { apiKey: "" });
  await expectCode(absentKey.execution.submit(command(), ACTOR), "api_key_missing");
  assert.equal(absentKey.calls.length, 0);

  const absentList = runtime(undefined, { allowlist: [] });
  await expectCode(absentList.execution.submit(command(), ACTOR), "allowlist_missing");
  assert.equal(absentList.calls.length, 0);

  assert.throws(
    () =>
      createExecutionRuntime({
        apiKey: KEY,
        allowlist: ["https://github.com/example/xrp"],
        fetch: async () => {
          throw new Error("Cursor API was called");
        },
      }),
    { code: "repository_forbidden" }
  );
  assert.throws(
    () =>
      createExecutionRuntime({
        apiKey: KEY,
        allowlist: ["https://github.com/example/freedom-financial"],
        fetch: async () => {
          throw new Error("Cursor API was called");
        },
      }),
    { code: "repository_forbidden" }
  );

  const { execution, calls } = runtime();
  const forbidden = [
    ["https://github.com/example/xrp", "repository_forbidden"],
    ["https://github.com/example/freedom-financial", "repository_forbidden"],
    ["https://github.com/example/other", "repository_not_allowed"],
  ];
  for (const [repositoryUrl, code] of forbidden) {
    await expectCode(
      execution.submit(
        command({
          repositoryUrl,
          approval: { repositoryUrl },
        }),
        ACTOR
      ),
      code
    );
  }
  await expectCode(execution.submit(command({ startingRef: "" }), ACTOR), "ref_missing");
  await expectCode(execution.submit(command({ objective: "   " }), ACTOR), "objective_invalid");
  await expectCode(execution.submit(command({ objective: "" }), ACTOR), "objective_invalid");
  await expectCode(
    execution.submit(command({ userId: "user-a", approval: { userId: "user-b" } }), ACTOR),
    "unauthorized"
  );
  await expectCode(execution.submit(command(), { userId: "user-b" }), "unauthorized");
  await expectCode(
    execution.submit(command({ objective: "Ship a different patch" }), ACTOR),
    "approval_mismatch"
  );
  await expectCode(
    execution.submit(
      command({
        approval: {
          scope: { effect: "execute", workOnCurrentBranch: true, autoCreatePR: false },
        },
      }),
      ACTOR
    ),
    "approval_mismatch"
  );
  await expectCode(
    execution.submit(command({ environment: "production" }), ACTOR),
    "scope_rejected"
  );
  await expectCode(
    execution.submit(command({ workOnCurrentBranch: true }), ACTOR),
    "scope_rejected"
  );
  await expectCode(
    execution.submit(command({ provider: "grokbot" }), ACTOR),
    "provider_unsupported"
  );
  assert.equal(calls.length, 0);
});

test("an expired approval does not submit", async () => {
  const { execution, calls } = runtime(undefined, {
    now: () => new Date("2026-10-11T00:00:00.000Z"),
  });
  await expectCode(
    execution.submit(command({ approval: { expiresAt: "2026-10-10T00:00:00.000Z" } }), ACTOR),
    "approval_mismatch"
  );
  assert.equal(calls.length, 0);
});

test("a valid submission posts one constrained create", async () => {
  const { execution, calls } = runtime(async () => createdRun());
  const result = await execution.submit(command(), ACTOR);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cursor.com/v1/agents");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].body.prompt.text.includes(KEY), false);
  assert.deepEqual(calls[0].body, {
    prompt: { text: "Ship the patch" },
    repos: [{ url: REPO, startingRef: "main" }],
    workOnCurrentBranch: false,
    autoCreatePR: false,
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.agentId, AGENT);
  assert.equal(result.runId, RUN);
  assert.equal(result.status, "CREATING");
  assert.equal(result.userId, "user-a");
});

test("resuming an accepted submission does not create another agent", async () => {
  const { execution, calls } = runtime(async () => createdRun());
  const first = await execution.submit(command(), ACTOR);
  const second = await execution.submit(command(), ACTOR);
  assert.equal(calls.length, 1);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.agentId, first.agentId);
  assert.equal(second.runId, first.runId);
});

test("authentication, rate limit, and agent busy failures stay definite", async () => {
  const auth = runtime(async () => jsonResponse(401, { message: `rejected ${KEY}` }));
  const authError = await expectCode(
    auth.execution.submit(command(), ACTOR),
    "authentication_failed"
  );
  assert.equal(authError.message.includes(KEY), false);
  assert.equal(auth.calls.length, 1);

  const limited = runtime(async () => jsonResponse(429, { code: "rate_limited" }));
  await expectCode(limited.execution.submit(command(), ACTOR), "rate_limited");

  const busy = runtime(async () => jsonResponse(409, { error: { code: "agent_busy" } }));
  await expectCode(busy.execution.submit(command(), ACTOR), "agent_busy");
});

test("an ambiguous create timeout is recorded and not retried", async () => {
  const { execution, calls } = runtime(async () => {
    throw Object.assign(new Error(`timed out with ${KEY}`), { name: "TimeoutError" });
  });
  await expectCode(execution.submit(command(), ACTOR), "reconciliation_required");
  await expectCode(execution.submit(command(), ACTOR), "reconciliation_required");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes(KEY), false);
});

test("a server error after create is ambiguous and is not resubmitted", async () => {
  const { execution, calls } = runtime(async () => jsonResponse(502, { message: KEY }));
  await expectCode(execution.submit(command(), ACTOR), "reconciliation_required");
  await expectCode(execution.submit(command(), ACTOR), "reconciliation_required");
  assert.equal(calls.length, 1);
});

test("run status uses Cursor states and does not invent waiting", async () => {
  const states = ["CREATING", "RUNNING", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"];
  for (const status of states) {
    const { execution, calls } = runtime(async (url) => {
      if (String(url).endsWith("/v1/agents")) return createdRun();
      return jsonResponse(200, { id: RUN, agentId: AGENT, status });
    });
    await execution.submit(command(), ACTOR);
    const viewed = await execution.getStatus({ agentId: AGENT, runId: RUN }, ACTOR);
    assert.equal(viewed.status, status);
    assert.equal(viewed.terminal, status !== "CREATING" && status !== "RUNNING");
    assert.match(calls.at(-1).url, new RegExp(`/v1/agents/${AGENT}/runs/${RUN}$`));
  }

  const unknown = runtime(async (url) => {
    if (String(url).endsWith("/v1/agents")) return createdRun();
    return jsonResponse(200, { id: RUN, agentId: AGENT, status: "WAITING" });
  });
  await unknown.execution.submit(command(), ACTOR);
  await expectCode(
    unknown.execution.getStatus({ agentId: AGENT, runId: RUN }, ACTOR),
    "unknown_status"
  );
});

test("worker speech is not verified success and platform git is reported as platform data", async () => {
  const spoken = runtime(async (url) => {
    if (String(url).endsWith("/v1/agents")) return createdRun();
    return jsonResponse(200, {
      id: RUN,
      agentId: AGENT,
      status: "FINISHED",
      result: "All tests passed. I opened https://github.com/example/forward-freedom/pull/12",
    });
  });
  await spoken.execution.submit(command(), ACTOR);
  const speech = await spoken.execution.getResult({ agentId: AGENT, runId: RUN }, ACTOR);
  assert.equal(speech.status, "FINISHED");
  assert.match(speech.statement, /All tests passed/);
  assert.equal(speech.verified, false);
  assert.equal(speech.testsPassed, null);
  assert.deepEqual(speech.branches, []);
  assert.deepEqual(speech.pullRequests, []);

  const platform = runtime(async (url) => {
    if (String(url).endsWith("/v1/agents")) return createdRun();
    return jsonResponse(200, {
      id: RUN,
      agentId: AGENT,
      status: "FINISHED",
      result: "Pushed the branch.",
      git: {
        branches: [
          {
            repoUrl: "github.com/example/forward-freedom",
            branch: "cursor/ship-the-patch",
            prUrl: "https://github.com/example/forward-freedom/pull/4",
          },
        ],
      },
    });
  });
  await platform.execution.submit(command(), ACTOR);
  const result = await platform.execution.getResult({ agentId: AGENT, runId: RUN }, ACTOR);
  assert.equal(result.verified, false);
  assert.equal(result.testsPassed, null);
  assert.deepEqual(result.branches, [
    {
      repoUrl: "github.com/example/forward-freedom",
      branch: "cursor/ship-the-patch",
    },
  ]);
  assert.deepEqual(result.pullRequests, [
    {
      repoUrl: "github.com/example/forward-freedom",
      url: "https://github.com/example/forward-freedom/pull/4",
    },
  ]);
});

test("cancel requires the authorized user and the stored run", async () => {
  const { execution, calls } = runtime(async (url) => {
    if (String(url).endsWith("/cancel")) return jsonResponse(200, { id: RUN });
    if (String(url).endsWith("/v1/agents")) return createdRun();
    return jsonResponse(200, { id: RUN, agentId: AGENT, status: "RUNNING" });
  });
  await execution.submit(command(), ACTOR);
  const before = calls.length;
  await expectCode(
    execution.cancel({ agentId: AGENT, runId: RUN }, { userId: "user-b" }),
    "unauthorized"
  );
  await expectCode(
    execution.cancel(
      {
        agentId: "bc-99999999-9999-9999-9999-999999999999",
        runId: "run-99999999-9999-9999-9999-999999999999",
      },
      ACTOR
    ),
    "unknown_run"
  );
  assert.equal(calls.length, before);

  const cancelled = await execution.cancel({ agentId: AGENT, runId: RUN }, ACTOR);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(calls.at(-1).method, "POST");
  assert.equal(calls.at(-1).url, `https://api.cursor.com/v1/agents/${AGENT}/runs/${RUN}/cancel`);
  assert.equal(calls.at(-1).body, null);

  const blocked = runtime(async (url) => {
    if (String(url).endsWith("/cancel")) {
      return jsonResponse(409, { code: "run_not_cancellable" });
    }
    return createdRun();
  });
  await blocked.execution.submit(command(), ACTOR);
  await expectCode(
    blocked.execution.cancel({ agentId: AGENT, runId: RUN }, ACTOR),
    "run_not_cancellable"
  );
});

test("delegation and the turn path stay provider neutral", () => {
  const files = [
    "server/chief/runtime/turn.js",
    "server/chief/context/delegation.js",
    "server/chief/context/behavior.js",
    "server/chief/context/wire.js",
    "server/chief/agents/grokbot.js",
    "server/chief/runtime/approvals.js",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(source.includes("api.cursor.com"), false, file);
    assert.equal(source.includes("CURSOR_API_KEY"), false, file);
    assert.equal(source.includes("cursor-cloud"), false, file);
  }
  const peeked = peekDelegation(
    `DELEGATION ${JSON.stringify({
      effect: "deploy",
      objective: "Ship the patch",
      outcome: "a reviewed branch",
    })}`
  );
  assert.equal(peeked.delegate, true);
  assert.equal(peeked.objective, "Ship the patch");
  assert.equal(Object.hasOwn(peeked, "agentId"), false);
  assert.equal(Object.hasOwn(peeked, "runId"), false);
});
