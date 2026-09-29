// Checkpoint store — atomic saveWithEvents, fork, and user scope.
// Memory store is the contract. Prisma store is exercised with a fake
// transaction and a passthrough codec (no database, no envelope keys).

import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryCheckpointStore,
  PrismaCheckpointStore,
  assertNoProviderPrivate,
  emptyCheckpoint,
} from "../server/chief/runtime/checkpoint.js";

const passthrough = {
  encrypt: (value) => value,
  decrypt: (value) => value,
};

function fakeDb() {
  const state = {
    sessions: [],
    journals: [],
    deltas: [],
    events: [],
    approvals: [],
  };
  const tx = {
    chiefSession: {
      create: async ({ data }) => {
        state.sessions.push({ ...data });
        return data;
      },
      findFirst: async ({ where }) =>
        state.sessions.find((row) => row.id === where.id && row.userId === where.userId) ?? null,
      findMany: async ({ where }) =>
        state.sessions.filter((row) => row.userId === where.userId && row.status === where.status),
      update: async ({ where, data }) => {
        const row = state.sessions.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    chiefExecutionJournal: {
      create: async ({ data }) => {
        state.journals.push({ ...data });
        return data;
      },
      findFirst: async ({ where }) => {
        const rows = state.journals.filter((row) => row.sessionId === where.sessionId);
        return rows.sort((a, b) => b.sequence - a.sequence)[0] ?? null;
      },
    },
    chiefTranscriptDelta: {
      create: async ({ data }) => {
        state.deltas.push({ ...data });
        return data;
      },
    },
    chiefEventJournal: {
      createMany: async ({ data }) => {
        if (state.failEvents) throw new Error("event journal failed");
        state.events.push(...data);
        return { count: data.length };
      },
    },
    chiefApproval: {
      create: async ({ data }) => {
        state.approvals.push({ ...data });
        return data;
      },
      update: async ({ where, data }) => {
        const row = state.approvals.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
  return {
    state,
    async withUser(_userId, fn) {
      const backup = structuredClone(state);
      try {
        return await fn(tx);
      } catch (error) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, backup);
        throw error;
      }
    },
  };
}

test("provider-private fields are rejected before a memory save advances the sequence", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user" });
  const checkpoint = emptyCheckpoint();
  checkpoint.transcript = [{ role: "assistant", content: "x", providerMetadata: { secret: "no" } }];
  await assert.rejects(
    store.saveWithEvents("user", created.id, { checkpoint, events: [] }),
    /provider-private field/
  );
  const loaded = await store.load("user", created.id);
  assert.equal(loaded.lastSequence, 0);
  assert.equal(loaded.journal.length, 0);
  assert.throws(() => assertNoProviderPrivate({ request: {} }), /provider-private/);
});

test("saveWithEvents is monotonic, user-scoped, and lists pending approvals", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user", context: { origin: "test" } });
  const checkpoint = emptyCheckpoint();
  checkpoint.context = { origin: "test" };
  checkpoint.transcript = [{ role: "user", content: "hi" }];
  checkpoint.pendingApproval = { id: "ap-1", turnId: "t1", calls: [], reason: "because" };
  const saved = await store.saveWithEvents("user", created.id, {
    checkpoint,
    events: [{ msg: { type: "turn_started" } }],
    transcriptDelta: [{ role: "user", content: "hi" }],
  });
  assert.equal(saved.lastSequence, 1);
  assert.equal(saved.status, "PENDING_APPROVAL");
  assert.equal(await store.load("other", created.id), null);

  checkpoint.pendingApproval = null;
  await store.saveWithEvents("user", created.id, { checkpoint });
  const again = await store.load("user", created.id);
  assert.equal(again.lastSequence, 2);
  assert.equal(again.status, "ACTIVE");
  assert.equal(again.checkpoint.transcript[0].content, "hi");
  assert.deepEqual(await store.listPending("user"), []);
});

test("fork copies transcript and sticky keys and clears in-flight work", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user" });
  const checkpoint = emptyCheckpoint();
  checkpoint.transcript = [{ role: "user", content: "hi" }];
  checkpoint.approvedForSession = ["sticky"];
  checkpoint.modelRoute = "grok-4.7";
  checkpoint.activeExecution = { turnId: "t", phase: "model", modelSteps: 1 };
  checkpoint.pendingApproval = { id: "ap", turnId: "t", calls: [] };
  checkpoint.pendingMessages = [{ text: "later" }];
  await store.saveWithEvents("user", created.id, { checkpoint });

  const child = await store.fork("user", created.id);
  assert.notEqual(child.id, created.id);
  assert.equal(child.forkedFromSessionId, created.id);
  assert.deepEqual(child.checkpoint.transcript, checkpoint.transcript);
  assert.deepEqual(child.checkpoint.approvedForSession, ["sticky"]);
  assert.equal(child.checkpoint.modelRoute, "grok-4.7");
  assert.equal(child.checkpoint.activeExecution, null);
  assert.equal(child.checkpoint.pendingApproval, null);
  assert.deepEqual(child.checkpoint.pendingMessages, []);
  const parent = await store.load("user", created.id);
  assert.equal(parent.checkpoint.pendingApproval.id, "ap");
});

