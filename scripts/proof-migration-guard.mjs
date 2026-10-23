import fs from "node:fs";
import path from "node:path";

// Proof migrations ship in prisma/migrations so the isolated database can
// apply the full history. Production builds must not apply one that is still
// pending. A folder is proof-only when its name contains this token or it
// contains an empty PROOF_ONLY marker.
export const PROOF_MIGRATION_TOKEN = "chief_managed_proof";

export function listMigrationNames(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

export function isProofMigration(migrationsDir, name) {
  if (typeof name !== "string" || !name) return false;
  if (name.includes(PROOF_MIGRATION_TOKEN)) return true;
  return fs.existsSync(path.join(migrationsDir, name, "PROOF_ONLY"));
}

// Applied proof migrations stay on disk so Prisma history still matches.
// Pending ones are withheld unless the operator set CHIEF_PROOF_MIGRATE=1
// for an isolated database.
export function migrationsToWithhold({
  migrationsDir,
  migrationNames,
  appliedNames,
  allowProofMigrate = false,
}) {
  if (allowProofMigrate) return [];
  const applied = new Set(appliedNames || []);
  return (migrationNames || []).filter(
    (name) => isProofMigration(migrationsDir, name) && !applied.has(name)
  );
}

export function withholdMigrationDirectories(migrationsDir, names, stagingDir) {
  const staging =
    stagingDir || path.join(path.dirname(migrationsDir), ".proof-migrations-withheld");
  fs.mkdirSync(staging, { recursive: true });
  const moved = [];
  for (const name of names) {
    const from = path.join(migrationsDir, name);
    const to = path.join(staging, name);
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, to);
    moved.push({ from, to });
  }
  return function restore() {
    for (const entry of moved.reverse()) {
      if (fs.existsSync(entry.to) && !fs.existsSync(entry.from)) {
        fs.renameSync(entry.to, entry.from);
      }
    }
    if (fs.existsSync(staging) && fs.readdirSync(staging).length === 0) {
      fs.rmdirSync(staging);
    }
  };
}

export async function readAppliedMigrationNames(env = process.env) {
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString) return [];
  const pg = (await import("pg")).default;
  const { buildPgPoolConfig } = await import("../server/db/pgPoolConfig.js");
  const pool = new pg.Pool({
    ...buildPgPoolConfig(connectionString),
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT migration_name
       FROM "_prisma_migrations"
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL`
    );
    return result.rows.map((row) => row.migration_name);
  } catch (error) {
    if (error.code === "42P01" || error.code === "3D000") return [];
    throw error;
  } finally {
    await pool.end();
  }
}
