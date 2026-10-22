import { PROOF_TABLES } from "./constants.js";

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
