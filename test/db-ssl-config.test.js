import test from "node:test";
import assert from "node:assert/strict";

import { buildPgPoolConfig } from "../server/db/pgPoolConfig.js";

// Guards the fix for the production "(ESSLREQUIRED) SSL connection is required"
// failure: pg never negotiates TLS on its own, so the pool config handed to
// PrismaPg must carry an explicit ssl option for every remote database host,
// and sslmode URL params must be translated (and stripped — pg-connection-
// string would otherwise override the ssl object with system-trust-store
// verification that Supabase's private CA chain fails).

const SUPABASE_POOLER_URL =
  "postgresql://freedom_app.abcdefghij:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";

test("remote host without sslmode gets TLS (require semantics)", () => {
  const config = buildPgPoolConfig(SUPABASE_POOLER_URL, {});
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  // Untouched URL params survive (pgbouncer flag, credentials, host, port).
  assert.equal(config.connectionString, SUPABASE_POOLER_URL);
});

test("sslmode=require on a remote host enables TLS and is stripped from the URL", () => {
  const config = buildPgPoolConfig(`${SUPABASE_POOLER_URL}&sslmode=require`, {});
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.equal(config.connectionString.includes("sslmode"), false);
  assert.equal(config.connectionString.includes("pgbouncer=true"), true);
});

test("localhost without sslmode stays non-TLS for local dev and CI", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const url = `postgresql://postgres:pw@${host}:5432/forward_freedom`;
    const config = buildPgPoolConfig(url, {});
    assert.equal(config.ssl, undefined);
    assert.equal(config.connectionString, url);
  }
});

test("sslmode=require on localhost still enables TLS (explicit wins)", () => {
  const config = buildPgPoolConfig(
    "postgresql://postgres:pw@localhost:5432/forward_freedom?sslmode=require",
    {}
  );
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.equal(config.connectionString.includes("sslmode"), false);
});

test("sslmode=disable opts out of TLS even on a remote host", () => {
  const config = buildPgPoolConfig(`${SUPABASE_POOLER_URL}&sslmode=disable`, {});
  assert.equal(config.ssl, false);
  assert.equal(config.connectionString.includes("sslmode"), false);
});

test("sslmode=verify-full verifies against the system trust store", () => {
  const config = buildPgPoolConfig(`${SUPABASE_POOLER_URL}&sslmode=verify-full`, {});
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("DATABASE_SSL_CA_CERT upgrades remote connections to verified TLS", () => {
  const config = buildPgPoolConfig(SUPABASE_POOLER_URL, { DATABASE_SSL_CA_CERT: CA_PEM });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: CA_PEM });
});

test("DATABASE_SSL_CA_CERT also applies when sslmode=require is present", () => {
  const config = buildPgPoolConfig(`${SUPABASE_POOLER_URL}&sslmode=require`, {
    DATABASE_SSL_CA_CERT: CA_PEM,
  });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: CA_PEM });
});

test("file-based TLS params are left for pg-connection-string to handle", () => {
  const url = `${SUPABASE_POOLER_URL}&sslrootcert=/etc/certs/root.crt`;
  const config = buildPgPoolConfig(url, {});
  assert.equal(config.connectionString, url);
  assert.equal("ssl" in config, false);
});

test("non-URL connection strings pass through unchanged", () => {
  const keywordValue = "host=localhost dbname=forward_freedom";
  const config = buildPgPoolConfig(keywordValue, {});
  assert.equal(config.connectionString, keywordValue);
  assert.equal("ssl" in config, false);
});
