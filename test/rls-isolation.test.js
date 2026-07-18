import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Phase 3 (Freedom OS): proves per-user isolation is enforced BY THE DATABASE
// (Postgres row-level security), not just by app-level WHERE clauses:
//   • withUserContext(A) sees only A's rows — even with no WHERE clause;
//   • a query with NO user context returns zero rows (fail closed, no error
//     that could leak data);
//   • an INSERT whose userId belongs to another user is rejected by the
//     policies' WITH CHECK;
//   • FORCE ROW LEVEL SECURITY applies the policies to the table OWNER too
//     (superusers always bypass RLS, so the schema is owned by a dedicated
//     non-superuser role here);
//   • the BYPASSRLS service role (used only by server/db/servicePrisma.js)
//     still sees every row.
//
// Runs against a REAL Postgres with ALL migrations applied, connected as the
// RLS-subject app role. Self-skips unless DATABASE_URL is set. Run locally
// with a superuser named `postgres` reachable via socket /tmp (matching the
// other DB-backed tests):
//   DATABASE_URL=postgresql://freedom_app@127.0.0.1:5433/ff_rls \
//     node --test test/rls-isolation.test.js

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;

function databaseNameFromUrl(fallback) {
  try {
    return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "") || fallback;
  } catch {
    return fallback;
  }
}
const DB_NAME = process.env.RLS_DB_NAME || databaseNameFromUrl("ff_rls");
const PG_PORT = process.env.TEST_PG_PORT || "5433";

// The schema owner must be a non-superuser so the FORCE-RLS assertions mean
// something (superusers bypass RLS unconditionally).
const OWNER_ROLE = "rls_test_owner";

let setupError = null;
let prisma;
let withUserContext;

function psqlAs(user, db, ...args) {
  return spawnSync("psql", ["-h", "/tmp", "-p", PG_PORT, "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
  });
}

function countAs(user, table) {
  const result = psqlAs(user, DB_NAME, "-tAc", `SELECT count(*) FROM "${table}";`);
  if (result.status !== 0) {
    throw new Error(`count as ${user} failed: ${result.stderr}`);
  }
  return Number(result.stdout.trim());
}

