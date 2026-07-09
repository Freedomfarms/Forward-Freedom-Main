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

const child = spawn("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
