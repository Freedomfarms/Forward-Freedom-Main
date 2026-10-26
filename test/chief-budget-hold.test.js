import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Client } from "pg";

import { createCursorCloudRuntime } from "../server/chief/agents/cursorCloud.js";
import {
  CODING_EXECUTION_SCOPE,
  ExecutionState,
  createMemoryExecutionStore,
} from "../server/chief/agents/ledger.js";
import { attributeActual, releaseHold, reserveHold } from "../server/chief/models/budget.js";
import { classifyMigrationBytes } from "../scripts/migration-classify.mjs";
import { databaseUrl, disposableAdminUrl } from "./disposable-postgres.js";

const MIGRATION = "prisma/migrations/20261026180000_chief_budget_hold/migration.sql";

function seal(value) {
  return `sealed:${Buffer.from(String(value), "utf8").toString("base64")}`;
}

function open(value) {
  return Buffer.from(String(value).slice("sealed:".length), "base64").toString("utf8");
}

async function withBudgetDb(run) {
  const adminUrl = await disposableAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `budget_hold_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = databaseUrl(adminUrl, name);
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`
    CREATE TABLE "chief_budget" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "scope" TEXT NOT NULL,
      "periodType" TEXT NOT NULL,
      "capUsd" DECIMAL(12,6) NOT NULL,
      "spentUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await run(client, url);
  } finally {
    await client.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
}

test("the budget hold migration is an additive create table", async () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const classified = await classifyMigrationBytes(Buffer.from(sql), {
    manifestSha: null,
    baseTables: new Set(["chief_budget"]),
    baseTypes: new Set(),
  });
  assert.equal(classified.class, "additive");
  assert.equal(/DROP|ROW LEVEL SECURITY|REFERENCES/i.test(sql), false);
});

test("a missing hold table or a missing cap refuses the spend and stays up", async () => {
  await withBudgetDb(async (client) => {
    await client.query(
      `INSERT INTO "chief_budget" ("id", "userId", "scope", "periodType", "capUsd") VALUES ('cap-1', 'user-a', 'cursor', 'run', 2)`
    );
    const missingTable = await reserveHold({
      client,
      userId: "user-a",
      operationId: "op-missing-table",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 1,
    });
    assert.equal(missingTable.ok, false);
    assert.equal(missingTable.code, "budget_unverified");

    await client.query(readFileSync(MIGRATION, "utf8"));
    const missingCap = await reserveHold({
      client,
      userId: "user-b",
      operationId: "op-missing-cap",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 1,
    });
    assert.equal(missingCap.ok, false);
    assert.equal(missingCap.code, "budget_unverified");
  });
});

