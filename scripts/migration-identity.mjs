// Fail-closed check for freedom_migration_identity.
//
// The row is created by the operator under authorization C. This module never
// inserts it. A missing table, a missing row, or a mismatch refuses the
// migrate before Prisma starts.
//
// Off Vercel, a development target also requires CHIEF_MIGRATE_LOCAL=1.
// A production or preview target off Vercel is only accepted in GitHub
// Actions, which is the migrate workflow. A laptop cannot claim those targets.
// The database hostname is not a control.

export const MIGRATE_TARGETS = new Set(["production", "preview", "development"]);

export function evaluateMigrationIdentity({ env, session, rows, readError = null }) {
  const target = env?.CHIEF_MIGRATE_TARGET;
  if (!MIGRATE_TARGETS.has(target)) {
    return { ok: false, reason: "target_invalid" };
  }
  if (readError?.code === "42P01") return { ok: false, reason: "identity_missing" };
  if (readError) return { ok: false, reason: "identity_unreadable" };
  if (!session?.migrate_role || !session?.database_name) {
    return { ok: false, reason: "identity_unreadable" };
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    return { ok: false, reason: "identity_missing" };
  }
  const row = rows[0];
  if (row.environment !== target) return { ok: false, reason: "target_mismatch" };
  if (row.database_name !== session.database_name) {
    return { ok: false, reason: "database_mismatch" };
  }
  if (row.migrate_role !== session.migrate_role) return { ok: false, reason: "role_mismatch" };
  const onVercel = env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
  if (onVercel) {
    if (env.VERCEL_ENV !== target) return { ok: false, reason: "vercel_env_mismatch" };
    return { ok: true };
  }
  if (target === "development") {
    if (env.CHIEF_MIGRATE_LOCAL !== "1") {
      return { ok: false, reason: "local_confirmation_missing" };
    }
    return { ok: true };
  }
  if (env.GITHUB_ACTIONS !== "true") return { ok: false, reason: "off_vercel_target_refused" };
  return { ok: true };
}

export const FORBIDDEN_SCHEMA_COMPAT_ROLES = new Set([
  "freedom_migrate_production",
  "freedom_migrate_preview",
]);

export function schemaCompatRoleAllowed(currentUser) {
  if (FORBIDDEN_SCHEMA_COMPAT_ROLES.has(currentUser)) {
    return { ok: false, reason: "migrate_role_refused" };
  }
  if (typeof currentUser !== "string" || currentUser.trim() === "") {
    return { ok: false, reason: "role_unreadable" };
  }
  return { ok: true };
}
