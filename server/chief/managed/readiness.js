import { BASE_MIGRATION, PROOF_MIGRATION, PROOF_TABLES } from "./constants.js";

// Schema readiness is checked after identity, and after a migration the
// operator ran on purpose. This function does not migrate.

export function evaluateSchemaReadiness(tables, { required = PROOF_TABLES } = {}) {
  const byName = new Map((tables || []).map((table) => [table.name, table]));
  const missing = [];
  const rlsOff = [];
  for (const name of required) {
    const table = byName.get(name);
    if (!table) {
      missing.push(name);
      continue;
    }
    if (!table.rowSecurity || !table.forced) rlsOff.push(name);
  }
  const failures = [];
  if (missing.length) failures.push(`missing tables: ${missing.join(", ")}`);
  if (rlsOff.length) failures.push(`RLS is not forced on: ${rlsOff.join(", ")}`);
  return { ok: failures.length === 0, failures, missing, rlsOff };
}

// The proof migration references "User". An empty database needs the full
// Prisma history, applied by prisma migrate deploy, before that migration.
export function evaluateMigrationBaseline({ userTable = false, appliedMigrations = [] } = {}) {
  const applied = new Set(appliedMigrations);
  const failures = [];
  if (!applied.has(BASE_MIGRATION)) {
    failures.push(
      `base migration ${BASE_MIGRATION} is not recorded in _prisma_migrations. On the isolated database, run prisma migrate deploy so the full history is applied. Applying only ${PROOF_MIGRATION} is not enough.`
    );
  }
  if (!applied.has(PROOF_MIGRATION)) {
    failures.push(`proof migration ${PROOF_MIGRATION} is not recorded in _prisma_migrations.`);
  }
  if (!userTable) {
    failures.push(
      'public."User" is missing. The proof tables reference it, so the base schema has to exist first.'
    );
  }
  return { ok: failures.length === 0, failures };
}
