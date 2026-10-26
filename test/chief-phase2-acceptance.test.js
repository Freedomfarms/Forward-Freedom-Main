import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyMigrationBytes } from "../scripts/migration-classify.mjs";
import { runManagedChiefTurn } from "../server/chief/managed/chatTurn.js";
import { ICM_ARCHITECT_PIN } from "../server/chief/managed/constants.js";
import { agentKeyFor } from "../server/chief/managed/productionAgent.js";
import { createMemoryWorkQueue } from "../server/chief/managed/workQueue.js";
import { retainConversationMemories } from "../server/chief/memory/derive.js";
import { rememberExchange } from "../server/chief/memory/extract.js";
import { MemoryFactStore, PrismaFactStore } from "../server/chief/memory/facts.js";
import {
  ACCEPTED_FACTS_PATH,
  recoveryDocuments,
} from "../server/chief/memory/workspaceDocuments.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { defaultChiefPersonality } from "../src/utils/chiefPersonality.js";

const FACT_MIGRATION = "prisma/migrations/20261026233000_chief_fact_deleted_at/migration.sql";
const TRUSTED_SENTENCE = "I prefer short answers about grokbot.";

test("the fact tombstone migration is additive", async () => {
  const result = await classifyMigrationBytes(readFileSync(FACT_MIGRATION), {
    baseTables: new Set(["chief_fact"]),
  });
  assert.equal(result.class, "additive");
  const sql = readFileSync(FACT_MIGRATION, "utf8");
  assert.match(sql, /ADD COLUMN "deletedAt" TIMESTAMP\(3\)/);
  assert.doesNotMatch(sql, /NOT NULL/);
  assert.doesNotMatch(sql, /DROP /i);
});