test("Prisma saveWithEvents writes one transaction and rolls back on a later failure", async () => {
  const db = fakeDb();
  const store = new PrismaCheckpointStore({
    withUser: db.withUser,
    encrypt: passthrough.encrypt,
    decrypt: passthrough.decrypt,
  });
  const created = await store.createSession({ userId: "user", sessionId: "s1" });
  const checkpoint = emptyCheckpoint();
  checkpoint.pendingApproval = {
    id: "ap-1",
    turnId: "t1",
    reason: "needs approval",
    calls: [{ callId: "c1", name: "lookup", arguments: { q: "a" } }],
  };
  checkpoint.activeExecution = { turnId: "t1", phase: "tool_authorize", modelSteps: 1 };
  await store.saveWithEvents("user", created.id, {
    checkpoint,
    events: [{ submission_id: "sub", msg: { type: "exec_approval_request" } }],
    transcriptDelta: [{ role: "user", content: "hi" }],
    approval: { opened: true },
  });
  assert.equal(db.state.sessions[0].lastSequence, 1);
  assert.equal(db.state.sessions[0].status, "PENDING_APPROVAL");
  assert.equal(db.state.journals.length, 1);
  assert.equal(db.state.deltas.length, 1);
  assert.equal(db.state.events.length, 1);
  assert.equal(db.state.events[0].eventType, "exec_approval_request");
  assert.equal(db.state.approvals[0].decision, "PENDING");
  assert.equal(db.state.approvals[0].id, "ap-1");

  const loaded = await store.load("user", "s1");
  assert.equal(loaded.checkpoint.pendingApproval.id, "ap-1");
  assert.deepEqual(await store.listPending("user"), [
    { sessionId: "s1", approval: checkpoint.pendingApproval },
  ]);

  await store.saveWithEvents("user", "s1", {
    checkpoint: { ...checkpoint, pendingApproval: null },
    approval: { decided: true, id: "ap-1", decision: "APPROVED" },
  });
  assert.equal(db.state.approvals[0].decision, "APPROVED");

  db.state.failEvents = true;
  const before = db.state.sessions[0].lastSequence;
  await assert.rejects(
    store.saveWithEvents("user", "s1", {
      checkpoint,
      events: [{ msg: { type: "turn_started" } }],
    }),
    /event journal failed/
  );
  assert.equal(db.state.sessions[0].lastSequence, before);
  assert.equal(db.state.failEvents, true);
});

test("Prisma fork records the parent and does not keep the parent's pending approval", async () => {
  const db = fakeDb();
  const store = new PrismaCheckpointStore({
    withUser: db.withUser,
    encrypt: passthrough.encrypt,
    decrypt: passthrough.decrypt,
  });
  await store.createSession({ userId: "user", sessionId: "parent" });
  const checkpoint = emptyCheckpoint();
  checkpoint.transcript = [{ role: "user", content: "hi" }];
  checkpoint.pendingApproval = { id: "ap", turnId: "t", calls: [], reason: "r" };
  await store.saveWithEvents("user", "parent", { checkpoint });
  const child = await store.fork("user", "parent");
  assert.equal(child.forkedFromSessionId, "parent");
  assert.equal(child.checkpoint.pendingApproval, null);
  assert.equal(child.checkpoint.transcript[0].content, "hi");
  assert.equal(db.state.sessions.find((row) => row.id === child.id).forkedFromSessionId, "parent");
});
