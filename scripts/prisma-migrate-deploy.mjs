import process from "node:process";
import { spawn } from "node:child_process";

// Applies pending Prisma migrations during the build (e.g. on Vercel) so the
// database schema is always in sync with the deployed code. This prevents the
// "column ... does not exist" failures that occur when new code is deployed
// before its migration has been applied.
//
// It only runs when a real DATABASE_URL is configured. Local/preview builds
// without a database (or using the generate-only placeholder) are skipped so
// they keep working.
//
// IMPORTANT: this step is intentionally NON-BLOCKING. The runtime has a
// schema-compatibility layer (server/db/schemaCapabilities.js) that tolerates
// an un-migrated database, so a migration hiccup here (unreachable DB, pooler
// misconfiguration, transient network error) must never fail the deploy —
// blocking the deploy would keep older, potentially broken code in
// production, which is strictly worse than deploying with a lagging
// migration.

const PLACEHOLDER_DATABASE_URL = "postgresql://postgres:password@localhost:5432/forward_freedom";
const databaseUrl = (process.env.DATABASE_URL || "").trim();

if (!databaseUrl || databaseUrl === PLACEHOLDER_DATABASE_URL) {
  process.stdout.write(
    "[prisma-migrate-deploy] No production DATABASE_URL configured; skipping migrate deploy.\n"
  );
  process.exit(0);
}

process.stdout.write("[prisma-migrate-deploy] Applying pending migrations…\n");

// Without a hard timeout, an unreachable/misconfigured migrations connection
// (e.g. a Supabase transaction-mode pooler URL, which Prisma Migrate can't
// use for schema changes — it needs the session pooler / direct connection
// via DIRECT_URL) can hang on the advisory lock and stall the Vercel build
// indefinitely until someone cancels it manually.
const MIGRATE_TIMEOUT_MS = 90_000;

const child = spawn("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

function warnAndContinue(reason) {
  process.stderr.write(
    "\n" +
      "╔════════════════════════════════════════════════════════════════════╗\n" +
      "║ [prisma-migrate-deploy] WARNING: migrations were NOT applied.       ║\n" +
      "╚════════════════════════════════════════════════════════════════════╝\n" +
      `Reason: ${reason}\n` +
      "The deploy will continue — the app tolerates an un-migrated database\n" +
      "via its schema-compatibility layer — but the pending migrations still\n" +
      "need to be applied for new columns/features (e.g. at-rest encryption)\n" +
      "to activate.\n" +
      "Checklist:\n" +
      "  1. DIRECT_URL must be set to Supabase's *session pooler* or direct\n" +
      "     connection string (host *.pooler.supabase.com, port 5432, no\n" +
      "     pgbouncer param). Transaction-mode pooler URLs (port 6543) hang\n" +
      "     or fail — Prisma Migrate cannot run schema changes through them.\n" +
      "  2. DATABASE_URL (app runtime) can stay on the transaction pooler.\n" +
      "  3. Alternatively run `npm run db:migrate` manually with DIRECT_URL.\n\n"
  );
  process.exit(0);
}

let timedOut = false;
const timeoutHandle = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, MIGRATE_TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(timeoutHandle);
  if (timedOut) {
    warnAndContinue(
      `timed out after ${MIGRATE_TIMEOUT_MS / 1000}s — the migrations connection is unreachable or blocked (typical of a transaction-mode pooler URL).`
    );
  } else if (code !== 0) {
    warnAndContinue(`\`prisma migrate deploy\` exited with code ${code}.`);
  } else {
    process.stdout.write("[prisma-migrate-deploy] Migrations applied successfully.\n");
    process.exit(0);
  }
});

child.on("error", (error) => {
  clearTimeout(timeoutHandle);
  warnAndContinue(`failed to start \`prisma migrate deploy\`: ${error}`);
});