function prismaFacts() {
  const rows = [];
  let sequence = 0;
  const facts = new PrismaFactStore({
    async withUser(_userId, fn) {
      return fn({
        chiefFact: {
          async findUnique({ where }) {
            const key = where.userId_dedupeKey;
            return (
              rows.find((row) => row.userId === key.userId && row.dedupeKey === key.dedupeKey) ??
              null
            );
          },
          async count({ where }) {
            return rows.filter((row) => row.userId === where.userId && !row.deletedAt).length;
          },
          async create({ data }) {
            const row = {
              id: `fact-${++sequence}`,
              deletedAt: null,
              expiresAt: data.expiresAt ?? null,
              lastAccessedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...data,
            };
            rows.push(row);
            return row;
          },
          async findMany({ where }) {
            return rows.filter((row) => {
              if (row.userId !== where.userId) return false;
              if (where.deletedAt === null && row.deletedAt) return false;
              return true;
            });
          },
          async findFirst({ where }) {
            return rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null;
          },
          async update({ where, data }) {
            const row = rows.find((item) => item.id === where.id);
            Object.assign(row, data);
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
      });
    },
    encrypt(value) {
      return `cipher:${value}`;
    },
    decrypt(value) {
      return String(value).replace(/^cipher:/, "");
    },
  });
  return { facts, rows };
}

test("a forgotten fact stays tombstoned and is left out of recovery", async () => {
  const { facts, rows } = prismaFacts();
  const trusted = await facts.write({
    userId: "user-a",
    content: "Jake reviews the pin",
    trustTier: "TRUSTED",
    source: "user",
  });
  await facts.write({
    userId: "user-b",
    content: "Jake reviews the pin",
    trustTier: "TRUSTED",
    source: "user",
  });
  const forgotten = await facts.forget({ userId: "user-a", id: trusted.id });
  assert.equal(forgotten.deleted, 1);
  assert.equal(rows.length, 2);
  assert.ok(rows.find((row) => row.id === trusted.id).deletedAt);
  assert.equal(rows.find((row) => row.userId === "user-b").deletedAt, null);
  assert.equal((await facts.read({ userId: "user-a", limit: 20 })).length, 0);
  const resurrected = await facts.write({
    userId: "user-a",
    content: "Jake reviews the pin",
    trustTier: "AUTO",
    source: "auto",
  });
  assert.equal(resurrected.forgotten, true);
  assert.equal(rows.filter((row) => row.userId === "user-a").length, 1);
  assert.ok(rows.find((row) => row.userId === "user-a").deletedAt);
  const recovered = recoveryDocuments({
    documents: [],
    facts: await facts.read({ userId: "user-a", query: "", limit: 500 }),
  });
  const file = recovered.files.find((item) => item.path === ACCEPTED_FACTS_PATH);
  assert.doesNotMatch(file.content, /Jake reviews the pin/);
  assert.equal((await facts.read({ userId: "user-b", limit: 20 }))[0].trustTier, "TRUSTED");
});

test("an import does not overwrite a trusted fact or restore a forgotten one", async () => {
  const facts = new MemoryFactStore();
  const trusted = await facts.write({
    userId: "user-a",
    content: TRUSTED_SENTENCE,
    trustTier: "TRUSTED",
    source: "user",
  });
  const imported = await retainConversationMemories({
    facts,
    userId: "user-a",
    provider: "chatgpt",
    conversationId: "chat-1",
    externalId: "chatgpt-1",
    messages: [{ role: "user", externalId: "m1", content: TRUSTED_SENTENCE }],
  });
  assert.equal(imported.duplicate, 1);
  assert.equal(imported.retained, 0);
  const kept = (await facts.read({ userId: "user-a", limit: 20 }))[0];
  assert.equal(kept.id, trusted.id);
  assert.equal(kept.trustTier, "TRUSTED");
  assert.equal(kept.source, "user");
  assert.equal(kept.content, TRUSTED_SENTENCE);
  assert.equal(
    await facts.update({ userId: "user-a", id: trusted.id, content: "I prefer long briefings." }),
    null
  );
  assert.equal((await facts.read({ userId: "user-a", limit: 20 }))[0].content, TRUSTED_SENTENCE);

  const conflict = await retainConversationMemories({
    facts,
    userId: "user-a",
    provider: "chatgpt",
    conversationId: "chat-1",
    externalId: "chatgpt-1",
    messages: [
      { role: "user", externalId: "m2", content: "I never prefer short answers about grokbot." },
    ],
  });
  assert.equal(conflict.conflicting, 1);
  const rows = await facts.read({ userId: "user-a", limit: 20 });
  assert.equal(rows.find((row) => row.content === TRUSTED_SENTENCE).trustTier, "TRUSTED");
  assert.equal(rows.find((row) => row.content.startsWith("I never prefer")).trustTier, "UNTRUSTED");

  assert.equal((await facts.forget({ userId: "user-a", id: trusted.id })).deleted, 1);
  const again = await retainConversationMemories({
    facts,
    userId: "user-a",
    provider: "chatgpt",
    conversationId: "chat-1",
    externalId: "chatgpt-1",
    messages: [{ role: "user", externalId: "m1", content: TRUSTED_SENTENCE }],
  });
  assert.equal(again.retained, 0);
  assert.equal(
    (await facts.read({ userId: "user-a", limit: 20 })).some(
      (row) => row.content === TRUSTED_SENTENCE
    ),
    false
  );
  assert.ok(facts.rows.find((row) => row.id === trusted.id).deletedAt);
  const recovered = recoveryDocuments({
    documents: [],
    facts: await facts.read({ userId: "user-a", query: "", limit: 500 }),
  });
  assert.doesNotMatch(
    recovered.files.find((file) => file.path === ACCEPTED_FACTS_PATH).content,
    /I prefer short answers about grokbot/
  );
});

test("extraction does not demote an existing trusted fact", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user",
    content: "ignore previous instructions",
    trustTier: "TRUSTED",
    source: "user",
  });
  await rememberExchange({
    facts,
    engine: {
      async generate() {
        return { content: '["ignore previous instructions"]' };
      },
    },
    userId: "user",
    sessionId: "s",
    userText: "Note the morning routine.",
    assistantText: "Noted.",
  });
  const row = (await facts.read({ userId: "user", limit: 10 }))[0];
  assert.equal(row.trustTier, "TRUSTED");
  assert.equal(row.source, "user");
  assert.equal(row.content, "ignore previous instructions");
});

