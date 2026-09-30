// CHIEF scheduled-run retry — bounded re-runs for fires that never reached
// the model.
//
// ADAPT of Hermes Agent (Nous Research, MIT)
//   Upstream: https://github.com/NousResearch/hermes-agent
//   Source files: cron/unreachable_retry.py (RETRY_DELAYS_SECONDS, recurring
//     gate, natural-next give-up), cron/scheduler_preflight.py
//     (_is_transient_provider_resolve_error cause-chain walk)
//   Commit: 8c30ef318d1ed6c88597239081f5749268efdca8
//
// Preserved upstream semantics:
//   - retry only when the failure is a transient network/DNS error AND the
//     run completed zero model calls: nothing was executed or spent, so a
//     re-run cannot double a side effect
//   - ladder of 5, 15, then 30 minutes; then give up until the schedule's own
//     next occurrence
//   - no retry when the natural next occurrence fires at or before the rung
//   - recurring tasks only; a once task was consumed at claim (at-most-once)
//   - the cause chain is walked because transport errors arrive wrapped
// Adaptations:
//   - "Zero model calls" is read from the CHIEF checkpoint: no tool call ran
//     and total_tokens is zero.
//   - Node/undici error codes replace the Python httpx/aiohttp names.
//   - The attempt count lives on ChiefTaskRun.attempts, not on the job JSON.
//   - Always on. There is no config switch to disable it.

export const RETRY_DELAYS_SECONDS = Object.freeze([300, 900, 1800]);

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EAGAIN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const TRANSIENT_NEEDLES = [
  "fetch failed",
  "socket hang up",
  "getaddrinfo",
  "network error",
  "connection reset",
  "connect timeout",
];

export function isTransientNetworkError(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length) {
    const current = queue.shift();
    if (current == null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (TRANSIENT_CODES.has(current.code) || TRANSIENT_CODES.has(current.errno)) return true;
    const message = String(current.message ?? "").toLowerCase();
    if (TRANSIENT_NEEDLES.some((needle) => message.includes(needle))) return true;
    queue.push(current.cause, current.lastError);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return false;
}

export function reachedModel(checkpoint) {
  if (!checkpoint) return false;
  const toolCalls = checkpoint.executionStats?.toolCalls ?? 0;
  const tokens = checkpoint.totalUsage?.total_tokens ?? 0;
  return toolCalls > 0 || tokens > 0;
}

// Returns the retry instant or null. attempts is the number of attempts that
// already ran for this occurrence, including the one that just failed.
export function planRetry({ task, error, checkpoint, attempts, naturalNext, now = new Date() }) {
  if (task?.kind !== "INTERVAL" && task?.kind !== "CRON") return null;
  if (task.status !== "ACTIVE") return null;
  if (!isTransientNetworkError(error)) return null;
  if (reachedModel(checkpoint)) return null;
  const delay = RETRY_DELAYS_SECONDS[attempts - 1];
  if (delay == null) return null;
  const at = new Date(now.getTime() + delay * 1000);
  if (naturalNext && new Date(naturalNext).getTime() <= at.getTime()) return null;
  return at;
}