before(async () => {
  if (!HAS_DB) return;

  try {
    // Roles are cluster-wide; create them idempotently as the superuser.
    // freedom_app / freedom_service mirror the production roles from
    // docs/RLS_ROLLOUT.md (trust auth locally, so no passwords).
    const roles = psqlAs("postgres", "postgres", "-c", `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
          CREATE ROLE ${OWNER_ROLE} LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
          CREATE ROLE freedom_app LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
          CREATE ROLE freedom_service LOGIN BYPASSRLS;
        END IF;
      END $$;
    `);
    if (roles.status !== 0) throw new Error(roles.stderr || "failed to create test roles");

    // Fresh database owned by the non-superuser owner role, then apply every
    // migration in order AS THAT OWNER (matching production, where migrate
    // deploy runs as the owning role via DIRECT_URL).
    spawnSync("psql", ["-h", "/tmp", "-p", PG_PORT, "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DB_NAME};`], { encoding: "utf8" });
    const created = psqlAs("postgres", "postgres", "-c", `CREATE DATABASE ${DB_NAME} OWNER ${OWNER_ROLE};`);
    if (created.status !== 0) throw new Error(created.stderr || "failed to create RLS test database");

    const migrationDirs = readdirSync("prisma/migrations", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of migrationDirs) {
      const applied = psqlAs(OWNER_ROLE, DB_NAME, "-f", `prisma/migrations/${dir}/migration.sql`);
      if (applied.status !== 0) {
        throw new Error(`migration ${dir} failed: ${applied.stderr}`);
      }
    }

    const prismaModule = await import("../server/db/prisma.js");
    prisma = prismaModule.getPrismaClient();
    withUserContext = prismaModule.withUserContext;

    // Seed both users through the wrapper itself — inserts inside the right
    // user context must pass WITH CHECK.
    for (const uid of ["rls-user-a", "rls-user-b"]) {
      await withUserContext(uid, async (tx) => {
        await tx.user.create({ data: { id: uid, email: `${uid}@example.com` } });
        const item = await tx.plaidItem.create({
          data: {
            userId: uid,
            itemId: `item-${uid}`,
            accessTokenCiphertext: `ciphertext-${uid}`,
          },
        });
        const account = await tx.account.create({
          data: {
            userId: uid,
            plaidItemRecordId: item.id,
            plaidAccountId: `acct-${uid}`,
            name: `${uid} Checking`,
            type: "Checking",
          },
        });
        await tx.transaction.create({
          data: {
            userId: uid,
            accountId: account.id,
            merchantCiphertext: `merchant-${uid}`,
            postedAt: new Date("2026-07-01T12:00:00Z"),
          },
        });
        await tx.workspaceSnapshot.create({
          data: { userId: uid, stateCiphertext: `state-${uid}` },
        });
        // Freedom OS agent tables are policy-covered too.
        await tx.ceoAgentConfig.create({ data: { userId: uid } });
        await tx.agentRun.create({
          data: { userId: uid, agentType: "finance", summary: "seed run" },
        });
      });
    }
  } catch (error) {
    setupError = error;
  }
});

after(async () => {
  if (prisma) await prisma.$disconnect();
});

function requireSetup() {
  if (setupError) throw setupError;
}

test("withUserContext(A) sees only A's rows even without a WHERE clause", { skip }, async () => {
  requireSetup();

  const seen = await withUserContext("rls-user-a", async (tx) => ({
    users: await tx.user.findMany(),
    items: await tx.plaidItem.findMany(),
    accounts: await tx.account.findMany(),
    transactions: await tx.transaction.findMany(),
    snapshots: await tx.workspaceSnapshot.findMany(),
    ceoConfigs: await tx.ceoAgentConfig.findMany(),
    agentRuns: await tx.agentRun.findMany(),
  }));

  // The superuser sees both users' rows...
  assert.equal(countAs("postgres", "User"), 2);
  assert.equal(countAs("postgres", "Transaction"), 2);

  // ...but the context-bound app connection sees exactly one user's.
  for (const [name, rows] of Object.entries(seen)) {
    assert.equal(rows.length, 1, `${name}: expected exactly user A's row`);
  }
  assert.equal(seen.users[0].id, "rls-user-a");
  for (const rows of [seen.items, seen.accounts, seen.transactions, seen.snapshots, seen.ceoConfigs, seen.agentRuns]) {
    assert.equal(rows[0].userId, "rls-user-a");
  }
});

test("a query with no user context returns zero rows, not an error", { skip }, async () => {
  requireSetup();

  // Bare client = freedom_app with app.current_user_id unset → the policy's
  // current_setting(..., true) is NULL → no row matches. Fail closed.
  assert.deepEqual(await prisma.user.findMany(), []);
  assert.deepEqual(await prisma.transaction.findMany(), []);
  assert.deepEqual(await prisma.workspaceSnapshot.findMany(), []);
  assert.deepEqual(await prisma.agentRun.findMany(), []);
});

test("an INSERT with a mismatched userId is rejected by WITH CHECK", { skip }, async () => {
  requireSetup();

  await assert.rejects(
    withUserContext("rls-user-a", (tx) =>
      tx.account.create({
        data: {
          userId: "rls-user-b",
          name: "Smuggled Account",
          type: "Checking",
        },
      })
    ),
    /row-level security|denied|42501/i
  );

  // Nothing landed for user B (verified via the RLS-bypassing superuser).
  const result = psqlAs(
    "postgres",
    DB_NAME,
    "-tAc",
    `SELECT count(*) FROM "Account" WHERE "name" = 'Smuggled Account';`
  );
  assert.equal(Number(result.stdout.trim()), 0);
});

test("cross-user UPDATE inside another user's context touches nothing", { skip }, async () => {
  requireSetup();

  const updated = await withUserContext("rls-user-a", (tx) =>
    tx.transaction.updateMany({ data: { pending: true } })
  );
  // Even an unscoped "update everything" only reaches A's single row.
  assert.equal(updated.count, 1);
  const bRow = psqlAs(
    "postgres",
    DB_NAME,
    "-tAc",
    `SELECT "pending" FROM "Transaction" WHERE "userId" = 'rls-user-b';`
  );
  assert.equal(bRow.stdout.trim(), "f");
});

test("FORCE applies the policies to the table owner (non-superuser)", { skip }, () => {
  requireSetup();

  // Without FORCE the owner would bypass its own tables' policies — exactly
  // the hole that made app-level filtering the only line of defense.
  assert.equal(countAs(OWNER_ROLE, "User"), 0);
  assert.equal(countAs(OWNER_ROLE, "Transaction"), 0);
  assert.equal(countAs(OWNER_ROLE, "WorkspaceSnapshot"), 0);

  // With a bound context the owner sees that user's rows — the policy (not a
  // privilege failure) is what gates access.
  const scoped = psqlAs(
    OWNER_ROLE,
    DB_NAME,
    "-tAc",
    `BEGIN;
     SELECT set_config('app.current_user_id', 'rls-user-b', true);
     SELECT count(*) FROM "Transaction";
     COMMIT;`
  );
  assert.equal(scoped.status, 0, scoped.stderr);
  // Output interleaves command tags (BEGIN/COMMIT) with results; the count is
  // the only purely numeric line.
  const countLine = scoped.stdout.trim().split("\n").find((line) => /^\d+$/.test(line.trim()));
  assert.equal(Number(countLine), 1);
});

test("the BYPASSRLS service role still sees every user's rows", { skip }, () => {
  requireSetup();

  // This is the role behind server/db/servicePrisma.js — webhook/cron/admin
  // only. It must see across users; everything else must not.
  assert.equal(countAs("freedom_service", "User"), 2);
  assert.equal(countAs("freedom_service", "Transaction"), 2);
});

test("withUserContext rejects an empty userId instead of running unscoped", { skip }, async () => {
  requireSetup();

  await assert.rejects(withUserContext("", () => {}), /non-empty userId/);
  await assert.rejects(withUserContext(null, () => {}), /non-empty userId/);
  await assert.rejects(withUserContext("   ", () => {}), /non-empty userId/);
});
