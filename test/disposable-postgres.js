import { execFileSync } from "node:child_process";

const FALLBACK_URL = "postgresql://chief_test:chief_test@127.0.0.1:5432/postgres";

async function canConnect(connectionString) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function disposableAdminUrl() {
  const configured = process.env.DISPOSABLE_DATABASE_URL || process.env.DATABASE_URL;
  if (configured && (await canConnect(configured))) return configured;
  if (await canConnect(FALLBACK_URL)) return FALLBACK_URL;
  execFileSync("sudo", [
    "-u",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chief_test') THEN CREATE ROLE chief_test LOGIN SUPERUSER PASSWORD 'chief_test'; END IF; END $$;",
  ]);
  return FALLBACK_URL;
}

export function databaseUrl(adminUrl, database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
