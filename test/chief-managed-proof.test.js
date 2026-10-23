import crypto from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { ICM_ARCHITECT_PIN, runtimeMode } from "../server/chief/managed/constants.js";
import { proofSessionBody, recordModelEvidence } from "../server/chief/managed/client.js";
import { compareDatabaseIdentities } from "../server/chief/managed/identity.js";
import { buildLatencySample, summarizeLatency } from "../server/chief/managed/latency.js";
import { createMemoryStore } from "../server/chief/managed/memoryStore.js";
import { advanceRun } from "../server/chief/managed/orchestrator.js";
import {
  acquireWriteLease,
  authorizeCommit,
  canReleaseWriteOwnership,
  planSync,
} from "../server/chief/managed/ownership.js";
import { deliverProofPing } from "../server/chief/managed/proofPing.js";
import {
  evaluateMigrationBaseline,
  evaluateSchemaReadiness,
} from "../server/chief/managed/readiness.js";
import { acknowledgeSupervisor } from "../server/chief/managed/drainTarget.js";
import { createKickServer } from "../server/chief/managed/kickServer.js";
import {
  LIVE_PHASES,
  assessLivePrerequisites,
  assessProofUser,
  executeLiveProof,
} from "../server/chief/managed/liveProof.js";
import {
  connectionLabel,
  projectRefFromConnection,
  redactSecrets,
} from "../server/chief/managed/redact.js";
import { runProofCommand } from "../scripts/chief-managed-proof.mjs";
import { classifyResourceList, ensureResource } from "../server/chief/managed/resources.js";
import { PROOF_TABLES } from "../server/chief/managed/constants.js";
import { queueProofRun } from "../server/chief/managed/queue.js";
import { promptFor, TRANSCRIPT_LEAK_MARKER } from "../server/chief/managed/scenario.js";
import { evaluateSkillRead, inspectWorkspace } from "../server/chief/managed/skillEvidence.js";
import {
  assertPinnedSkillTree,
  buildIcmArchitectZip,
  icmArchitectRoot,
} from "../server/chief/managed/skillPackage.js";
import { decideWebhookDelivery } from "../server/chief/managed/jobs.js";
import {
  handleManagedDrain,
  handleManagedRunStart,
  handleManagedRunStatus,
  handleManagedWebhook,
} from "../server/chief/managed/handlers.js";
import { readSessionIdled, verifyStandardWebhook } from "../server/chief/managed/webhookVerify.js";
import path from "node:path";