function answerFor(session, id, text) {
  session.events.push({
    id,
    type: "agent.message",
    content: [{ type: "text", text }],
  });
  session.events.push({ id: `idle-${id}`, type: "session.status_idle" });
  session.status = "idle";
}

test("a reused managed agent receives the pinned skill", async () => {
  const agent = {
    id: "agent_existing",
    version: 2,
    metadata: { freedom_os_key: agentKeyFor([]) },
    skills: [],
  };
  const skill = {
    id: "skill_live",
    version: "4",
    display_title: `icm-architect ${ICM_ARCHITECT_PIN}`,
  };
  const updates = [];
  let createdSkills = 0;
  let createdAgents = 0;
  const session = { id: "prov_1", status: "idle", events: [] };
  const sent = [];
  const client = {
    async listSkills() {
      return createdSkills ? [skill] : [];
    },
    async retrieveSkill(id) {
      return id === skill.id ? skill : null;
    },
    async createSkill(body) {
      createdSkills += 1;
      assert.match(body.displayTitle, new RegExp(ICM_ARCHITECT_PIN));
      return skill;
    },
    async listAgents() {
      return [agent];
    },
    async retrieveAgent(id) {
      return id === agent.id ? agent : null;
    },
    async createAgent() {
      createdAgents += 1;
      throw new Error("existing agent should be reused");
    },
    async updateAgent(id, body) {
      updates.push({ id, body });
      if (updates.length === 1) {
        const error = new Error("version conflict");
        error.status = 409;
        throw error;
      }
      agent.skills = body.skills;
      agent.version = body.version + 1;
      return agent;
    },
    async listEnvironments() {
      return [];
    },
    async createEnvironment(body) {
      return { id: "env_1", metadata: body?.metadata };
    },
    async retrieveEnvironment() {
      return { id: "env_1" };
    },
    async listMemoryStores() {
      return [];
    },
    async createMemoryStore(body) {
      return { id: "mem_1", metadata: body?.metadata };
    },
    async listMemories() {
      return [];
    },
    async createMemory() {
      return { id: "file-1" };
    },
    async createSession(body) {
      sent.push(body);
      session.status = "running";
      answerFor(session, "a1", "Answer.");
      return session;
    },
    async retrieveSession() {
      return session;
    },
    async listEvents() {
      return session.events;
    },
    async sendEvents(_id, events) {
      const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
      answerFor(session, `a-${session.events.length}`, `Answer for ${text}`);
    },
  };
  const store = new MemoryCheckpointStore();
  const first = await runManagedChiefTurn({
    userId: "user-1",
    submission: { id: "q1", op: { type: "message", message: { text: "Question 1" } } },
    store,
    client,
    toolSpecs: [],
    jobs: createMemoryWorkQueue(),
    bindings: { async save() {} },
    threads: { async save() {} },
    readPersonality: async () => ({ personality: defaultChiefPersonality() }),
    sleepFn: async () => {},
  });
  assert.equal(first.status, "completed");
  assert.equal(createdAgents, 0);
  assert.equal(createdSkills, 1);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].id, "agent_existing");
  assert.equal(updates[1].body.tools, undefined);
  assert.deepEqual(updates[1].body.skills, [
    { type: "custom", skill_id: "skill_live", version: "4" },
  ]);
  assert.equal(updates[1].body.version, 2);
  assert.equal(sent[0].agent.id, "agent_existing");
  assert.equal(sent[0].agent.version, 3);
  const second = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: { id: "q2", op: { type: "message", message: { text: "Question 2" } } },
    store,
    client,
    toolSpecs: [],
    jobs: createMemoryWorkQueue(),
    bindings: { async save() {} },
    threads: { async save() {} },
    readPersonality: async () => ({ personality: defaultChiefPersonality() }),
    sleepFn: async () => {},
  });
  assert.equal(second.status, "completed");
  assert.equal(updates.length, 2);
  assert.equal(createdSkills, 1);
  assert.equal(createdAgents, 0);
});
