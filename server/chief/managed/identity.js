// Cluster identity for the proof database. Equal database names are not
// enough: two instances can both be named "postgres". pg_control_system()
// system_identifier identifies the cluster. The database oid identifies the
// database inside that cluster. Hosts may differ (pooler versus direct).

export function compareDatabaseIdentities({
  runtime,
  direct,
  service = null,
  productionSystemId,
  proofSystemId,
}) {
  const failures = [];
  if (!runtime || !direct) failures.push("runtime and direct probes are both required");
  const runtimeId = text(runtime?.systemIdentifier);
  const directId = text(direct?.systemIdentifier);
  const runtimeOid = text(runtime?.databaseOid);
  const directOid = text(direct?.databaseOid);
  const runtimeName = text(runtime?.databaseName);
  const directName = text(direct?.databaseName);

  if (!runtimeId || !directId) {
    failures.push("system_identifier missing; refusing to fall back to database name");
  } else if (runtimeId !== directId) {
    failures.push("runtime and direct connections are different Postgres clusters");
  }
  if (!runtimeOid || !directOid) {
    failures.push("database oid missing");
  } else if (runtimeOid !== directOid) {
    failures.push("runtime and direct connections are different databases in the cluster");
  }
  if (!runtimeName || !directName) {
    failures.push("database name missing");
  } else if (runtimeName !== directName) {
    failures.push("runtime and direct database names differ");
  }

  if (service) {
    if (text(service.systemIdentifier) !== runtimeId || text(service.databaseOid) !== runtimeOid) {
      failures.push("service connection does not reach the same cluster and database");
    }
  }

  const production = text(productionSystemId);
  let isolation = "unproven";
  if (!production) {
    failures.push(
      "CHIEF_PRODUCTION_DB_SYSTEM_ID is unset, so isolation from production is unproven"
    );
  } else if (production === runtimeId) {
    isolation = "production";
    failures.push("connected cluster matches the production system identifier");
  } else if (runtimeId) {
    isolation = "isolated";
  }

  const expected = text(proofSystemId);
  if (expected && expected !== runtimeId) {
    failures.push("connected cluster does not match CHIEF_PROOF_DB_SYSTEM_ID");
  }

  return {
    ok: failures.length === 0,
    isolation,
    failures,
    identity: {
      systemIdentifier: runtimeId || null,
      databaseOid: runtimeOid || null,
      databaseName: runtimeName || null,
      hostsMayDiffer:
        Boolean(runtime?.serverAddr || direct?.serverAddr) &&
        runtime?.serverAddr !== direct?.serverAddr,
    },
  };
}

function text(value) {
  if (value == null) return "";
  return String(value).trim();
}
