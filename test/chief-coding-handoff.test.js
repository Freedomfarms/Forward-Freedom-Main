import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCodingHandoff } from "../server/chief/agents/codingHandoff.js";
import { createCursorCloudRuntime } from "../server/chief/agents/cursorCloud.js";
import {
  CODING_EXECUTION_SCOPE,
  ExecutionState,
  createMemoryExecutionStore,
  executionScopeHash,
  submitGranted,
} from "../server/chief/agents/ledger.js";
import { ensureIcmArchitectSkill } from "../server/chief/managed/chatTurn.js";
import { ICM_ARCHITECT_PIN } from "../server/chief/managed/constants.js";
import { taskTimezone } from "../server/chief/scheduler/schedule.js";
import { createCodingHandoffTools } from "../server/chief/tools/codingHandoff.js";

const KEY = "cursor_test_key_value";
const REPO = "https://github.com/Freedomfarms/Forward-Freedom-Main";
const REQUIREMENTS = "Add a comment to the response mode control.";
const STATUS_ID = "bc-01234567-89ab-4cde-8fab-0123456789ab";

function json(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
  };
}

function seal(value) {
  return `sealed:${Buffer.from(String(value), "utf8").toString("base64")}`;
}

function open(value) {
  if (typeof value !== "string" || !value.startsWith("sealed:")) throw new Error("unreadable");
  return Buffer.from(value.slice("sealed:".length), "base64").toString("utf8");
}

function newStore(now = () => new Date()) {
  return createMemoryExecutionStore({ encrypt: seal, decrypt: open, now });
}

function postsOf(calls) {
  return calls.filter((call) => call.method === "POST");
}

function approvedContext(store, extra = {}) {
  return {
    userId: "user-a",
    mutationApproved: true,
    approvalDecision: "approved",
    ledger: store,
    ...extra,
  };
}

test("status returns the pull request, diff, and checks, and a missing key does not call Cursor", async () => {
  const calls = [];
  const handoff = createCodingHandoff({
    env: {
      CURSOR_API_KEY: KEY,
      CHIEF_CODE_READ_TOKEN: "github_read_token_value",
      CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      const href = String(url);
      if (href.includes("api.cursor.com") && href.endsWith(`/v1/agents/${STATUS_ID}`)) {
        return json(200, { id: STATUS_ID, latestRunId: "run-1234567890" });
      }
      if (href.includes("/runs/run-1234567890")) {
        return json(200, {
          id: "run-1234567890",
          agentId: STATUS_ID,
          status: "FINISHED",
          result: "Opened the pull request.",
          git: {
            branches: [
              {
                branch: "cursor/response-mode",
                prUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/321",
              },
            ],
          },
        });
      }
      if (href.includes("/compare/")) {
        return json(200, {
          ahead_by: 1,
          behind_by: 0,
          files: [
            {
              filename: "src/components/chief/ChiefResponseMode.jsx",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: '+const note = "review";\n',
            },
          ],
        });
      }
      if (href.includes("/check-runs")) {
        return json(200, {
          total_count: 1,
          check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
        });
      }
      return json(404, {});
    },
  });
  const status = await handoff.status({ userId: "user-a", taskId: STATUS_ID });
  assert.equal(status.available, true);
  assert.equal(
    status.pullRequestUrl,
    "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/321"
  );
  assert.equal(status.branch, "cursor/response-mode");
  assert.equal(status.diff.files[0].filename, "src/components/chief/ChiefResponseMode.jsx");
  assert.equal(status.checks.runs[0].conclusion, "success");
  assert.equal(status.merged, false);
  assert.equal(JSON.stringify(status).includes("github_read_token_value"), false);

  const callsBefore = calls.length;
  const missing = createCodingHandoff({ env: { CURSOR_API_KEY: "" } });
  const blocked = await missing.submit({ userId: "user-a", requirements: "Add a comment." });
  assert.equal(blocked.available, false);
  assert.equal(blocked.missing, "CURSOR_API_KEY");
  assert.equal(blocked.posted, undefined);
  assert.equal(calls.length, callsBefore);

  const [submitTool] = createCodingHandoffTools({ handoff: missing });
  const toolResult = await submitTool.execute(
    { requirements: "Add a comment.", repository: "https://github.com/evil/other" },
    { userId: "user-a" }
  );
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.output, /unsupported coding task argument/);
});

