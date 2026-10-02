// Workforce observation journal — shape, trust, and projection.
//
// Grok Bot owns execution. This module does not run an agent. It is the
// boundary both ingresses must pass before a row exists.
//
// OTEL is platform telemetry. Self-report is contextual and untrusted.
// Trust is derived from the source. The payload cannot set it.
// The two kind namespaces cannot impersonate each other.

export const ObservationSource = Object.freeze({
  OTEL: "otel",
  SELF_REPORT: "self_report",
});

export const ObservationTrust = Object.freeze({
  PLATFORM: "platform",
  UNTRUSTED: "untrusted",
});

export const DbSource = Object.freeze({
  otel: "OTEL",
  self_report: "SELF_REPORT",
});

export const DbTrust = Object.freeze({
  platform: "PLATFORM",
  untrusted: "UNTRUSTED",
});

export const SELF_REPORT_KINDS = Object.freeze([
  "freedom.report.agent",
  "freedom.report.work",
  "freedom.report.finding",
  "freedom.report.attention",
]);

export const LIVENESS = Object.freeze({
  ACTIVE: "ACTIVE",
  IDLE: "IDLE",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
});

export const LIVENESS_WINDOWS_MS = Object.freeze({
  active: 15 * 60 * 1000,
  idle: 6 * 60 * 60 * 1000,
});

const ALLOWED_KEYS = new Set([
  "source",
  "sourceEventId",
  "kind",
  "occurredAt",
  "agentExternalId",
  "turnId",
  "rootTurnId",
  "toolCallId",
  "sequence",
  "provenance",
  "coded",
  "text",
]);

const COVERAGE_LINES = Object.freeze({
  both: "Platform telemetry is the authority for actions. Self-reported notes are contextual and untrusted.",
  platform: "Agent status is based on platform telemetry. Self-reported context is absent.",
  self_report:
    "Agent status is based on self-reported activity; platform telemetry is unavailable.",
  none: "No workforce activity has been observed.",
});

function requiredString(value, field, max) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`observation ${field} must be a nonempty string`);
  }
  return value.trim();
}

function optionalId(value, field) {
  if (value == null || value === "") return null;
  return requiredString(value, field, 256);
}

export function trustForSource(source) {
  if (source === ObservationSource.OTEL) return ObservationTrust.PLATFORM;
  if (source === ObservationSource.SELF_REPORT) return ObservationTrust.UNTRUSTED;
  throw new Error("unknown observation source");
}

export function normalizeSourceToken(value) {
  if (value === ObservationSource.OTEL || value === DbSource.otel) return ObservationSource.OTEL;
  if (value === ObservationSource.SELF_REPORT || value === DbSource.self_report) {
    return ObservationSource.SELF_REPORT;
  }
  throw new Error("unknown observation source");
}

function assertKind(source, kind) {
  if (source === ObservationSource.OTEL) {
    if (!kind.startsWith("cursor.")) {
      throw new Error("platform telemetry kinds must start with cursor.");
    }
    return;
  }
  if (!SELF_REPORT_KINDS.includes(kind)) {
    throw new Error("self-report kinds must be freedom.report events");
  }
}

function assertCoded(coded) {
  if (coded == null) return null;
  if (typeof coded !== "object" || Array.isArray(coded)) {
    throw new Error("observation coded must be an object");
  }
  if (Object.prototype.hasOwnProperty.call(coded, "trust")) {
    throw new Error("observation coded cannot set trust");
  }
  if (Object.prototype.hasOwnProperty.call(coded, "userId")) {
    throw new Error("observation coded cannot set userId");
  }
  const encoded = JSON.stringify(coded);
  if (encoded.length > 8000) throw new Error("observation coded is too large");
  return JSON.parse(encoded);
}

