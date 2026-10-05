// The memory seam delegates to chief_fact and recall documents.
// It does not add a store, a second provider, or a live-tool write path.

import test from "node:test";
import assert from "node:assert/strict";

import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { applyMemoryCommands } from "../server/chief/memory/commands.js";
import { MemoryFactStore, PrismaFactStore } from "../server/chief/memory/facts.js";
import { NativeMemoryProvider } from "../server/chief/memory/native.js";
import { createMemoryAccess, openMemoryAccess } from "../server/chief/memory/provider.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";

function event(fields = {}) {
  return {
    userId: "user-a",
    source: "user",
    kind: "explicit",
    text: "I prefer short answers",
    occurredAt: new Date("2026-10-05T00:00:00.000Z"),
    sessionId: "session-a",
    agentId: null,
    trust: "AUTO",
    ...fields,
  };
}

test("the native provider is available from local fact methods only", () => {
  let calls = 0;
  const facts = {
    read() {
      calls += 1;
      return [];
    },
    write() {
      calls += 1;
    },
    forget() {
      calls += 1;
    },
  };
  const provider = new NativeMemoryProvider({ facts });
  assert.equal(provider.isAvailable(), true);
  assert.equal(calls, 0);
  assert.equal(new NativeMemoryProvider({}).isAvailable(), false);
  const access = createMemoryAccess({ facts });
  assert.equal(access.isAvailable(), true);
  assert.equal(calls, 0);
});

test("remember, search, and forget delegate to the fact store", async () => {
  const facts = new MemoryFactStore();
  const provider = new NativeMemoryProvider({ facts });
  const remembered = await provider.remember(event());
  assert.equal(remembered.stored, true);
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, remembered.id);
  assert.equal(rows[0].source, "preference");
  assert.equal(rows[0].trustTier, "AUTO");

  const found = await provider.search("short answers", {
    userId: "user-a",
    layers: ["PERSONAL"],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].layer, "PERSONAL");
  assert.equal(found[0].text, "I prefer short answers");
  assert.equal(found[0].sourceId, remembered.id);
  assert.equal(typeof found[0].score, "number");

  const forgotten = await provider.forget({ userId: "user-a", content: "short answers" });
  assert.equal(forgotten.deleted, 1);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);
});

test("memory stays inside the owning user and the encrypting fact store", async () => {
  const facts = new MemoryFactStore();
  const provider = new NativeMemoryProvider({ facts });
  await provider.remember(event());
  await provider.remember(event({ userId: "user-b", text: "I prefer long briefings" }));
  const own = await provider.search("answers", { userId: "user-a", layers: ["PERSONAL"] });
  const other = await provider.search("briefings", { userId: "user-b", layers: ["PERSONAL"] });
  assert.equal(own.length, 1);
  assert.match(own[0].text, /short answers/);
  assert.equal(other.length, 1);
  assert.match(other[0].text, /long briefings/);
  assert.equal((await provider.forget({ userId: "user-b", content: "short answers" })).deleted, 0);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 1);

  const written = [];
  const prismaFacts = new PrismaFactStore({
    async withUser(_userId, run) {
      return run({
        chiefFact: {
          async findUnique() {
            return null;
          },
          async count() {
            return 0;
          },
          async create({ data }) {
            written.push(data);
            return {
              id: "fact-1",
              dedupeKey: data.dedupeKey,
              trustTier: data.trustTier,
              source: data.source,
              importance: data.importance,
              confidence: data.confidence,
              expiresAt: null,
              lastAccessedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
        },
      });
    },
    encrypt(value) {
      return `cipher:${value}`;
    },
    decrypt(value) {
      return String(value).replace(/^cipher:/, "");
    },
  });
  const encrypted = new NativeMemoryProvider({ facts: prismaFacts });
  const stored = await encrypted.remember(event());
  assert.equal(stored.id, "fact-1");
  assert.equal(written[0].userId, "user-a");
  assert.equal(written[0].contentCiphertext, "cipher:I prefer short answers");
  assert.equal(written[0].content, undefined);
});

test("a provider failure returns nothing and does not invent memory", async () => {
  const facts = {
    async read() {
      throw new Error("fact store down");
    },
    async write() {
      throw new Error("fact store down");
    },
    async forget() {
      throw new Error("fact store down");
    },
  };
  const memory = createMemoryAccess({ facts });
  assert.deepEqual(await memory.search("well", { userId: "user-a", layers: ["PERSONAL"] }), []);
  assert.deepEqual(await memory.remember(event()), { stored: false, reason: "unavailable" });
  assert.deepEqual(await memory.forget({ userId: "user-a", content: "short answers" }), {
    deleted: 0,
  });

  let calls = 0;
  const closed = openMemoryAccess({
    isAvailable() {
      return false;
    },
    remember() {
      calls += 1;
      throw new Error("should not run");
    },
    search() {
      calls += 1;
      throw new Error("should not run");
    },
    forget() {
      calls += 1;
      throw new Error("should not run");
    },
  });
  assert.equal(closed.isAvailable(), false);
  assert.deepEqual(await closed.remember(event()), { stored: false, reason: "unavailable" });
  assert.deepEqual(await closed.search("well", { userId: "user-a" }), []);
  assert.deepEqual(await closed.forget({ userId: "user-a", id: "x" }), { deleted: 0 });
  assert.equal(calls, 0);
});

test("live tool results are not written, and search keeps the three layers apart", async () => {
  const facts = new MemoryFactStore();
  const episodes = new MemoryCheckpointStore();
  const provider = new NativeMemoryProvider({ facts, episodes });
  const live = [
    event({ source: "finance_summary", kind: "tool", text: "User owns 59000 XRP" }),
    event({ source: "calendar", kind: "calendar", text: "Free at 3 PM tomorrow" }),
    event({ source: "email", kind: "email", text: "Inbox has four unread notes" }),
    event({ source: "web_search", kind: "web", text: "XRP price today is 2 dollars" }),
    event({ source: "codebase", kind: "code", text: "finance access lives in reader.js" }),
    event({ source: "user", kind: "personal", text: "User owns 59000 XRP" }),
  ];
  for (const item of live) {
    const result = await provider.remember(item);
    assert.equal(result.stored, false);
  }
  assert.equal((await facts.read({ userId: "user-a", limit: 20 })).length, 0);

  await facts.write({
    userId: "user-a",
    content: "User owns 59000 XRP",
    trustTier: "AUTO",
    source: "user",
  });
  await facts.write({
    userId: "user-a",
    content: "I prefer short answers",
    trustTier: "AUTO",
    source: "preference",
  });
  const finance = await provider.search("How much XRP do I own?", {
    userId: "user-a",
    layers: ["PERSONAL"],
  });
  assert.equal(
    finance.some((hit) => /59000/.test(hit.text)),
    false
  );
  assert.equal(
    finance.some((hit) => hit.layer === "PERSONAL" && hit.text === "I prefer short answers"),
    true
  );

  const owned = await episodes.createSession({ userId: "user-a" });
  const current = await episodes.createSession({ userId: "user-a" });
  const other = await episodes.createSession({ userId: "user-b" });
  await episodes.setRecallDocument("user-a", owned.id, [
    { role: "user", content: "Freedom Financial read access was disabled." },
    { role: "assistant", content: "Turn the finance reader on." },
  ]);
  await episodes.setRecallDocument("user-a", current.id, [
    { role: "user", content: "Freedom Financial read access was disabled." },
  ]);
  await episodes.setRecallDocument("user-b", other.id, [
    { role: "user", content: "Freedom Financial read access was disabled." },
  ]);
  const past = await provider.search("why can't you see my finances?", {
    userId: "user-a",
    layers: ["EPISODIC"],
    sessionId: current.id,
  });
  assert.equal(past.length, 1);
  assert.equal(past[0].layer, "EPISODIC");
  assert.equal(past[0].sourceId, owned.id);
  assert.match(past[0].text, /Freedom Financial read access/);

  const working = await provider.search("What's it worth?", {
    userId: "user-a",
    layers: ["WORKING", "PERSONAL", "EPISODIC"],
    sessionId: "open",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "user", content: "What's it worth?" },
    ],
  });
  const layers = new Set(working.map((hit) => hit.layer));
  assert.equal(layers.has("WORKING"), true);
  assert.match(working.find((hit) => hit.layer === "WORKING").text, /refer to XRP/);
  assert.equal(working.find((hit) => hit.layer === "WORKING").sourceId, "open");
  assert.equal(
    working.some((hit) => hit.layer === "EPISODIC"),
    false
  );
});