test("the handoff client does not post, and a submit without a ledger does not post", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    throw new Error("Cursor was called");
  };
  const handoff = createCodingHandoff({
    env: { CURSOR_API_KEY: KEY, CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl,
  });
  const direct = await handoff.submit({ userId: "user-a", requirements: REQUIREMENTS });
  assert.equal(direct.available, false);
  assert.equal(direct.error, "ledger_required");
  assert.equal(direct.posted, false);

  const [tool] = createCodingHandoffTools({
    env: { CURSOR_API_KEY: KEY, CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl,
  });
  const declined = await tool.execute({ requirements: REQUIREMENTS }, { userId: "user-a" });
  assert.equal(declined.isError, true);
  assert.match(declined.output, /confirmation_required/);

  const session = await tool.execute(
    { requirements: REQUIREMENTS },
    { userId: "user-a", mutationApproved: true, approvalDecision: "approved_for_session" }
  );
  assert.match(session.output, /session_approval_rejected/);

  const scheduled = await tool.execute(
    { requirements: REQUIREMENTS },
    {
      userId: "user-a",
      mutationApproved: true,
      approvalDecision: "approved",
      caller: { kind: "schedule" },
    }
  );
  assert.match(scheduled.output, /schedule_cannot_grant/);

  const unledered = await tool.execute(
    { requirements: REQUIREMENTS },
    { userId: "user-a", mutationApproved: true, approvalDecision: "approved" }
  );
  assert.match(unledered.output, /ledger_required/);
  assert.equal(postsOf(calls).length, 0);
  assert.equal(
    readFileSync("server/chief/tools/codingHandoff.js", "utf8").includes("api.cursor.com"),
    false
  );
  assert.equal(
    readFileSync("server/chief/agents/codingHandoff.js", "utf8").includes("autoCreatePR: true"),
    false
  );
});

test("an approved coding submit reserves one agent id and does not post without a start", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
    throw new Error("Cursor was called");
  };
  const store = newStore();
  const [tool] = createCodingHandoffTools({
    env: { CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl,
    ledger: store,
  });
  const first = JSON.parse(
    (await tool.execute({ requirements: REQUIREMENTS }, approvedContext(store))).output
  );
  assert.equal(first.posted, false);
  assert.equal(first.reserved, true);
  assert.match(first.agentId, /^bc-/);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].state, ExecutionState.SUBMITTING);

  const second = JSON.parse(
    (await tool.execute({ requirements: REQUIREMENTS }, approvedContext(store))).output
  );
  assert.equal(second.posted, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.agentId, first.agentId);
  assert.equal(store.rows().length, 1);
  assert.equal(postsOf(calls).length, 0);

  const cancelled = await store.cancelBeforePost("user-a", store.rows()[0].id);
  assert.equal(cancelled.state, ExecutionState.CANCELLED);
  assert.equal(postsOf(calls).length, 0);
});

test("an expired coding grant is not posted and does not open another grant", async () => {
  let clock = new Date("2026-10-26T16:00:00.000Z");
  const store = newStore(() => clock);
  const calls = [];
  const snapshot = {
    userId: "user-a",
    provider: "cursor-cloud",
    objective: REQUIREMENTS,
    constraints: ["Do not merge.", "Do not deploy."],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  };
  await store.grant({
    ...snapshot,
    actorUserId: "user-a",
    approvalAction: "execute",
    expiresAt: new Date(clock.getTime() + 1000),
  });
  clock = new Date(clock.getTime() + 60_000);
  const [tool] = createCodingHandoffTools({
    env: { CURSOR_API_KEY: KEY, CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl: async () => {
      calls.push("post");
      throw new Error("Cursor was called");
    },
    ledger: store,
  });
  const result = JSON.parse(
    (await tool.execute({ requirements: REQUIREMENTS }, approvedContext(store))).output
  );
  assert.equal(result.posted, false);
  assert.equal(result.error, "expired");
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].state, ExecutionState.EXPIRED);
  assert.equal(calls.length, 0);
  assert.equal(executionScopeHash(snapshot), store.rows()[0].scopeHash);
});

