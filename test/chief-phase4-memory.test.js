// Phase 4 memory closure. Explicit commands use the existing fact store.
// A noticed preference is not written and is not trusted.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runManagedChiefTurn } from "../server/chief/managed/chatTurn.js";
import {
  CORE_INSTRUCTION_REVISION,
  productionAgentBody,
} from "../server/chief/managed/productionAgent.js";
import { planUserMemory, resolveRememberedFact } from "../server/chief/memory/commands.js";
import { retainConversationMemories } from "../server/chief/memory/derive.js";
import { MemoryFactStore, PrismaFactStore, factDedupeKey } from "../server/chief/memory/facts.js";
import {
  acceptedFactsDocument,
  createMemoryWorkspaceDocumentStore,
  recoveryDocuments,
} from "../server/chief/memory/workspaceDocuments.js";
import { createMemoryWorkQueue } from "../server/chief/managed/workQueue.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";

function sentText(client) {
  return JSON.stringify(client.state.sent);
}

async function say(facts, text, { transcript = null, schedule = false } = {}) {
  const store = new MemoryCheckpointStore();
  const documents = createMemoryWorkspaceDocumentStore();
  const session = await store.createSession({
    userId: "user-a",
    context: { origin: schedule ? "managed-schedule" : "managed" },
  });
  if (transcript) session.checkpoint.transcript = transcript;
  if (schedule) session.checkpoint.context.pendingPrompt = text;
  await store.saveWithEvents("user-a", session.id, { checkpoint: session.checkpoint });
  const client = scriptedManagedClient([{ text: "Noted." }]);
  await runManagedChiefTurn({
    userId: "user-a",
    sessionId: session.id,
    submission: schedule
      ? undefined
      : { id: "s1", op: { type: "message", message: { text } } },
    store,
    client,
    jobs: createMemoryWorkQueue(),
    factStore: facts,
    documentStore: documents,
    toolExecutor: new ToolExecutor(),
    resume: schedule,
    caller: schedule ? { kind: "schedule", trigger: "schedule:task-1" } : null,
  });
  return { client, store, documents };
}

test("production instructions tell CHIEF how to use memory, research, and coding status", () => {
  assert.equal(CORE_INSTRUCTION_REVISION, "operator-context-and-settled-turns-v5");
  const body = productionAgentBody({ toolSpecs: [], idempotencyKey: "agent:chief:production:test" });
  assert.match(body.system, /empty note is not the Freedom OS architecture/);
  assert.match(body.system, /call web_search/);
  assert.match(body.system, /pinned ICM skill/);
  assert.match(body.system, /coding_task_submit attaches ECC guidance/);
  assert.match(body.system, /scheduled run cannot approve a coding task/);
  assert.match(body.system, /memory\/accepted-facts\.md and next-step\.md/);
  assert.match(body.system, /application notice says a fact was not stored/);
  assert.match(body.system, /not stored until memory_write succeeds/);
  assert.match(body.system, /do not invent a security-hook result/);
  const chat = readFileSync("server/chief/managed/chatTurn.js", "utf8");
  assert.equal(chat.includes("rememberExchange"), false);
});

test("a fully stated remember stores the fact, and a retry does not write it twice", async () => {
  const facts = new MemoryFactStore();
  let writes = 0;
  const write = facts.write.bind(facts);
  facts.write = async (input) => {
    writes += 1;
    return write(input);
  };
  const first = await say(facts, "Chief, remember that I prefer short answers.");
  assert.match(sentText(first.client), /Accepted memory now includes \\"I prefer short answers\\"/);
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "I prefer short answers");
  assert.equal(rows[0].trustTier, "AUTO");
  assert.equal(writes, 1);

  await runManagedChiefTurn({
    userId: "user-a",
    sessionId: (await first.store.listOwnedSessions("user-a"))[0].id,
    submission: {
      id: "s2",
      op: { type: "message", message: { text: "Chief, remember that I prefer short answers." } },
    },
    store: first.store,
    client: first.client,
    jobs: createMemoryWorkQueue(),
    factStore: facts,
    documentStore: first.documents,
    toolExecutor: new ToolExecutor(),
  });
  assert.equal(writes, 1);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 1);
});

test("remember this keeps the referenced decision and does not store the meta phrase", async () => {
  const decision = "I decided the feeder stays manual.";
  const resolved = resolveRememberedFact("Chief, remember this decision for future conversations.", [
    { role: "user", content: decision },
    { role: "user", content: "Chief, remember this decision for future conversations." },
  ]);
  assert.equal(resolved.content, decision);
  const facts = new MemoryFactStore();
  const turn = await say(facts, "Chief, remember this decision for future conversations.", {
    transcript: [{ role: "user", content: decision }],
  });
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, decision);
  assert.equal(
    rows.some((row) => /remember this decision/i.test(row.content)),
    false
  );
  assert.match(sentText(turn.client), /feeder stays manual/);
});

