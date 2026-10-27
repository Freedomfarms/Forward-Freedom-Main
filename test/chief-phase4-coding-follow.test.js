// Phase 4 coding follow-through. The tick reads the existing ledger.
// It does not submit, grant, or call Cursor when no runtime is configured.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCodingHandoffTools } from "../server/chief/tools/codingHandoff.js";
import {
  CODING_EXECUTION_SCOPE,
  ExecutionState,
  createMemoryExecutionStore,
} from "../server/chief/agents/ledger.js";
import { drainManagedWork, runManagedChiefTurn } from "../server/chief/managed/chatTurn.js";
import { createMemoryWorkQueue } from "../server/chief/managed/workQueue.js";
import { createMemoryWorkspaceDocumentStore } from "../server/chief/memory/workspaceDocuments.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { MemoryTaskStore } from "../server/chief/scheduler/store.js";
import { codingRuntimeFor, codingStatusLine, pollCodingExecutions } from "../server/chief/scheduler/codingFollow.js";
import { runChiefTick } from "../server/chief/scheduler/tick.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";

const REPO = "https://github.com/Freedomfarms/Forward-Freedom-Main";
const REQUIREMENTS = "Add a comment to the response mode control.";

function seal(value) {
  return `sealed:${Buffer.from(String(value), "utf8").toString("base64")}`;
}

function open(value) {
  if (typeof value !== "string" || !value.startsWith("sealed:")) throw new Error("unreadable");
  return Buffer.from(value.slice("sealed:".length), "base64").toString("utf8");
}

function newStore() {
  return createMemoryExecutionStore({ encrypt: seal, decrypt: open });
}

function snapshot(userId = "user-a") {
  return {
    userId,
    provider: "cursor-cloud",
    objective: REQUIREMENTS,
    constraints: ["Do not merge.", "Do not deploy."],
    repositoryUrl: REPO,
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  };
}

async function grant(store, userId = "user-a") {
  const body = snapshot(userId);
  return store.grant({
    ...body,
    actorUserId: userId,
    approvalAction: "execute",
  });
}

async function submitted(store, userId = "user-a") {
  const granted = await grant(store, userId);
  const begun = await store.begin(granted.approvalId, snapshot(userId));
  const finished = await store.adapter().finish(granted.approvalId, "pending", {
    state: "submitted",
    agentId: begun.record.agentId,
    runId: `run-${userId}`,
    status: "CREATING",
  });
  return finished.record;
}

function runtimeFor(store, result) {
  const calls = [];
  return {
    calls,
    async lookupPlatformAgent(agentId) {
      calls.push(["lookup", agentId]);
      return result.lookup || { found: false, absenceProven: false };
    },
    async getStatus(ref) {
      calls.push(["status", ref.runId]);
      const record = await store.adapter().findAgent(ref.agentId);
      if (record && ref.runId) {
        await store.adapter().attachRun(record.approvalId, {
          agentId: ref.agentId,
          runId: ref.runId,
        });
      }
      return { status: "RUNNING", verified: false };
    },
    async getResult(ref) {
      calls.push(["result", ref.agentId, ref.runId]);
      const record = await store.adapter().findRun(ref.agentId, ref.runId);
      if (record && result.mark !== false) {
        await store.adapter().markStatus(record.approvalId, result.status || "FINISHED", {
          result: result.statement || "",
        });
      }
      return {
        status: result.status || "FINISHED",
        verified: result.verified === true,
        pullRequests: result.pullRequests || [],
        statement: result.statement || "",
        ...(typeof result.automatedChecksPassed === "boolean"
          ? { automatedChecksPassed: result.automatedChecksPassed }
          : {}),
      };
    },
    async submit() {
      calls.push(["submit"]);
      throw new Error("poll must not submit");
    },
  };
}

test("a missing Cursor runtime does not list or submit coding work", async () => {
  let listed = false;
  const report = await pollCodingExecutions({
    executionStore: {
      async listNonterminal() {
        listed = true;
        return [];
      },
      adapter() {
        return {};
      },
    },
    runtime: null,
  });
  assert.equal(report.skipped, "not_configured");
  assert.equal(listed, false);
  assert.equal(codingRuntimeFor({ CURSOR_API_KEY: "" }, { adapter() {} }), null);
  const source = readFileSync("server/chief/scheduler/codingFollow.js", "utf8");
  assert.equal(source.includes("runtime.submit"), false);
  assert.equal(source.includes("submitGranted"), false);
  const dispatch = readFileSync("api/cron/chief-dispatch.js", "utf8");
  assert.match(dispatch, /executionStore: createPrismaExecutionStore\(\)/);
  assert.match(dispatch, /documentStore: createPrismaWorkspaceDocumentStore\(\)/);
});

