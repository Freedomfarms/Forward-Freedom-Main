// Execution contract for a provider that can run approved work.
//
// This object is not the read contract. A read provider does not gain
// command methods, and an execution provider does not read the observation
// journal. TurnMachine does not call this contract. Conversational
// acceptance is not approval. ChiefApproval stores a tool batch, not an
// objective, repository, ref, and execution scope, so submit stays behind
// an explicit scope match until that approval exists.

export const EXECUTION_EFFECTS = Object.freeze(["execute"]);

export const RUN_STATUSES = Object.freeze([
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

const TERMINAL_STATUSES = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
const COMMANDS = Object.freeze(["submit", "getStatus", "getResult", "cancel"]);
const READS = Object.freeze(["listAgents", "getAgent", "listEvents", "picture"]);

export class ExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

export function isRunStatus(value) {
  return RUN_STATUSES.includes(value);
}

export function isTerminalStatus(value) {
  return TERMINAL_STATUSES.has(value);
}

export function assertExecutionRuntime(runtime) {
  if (typeof runtime?.provider !== "string" || runtime.provider.trim() === "") {
    throw new TypeError("execution runtime requires a provider");
  }
  if (
    !Array.isArray(runtime.effects) ||
    runtime.effects.length !== 1 ||
    runtime.effects[0] !== "execute"
  ) {
    throw new TypeError("execution runtime effects are execute only");
  }
  for (const name of COMMANDS) {
    if (typeof runtime[name] !== "function") {
      throw new TypeError(`execution runtime is missing ${name}`);
    }
  }
  for (const name of READS) {
    if (typeof runtime[name] === "function") {
      throw new TypeError("execution runtime cannot observe the workforce journal");
    }
  }
  return runtime;
}

export function isExactRepositoryUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 300) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.href !== value) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (segments.some((part) => part === "." || part === "..")) return false;
  return true;
}

export function isProtectedRepository(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (/freedom[\s._-]*financial/.test(normalized)) return true;
  let segments;
  try {
    segments = new URL(normalized).pathname
      .split("/")
      .filter(Boolean)
      .map((part) => part.replace(/\.git$/, ""));
  } catch {
    segments = normalized.split(/[/:]/).filter(Boolean);
  }
  return segments.some((part) => part === "xrp" || part === "freedomfinancial");
}

function copy(record) {
  return record ? structuredClone(record) : null;
}

// Process-local stand-in for adapter tests. WorkforceExecution is the
// source of truth. Do not use this map for a granted execution.
export function createMemoryExecutionLedger() {
  const records = new Map();

  return {
    async begin(approvalId, next) {
      const current = records.get(approvalId);
      if (!current || current.state === "rejected") {
        records.set(approvalId, next);
        return { action: "start" };
      }
      if (current.state === "submitted") {
        return { action: "duplicate", record: copy(current) };
      }
      return { action: "blocked", record: copy(current) };
    },

    async finish(approvalId, expectedState, patch) {
      const current = records.get(approvalId);
      if (!current || current.state !== expectedState) {
        return { ok: false, record: copy(current) };
      }
      const stored = { ...current, ...patch };
      records.set(approvalId, stored);
      return { ok: true, record: copy(stored) };
    },

    async findRun(agentId, runId) {
      const matches = [];
      for (const record of records.values()) {
        if (record.state === "submitted" && record.agentId === agentId && record.runId === runId) {
          matches.push(record);
        }
      }
      if (matches.length !== 1) return null;
      return copy(matches[0]);
    },

    async markStatus(approvalId, status) {
      const current = records.get(approvalId);
      if (!current || current.state !== "submitted") return null;
      const stored = { ...current, status };
      records.set(approvalId, stored);
      return copy(stored);
    },
  };
}