const FILES = {
  "requirements.md": "Herd size starts at 12 goats. Feed must last two days.",
  "decisions.md": "Build a ground-level feeder. No barn hoist.",
  "open-questions.md": "Which timber is already on the farm?",
  "next-step.md": "Measure the gate opening.",
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function skillText() {
  return fs.readFileSync(path.join(icmArchitectRoot(), "SKILL.md"), "utf8");
}

function workspaceMemories() {
  return Object.entries(FILES).map(([filePath, content]) => ({ path: `/${filePath}`, content }));
}

function createMockClient() {
  const skills = [];
  const agents = [];
  const environments = [];
  const stores = [];
  const sessions = [];
  const calls = {
    createSkill: 0,
    createAgent: 0,
    createEnvironment: 0,
    createMemoryStore: 0,
    createSession: 0,
    createMemory: [],
    sendEvents: 0,
    deleteMemoryStore: 0,
  };
  let eventsMode = "idle";
  const client = {
    calls,
    sessions,
    stores,
    setEvents(mode) {
      eventsMode = mode;
    },
    async listSkills() {
      return skills;
    },
    async createSkill() {
      calls.createSkill += 1;
      const row = {
        id: `skill_${calls.createSkill}`,
        latest_version: "ver_pinned",
        display_title: `icm-architect ${ICM_ARCHITECT_PIN}`,
      };
      skills.push(row);
      return row;
    },
    async retrieveSkill(id) {
      return skills.find((row) => row.id === id) || null;
    },
    async listAgents() {
      return agents;
    },
    async createAgent(body) {
      calls.createAgent += 1;
      const row = {
        id: `agent_${calls.createAgent}`,
        version: 1,
        name: body.name,
        metadata: body.metadata,
        model: body.model,
      };
      agents.push(row);
      return row;
    },
    async retrieveAgent(id) {
      return agents.find((row) => row.id === id) || null;
    },
    async listEnvironments() {
      return environments;
    },
    async createEnvironment(body) {
      calls.createEnvironment += 1;
      const row = {
        id: `env_${calls.createEnvironment}`,
        name: body.name,
        metadata: body.metadata,
      };
      environments.push(row);
      return row;
    },
    async retrieveEnvironment(id) {
      return environments.find((row) => row.id === id) || null;
    },
    async listMemoryStores() {
      return stores;
    },
    async createMemoryStore(body) {
      calls.createMemoryStore += 1;
      const row = {
        id: `mem_${calls.createMemoryStore}`,
        name: body.name,
        metadata: body.metadata,
      };
      stores.push(row);
      return row;
    },
    async createMemory(_storeId, body) {
      calls.createMemory.push(body);
      return { id: `doc_${calls.createMemory.length}` };
    },
    async listSessions() {
      return sessions;
    },
    async createSession(body) {
      calls.createSession += 1;
      const row = {
        id: `sess_${calls.createSession}`,
        status: "running",
        model: { id: "claude-opus-5-5", effort: "medium" },
        resources: body.resources,
        metadata: body.metadata,
        prompt: body.initial_events?.[0]?.content?.[0]?.text || "",
        access: body.resources?.[0]?.access,
        storeId: body.resources?.[0]?.memory_store_id,
      };
      sessions.push(row);
      return row;
    },
    async retrieveSession(id) {
      return {
        ...(sessions.find((row) => row.id === id) || null),
        status: eventsMode === "idle" ? "idle" : "running",
      };
    },
    async listEvents(sessionId) {
      const text = sessionId.endsWith("_1")
        ? `Ground-level feeder. ${TRANSCRIPT_LEAK_MARKER}`
        : "The current decision is a ground-level feeder for 40 goats.";
      const events = [
        {
          type: "agent.tool_use",
          id: `read_${sessionId}`,
          name: "read",
          input: { path: "/mnt/skills/icm-architect/SKILL.md" },
        },
        {
          type: "agent.tool_result",
          tool_use_id: `read_${sessionId}`,
          is_error: false,
          content: [{ type: "text", text: skillText() }],
        },
        {
          type: "agent.message",
          id: `msg_${sessionId}`,
          processed_at: new Date().toISOString(),
          content: [{ type: "text", text }],
        },
        { type: "agent.custom_tool_use", id: `ping_${sessionId}`, name: "proof_ping" },
      ];
      if (eventsMode === "idle")
        events.push({ type: "session.status_idle", id: `idle_${sessionId}` });
      return events;
    },
    async listMemories() {
      const latest = sessions.at(-1);
      const files = workspaceMemories();
      if (latest?.prompt?.includes("40 goats")) {
        return files.map((file) =>
          file.path.endsWith("requirements.md")
            ? { ...file, content: "Herd size is 40 goats." }
            : file
        );
      }
      return files;
    },
    async sendEvents() {
      calls.sendEvents += 1;
      return { ok: true };
    },
  };
  return client;
}

test("production chat runtime stays legacy unless explicitly switched", () => {
  assert.equal(runtimeMode({}), "legacy");
  assert.equal(runtimeMode({ CHIEF_RUNTIME: "managed" }), "managed");
});

test("database identity requires the cluster id, not the database name", () => {
  const runtime = {
    systemIdentifier: "111",
    databaseOid: "5",
    databaseName: "postgres",
    serverAddr: "10.0.0.1",
  };
  const direct = {
    systemIdentifier: "222",
    databaseOid: "5",
    databaseName: "postgres",
    serverAddr: "10.0.0.2",
  };
  const differentCluster = compareDatabaseIdentities({
    runtime,
    direct,
    productionSystemId: "999",
  });
  assert.equal(differentCluster.ok, false);
  assert.match(differentCluster.failures.join(" "), /different Postgres clusters/);

  const isolated = compareDatabaseIdentities({
    runtime,
    direct: { ...runtime, serverAddr: "10.9.9.9" },
    service: { ...runtime, serverAddr: null },
    productionSystemId: "999",
  });
  assert.equal(isolated.ok, true);
  assert.equal(isolated.isolation, "isolated");

  const unproven = compareDatabaseIdentities({
    runtime,
    direct: runtime,
  });
  assert.equal(unproven.ok, false);
  assert.equal(unproven.isolation, "unproven");

  const production = compareDatabaseIdentities({
    runtime,
    direct: runtime,
    productionSystemId: "111",
  });
  assert.equal(production.ok, false);
  assert.equal(production.isolation, "production");
});

test("connection labels omit credentials", () => {
  const label = connectionLabel(
    "postgresql://user:secret-token@db.example:5432/postgres?sslmode=require"
  );
  assert.deepEqual(label, { host: "db.example", port: "5432", database: "postgres" });
  assert.equal(JSON.stringify(label).includes("secret-token"), false);
  assert.match(
    redactSecrets("failed postgresql://user:secret-token@db.example/postgres"),
    /<redacted>/
  );
});

test("schema readiness is separate from identity and requires forced RLS", () => {
  const missing = evaluateSchemaReadiness([]);
  assert.equal(missing.ok, false);
  const ready = evaluateSchemaReadiness(
    PROOF_TABLES.map((name) => ({ name, rowSecurity: true, forced: true }))
  );
  assert.equal(ready.ok, true);
});

test("webhook delivery does not start a second worker while a lease is valid", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(decideWebhookDelivery(null, now).action, "insert");
  assert.equal(decideWebhookDelivery({ status: "completed" }, now).action, "ignore");
  assert.equal(decideWebhookDelivery({ status: "pending" }, now).action, "wake");
  assert.equal(
    decideWebhookDelivery(
      { status: "running", leaseExpiresAt: new Date("2026-10-22T12:01:00Z") },
      now
    ).action,
    "ignore"
  );
  assert.equal(
    decideWebhookDelivery(
      { status: "running", leaseExpiresAt: new Date("2026-10-22T11:00:00Z") },
      now
    ).action,
    "wake"
  );
});