test("a finished run records the pull request without calling it verified", async () => {
  const store = newStore();
  const record = await submitted(store);
  const documents = createMemoryWorkspaceDocumentStore();
  const checkpoints = new MemoryCheckpointStore();
  await checkpoints.createSession({ userId: "user-a", context: { origin: "managed" } });
  const jobs = createMemoryWorkQueue();
  const runtime = runtimeFor(store, {
    status: "FINISHED",
    verified: false,
    automatedChecksPassed: true,
    pullRequests: [{ url: "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/400" }],
    statement: "Opened the pull request.",
  });
  const first = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
    checkpointStore: checkpoints,
    jobs,
  });
  assert.equal(first.polled, 1);
  assert.equal(first.reported, 1);
  assert.equal(first.enqueued, 1);
  assert.equal(runtime.calls.some((call) => call[0] === "submit"), false);
  assert.equal(runtime.calls.filter((call) => call[0] === "result").length, 1);
  const current = await store.get("user-a", record.id);
  assert.equal(current.state, ExecutionState.COMPLETED);
  assert.equal(current.verified, false);
  const file = (await documents.list("user-a")).find((row) => row.path === "next-step.md");
  assert.match(file.content, /status=FINISHED/);
  assert.match(file.content, /finished=yes/);
  assert.match(file.content, /pr=https:\/\/github.com\/Freedomfarms\/Forward-Freedom-Main\/pull\/400/);
  assert.match(file.content, /checks=yes/);
  assert.match(file.content, /verified=no/);
  assert.match(file.content, /hook=unconfirmed/);
  const session = (await checkpoints.listOwnedSessions("user-a"))[0];
  const loaded = await checkpoints.load("user-a", session.id);
  assert.match(loaded.checkpoint.context.outboundPrompt, /FINISHED means the run finished/);
  assert.match(loaded.checkpoint.context.outboundPrompt, /verified=no/);
  assert.match(loaded.checkpoint.context.outboundPrompt, /do not invent a security-hook result/i);

  const client = scriptedManagedClient([{ text: "The pull request is open. It is not verified." }]);
  const delivered = await drainManagedWork({
    jobs,
    client,
    store: checkpoints,
    runTurn: (input) =>
      runManagedChiefTurn({
        ...input,
        factStore: { async read() { return []; } },
        documentStore: documents,
        toolExecutor: { async execute() { throw new Error("no tool"); } },
      }),
  });
  assert.equal(delivered.drained, 1);
  const prompt = JSON.stringify(client.state.sent);
  assert.match(prompt, /status=FINISHED/);
  assert.match(prompt, /verified=no/);
  assert.equal(prompt.includes("verified=yes"), false);
  assert.equal(runtime.calls.some((call) => call[0] === "submit"), false);

  const second = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
    checkpointStore: checkpoints,
    jobs,
  });
  assert.equal(second.polled, 0);
  assert.equal(second.enqueued, 0);
  assert.equal(jobs.rows.size, 1);
});

test("an unchanged running status does not enqueue another continuation", async () => {
  const store = newStore();
  await submitted(store);
  const documents = createMemoryWorkspaceDocumentStore();
  const checkpoints = new MemoryCheckpointStore();
  await checkpoints.createSession({ userId: "user-a", context: { origin: "managed" } });
  const jobs = createMemoryWorkQueue();
  const runtime = runtimeFor(store, { status: "RUNNING", mark: true });
  const first = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
    checkpointStore: checkpoints,
    jobs,
  });
  assert.equal(first.reported, 1);
  assert.equal(first.enqueued, 0);
  const second = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
    checkpointStore: checkpoints,
    jobs,
  });
  assert.equal(second.unchanged, 1);
  assert.equal(second.enqueued, 0);
  assert.equal(jobs.rows.size, 0);
  assert.equal(runtime.calls.filter((call) => call[0] === "result").length, 2);
  assert.equal(runtime.calls.some((call) => call[0] === "submit"), false);
  const line = codingStatusLine(
    { agentId: "bc-1", state: "RUNNING" },
    { status: "FINISHED", verified: false, pullRequests: [] }
  );
  assert.match(line, /verified=no/);
  assert.match(line, /checks=not-read/);
  assert.match(line, /hook=unconfirmed/);
});

