import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildPgPoolConfig } from "../server/db/pgPoolConfig.js";
import {
  BASE_MIGRATION,
  PROOF_MIGRATION,
  PROOF_TABLES,
} from "../server/chief/managed/constants.js";
import {
  evaluateMigrationBaseline,
  evaluateSchemaReadiness,
} from "../server/chief/managed/readiness.js";
import { redactSecrets } from "../server/chief/managed/redact.js";
import { identifyProofDatabase } from "./chief-proof-db-identity.mjs";

const QUERY = `
  SELECT c.relname AS name,
         c.relrowsecurity AS row_security,
         c.relforcerowsecurity AS forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = ANY($1::text[])
`;

const BASELINE_QUERY = `
  SELECT migration_name
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND migration_name = ANY($1::text[])
`;

const USER_QUERY = `SELECT to_regclass('public."User"')::text AS user_table`;

export async function checkProofReadiness(env = process.env, existingIdentity = null) {
  const identity = existingIdentity || (await identifyProofDatabase(env));
  if (!identity.ok) {
    return { ok: false, stage: "identity", identity, baseline: null, readiness: null };
  }
  const pool = new pg.Pool(buildPgPoolConfig(env.DIRECT_URL));
  try {
    const baseline = await readBaseline(pool);
    if (!baseline.ok) {
      return { ok: false, stage: "baseline", identity, baseline, readiness: null };
    }
    const result = await pool.query(QUERY, [PROOF_TABLES]);
    const tables = result.rows.map((row) => ({
      name: row.name,
      rowSecurity: row.row_security,
      forced: row.forced,
    }));
    const readiness = evaluateSchemaReadiness(tables);
    return { ok: readiness.ok, stage: "schema", identity, baseline, readiness };
  } finally {
    await pool.end();
  }
}

async function readBaseline(pool) {
  try {
    const [migrations, user] = await Promise.all([
      pool.query(BASELINE_QUERY, [[BASE_MIGRATION, PROOF_MIGRATION]]),
      pool.query(USER_QUERY),
    ]);
    return evaluateMigrationBaseline({
      userTable: Boolean(user.rows[0]?.user_table),
      appliedMigrations: migrations.rows.map((row) => row.migration_name),
    });
  } catch (error) {
    if (error.code === "42P01") {
      return evaluateMigrationBaseline({ userTable: false, appliedMigrations: [] });
    }
    throw error;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  checkProofReadiness()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 2;
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error.message)}\n`);
      process.exitCode = 2;
    });
}