test("an ambiguous remember is not stored and the model is told to say so", async () => {
  const facts = new MemoryFactStore();
  const turn = await say(facts, "Remember this.", {
    transcript: [
      {
        role: "assistant",
        content: "I decided the feeder stays manual. I prefer short answers.",
      },
    ],
  });
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);
  assert.match(sentText(turn.client), /Not stored\. The request did not identify one specific fact/);
  assert.match(sentText(turn.client), /Do not say it was remembered/);

  const none = await planUserMemory({
    facts,
    userId: "user-a",
    userText: "Remember this.",
    transcript: [],
  });
  assert.equal(none.stored, false);
  assert.equal(none.action, "clarify");
});

test("a durable preference is noticed and left unstored until memory_write is approved", async () => {
  const facts = new MemoryFactStore();
  const turn = await say(facts, "I prefer brief status notes.");
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);
  assert.match(sentText(turn.client), /Not stored/);
  assert.match(sentText(turn.client), /Call memory_write/);
  assert.match(sentText(turn.client), /Do not mark it trusted/);
  const tools = createChiefTools({ facts });
  const write = tools.find((tool) => tool.spec.name === "memory_write");
  const trusted = await write.execute(
    { content: "I prefer brief status notes.", trust: "trusted" },
    { userId: "user-a" }
  );
  assert.equal(trusted.isError, true);
  assert.match(trusted.output, /cannot be promoted to trusted/);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);

  const existing = new MemoryFactStore();
  await existing.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const proposal = await planUserMemory({
    facts: existing,
    userId: "user-a",
    userText: "I prefer long morning reports.",
  });
  assert.equal(proposal.stored, false);
  assert.match(proposal.notice, /only after that approval/);
  const still = await existing.read({ userId: "user-a", limit: 10 });
  assert.equal(still.length, 1);
  assert.equal(still[0].content, "I prefer short morning reports.");
});

test("a correction supersedes one fact, and an ambiguous correction does not", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  await facts.write({
    userId: "user-b",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const corrected = await planUserMemory({
    facts,
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(corrected.stored, true);
  assert.equal(corrected.action, "correct");
  const mine = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].content, "I prefer long morning reports");
  const theirs = await facts.read({ userId: "user-b", limit: 10 });
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].content, "I prefer short morning reports.");

  const ambiguous = new MemoryFactStore();
  await ambiguous.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  await ambiguous.write({
    userId: "user-a",
    content: "I prefer short evening reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const blocked = await planUserMemory({
    facts: ambiguous,
    userId: "user-a",
    userText: "Correct that I prefer long morning reports.",
  });
  assert.equal(blocked.action, "clarify");
  assert.equal(blocked.stored, false);
  const unchanged = await ambiguous.read({ userId: "user-a", limit: 10 });
  assert.equal(unchanged.length, 2);
});

test("a forgotten fact stays forgotten across recovery and a later import", async () => {
  const facts = new MemoryFactStore();
  const remembered = await planUserMemory({
    facts,
    userId: "user-a",
    userText: "Remember that I prefer short answers.",
  });
  assert.equal(remembered.stored, true);
  const forgotten = await planUserMemory({
    facts,
    userId: "user-a",
    userText: "Forget that I prefer short answers.",
  });
  assert.equal(forgotten.action, "forget");
  assert.equal(forgotten.deleted, 1);
  const visible = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(visible.length, 0);
  const recovered = recoveryDocuments({ documents: [], facts: visible });
  const file = recovered.files.find((item) => item.path === "memory/accepted-facts.md");
  assert.equal(file.content.includes("I prefer short answers"), false);
  assert.equal(acceptedFactsDocument(visible).includes("I prefer short answers"), false);

  const again = await facts.write({
    userId: "user-a",
    content: "I prefer short answers",
    trustTier: "AUTO",
    source: "preference",
  });
  assert.equal(again.forgotten, true);
  const imported = await retainConversationMemories({
    facts,
    userId: "user-a",
    provider: "chief",
    conversationId: "session-1",
    messages: [{ role: "user", content: "I prefer short answers" }],
  });
  assert.equal(imported.retained, 0);
  assert.equal(imported.duplicate, 1);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);

  const tools = createChiefTools({ facts });
  const write = tools.find((tool) => tool.spec.name === "memory_write");
  const toolResult = await write.execute(
    { content: "I prefer short answers" },
    { userId: "user-a" }
  );
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.output, /forgotten/);
});

