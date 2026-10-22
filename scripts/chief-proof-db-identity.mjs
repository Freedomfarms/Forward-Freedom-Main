import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildPgPoolConfig } from "../server/db/pgPoolConfig.js";
import { compareDatabaseIdentities } from "../server/chief/managed/identity.js";
import { connectionLabel, redactSecrets } from "../server/chief/managed/redact.js";

const QUERY = `
  SELECT
    current_database() AS database_name,
    (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    current_setting('server_version') AS server_version,
    inet_server_addr()::text AS server_addr,
    inet_server_port()::text AS server_port
`;

export async function probeConnection(connectionString) {
  const pool = new pg.Pool(buildPgPoolConfig(connectionString));
  try {
    const result = await pool.query(QUERY);
    const row = result.rows[0] || {};
    return {
      databaseName: row.database_name ?? null,
      databaseOid: row.database_oid ?? null,
      systemIdentifier: row.system_identifier ?? null,
      serverVersion: row.server_version ?? null,
      serverAddr: row.server_addr ?? null,
      serverPort: row.server_port ?? null,
    };
  } finally {
    await pool.end();
  }
}

export async function identifyProofDatabase(env = process.env) {
  if (!env.DATABASE_URL || !env.DIRECT_URL) {
    return {
      ok: false,
      failures: ["DATABASE_URL and DIRECT_URL are both required before any proof migration"],
    };
  }
  const runtime = await probeConnection(env.DATABASE_URL);
  const direct = await probeConnection(env.DIRECT_URL);
  const service = env.SERVICE_DATABASE_URL ? await probeConnection(env.SERVICE_DATABASE_URL) : null;
  const compared = compareDatabaseIdentities({
    runtime,
    direct,
    service,
    productionSystemId: env.CHIEF_PRODUCTION_DB_SYSTEM_ID,
    proofSystemId: env.CHIEF_PROOF_DB_SYSTEM_ID,
  });
  return {
    ...compared,
    labels: {
      runtime: connectionLabel(env.DATABASE_URL),
      direct: connectionLabel(env.DIRECT_URL),
      service: env.SERVICE_DATABASE_URL ? connectionLabel(env.SERVICE_DATABASE_URL) : null,
    },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  identifyProofDatabase()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 2;
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error.message)}\n`);
      process.exitCode = 2;
    });
}