test("an ambiguous grant is reconciled once and an approved grant is not submitted", async () => {
  const store = newStore();
  const approved = await grant(store, "user-a");
  const other = await grant(store, "user-b");
  const begun = await store.begin(other.approvalId, snapshot("user-b"));
  await store.adapter().finish(other.approvalId, "pending", {
    state: "ambiguous",
    agentId: begun.record.agentId,
  });
  const documents = createMemoryWorkspaceDocumentStore();
  const runtime = runtimeFor(store, {
    status: "FINISHED",
    lookup: { found: true, runId: "run-user-b" },
    pullRequests: [{ url: "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/401" }],
  });
  const report = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
  });
  assert.equal(report.polled, 1);
  assert.equal(runtime.calls.some((call) => call[0] === "submit"), false);
  assert.equal(runtime.calls.filter((call) => call[0] === "lookup").length, 1);
  assert.equal(runtime.calls.filter((call) => call[0] === "result").length, 1);
  assert.equal((await store.get("user-a", approved.id)).state, ExecutionState.APPROVED);
  assert.equal((await store.get("user-b", other.id)).state, ExecutionState.COMPLETED);
  assert.equal(store.rows().length, 2);
  const file = (await documents.list("user-b")).find((row) => row.path === "next-step.md");
  assert.match(file.content, /pull\/401/);
  assert.match(file.content, /verified=no/);
  assert.equal((await documents.list("user-a")).some((row) => row.path === "next-step.md"), false);
});

test("a deleted next-step file is not rewritten by a status poll", async () => {
  const store = newStore();
  await submitted(store);
  const documents = createMemoryWorkspaceDocumentStore();
  await documents.applyWrite({
    userId: "user-a",
    path: "next-step.md",
    content: "Old step.",
    op: "insert",
  });
  const current = (await documents.list("user-a")).find((row) => row.path === "next-step.md");
  await documents.applyWrite({
    userId: "user-a",
    path: "next-step.md",
    content: "",
    expectedSha256: current.contentSha256,
    op: "delete",
  });
  const runtime = runtimeFor(store, { status: "FINISHED" });
  const report = await pollCodingExecutions({
    executionStore: store,
    runtime,
    documentStore: documents,
  });
  assert.equal(report.reported, 0);
  assert.equal(report.enqueued, 0);
  const row = (await documents.list("user-a")).find((item) => item.path === "next-step.md");
  assert.ok(row.deletedAt);
  assert.equal(row.content.includes("status=FINISHED"), false);
});

test("the tick records coding status without a model, and a schedule cannot grant coding", async () => {
  const store = newStore();
  await submitted(store);
  const documents = createMemoryWorkspaceDocumentStore();
  const checkpoints = new MemoryCheckpointStore();
  const jobs = createMemoryWorkQueue();
  const runtime = runtimeFor(store, {
    status: "FINISHED",
    pullRequests: [{ url: "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/402" }],
  });
  const report = await runChiefTick({
    taskStore: new MemoryTaskStore(),
    checkpointStore: checkpoints,
    client: null,
    jobs,
    executionStore: store,
    codingRuntime: runtime,
    documentStore: documents,
  });
  assert.equal(report.blocked, "ANTHROPIC_API_KEY");
  assert.equal(report.coding.reported, 1);
  assert.deepEqual(report.runs, []);
  assert.equal(runtime.calls.some((call) => call[0] === "submit"), false);

  const quiet = await runChiefTick({
    taskStore: new MemoryTaskStore(),
    checkpointStore: new MemoryCheckpointStore(),
    client: null,
  });
  assert.equal(quiet.coding, undefined);

  const calls = [];
  const [tool] = createCodingHandoffTools({
    env: { CURSOR_API_KEY: "cursor_test_key_value", CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl: async () => {
      calls.push("cursor");
      throw new Error("Cursor was called");
    },
    ledger: store,
  });
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
  assert.equal(calls.length, 0);
  assert.equal(store.rows().filter((row) => row.state === ExecutionState.APPROVED).length, 0);
});
