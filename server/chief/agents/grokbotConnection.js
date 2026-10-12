// Truthful Grok Bot connection check.
//
// Grok Bot is observed through the workforce journal. This module does not
// call api.x.ai, Cursor, or a bot, and it does not submit work. An xAI model
// key and a Cursor cloud-agent key do not authenticate Grok Bot.

import { OBSERVATION_INGRESS } from "../workforce/ingest.js";

const FAILURE_TEXT = Object.freeze({
  database_unavailable: "The workforce journal database is not configured.",
  unauthenticated:
    "Grok Bot observation requires the signed-in user. No service credential is in use.",
  permission_denied: "The workforce journal refused this user.",
  timeout: "The workforce journal read timed out.",
  malformed: "The workforce journal returned a response that could not be read.",
  not_configured:
    "No Grok Bot service credential is configured. An xAI model key does not connect Grok Bot.",
  connectivity_failed: "The workforce journal could not be read.",
  not_read_only: "This provider is not the read-only Grok Bot runtime.",
});

function present(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "";
}

function anyPresent(env, names) {
  return names.some((name) => present(env, name));
}

export function grokBotCredentialPresence(env = process.env) {
  return {
    xaiModelKeyPresent: anyPresent(env, ["CHIEF_XAI_API_KEY", "XAI_API_KEY"]),
    xaiAuthorizesGrokBot: false,
    cursorApiKeyPresent: present(env, "CURSOR_API_KEY"),
    cursorApiAuthorizesGrokBot: false,
    otelCredentialPresent: anyPresent(env, [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "CURSOR_OTLP_ENDPOINT",
    ]),
  };
}

function failure(code) {
  return { code, message: FAILURE_TEXT[code] };
}

function classifyReadError(error) {
  const message = String(error?.message ?? "");
  const name = String(error?.name ?? "");
  if (
    error?.status === 503 ||
    /database client is not configured/i.test(message) ||
    /not configured/i.test(message)
  ) {
    return "database_unavailable";
  }
  if (error?.status === 401 || /requires a user/i.test(message) || /unauthorized/i.test(message)) {
    return "unauthenticated";
  }
  if (error?.status === 403 || /permission|forbidden|row-level security|rls/i.test(message)) {
    return "permission_denied";
  }
  if (
    name === "TimeoutError" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ABORT_ERR" ||
    /timed out|timeout/i.test(message)
  ) {
    return "timeout";
  }
  if (
    name === "SyntaxError" ||
    /malformed|unexpected token|sealed text|could not be read/i.test(message)
  ) {
    return "malformed";
  }
  return "connectivity_failed";
}

function readOnlyRuntime(runtime) {
  if (!runtime || runtime.provider !== "grokbot") return false;
  if (!Array.isArray(runtime.effects) || runtime.effects.length !== 1) return false;
  if (runtime.effects[0] !== "read") return false;
  if (typeof runtime.picture !== "function") return false;
  if (typeof runtime.listAgents !== "function" || typeof runtime.getAgent !== "function") {
    return false;
  }
  if (
    typeof runtime.submit === "function" ||
    typeof runtime.getStatus === "function" ||
    typeof runtime.getResult === "function" ||
    typeof runtime.cancel === "function"
  ) {
    return false;
  }
  return true;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("Grok Bot journal read timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function baseReport(credentials) {
  return {
    product: "Grok Bot",
    mechanism: "workforce-journal",
    serviceApi: false,
    serviceAuthenticated: false,
    serviceReachable: false,
    xaiModelKeyPresent: credentials.xaiModelKeyPresent,
    xaiAuthorizesGrokBot: false,
    cursorApiKeyPresent: credentials.cursorApiKeyPresent,
    cursorApiAuthorizesGrokBot: false,
    platformTelemetry: credentials.otelCredentialPresent
      ? "credential_present_unwired"
      : "not_configured",
    selfReportIngress: OBSERVATION_INGRESS.selfReport === true ? "implemented" : "unavailable",
    platformIngress: OBSERVATION_INGRESS.otel === true ? "implemented" : "not_configured",
    readOnly: true,
    canSubmit: false,
    journal: "not_queried",
    observedAgents: null,
    observedEvents: null,
    coverage: null,
    textUnreadable: false,
    agents: null,
    agent: null,
    failure: null,
  };
}

export async function probeGrokBotConnection({
  runtime = null,
  userId = null,
  agentId = null,
  env = process.env,
  timeoutMs = null,
  now = null,
} = {}) {
  const report = baseReport(grokBotCredentialPresence(env));
  if (!runtime) {
    report.failure = failure("not_configured");
    return report;
  }
  if (!readOnlyRuntime(runtime)) {
    report.readOnly = false;
    report.failure = failure("not_read_only");
    return report;
  }
  if (typeof userId !== "string" || userId.trim() === "") {
    report.failure = failure("unauthenticated");
    return report;
  }
  try {
    const picture = await withTimeout(
      runtime.picture(userId, { now: now ?? undefined }),
      timeoutMs
    );
    const agents = Array.isArray(picture?.agents) ? picture.agents : [];
    const recent = Array.isArray(picture?.recent) ? picture.recent : [];
    report.journal = "read";
    report.observedAgents = agents.length;
    report.observedEvents = recent.length;
    report.coverage = picture?.coverage ?? null;
    report.textUnreadable = (picture?.gaps ?? []).some((gap) => /could not be read/i.test(gap));
    report.agents = agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName ?? null,
      liveness: agent.liveness ?? null,
      identityTrust: agent.identityTrust ?? null,
      lastEventAt: agent.lastEventAt ?? null,
    }));
    if (agentId != null && agentId !== "") {
      report.agent = (await withTimeout(runtime.getAgent(userId, agentId), timeoutMs)) ?? null;
    }
    return report;
  } catch (error) {
    report.journal = "failed";
    report.failure = failure(classifyReadError(error));
    return report;
  }
}