test("write ownership stays with a session that can resume, and a stale generation does not commit", async () => {
  assert.equal(
    canReleaseWriteOwnership({ runStatus: "idle", providerStatus: "idle", unfinishedToolCalls: 0 }),
    false
  );
  assert.equal(
    canReleaseWriteOwnership({
      runStatus: "closed",
      providerStatus: "idle",
      unfinishedToolCalls: 1,
    }),
    false
  );
  assert.equal(
    canReleaseWriteOwnership({
      runStatus: "closed",
      providerStatus: "terminated",
      unfinishedToolCalls: 0,
    }),
    true
  );

  const project = {
    writeSessionId: "sess_a",
    leaseGeneration: 2,
    writeLeaseExpiresAt: new Date("2026-10-22T12:01:00Z"),
  };
  const now = new Date("2026-10-22T12:00:00Z");
  const blocked = acquireWriteLease({
    project,
    sessionId: "sess_b",
    now,
    ownerCanResume: true,
  });
  assert.equal(blocked.ok, false);

  const store = createMemoryStore();
  const saved = await store.createProject({ userId: "user_1", title: "feeder" });
  saved.writeSessionId = "sess_a";
  saved.leaseGeneration = 2;
  saved.writeLeaseExpiresAt = new Date("2026-10-22T12:01:00Z");
  await store.applyCommit({
    projectId: saved.id,
    writeSessionId: "sess_a",
    leaseGeneration: 1,
    now,
    writes: [{ op: "insert", path: "requirements.md", content: "new", contentSha256: "abc" }],
    deletes: [],
    conflicts: [
      {
        path: "requirements.md",
        reason: "generation_mismatch",
        rejectedContent: "new",
        baseSha256: null,
      },
    ],
  });
  assert.equal((await store.listDocuments(saved.id)).length, 0);
  assert.equal((await store.listConflicts(saved.id))[0].rejectedContent, "new");
  assert.equal(
    authorizeCommit({ project: saved, writeSessionId: "sess_a", leaseGeneration: 2, now }).ok,
    true
  );
});

test("an empty memory list does not delete postgres documents", () => {
  const plan = planSync({
    baseHashes: { "requirements.md": "abc" },
    liveDocuments: [{ path: "requirements.md", contentSha256: "abc" }],
    incoming: [],
    listOk: true,
  });
  assert.equal(plan.skipped, "empty_or_failed_list");
  assert.equal(plan.deletes.length, 0);
});

