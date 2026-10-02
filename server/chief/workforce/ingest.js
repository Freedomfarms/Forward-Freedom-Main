// Self-report ingress. Enterprise OpenTelemetry is not connected.
//
// Checked 2026-10-02: this environment is a personal cloud environment, the
// process has no OTEL or OTLP credential, and the repo has no collector.
// Cursor Enterprise Action Recording is the only platform feed, and it is
// not configured here. A report is an assertion the sender made. It is not
// platform telemetry.

import { describeCoverage } from "./journal.js";
import { parseReportToken, reportTokenMatches } from "./reportKey.js";
import { appendObservation } from "./store.js";

export const OBSERVATION_INGRESS = Object.freeze({
  otel: false,
  selfReport: true,
});

const SELF_REPORT_COVERAGE = describeCoverage(["self_report"]);

export function selfReportCoverage() {
  return SELF_REPORT_COVERAGE;
}

export class ReportRejected extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "ReportRejected";
    this.code = code;
    this.status = status;
  }
}

const KEPT_FIELDS = [
  "sourceEventId",
  "kind",
  "occurredAt",
  "agentExternalId",
  "turnId",
  "rootTurnId",
  "toolCallId",
  "sequence",
  "coded",
  "text",
];

function reject(code, status, message) {
  throw new ReportRejected(code, status, message);
}

export function shapeSelfReport(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    reject("MALFORMED", 400, "Workforce report must be an object.");
  }
  if (Object.prototype.hasOwnProperty.call(body, "userId")) {
    reject("CROSS_USER", 400, "A self-report cannot choose a user.");
  }
  if (Object.prototype.hasOwnProperty.call(body, "trust")) {
    reject("PLATFORM", 400, "A self-report cannot set trust.");
  }
  if (body.source != null && body.source !== "self_report" && body.source !== "SELF_REPORT") {
    reject("PLATFORM", 400, "A self-report cannot claim platform provenance.");
  }
  if (body.provenance != null && body.provenance !== "report") {
    reject("PLATFORM", 400, "A self-report cannot claim platform provenance.");
  }
  const observation = { source: "self_report", provenance: "report" };
  for (const field of KEPT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) observation[field] = body[field];
  }
  return observation;
}

export async function acceptSelfReport(tx, token, body, options = {}) {
  const parsed = parseReportToken(token);
  if (!parsed) {
    reject("UNAUTHENTICATED", 401, "Workforce report was not accepted.");
  }
  const binding = await tx.workforceBinding.findUnique({ where: { userId: parsed.userId } });
  if (!binding || binding.status !== "ACTIVE" || !binding.reportKeyHash) {
    reject("UNBOUND", 401, "Workforce report was not accepted.");
  }
  if (!reportTokenMatches(token, binding.reportKeyHash)) {
    reject("UNAUTHENTICATED", 401, "Workforce report was not accepted.");
  }
  const observation = shapeSelfReport(body);
  try {
    return await appendObservation(tx, parsed.userId, observation, options);
  } catch (error) {
    if (error instanceof ReportRejected) throw error;
    const message = error?.message || "Workforce report was not accepted.";
    if (message === "workforce binding is not active") {
      reject("UNBOUND", 401, "Workforce report was not accepted.");
    }
    if (message.includes("not sealed") || message.includes("Encryption is not configured")) {
      reject("UNAVAILABLE", 503, "Workforce report could not be stored.");
    }
    reject("MALFORMED", 400, message);
  }
}