test("a stored fact is available in a later session, and another user's fact is not", async () => {
  const facts = new MemoryFactStore();
  await say(facts, "Chief, remember that I prefer short answers.");
  await facts.write({
    userId: "user-b",
    content: "I prefer long board reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const documents = createMemoryWorkspaceDocumentStore();
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ text: "Short answer." }]);
  await runManagedChiefTurn({
    userId: "user-a",
    submission: { id: "s3", op: { type: "message", message: { text: "What should the update look like?" } } },
    store,
    client,
    jobs: createMemoryWorkQueue(),
    factStore: facts,
    documentStore: documents,
    toolExecutor: new ToolExecutor(),
  });
  const mounted = JSON.stringify(client.state.memories);
  assert.match(mounted, /I prefer short answers/);
  assert.equal(mounted.includes("long board reports"), false);
  const recovered = recoveryDocuments({
    documents: await documents.list("user-a"),
    facts: await facts.read({ userId: "user-a", limit: 20 }),
  });
  const accepted = recovered.files.find((item) => item.path === "memory/accepted-facts.md");
  assert.match(accepted.content, /I prefer short answers/);
  assert.equal(accepted.content.includes("long board reports"), false);
});

test("a failed write is reported as not stored", async () => {
  const facts = new MemoryFactStore();
  facts.write = async () => {
    throw new Error("database unavailable");
  };
  const turn = await say(facts, "Chief, remember that I prefer short answers.");
  assert.match(sentText(turn.client), /Not stored\. Persistence failed/);
  assert.match(sentText(turn.client), /Do not tell the user this was remembered/);
  assert.equal(facts.rows.length, 0);

  const planned = await planUserMemory({
    facts: {
      async read() {
        throw new Error("database unavailable");
      },
    },
    userId: "user-a",
    userText: "I prefer brief status notes.",
  });
  assert.equal(planned.stored, false);
  assert.match(planned.notice, /Persistence failed/);
});

