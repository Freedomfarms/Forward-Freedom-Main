import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildPgPoolConfig } from "../server/db/pgPoolConfig.js";
import { PROOF_TABLES } from "../server/chief/managed/constants.js";
import { evaluateSchemaReadiness } from "../server/chief/managed/readiness.js";
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

export async function checkProofReadiness(env = process.env) {
  const identity = await identifyProofDatabase(env);
  if (!identity.ok) {
    return { ok: false, stage: "identity", identity, readiness: null };
  }
  const pool = new pg.Pool(buildPgPoolConfig(env.DIRECT_URL));
  try {
    const result = await pool.query(QUERY, [PROOF_TABLES]);
    const tables = result.rows.map((row) => ({
      name: row.name,
      rowSecurity: row.row_security,
      forced: row.forced,
    }));
    const readiness = evaluateSchemaReadiness(tables);
    return { ok: readiness.ok, stage: "schema", identity, readiness };
  } finally {
    await pool.end();
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