test("proof_ping inserts once and posts again until the result is accepted", async () => {
  const store = createMemoryStore();
  let posts = 0;
  const first = await deliverProofPing({
    toolEventId: "tool_1",
    runId: "run_1",
    userId: "user_1",
    store,
    now: new Date(),
    postResult: async () => {
      posts += 1;
      return { ok: false, error: "socket closed" };
    },
  });
  assert.equal(first.created, true);
  assert.equal(first.completed, false);
  const second = await deliverProofPing({
    toolEventId: "tool_1",
    runId: "run_1",
    userId: "user_1",
    store,
    now: new Date(),
    postResult: async () => {
      posts += 1;
      return { ok: true };
    },
  });
  assert.equal(second.created, false);
  assert.equal(second.completed, true);
  assert.equal(posts, 2);
  const third = await deliverProofPing({
    toolEventId: "tool_1",
    runId: "run_1",
    userId: "user_1",
    store,
    now: new Date(),
    postResult: async () => {
      posts += 1;
      return { ok: true };
    },
  });
  assert.equal(third.posted, false);
  assert.equal(posts, 2);
});

test("setup adopts a provider id that was created before it was stored, and does not create when list fails", async () => {
  const store = createMemoryStore();
  const now = new Date();
  let creates = 0;
  const adopted = await ensureResource({
    store,
    now,
    spec: {
      kind: "skill",
      idempotencyKey: "skill:icm",
      fingerprint: "pin",
      matches: (item) => item.display_title === "icm-architect pin",
      identifiable: (item) => Boolean(item.display_title),
    },
    list: async () => [
      { id: "skill_existing", version: "ver_1", display_title: "icm-architect pin" },
    ],
    retrieve: async () => null,
    create: async () => {
      creates += 1;
      return { id: "should_not_create" };
    },
  });
  assert.equal(creates, 0);
  assert.equal(adopted.resource.providerId, "skill_existing");
  assert.equal(adopted.adopted, true);

  const blocked = await ensureResource({
    store,
    now,
    spec: {
      kind: "agent",
      idempotencyKey: "agent:chief",
      fingerprint: "pin",
      matches: () => false,
      identifiable: () => true,
    },
    list: async () => {
      throw new Error("list unavailable");
    },
    retrieve: async () => null,
    create: async () => {
      creates += 1;
      return { id: "agent_new" };
    },
  });
  assert.equal(creates, 0);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.resource.status, "needs_reconciliation");
  assert.equal(
    classifyResourceList([{ id: "x" }], { matches: () => false, identifiable: () => false }).action,
    "reconcile"
  );
});

test("skill evidence requires a successful SKILL.md read, and the workspace is inspected separately", () => {
  const description = skillText().split("\n")[2].replace("description: ", "");
  const described = evaluateSkillRead([
    {
      type: "agent.tool_use",
      id: "read_desc",
      name: "read",
      description,
      input: { path: "/mnt/skills/icm-architect/SKILL.md" },
      result: description,
    },
  ]);
  assert.equal(described.pass, false);

  const read = evaluateSkillRead([
    {
      type: "agent.tool_use",
      id: "read_ok",
      name: "read",
      input: { path: "/mnt/skills/icm-architect/SKILL.md" },
    },
    {
      type: "agent.tool_result",
      tool_use_id: "read_ok",
      is_error: false,
      content: [{ type: "text", text: skillText() }],
    },
  ]);
  assert.equal(read.pass, true);
  assert.equal(
    inspectWorkspace(
      Object.entries(FILES).map(([filePath, content]) => ({ path: filePath, content })),
      ["requirements.md", "decisions.md", "open-questions.md", "next-step.md"]
    ).pass,
    true
  );
  assert.equal(
    inspectWorkspace(
      [{ path: "requirements.md", content: "x" }],
      ["requirements.md", "decisions.md"]
    ).pass,
    false
  );
});

test("the pinned skill zip contains the unchanged SKILL.md", async () => {
  const pinned = assertPinnedSkillTree();
  assert.equal(pinned.pin, ICM_ARCHITECT_PIN);
  const built = await buildIcmArchitectZip();
  const zip = await JSZip.loadAsync(built.bytes);
  const packed = await zip.file("SKILL.md").async("string");
  assert.equal(packed, skillText());
  assert.equal(zip.file("VENDORED.md"), null);
  assert.ok(zip.file("references/core.md"));
});

