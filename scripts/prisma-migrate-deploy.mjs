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

const PLACEHOLDER_DATABASE_URL = "postgresql://postgres:password@localhost:5432/forward_freedom";
const databaseUrl = (process.env.DATABASE_URL || "").trim();

if (!databaseUrl || databaseUrl === PLACEHOLDER_DATABASE_URL) {
  process.stdout.write(
    "[prisma-migrate-deploy] No production DATABASE_URL configured; skipping migrate deploy.\n"
  );
  process.exit(0);
}

process.stdout.write("[prisma-migrate-deploy] Applying pending migrations…\n");

// Without a hard timeout, an unreachable/misconfigured DATABASE_URL (e.g. a
// Supabase direct connection that needs IPv6, or a transaction-mode pooler
// URL that Prisma Migrate can't use) makes the TCP connect attempt hang
// instead of failing, which stalls the whole Vercel build indefinitely until
// someone cancels it manually. Fail fast instead so the build reports a
// clear error.
const MIGRATE_TIMEOUT_MS = 90_000;

const child = spawn("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

let timedOut = false;
const timeoutHandle = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `[prisma-migrate-deploy] Timed out after ${MIGRATE_TIMEOUT_MS / 1000}s waiting for ` +
      "`prisma migrate deploy` to finish. This usually means DATABASE_URL can't be reached " +
      "(e.g. wrong Supabase connection string/port, or a pooler URL in transaction mode that " +
      "Prisma Migrate can't use for schema changes). Killing the process so the build fails " +
      "fast instead of hanging.\n"
  );
  child.kill("SIGKILL");
}, MIGRATE_TIMEOUT_MS);

child.on("exit", (code) => {
  clearTimeout(timeoutHandle);
  process.exit(timedOut ? 1 : code ?? 1);
});

child.on("error", (error) => {
  clearTimeout(timeoutHandle);
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
