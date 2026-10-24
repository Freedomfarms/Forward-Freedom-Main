// Follows one open CHIEF conversation until the Managed Agents turn settles.
// The loop has no time cap: a long reply stays in Reasoning or Responding and
// is spoken once by the caller after this returns settled. A dropped connection
// retries the same session. Stop, switch, and a new message leave isCurrent().

import { isActiveChiefTurn } from "./chiefProtocol.js";

export const FOLLOW_IDLE_MS = 4000;
export const FOLLOW_GAP_MS = 300;
export const CHIEF_FOLLOW_CONNECTION =
  "The connection dropped. CHIEF is still finishing this response.";

export function followWaitMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 2000) return FOLLOW_IDLE_MS;
  return FOLLOW_GAP_MS;
}

export function isRetryableFollowError(error) {
  if (!error || error.name === "AbortError") return false;
  const status = error.status;
  if (status === undefined || status === null || status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

// Speech belongs to the gesture that sent the message. Stop, a conversation
// switch, and a newer turn all fail this check.
export function canAutoSpeak({
  aborted = false,
  epoch = 0,
  currentEpoch = 0,
  speak = false,
  sessionId = null,
  activeSessionId = null,
} = {}) {
  if (aborted || speak !== true) return false;
  if (epoch !== currentEpoch) return false;
  if (sessionId && activeSessionId && sessionId !== activeSessionId) return false;
  return true;
}

export async function followManagedTurn({
  sessionId = null,
  stream,
  readHistory,
  isCurrent,
  onUpdate,
  wait,
}) {
  let resume = false;
  let turn = {
    sessionId,
    turnStatus: "running",
    streamText: "",
    finished: false,
    status: "Working",
  };
  while (isCurrent()) {
    const started = Date.now();
    try {
      const next = await stream({ resume, sessionId: resume ? turn.sessionId : sessionId });
      if (next && typeof next === "object") turn = next;
    } catch (error) {
      if (!isCurrent() || error?.name === "AbortError") return { reason: "cancelled", turn };
      const id = turn.sessionId || sessionId;
      if (!id || !isRetryableFollowError(error)) return { reason: "error", error, turn };
      turn = { ...turn, sessionId: id, turnStatus: "continuing", finished: false };
      onUpdate?.(turn, { connectionError: error });
      resume = true;
      if (await wait(FOLLOW_IDLE_MS)) return { reason: "cancelled", turn };
      continue;
    }
    if (!isCurrent()) return { reason: "cancelled", turn };
    if (!turn?.sessionId || !isActiveChiefTurn(turn.turnStatus)) {
      return { reason: "settled", turn };
    }
    try {
      const snapshot = await readHistory(turn.sessionId);
      if (!isCurrent()) return { reason: "cancelled", turn };
      const nextStatus = typeof snapshot?.turnStatus === "string" ? snapshot.turnStatus : "";
      if (nextStatus && !isActiveChiefTurn(nextStatus)) {
        return {
          reason: "settled",
          turn: {
            ...turn,
            turnStatus: nextStatus,
            finished: nextStatus !== "suspended",
            history: snapshot,
          },
        };
      }
    } catch (error) {
      if (!isCurrent()) return { reason: "cancelled", turn };
      if (!isRetryableFollowError(error)) return { reason: "error", error, turn };
      onUpdate?.(turn, { connectionError: error });
    }
    resume = true;
    onUpdate?.(turn);
    if (await wait(followWaitMs(Date.now() - started))) return { reason: "cancelled", turn };
  }
  return { reason: "cancelled", turn };
}