test("latency keeps every sample and separates supervisor recovery", () => {
  const started = new Date("2026-10-22T12:00:00Z");
  const normal = buildLatencySample({
    run: { id: "run", userId: "user", promptClass: "resumed", createdAt: started },
    actor: "awaited_start",
    now: new Date("2026-10-22T12:00:05Z"),
    processedAt: "2026-10-22T12:00:04Z",
    firstTextAt: "2026-10-22T12:00:04Z",
    completedAt: "2026-10-22T12:00:05Z",
    phase: "continue",
  });
  const recovery = buildLatencySample({
    run: { id: "run", userId: "user", promptClass: "resumed", createdAt: started },
    actor: "supervisor",
    now: new Date("2026-10-22T12:00:30Z"),
    firstTextAt: "2026-10-22T12:00:30Z",
    phase: "continue",
  });
  const summary = summarizeLatency([normal, recovery]);
  assert.equal(summary.kept, 2);
  assert.equal(summary.dropped, 0);
  assert.equal(summary.groups["resumed:normal"].count, 1);
  assert.equal(summary.groups["resumed:supervisor_recovery"].count, 1);
  assert.equal(normal.note, null);
  assert.match(recovery.note, /poll-observed only/);
});

test("prompts do not carry a prior transcript", () => {
  for (const phase of ["continue_same_store", "confirm", "recover", "correct"]) {
    assert.equal(promptFor(phase).includes(TRANSCRIPT_LEAK_MARKER), false);
  }
});

test("same-store continuation and postgres recovery use different stores", async () => {
  const store = createMemoryStore();
  const client = createMockClient();
  client.setEvents("idle");
  const queued = await queueProofRun(store, {
    userId: "user_1",
    phase: "initial",
    title: "Goat hay feeder",
  });
  const initial = await advanceRun({
    store,
    client,
    runId: queued.run.id,
    actor: "awaited_start",
    budgetMs: 20_000,
  });
  assert.equal(initial.promptSubmitted, true);
  assert.equal(initial.run.skillEvidence.pass, true);
  assert.equal(initial.run.workspaceEvidence.pass, true);
  assert.equal(initial.run.modelEvidence.independentServingProof, false);
  assert.match(initial.run.modelEvidence.limitation, /not independent serving proof/);
  assert.equal(initial.run.modelEvidence.configured.id, "claude-opus-5-5");
  const originalStore = initial.run.memoryStoreId;
  const requirements = (await store.listDocuments(queued.project.id)).find(
    (doc) => doc.path === "requirements.md"
  );
  assert.match(requirements.content, /12 goats/);

  const continued = await queueProofRun(store, {
    userId: "user_1",
    phase: "continue_same_store",
    projectId: queued.project.id,
    priorRunId: queued.run.id,
  });
  const continuation = await advanceRun({
    store,
    client,
    runId: continued.run.id,
    actor: "awaited_start",
    budgetMs: 20_000,
  });
  const continuationSession = client.sessions.at(-1);
  assert.equal(continuationSession.storeId, originalStore);
  assert.equal(continuationSession.access, "read_only");
  assert.equal(continuationSession.prompt.includes(TRANSCRIPT_LEAK_MARKER), false);
  assert.equal(continuation.run.priorStoreId, null);

  const closed = await queueProofRun(store, {
    userId: "user_1",
    phase: "close",
    projectId: queued.project.id,
    priorRunId: queued.run.id,
  });
  const closing = await advanceRun({ store, client, runId: closed.run.id, budgetMs: 20_000 });
  assert.equal(closing.done, true);
  assert.equal((await store.getProject(queued.project.id)).writeSessionId, null);

  const recovered = await queueProofRun(store, {
    userId: "user_1",
    phase: "recover",
    projectId: queued.project.id,
    priorRunId: continued.run.id,
  });
  const recovery = await advanceRun({
    store,
    client,
    runId: recovered.run.id,
    actor: "awaited_start",
    budgetMs: 20_000,
  });
  const recoverySession = client.sessions.at(-1);
  assert.notEqual(recoverySession.storeId, originalStore);
  assert.equal(
    recoverySession.resources.some((item) => item.memory_store_id === originalStore),
    false
  );
  assert.equal(client.calls.deleteMemoryStore, 0);
  assert.equal(recovery.run.priorStoreId, originalStore);
  assert.ok(client.calls.createMemory.some((body) => body.content.includes("12 goats")));
  assert.equal(recoverySession.prompt.includes(TRANSCRIPT_LEAK_MARKER), false);
  assert.equal(client.calls.createSkill, 1);
  assert.equal(client.calls.createAgent, 1);
});