test("one cap cannot fund two reserves, and the same operation reuses its hold", async () => {
  await withBudgetDb(async (client) => {
    await client.query(readFileSync(MIGRATION, "utf8"));
    await client.query(
      `INSERT INTO "chief_budget" ("id", "userId", "scope", "periodType", "capUsd") VALUES ('cap-1', 'user-a', 'cursor', 'run', 1)`
    );
    const first = await reserveHold({
      client,
      userId: "user-a",
      operationId: "approval-1",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 0.75,
    });
    assert.equal(first.ok, true);
    assert.equal(first.hold.actualUsd, null);
    const second = await reserveHold({
      client,
      userId: "user-a",
      operationId: "approval-2",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 0.75,
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, "budget_exceeded");
    const again = await reserveHold({
      client,
      userId: "user-a",
      operationId: "approval-1",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 0.75,
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    const rows = await client.query(`SELECT "actualUsd" FROM "chief_budget_hold"`);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].actualUsd, null);

    const unknown = await attributeActual({
      client,
      operationId: "approval-1",
      actualUsd: null,
    });
    assert.equal(unknown.reason, "unknown_cost");
    const raised = await attributeActual({
      client,
      operationId: "approval-1",
      actualUsd: 0.9,
    });
    assert.equal(raised.ok, true);
    const lowered = await attributeActual({
      client,
      operationId: "approval-1",
      actualUsd: 0.1,
    });
    assert.equal(lowered.reason, "below_estimate");
    const operator = await attributeActual({
      client,
      operationId: "approval-1",
      actualUsd: 0.1,
      operator: true,
    });
    assert.equal(operator.operatorAdjusted, true);

    await client.query(
      `UPDATE "chief_budget_hold" SET "actualUsd" = NULL, "operatorAdjusted" = false`
    );
    const released = await releaseHold({ client, operationId: "approval-1" });
    assert.equal(released.ok, true);
    const afterRelease = await reserveHold({
      client,
      userId: "user-a",
      operationId: "approval-3",
      scope: "cursor",
      periodType: "run",
      estimateUsd: 0.75,
    });
    assert.equal(afterRelease.ok, true);
  });
});

test("two concurrent reserves cannot both pass one cap", async () => {
  await withBudgetDb(async (client, url) => {
    await client.query(readFileSync(MIGRATION, "utf8"));
    await client.query(
      `INSERT INTO "chief_budget" ("id", "userId", "scope", "periodType", "capUsd") VALUES ('cap-1', 'user-a', 'cursor', 'run', 1)`
    );
    const left = new Client({ connectionString: url });
    const right = new Client({ connectionString: url });
    await left.connect();
    await right.connect();
    try {
      const [one, two] = await Promise.all([
        reserveHold({
          client: left,
          userId: "user-a",
          operationId: "approval-left",
          estimateUsd: 0.8,
        }),
        reserveHold({
          client: right,
          userId: "user-a",
          operationId: "approval-right",
          estimateUsd: 0.8,
        }),
      ]);
      const passed = [one, two].filter((item) => item.ok);
      assert.equal(passed.length, 1);
      assert.equal(
        [one, two].some((item) => item.code === "budget_exceeded"),
        true
      );
    } finally {
      await left.end();
      await right.end();
    }
  });
});

test("a coding create without a hold does not post, and an ambiguous post keeps the hold", async () => {
  const store = createMemoryExecutionStore({ encrypt: seal, decrypt: open });
  const granted = await store.grant({
    userId: "user-a",
    actorUserId: "user-a",
    approvalAction: "execute",
    provider: "cursor-cloud",
    objective: "Add a comment.",
    constraints: [],
    repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  });
  const calls = [];
  let released = 0;
  const blocked = createCursorCloudRuntime({
    apiKey: "cursor_test_key_value",
    allowlist: ["https://github.com/Freedomfarms/Forward-Freedom-Main"],
    ledger: store.adapter(),
    reserveHold: async () => ({ ok: false, code: "budget_unverified" }),
    releaseHold: async () => {
      released += 1;
      return { ok: true };
    },
    fetch: async () => {
      calls.push("post");
      throw new Error("Cursor was called");
    },
  });
  await assert.rejects(
    () =>
      blocked.submit(
        {
          userId: "user-a",
          provider: "cursor-cloud",
          objective: "Add a comment.",
          constraints: [],
          repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
          startingRef: "main",
          approval: {
            id: granted.approvalId,
            decision: "approved",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            userId: "user-a",
            provider: "cursor-cloud",
            objective: "Add a comment.",
            constraints: [],
            repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
            startingRef: "main",
            scope: { ...CODING_EXECUTION_SCOPE },
          },
        },
        { userId: "user-a" }
      ),
    (error) => error.code === "budget_unverified"
  );
  assert.equal(calls.length, 0);
  assert.equal(store.rows()[0].state, ExecutionState.FAILED);

  const store2 = createMemoryExecutionStore({ encrypt: seal, decrypt: open });
  const granted2 = await store2.grant({
    userId: "user-a",
    actorUserId: "user-a",
    approvalAction: "execute",
    provider: "cursor-cloud",
    objective: "Add a comment.",
    constraints: [],
    repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  });
  let holds = 0;
  const ambiguous = createCursorCloudRuntime({
    apiKey: "cursor_test_key_value",
    allowlist: ["https://github.com/Freedomfarms/Forward-Freedom-Main"],
    ledger: store2.adapter(),
    reserveHold: async () => {
      holds += 1;
      return { ok: true, hold: { id: "hold-1" } };
    },
    releaseHold: async () => {
      released += 1;
      return { ok: true };
    },
    fetch: async () => {
      calls.push("post");
      throw new Error("lost");
    },
  });
  await assert.rejects(() =>
    ambiguous.submit(
      {
        userId: "user-a",
        provider: "cursor-cloud",
        objective: "Add a comment.",
        constraints: [],
        repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
        startingRef: "main",
        approval: {
          id: granted2.approvalId,
          decision: "approved",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: "user-a",
          provider: "cursor-cloud",
          objective: "Add a comment.",
          constraints: [],
          repositoryUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main",
          startingRef: "main",
          scope: { ...CODING_EXECUTION_SCOPE },
        },
      },
      { userId: "user-a" }
    )
  );
  assert.equal(holds, 1);
  assert.equal(store2.rows()[0].state, ExecutionState.AMBIGUOUS);
  assert.equal(released, 0);
});