test("a lost coding create keeps one agent id and does not post again", async () => {
  const calls = [];
  const store = newStore();
  const [tool] = createCodingHandoffTools({
    env: { CURSOR_API_KEY: KEY, CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl: async (_url, init) => {
      calls.push({
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(init.body) : null,
      });
      if (init?.method === "POST") {
        const error = new Error("socket hang up");
        throw error;
      }
      return json(404, { code: "not_found" });
    },
    ledger: store,
    reserveHold: async () => ({ ok: true, hold: { id: "hold-test" } }),
  });
  const first = await tool.execute({ requirements: REQUIREMENTS }, approvedContext(store));
  assert.equal(first.isError, true);
  const row = store.rows()[0];
  assert.equal(row.state, ExecutionState.AMBIGUOUS);
  assert.match(row.agentId, /^bc-/);
  assert.equal(calls[0].body.autoCreatePR, true);
  assert.equal(calls[0].body.workOnCurrentBranch, false);
  assert.equal(calls[0].body.agentId, row.agentId);
  assert.equal(calls[0].body.repos[0].startingRef, "main");

  const second = JSON.parse(
    (await tool.execute({ requirements: REQUIREMENTS }, approvedContext(store))).output
  );
  assert.equal(second.posted, false);
  assert.equal(second.agentId, row.agentId);
  assert.equal(postsOf(calls).length, 1);
  assert.equal(store.rows().length, 1);
});

test("concurrent coding submits share one open row", async () => {
  const store = newStore();
  const [tool] = createCodingHandoffTools({
    env: { CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl: async () => {
      throw new Error("Cursor was called");
    },
    ledger: store,
  });
  const [left, right] = await Promise.all([
    tool.execute({ requirements: REQUIREMENTS }, approvedContext(store)),
    tool.execute({ requirements: REQUIREMENTS }, approvedContext(store)),
  ]);
  const bodies = [JSON.parse(left.output), JSON.parse(right.output)];
  assert.equal(store.rows().length, 1);
  assert.equal(bodies.filter((body) => body.reserved === true).length, 1);
  assert.equal(
    bodies.every((body) => body.posted !== true),
    true
  );
});

test("merge or deploy is rejected and a non-coding create cannot open a pull request", async () => {
  const store = newStore();
  await assert.rejects(
    () =>
      store.grant({
        userId: "user-a",
        actorUserId: "user-a",
        approvalAction: "execute",
        provider: "cursor-cloud",
        objective: REQUIREMENTS,
        constraints: [],
        repositoryUrl: REPO,
        startingRef: "main",
        scope: { ...CODING_EXECUTION_SCOPE, merge: true },
      }),
    (error) => error.code === "scope_rejected"
  );
  const calls = [];
  const runtime = createCursorCloudRuntime({
    apiKey: KEY,
    allowlist: [REPO],
    ledger: store.adapter(),
    fetch: async (_url, init) => {
      calls.push(init?.method || "GET");
      return json(500, {});
    },
  });
  await assert.rejects(
    () =>
      runtime.submit(
        {
          userId: "user-a",
          provider: "cursor-cloud",
          objective: REQUIREMENTS,
          constraints: [],
          repositoryUrl: REPO,
          startingRef: "main",
          autoCreatePR: true,
          approval: {
            id: "appr-12345678",
            decision: "approved",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            userId: "user-a",
            provider: "cursor-cloud",
            objective: REQUIREMENTS,
            constraints: [],
            repositoryUrl: REPO,
            startingRef: "main",
            scope: { effect: "execute", workOnCurrentBranch: false, autoCreatePR: false },
          },
        },
        { userId: "user-a" }
      ),
    (error) => error.code === "scope_rejected"
  );
  assert.equal(calls.length, 0);

  const granted = await store.grant({
    userId: "user-a",
    actorUserId: "user-a",
    approvalAction: "execute",
    provider: "cursor-cloud",
    objective: REQUIREMENTS,
    constraints: ["Do not merge.", "Do not deploy."],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  });
  const posted = [];
  const codingRuntime = createCursorCloudRuntime({
    apiKey: KEY,
    allowlist: [REPO],
    ledger: store.adapter(),
    reserveHold: async () => ({ ok: true, hold: { id: "hold-test" } }),
    fetch: async (_url, init) => {
      posted.push(init?.body ? JSON.parse(init.body) : null);
      throw new Error("lost response");
    },
  });
  await assert.rejects(() =>
    submitGranted({
      store,
      runtime: codingRuntime,
      userId: "user-a",
      executionId: granted.id,
    })
  );
  assert.equal(posted.length, 1);
  assert.equal(posted[0].autoCreatePR, true);
  assert.equal(posted[0].workOnCurrentBranch, false);
  const ambiguous = store.rows()[0];
  assert.equal(ambiguous.state, ExecutionState.AMBIGUOUS);
  assert.match(ambiguous.agentId, /^bc-/);
  await assert.rejects(() =>
    submitGranted({
      store,
      runtime: codingRuntime,
      userId: "user-a",
      executionId: granted.id,
    })
  );
  assert.equal(posted.length, 1);
  assert.equal(store.rows()[0].agentId, ambiguous.agentId);
});

test("a null schedule timezone resolves to Eastern", () => {
  assert.equal(
    taskTimezone({ payload: { timezone: null } }, { timezone: null }),
    "America/New_York"
  );
  assert.equal(taskTimezone({}, {}), "America/New_York");
  assert.equal(taskTimezone({ payload: {} }, { timezone: "America/Chicago" }), "America/Chicago");
  assert.equal(
    taskTimezone({ payload: { timezone: "UTC" } }, { timezone: "America/Chicago" }),
    "UTC"
  );
  const status = readFileSync("docs/chief-rebuild/STATUS.md", "utf8");
  const capabilities = readFileSync("docs/CHIEF_CAPABILITIES.md", "utf8");
  assert.equal(
    /scheduled background ticks still use the retained turn machine/i.test(status),
    false
  );
  assert.match(status, /do not use the retained turn machine/i);
  assert.equal(/remain the execution path/.test(capabilities), false);
});

test("the ICM skill helper lists before it creates and does not create twice", async () => {
  const rows = new Map();
  const store = {
    async getResource(key) {
      return rows.get(key) || null;
    },
    async saveResource(record) {
      rows.set(record.idempotencyKey, { ...record });
    },
  };
  let listed = 0;
  let created = 0;
  const skill = {
    id: "skill_test",
    version: "1",
    display_title: `icm-architect ${ICM_ARCHITECT_PIN}`,
  };
  const list = async () => {
    listed += 1;
    return created ? [skill] : [];
  };
  const create = async (zip) => {
    created += 1;
    assert.match(zip.filename, new RegExp(ICM_ARCHITECT_PIN));
    return skill;
  };
  const first = await ensureIcmArchitectSkill({
    store,
    list,
    create,
    retrieve: async () => skill,
    buildZip: async () => ({
      filename: `icm-architect-${ICM_ARCHITECT_PIN}.zip`,
      bytes: Buffer.from("local"),
      pin: ICM_ARCHITECT_PIN,
    }),
  });
  assert.equal(first.created, true);
  assert.equal(created, 1);
  assert.equal(listed, 1);
  const second = await ensureIcmArchitectSkill({
    store,
    list,
    create,
    retrieve: async () => skill,
    buildZip: async () => {
      throw new Error("second boot must not build a zip");
    },
  });
  assert.equal(second.created, false);
  assert.equal(created, 1);

  const ambiguous = new Map();
  let ambiguousCreates = 0;
  const blocked = await ensureIcmArchitectSkill({
    store: {
      async getResource(key) {
        return ambiguous.get(key) || null;
      },
      async saveResource(record) {
        ambiguous.set(record.idempotencyKey, { ...record });
      },
    },
    list: async () => [{}, {}],
    create: async () => {
      ambiguousCreates += 1;
      return skill;
    },
    retrieve: async () => null,
    buildZip: async () => ({
      filename: "unused.zip",
      bytes: Buffer.from("x"),
      pin: ICM_ARCHITECT_PIN,
    }),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(ambiguousCreates, 0);
});