test("a failed instead-of correction keeps the previous fact and does not revive a forgotten one", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const write = facts.write.bind(facts);
  facts.write = async () => {
    throw new Error("database unavailable");
  };
  const failed = await planUserMemory({
    facts,
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(failed.stored, false);
  assert.match(failed.notice, /Persistence failed/);
  const kept = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, "I prefer short morning reports.");

  facts.write = write;
  await facts.write({
    userId: "user-a",
    content: "I prefer long morning reports",
    trustTier: "AUTO",
    source: "preference",
  });
  await facts.forget({ userId: "user-a", content: "I prefer long morning reports" });
  const blocked = await planUserMemory({
    facts,
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(blocked.stored, false);
  assert.equal(blocked.reason, "forgotten");
  const still = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(still.length, 1);
  assert.equal(still[0].content, "I prefer short morning reports.");
  const revived = await facts.write({
    userId: "user-a",
    content: "I prefer long morning reports",
    trustTier: "AUTO",
    source: "preference",
  });
  assert.equal(revived.forgotten, true);

  const narrowed = new MemoryFactStore();
  await narrowed.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const replaced = await planUserMemory({
    facts: narrowed,
    userId: "user-a",
    userText: "Correct that I prefer long morning reports instead of morning reports.",
  });
  assert.equal(replaced.action, "correct");
  const visible = await narrowed.read({ userId: "user-a", limit: 10 });
  assert.deepEqual(
    visible.map((row) => row.content),
    ["I prefer long morning reports"]
  );
});

test("a correction without the atomic replace forgets the previous fact only after the write", async () => {
  const previous = {
    id: "old",
    userId: "user-a",
    content: "I prefer short morning reports.",
    dedupeKey: factDedupeKey("I prefer short morning reports."),
    source: "preference",
    deletedAt: null,
  };
  let forgot = false;
  const failed = await planUserMemory({
    facts: {
      async read() {
        return [previous];
      },
      async write() {
        throw new Error("database unavailable");
      },
      async forget() {
        forgot = true;
        return { deleted: 1 };
      },
    },
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(forgot, false);
  assert.match(failed.notice, /Persistence failed/);

  const rows = [previous];
  const stored = await planUserMemory({
    facts: {
      async read() {
        return rows.filter((row) => !row.deletedAt);
      },
      async write({ content }) {
        const row = {
          id: "new",
          userId: "user-a",
          content,
          dedupeKey: factDedupeKey(content),
          source: "preference",
          deletedAt: null,
        };
        rows.push(row);
        return row;
      },
      async forget({ id }) {
        const row = rows.find((item) => item.id === id && !item.deletedAt);
        if (!row) return { deleted: 0 };
        row.deletedAt = new Date();
        return { deleted: 1 };
      },
    },
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(stored.action, "correct");
  assert.equal(rows.find((row) => row.id === "new").deletedAt, null);
  assert.ok(rows.find((row) => row.id === "old").deletedAt);
});

test("postgres replacement keeps the previous fact when the insert fails", async () => {
  const rows = [];
  let seq = 0;
  const tx = {
    chiefFact: {
      async findUnique({ where }) {
        const key = where.userId_dedupeKey;
        return (
          rows.find((row) => row.userId === key.userId && row.dedupeKey === key.dedupeKey) || null
        );
      },
      async findMany({ where }) {
        return rows.filter((row) => row.userId === where.userId && row.deletedAt == null);
      },
      async count({ where }) {
        return rows.filter((row) => row.userId === where.userId && row.deletedAt == null).length;
      },
      async create({ data }) {
        const row = {
          id: `fact-${(seq += 1)}`,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows) {
          if (row.userId !== where.userId || row.deletedAt) continue;
          if (where.id?.in && !where.id.in.includes(row.id)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  let transactions = 0;
  const store = new PrismaFactStore({
    async withUser(_userId, fn) {
      transactions += 1;
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        return await fn(tx);
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    },
    encrypt: (value) => `sealed:${value}`,
    decrypt: (value) => String(value).slice("sealed:".length),
  });
  await store.write({
    userId: "user-a",
    content: "I prefer short morning reports.",
    trustTier: "AUTO",
    source: "preference",
  });
  const before = transactions;
  const create = tx.chiefFact.create.bind(tx.chiefFact);
  tx.chiefFact.create = async (input) => {
    await create(input);
    throw new Error("database unavailable");
  };
  const failed = await planUserMemory({
    facts: store,
    userId: "user-a",
    userText:
      "Correct that I prefer long morning reports instead of I prefer short morning reports.",
  });
  assert.equal(failed.stored, false);
  assert.match(failed.notice, /Persistence failed/);
  assert.equal(transactions, before + 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deletedAt, null);
  assert.equal(store._decrypt(rows[0].contentCiphertext), "I prefer short morning reports.");
});

test("remember this keeps a user fact or a confirmed decision, and drops assistant guesses", async () => {
  const decision = "I decided the feeder stays manual.";
  const recommendation = "I recommend keeping the feeder manual.";
  const guess = "I think the feeder should stay manual.";
  const confirmed = "We decided the feeder stays manual.";

  const authored = resolveRememberedFact("Remember this.", [
    { role: "assistant", content: recommendation },
    { role: "user", content: decision },
  ]);
  assert.equal(authored.content, decision);

  const unconfirmed = resolveRememberedFact("Remember this.", [
    { role: "user", content: decision },
    { role: "assistant", content: recommendation },
  ]);
  assert.equal(unconfirmed.clarify, true);
  assert.equal(unconfirmed.content, "");

  const guessed = resolveRememberedFact("Remember this.", [
    { role: "assistant", content: guess },
    { role: "user", content: "Yes." },
  ]);
  assert.equal(guessed.clarify, true);

  const accepted = resolveRememberedFact("Remember this.", [
    { role: "assistant", content: confirmed },
    { role: "user", content: "Yes, that's correct." },
  ]);
  assert.equal(accepted.content, confirmed);

  const mixed = resolveRememberedFact("Remember this.", [
    { role: "assistant", content: `${confirmed} ${recommendation}` },
    { role: "user", content: "Yes." },
  ]);
  assert.equal(mixed.clarify, true);

  const facts = new MemoryFactStore();
  const stored = await planUserMemory({
    facts,
    userId: "user-a",
    userText: "Remember this.",
    transcript: [
      { role: "assistant", content: confirmed },
      { role: "user", content: "Yes, that's correct." },
      { role: "user", content: "Remember this." },
    ],
  });
  assert.equal(stored.stored, true);
  assert.equal((await facts.read({ userId: "user-a", limit: 5 }))[0].content, confirmed);

  const rejected = await planUserMemory({
    facts: new MemoryFactStore(),
    userId: "user-a",
    userText: "Remember this.",
    transcript: [
      { role: "assistant", content: recommendation },
      { role: "user", content: "Remember this." },
    ],
  });
  assert.equal(rejected.stored, false);
  assert.equal(rejected.action, "clarify");

  const live = new MemoryFactStore();
  const turn = await say(live, "Remember this.", {
    transcript: [{ role: "assistant", content: `${guess} ${recommendation}` }],
  });
  assert.equal((await live.read({ userId: "user-a", limit: 5 })).length, 0);
  assert.match(sentText(turn.client), /Not stored/);
});

test("a scheduled turn does not store a remember command", async () => {
  const facts = new MemoryFactStore();
  const turn = await say(facts, "Chief, remember that I prefer short answers.", { schedule: true });
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);
  assert.equal(sentText(turn.client).includes("Stored."), false);
});