test("explicit remember and forget keep the fact-store result", async () => {
  const facts = new MemoryFactStore();
  const provider = new NativeMemoryProvider({ facts });
  const remembered = await applyMemoryCommands({
    facts,
    provider,
    userId: "user-a",
    userText: "Chief, remember that I prefer short answers.",
  });
  assert.equal(remembered.action, "remember");
  const direct = await applyMemoryCommands({
    facts,
    userId: "user-a",
    userText: "Remember that I prefer short answers.",
  });
  assert.equal(direct.action, "remember");
  assert.equal(direct.id, remembered.id);

  const secret = await applyMemoryCommands({
    facts,
    provider,
    userId: "user-a",
    userText: "Remember that the password is hunter2.",
  });
  assert.equal(secret.action, "rejected");
  assert.equal(secret.reason, "not-durable");

  const forgotten = await applyMemoryCommands({
    facts,
    provider,
    userId: "user-a",
    userText: "Forget that I prefer short answers.",
  });
  assert.equal(forgotten.action, "forget");
  assert.equal(forgotten.deleted, 1);
  assert.equal((await facts.read({ userId: "user-a", limit: 10 })).length, 0);
});

test("a turn has one native provider and no private memory rows", async () => {
  const facts = new MemoryFactStore();
  const checkpointStore = new MemoryCheckpointStore();
  assert.throws(() => createMemoryAccess({ facts, providers: [] }), /only one memory provider/);
  for (const name of ["honcho", "hindsight", "mem0"]) {
    assert.throws(() => createMemoryAccess({ facts, provider: name }), /only one memory provider/);
  }
  const services = createChiefTurnServices({
    facts,
    engine: {
      async generate() {
        return { content: '["Rises at dawn", "User owns 59000 XRP"]' };
      },
    },
    checkpointStore,
  });
  assert.equal(services.memory.provider.name, "native");
  assert.equal(services.memory.provider instanceof NativeMemoryProvider, true);
  assert.equal(services.memory.providers, undefined);
  assert.equal(Object.hasOwn(services.memory.provider, "rows"), false);

  await services.onTurnComplete({
    userId: "user-a",
    sessionId: "session-a",
    userText: "Remember that I prefer short answers.",
    assistantText: "Noted.",
  });
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(
    rows.some((row) => row.content === "I prefer short answers"),
    true
  );
  assert.equal(
    rows.some((row) => row.content === "Rises at dawn"),
    true
  );
  assert.equal(
    rows.some((row) => /59000/.test(row.content)),
    false
  );
  const found = await services.memory.search("dawn", { userId: "user-a", layers: ["PERSONAL"] });
  assert.equal(
    found.some((hit) => hit.text === "Rises at dawn" && hit.layer === "PERSONAL"),
    true
  );
});