export function normalizeObservation(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("observation must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`observation field '${key}' is not accepted`);
    }
  }
  const source = normalizeSourceToken(input.source);
  const kind = requiredString(input.kind, "kind", 200);
  assertKind(source, kind);
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error("observation occurredAt is invalid");

  let provenance = input.provenance ?? null;
  if (source === ObservationSource.SELF_REPORT) {
    if (provenance == null) provenance = "report";
    if (provenance !== "report") {
      throw new Error("a self-report cannot claim platform provenance");
    }
  } else if (provenance != null && provenance !== "client" && provenance !== "server") {
    throw new Error("platform provenance must be client or server");
  }

  let sequence = null;
  if (input.sequence != null) {
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 1_000_000) {
      throw new Error("observation sequence must be a non-negative integer");
    }
    sequence = input.sequence;
  }

  let text = null;
  if (input.text != null) {
    if (typeof input.text !== "string" || input.text.length > 8000) {
      throw new Error("observation text must be a string within the size cap");
    }
    text = input.text;
  }

  return Object.freeze({
    source,
    trust: trustForSource(source),
    dbSource: DbSource[source],
    dbTrust: DbTrust[trustForSource(source)],
    sourceEventId: requiredString(input.sourceEventId, "sourceEventId", 256),
    kind,
    occurredAt,
    agentExternalId: requiredString(input.agentExternalId, "agentExternalId", 256),
    turnId: optionalId(input.turnId, "turnId"),
    rootTurnId: optionalId(input.rootTurnId, "rootTurnId"),
    toolCallId: optionalId(input.toolCallId, "toolCallId"),
    sequence,
    provenance,
    coded: assertCoded(input.coded),
    text,
  });
}

export function livenessAt(lastEventAt, now = new Date()) {
  if (!lastEventAt) return LIVENESS.UNKNOWN;
  const age = now.getTime() - new Date(lastEventAt).getTime();
  if (Number.isNaN(age)) return LIVENESS.UNKNOWN;
  if (age <= LIVENESS_WINDOWS_MS.active) return LIVENESS.ACTIVE;
  if (age <= LIVENESS_WINDOWS_MS.idle) return LIVENESS.IDLE;
  return LIVENESS.STALE;
}

export function projectAgent(current, event, now = new Date()) {
  const previousAt = current?.lastEventAt ? new Date(current.lastEventAt) : null;
  const newer = !previousAt || event.occurredAt.getTime() >= previousAt.getTime();
  const lastEventAt = newer ? event.occurredAt : previousAt;
  let displayName = current?.displayName ?? null;
  let role = current?.role ?? null;
  if (
    newer &&
    event.source === ObservationSource.SELF_REPORT &&
    event.kind === "freedom.report.agent"
  ) {
    if (typeof event.coded?.displayName === "string" && event.coded.displayName.trim()) {
      displayName = event.coded.displayName.trim().slice(0, 120);
    }
    if (typeof event.coded?.role === "string" && event.coded.role.trim()) {
      role = event.coded.role.trim().slice(0, 280);
    }
  }
  return {
    externalId: event.agentExternalId,
    displayName,
    role,
    identityTrust: displayName || role ? ObservationTrust.UNTRUSTED : null,
    lastEventAt,
    lastTurnId: newer
      ? (event.turnId ?? current?.lastTurnId ?? null)
      : (current?.lastTurnId ?? null),
    liveness: livenessAt(lastEventAt, now),
  };
}

export function describeCoverage(sources) {
  let platform = false;
  let report = false;
  for (const source of sources ?? []) {
    const token = normalizeSourceToken(source);
    if (token === ObservationSource.OTEL) platform = true;
    if (token === ObservationSource.SELF_REPORT) report = true;
  }
  if (platform && report) {
    return { coverage: "platform+report", line: COVERAGE_LINES.both };
  }
  if (platform) return { coverage: "platform", line: COVERAGE_LINES.platform };
  if (report) return { coverage: "self_report", line: COVERAGE_LINES.self_report };
  return { coverage: "none", line: COVERAGE_LINES.none };
}