test("run start returns the run id after a dispatch ack and does not wait for the provider", async () => {
  const store = createMemoryStore();
  let providerFinished = false;
  const res = response();
  await handleManagedRunStart(
    { method: "POST", body: { phase: "initial", title: "Goat hay feeder" } },
    res,
    {
      enabled: true,
      authenticate: async () => ({ uid: "user_1" }),
      storeFor: () => store,
      dispatch: async ({ runId }) => {
        setTimeout(() => {
          providerFinished = runId;
        }, 50);
        return { accepted: true };
      },
    }
  );
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.promptSubmitted, false);
  assert.equal(res.body.status, "queued");
  assert.equal(res.body.dispatchAcknowledged, true);
  assert.ok(res.body.runId);
  assert.equal(providerFinished, false);
  const saved = await store.getRun(res.body.runId);
  assert.equal(saved.status, "queued");
  assert.equal(saved.providerSessionId, null);

  const statusResponse = response();
  await handleManagedRunStatus(
    { method: "GET", params: { runId: res.body.runId } },
    statusResponse,
    {
      enabled: true,
      authenticate: async () => ({ uid: "user_1" }),
      storeFor: () => store,
      client: {
        listSkills() {
          throw new Error("status drained");
        },
      },
    }
  );
  assert.equal(statusResponse.statusCode, 200);
  assert.equal(statusResponse.body.run.providerSessionId, null);
  assert.equal(statusResponse.body.latency.dropped, 0);
});

