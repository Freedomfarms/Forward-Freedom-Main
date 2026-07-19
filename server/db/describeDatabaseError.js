import { redactSensitive } from "../security/redaction.js";

// Builds a short, redacted, human-actionable summary of a database failure,
// e.g. `role freedom_app — code 28P01 — password authentication failed`.
//
// Rationale: during the RLS rollout the app's "database unreachable" state is
// almost always a connection-config problem (wrong Supavisor username, wrong
// password, missing grants, SSL enforcement) that can only be told apart by
// the underlying driver error — which serverless logs make painful to reach.
// This summary is shown to AUTHENTICATED users (the failure path runs after
// Firebase token verification) and written to the server log. Postgres and
// driver error messages never contain passwords; everything is additionally
// scrubbed through the standard redaction layer. The connection role is
// reported without the `.<project-ref>` tenant suffix.

const MAX_DIAGNOSTIC_LENGTH = 200;

function configuredDatabaseRole(env) {
  try {
    const username = decodeURIComponent(new URL(env.DATABASE_URL).username);
    return username.split(".")[0] || null;
  } catch {
    return null;
  }
}

// Prisma wraps driver errors in `cause` chains, and pg reports multi-address
// connection failures as AggregateError; the deepest error carries the real
// Postgres/pooler message.
function unwrapErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
  }
  return chain;
}

function firstNonEmptyLine(message) {
  return (
    message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

export function describeDatabaseError(error, env = process.env) {
  try {
    const parts = [];

    const role = configuredDatabaseRole(env);
    if (role) parts.push(`role ${role}`);

    const chain = unwrapErrorChain(error);

    const code = chain
      .map((entry) => entry.code)
      .find((value) => typeof value === "string" && value);
    if (code) parts.push(`code ${code}`);

    const deepestMessage = [...chain]
      .reverse()
      .map((entry) => (typeof entry.message === "string" ? firstNonEmptyLine(entry.message) : ""))
      .find(Boolean);
    if (deepestMessage) {
      parts.push(String(redactSensitive(deepestMessage)).slice(0, MAX_DIAGNOSTIC_LENGTH));
    }

    return parts.join(" — ");
  } catch {
    // Diagnostics must never mask or replace the original failure.
    return "";
  }
}
