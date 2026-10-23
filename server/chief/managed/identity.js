// Cluster identity for the proof database. Equal database names are not
// enough: two instances can both be named "postgres". pg_control_system()
// is the cluster id, and pg_database.oid is the database inside that cluster.
// freedom_app and freedom_service are not members of pg_monitor, so they may
// be denied that function. The owner connection on DIRECT_URL is the
// supported reader. Hosts may differ (pooler versus direct).

export function compareDatabaseIdentities({
  runtime,
  direct,
  service = null,
  requireService = false,
  productionSystemId,
  productionProjectRef,
  proofSystemId,
}) {
  const failures = [];
  if (!runtime || !direct) failures.push("runtime and direct probes are both required");

  const runtimeOid = text(runtime?.databaseOid);
  const directOid = text(direct?.databaseOid);
  const runtimeName = text(runtime?.databaseName);
  const directName = text(direct?.databaseName);
  if (!runtimeOid || !directOid) failures.push("database oid missing");
  else if (runtimeOid !== directOid) {
    failures.push("runtime and direct connections are different databases in the cluster");
  }
  if (!runtimeName || !directName) failures.push("database name missing");
  else if (runtimeName !== directName) failures.push("runtime and direct database names differ");

  const cluster = resolveCluster(runtime, direct, failures);
  if (requireService && !service) failures.push("SERVICE_DATABASE_URL was not checked");
  if (service)
    compareService(
      service,
      { ...cluster, databaseOid: directOid, databaseName: directName },
      failures
    );

  const production = text(productionSystemId);
  const productionRef = text(productionProjectRef);
  let isolation = "unproven";
  if (cluster.systemIdentifier && production && production === cluster.systemIdentifier) {
    isolation = "production";
    failures.push("connected cluster matches the production system identifier");
  } else if (cluster.projectRef && productionRef && productionRef === cluster.projectRef) {
    isolation = "production";
    failures.push("connected project ref matches the production project ref");
  } else if (cluster.systemIdentifier && production) isolation = "isolated";
  else if (
    cluster.method === "project_ref_and_database_oid" &&
    productionRef &&
    cluster.projectRef
  ) {
    isolation = "isolated";
  } else {
    failures.push(
      "isolation from production is unproven. Set CHIEF_PRODUCTION_DB_SYSTEM_ID from a role that can read pg_control_system(), or CHIEF_PRODUCTION_SUPABASE_PROJECT_REF when every connection is denied that function."
    );
  }

  const expected = text(proofSystemId);
  if (expected && cluster.systemIdentifier && expected !== cluster.systemIdentifier) {
    failures.push("connected cluster does not match CHIEF_PROOF_DB_SYSTEM_ID");
  }

  return {
    ok: failures.length === 0,
    isolation,
    failures,
    serviceChecked: Boolean(service),
    identity: {
      method: cluster.method,
      systemIdentifier: cluster.systemIdentifier || null,
      databaseOid: directOid || runtimeOid || null,
      databaseName: directName || runtimeName || null,
      projectRef: cluster.projectRef || null,
      limitation: cluster.limitation,
      hostsMayDiffer:
        Boolean(runtime?.serverAddr || direct?.serverAddr) &&
        runtime?.serverAddr !== direct?.serverAddr,
    },
  };
}

function resolveCluster(runtime, direct, failures) {
  const runtimeId = grantedId(runtime);
  const directId = grantedId(direct);
  const runtimeDenied = isDenied(runtime);
  const directDenied = isDenied(direct);
  const projectRef = sharedProjectRef(runtime, direct, failures, runtimeDenied || directDenied);

  if (runtimeId && directId && runtimeId !== directId) {
    failures.push("runtime and direct connections are different Postgres clusters");
    return { method: "system_identifier", systemIdentifier: "", projectRef, limitation: null };
  }
  if (runtimeId || directId) {
    const denied = runtimeDenied || directDenied;
    return {
      method: denied ? "owner_system_identifier" : "system_identifier",
      systemIdentifier: directId || runtimeId,
      projectRef,
      limitation: denied
        ? "At least one managed role cannot call pg_control_system(). The system identifier was read from a connection that is allowed to, and the denied connection matched database oid, database name, and Supabase project ref."
        : null,
    };
  }
  if (!runtimeDenied && !directDenied) {
    failures.push("system_identifier missing; refusing to fall back to database name");
    return { method: "unavailable", systemIdentifier: "", projectRef, limitation: null };
  }
  if (!projectRef) {
    failures.push(
      "no connection can call pg_control_system(). freedom_app and freedom_service are not granted pg_monitor. DIRECT_URL should be the database owner, which can read the system identifier. The Supabase project ref was also missing, so isolation is unproven."
    );
    return {
      method: "unavailable",
      systemIdentifier: "",
      projectRef: "",
      limitation:
        "pg_control_system() was denied and the Supabase project ref could not be read from the connection endpoint.",
    };
  }
  return {
    method: "project_ref_and_database_oid",
    systemIdentifier: "",
    projectRef,
    limitation:
      "pg_control_system() was denied on every connection. Isolation uses the Supabase project ref and database oid, not the Postgres system identifier.",
  };
}

function compareService(service, canonical, failures) {
  if (text(service.databaseOid) !== text(canonical.databaseOid)) {
    failures.push("service connection does not reach the same database");
    return;
  }
  if (text(service.databaseName) !== text(canonical.databaseName)) {
    failures.push("service connection database name differs");
  }
  const serviceId = grantedId(service);
  if (serviceId && canonical.systemIdentifier && serviceId !== canonical.systemIdentifier) {
    failures.push("service connection is a different Postgres cluster");
  }
  if (isDenied(service) || !serviceId) {
    const ref = text(service.projectRef);
    if (!ref || !canonical.projectRef || ref !== canonical.projectRef) {
      failures.push(
        "service connection cannot prove cluster identity. It needs the same Supabase project ref as the direct connection, because freedom_service is not granted pg_control_system()."
      );
    }
  }
}

function sharedProjectRef(left, right, failures, required) {
  const leftRef = text(left?.projectRef);
  const rightRef = text(right?.projectRef);
  if (leftRef && rightRef && leftRef !== rightRef) {
    failures.push("runtime and direct Supabase project refs differ");
    return "";
  }
  if (required && (!leftRef || !rightRef)) {
    failures.push(
      "Supabase project ref is missing on a connection that cannot call pg_control_system()"
    );
    return "";
  }
  return leftRef || rightRef;
}

function grantedId(probe) {
  if (!probe || isDenied(probe)) return "";
  return text(probe.systemIdentifier);
}

function isDenied(probe) {
  return probe?.systemIdentifierAccess === "denied";
}

function text(value) {
  if (value == null) return "";
  return String(value).trim();
}