test("a valid drain lease ignores a duplicate webhook", async () => {
  const store = createMemoryStore();
  const queued = await queueProofRun(store, { userId: "user_1", phase: "initial" });
  queued.run.providerSessionId = "sess_held";
  await store.saveRun(queued.run);
  const job = await store.openJob(queued.run.id);
  job.status = "running";
  job.webhookEventId = "msg_1";
  job.leaseExpiresAt = new Date(Date.now() + 60_000);
  const secret = Buffer.from("proof-webhook-secret").toString("base64");
  const rawBody = JSON.stringify({ type: "session.status_idled", id: "sess_held" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`msg_1.${timestamp}.${rawBody}`)
    .digest("base64");
  const res = response();
  await handleManagedWebhook(
    {
      method: "POST",
      body: rawBody,
      headers: {
        "webhook-id": "msg_1",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
    },
    res,
    {
      enabled: true,
      webhookSecret: `whsec_${secret}`,
      storeFor: () => store,
      findRunBySession: async () => queued.run,
      client: {
        listSkills() {
          throw new Error("second worker");
        },
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.delivery, "ignore");
  assert.equal(readSessionIdled(JSON.parse(rawBody)), "sess_held");
});

test("webhook signatures fail closed", () => {
  assert.equal(verifyStandardWebhook({ rawBody: "{}", headers: {}, secret: "" }).status, 503);
  const stale = verifyStandardWebhook({
    rawBody: "{}",
    headers: { "webhook-id": "m", "webhook-timestamp": "1", "webhook-signature": "v1,aa" },
    secret: "whsec_YQ==",
    now: Date.now(),
  });
  assert.equal(stale.ok, false);
});

test("model evidence does not invent a served model", () => {
  const evidence = recordModelEvidence({ model: { id: "claude-opus-5-5", effort: "medium" } });
  assert.equal(evidence.servedModel, null);
  assert.equal(evidence.independentServingProof, false);
  assert.throws(() =>
    proofSessionBody({
      agentId: "agent",
      agentVersion: null,
      environmentId: "env",
      storeId: "mem",
      access: "read_write",
      prompt: "hi",
      runId: "run",
    })
  );
});

test("drain requires the shared secret", async () => {
  const res = response();
  await handleManagedDrain({ method: "POST", headers: {} }, res, {
    enabled: true,
    drainSecret: "",
    listClaimable: async () => [],
    storeFor: () => createMemoryStore(),
  });
  assert.equal(res.statusCode, 503);
});

test("a managed role denied pg_control_system still matches the owner cluster", () => {
  const denied = {
    systemIdentifier: null,
    systemIdentifierAccess: "denied",
    databaseOid: "5",
    databaseName: "postgres",
    projectRef: "proofref",
    serverAddr: "10.0.0.1",
  };
  const owner = {
    systemIdentifier: "111",
    systemIdentifierAccess: "granted",
    databaseOid: "5",
    databaseName: "postgres",
    projectRef: "proofref",
    serverAddr: "10.0.0.2",
  };
  const isolated = compareDatabaseIdentities({
    runtime: denied,
    direct: owner,
    service: { ...denied, serverAddr: "10.0.0.3" },
    requireService: true,
    productionSystemId: "999",
  });
  assert.equal(isolated.ok, true);
  assert.equal(isolated.identity.method, "owner_system_identifier");
  assert.equal(isolated.identity.systemIdentifier, "111");
  assert.equal(isolated.serviceChecked, true);
  assert.match(isolated.identity.limitation, /cannot call pg_control_system/);

  const missingRef = compareDatabaseIdentities({
    runtime: { ...denied, projectRef: "" },
    direct: owner,
    productionSystemId: "999",
  });
  assert.equal(missingRef.ok, false);
  assert.match(missingRef.failures.join(" "), /project ref is missing/);
});

test("project ref and database oid are the fallback when every role is denied", () => {
  const denied = {
    systemIdentifier: null,
    systemIdentifierAccess: "denied",
    databaseOid: "5",
    databaseName: "postgres",
    projectRef: "proofref",
  };
  const isolated = compareDatabaseIdentities({
    runtime: denied,
    direct: denied,
    service: denied,
    requireService: true,
    productionProjectRef: "prodref",
  });
  assert.equal(isolated.ok, true);
  assert.equal(isolated.identity.method, "project_ref_and_database_oid");
  assert.equal(isolated.identity.systemIdentifier, null);
  assert.match(isolated.identity.limitation, /not the Postgres system identifier/);

  const sameProject = compareDatabaseIdentities({
    runtime: denied,
    direct: denied,
    productionProjectRef: "proofref",
  });
  assert.equal(sameProject.isolation, "production");
  assert.equal(sameProject.ok, false);
});

test("project ref parsing drops the role name and password", () => {
  assert.equal(
    projectRefFromConnection(
      "postgresql://freedom_app.proofref:secret-token@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
    ),
    "proofref"
  );
  assert.equal(
    projectRefFromConnection(
      "postgresql://postgres:secret-token@db.proofref.supabase.co:5432/postgres"
    ),
    "proofref"
  );
  assert.equal(
    JSON.stringify(
      projectRefFromConnection("postgresql://postgres:secret@db.proofref.supabase.co/postgres")
    ).includes("secret"),
    false
  );
});

test("baseline readiness requires the init migration and User, not only the proof migration", () => {
  const proofOnly = evaluateMigrationBaseline({
    userTable: false,
    appliedMigrations: ["20261022193000_chief_managed_proof"],
  });
  assert.equal(proofOnly.ok, false);
  assert.match(proofOnly.failures.join(" "), /20250604120000_init/);
  assert.match(proofOnly.failures.join(" "), /User/);
  const ready = evaluateMigrationBaseline({
    userTable: true,
    appliedMigrations: ["20250604120000_init", "20261022193000_chief_managed_proof"],
  });
  assert.equal(ready.ok, true);
});

test("live prerequisites name what is missing and do not say the runner is unimplemented", () => {
  const missing = assessLivePrerequisites({});
  assert.equal(
    missing.some((item) => /not implemented/i.test(item)),
    false
  );
  assert.match(missing.join("\n"), /CHIEF_PROOF_SPEND_APPROVED/);
  assert.match(missing.join("\n"), /SERVICE_DATABASE_URL/);
  assert.match(missing.join("\n"), /CHIEF_SUPERVISOR_URL/);
  assert.match(missing.join("\n"), /5 provider sessions/);
  assert.equal(assessProofUser(null, "user_proof").ok, false);
});

test("the live runner executes phases through a supervisor ack when prerequisites are injected", async () => {
  const store = createMemoryStore();
  const client = createMockClient();
  client.setEvents("idle");
  const result = await executeLiveProof({
    store,
    userId: "user_1",
    phases: LIVE_PHASES,
    queue: queueProofRun,
    liveProvider: false,
    timeoutMs: 5000,
    dispatch: ({ runId }) => {
      setImmediate(() => {
        advanceRun({ store, client, runId, actor: "supervisor", budgetMs: 20_000 }).catch(() => {});
      });
      return { accepted: true };
    },
    readRun: (runId) => store.getRun(runId),
  });
  assert.equal(result.ok, true);
  assert.equal(result.acceptance, "runner_exercised_with_injected_client");
  assert.equal(result.mocked, true);
  assert.equal(result.sessionsReserved, 5);
  const continued = client.sessions[1];
  const recovered = client.sessions.at(-1);
  assert.equal(continued.access, "read_only");
  assert.equal(continued.storeId, client.sessions[0].storeId);
  assert.equal(client.sessions[2].prompt.includes("40 goats"), true);
  assert.notEqual(recovered.storeId, client.sessions[0].storeId);
  assert.equal(client.calls.createSkill, 1);
  assert.equal(client.calls.createAgent, 1);
  assert.ok(client.calls.createMemory.some((body) => body.content.includes("40 goats")));
  assert.equal(result.evidence.at(-1).priorStoreId, client.sessions[0].storeId);
});

test("the proposed session cap stops the runner before another provider session", async () => {
  const store = createMemoryStore();
  const client = createMockClient();
  client.setEvents("idle");
  const result = await executeLiveProof({
    store,
    userId: "user_1",
    queue: queueProofRun,
    sessionCap: 1,
    ledgerCents: 1000,
    timeoutMs: 5000,
    dispatch: ({ runId }) => {
      setImmediate(() => {
        advanceRun({ store, client, runId, actor: "supervisor", budgetMs: 20_000 }).catch(() => {});
      });
      return { accepted: true };
    },
    readRun: (runId) => store.getRun(runId),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "proposed_cost_cap");
  assert.equal(result.sessionsReserved, 1);
  assert.equal(client.calls.createSession, 1);
});

test("supervisor kick acknowledges before work finishes and continues after the client aborts", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let finished = false;
  const listener = await createKickServer({
    secret: "proof-secret",
    onKick: async () => {
      await gate;
      finished = true;
    },
  });
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${listener.port}/kick`, {
      method: "POST",
      headers: { authorization: "Bearer proof-secret" },
      signal: controller.signal,
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).accepted, true);
    assert.equal(finished, false);
    controller.abort();
    const acked = await acknowledgeSupervisor(
      {
        CHIEF_SUPERVISOR_URL: `http://127.0.0.1:${listener.port}`,
        CHIEF_DRAIN_SECRET: "proof-secret",
      },
      fetch
    );
    assert.equal(acked.accepted, true);
    assert.equal(finished, false);
    release();
    const deadline = Date.now() + 1000;
    while (!finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finished, true);
  } finally {
    await listener.close();
  }
});

test("the live command runs the injected experiment when prerequisites pass", async () => {
  const env = {
    CHIEF_PROOF_SPEND_APPROVED: "1",
    ANTHROPIC_API_KEY: "present",
    CHIEF_MANAGED_PROOF: "1",
    DATABASE_URL: "present",
    DIRECT_URL: "present",
    SERVICE_DATABASE_URL: "present",
    CHIEF_PRODUCTION_DB_SYSTEM_ID: "production",
    FFF_ENCRYPTION_KEYS: "present",
    FFF_ENCRYPTION_ACTIVE_VERSION: "1",
    CHIEF_PROOF_USER_ID: "user_proof",
    CHIEF_SUPERVISOR_URL: "http://127.0.0.1:9",
    CHIEF_DRAIN_SECRET: "present",
    CHIEF_SUPERVISOR_MODE: "embedded",
  };
  let called = false;
  const result = await runProofCommand(env, {
    live: true,
    identify: async () => ({ ok: true, serviceChecked: true, failures: [] }),
    checkReadiness: async () => ({
      ok: true,
      baseline: { ok: true, failures: [] },
      readiness: { ok: true, failures: [] },
    }),
    lookupUser: async () => ({ id: "user_proof" }),
    execute: async () => {
      called = true;
      return { ok: true, acceptance: "live", mocked: false };
    },
  });
  assert.equal(called, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.body.acceptance, "live");
  assert.equal(result.body.mocked, false);
});

test("the live command refuses with the missing prerequisites", async () => {
  const refused = await runProofCommand({}, { live: true });
  assert.equal(refused.exitCode, 3);
  assert.equal(refused.body.implemented, true);
  assert.equal(refused.body.acceptance, "live_refused");
  assert.equal(JSON.stringify(refused.body).includes("not implemented"), false);
  const dry = await runProofCommand({}, { live: false });
  assert.equal(dry.body.acceptance, "mocked_only");
  assert.equal(dry.body.live, false);
});
