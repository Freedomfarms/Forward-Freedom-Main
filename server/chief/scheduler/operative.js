// CHIEF operative tick input — the message a scheduled task submits to the
// turn machine, plus the operator state carried between runs.
//
// ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/agents/operative.py (_recall_state,
//     "## Previous State" section, _auto_persist_state)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Preserved upstream semantics:
//   - state key operator:{id}:state; the id is the scheduled task id
//   - recalled state is added under a "## Previous State" heading
//   - after a run the response is auto-persisted as state, truncated to
//     1000 characters
// Adaptations:
//   - Nothing here runs a loop or calls a model. The message goes to the
//     existing TurnMachine; OperativeAgent's own tool loop is not ported.
//   - State lives in chief_middleware_state on the run's session (the
//     checkpoint store), not in a separate memory backend.
//   - Recalled state and the stored prompt go into the user message, not the
//     system prompt. Both came from earlier model output or tool input and
//     must not gain system authority.
//   - The stored prompt is injection-scanned before it becomes a message. A
//     fenced (HIGH/CRITICAL) prompt is refused. Fenced state is dropped.
//   - The model cannot write the state key explicitly. Only auto-persist.
//   - A scheduled run is quiet. Hermes cron/scheduler_delivery.py treats an
//     empty deliver value as "local" (no push). CHIEF has no delivery target,
//     so quietAttention() is always false and does not read the answer.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { TaintLabel, autoDetectTaint, unionTaint } from "../security/taint.js";

export const OPERATOR_STATE_MAX_CHARS = 1000;
export const PROMPT_MAX_CHARS = 8000;

export function operatorStateKey(taskId) {
  return `operator:${taskId}:state`;
}

export function taskPrompt(task) {
  const prompt = task?.payload?.prompt;
  return typeof prompt === "string" ? prompt.trim() : "";
}

export function lastAssistantText(transcript = []) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

// No delivery target means no push. Arguments are ignored on purpose: model
// prose, an address, and tool output cannot raise attention.
export function quietAttention() {
  return false;
}

export function stateFromResponse(text, { runId, at }) {
  const summary = String(text ?? "").trim();
  if (!summary) return null;
  return { summary: summary.slice(0, OPERATOR_STATE_MAX_CHARS), runId, at: at.toISOString() };
}

// Returns { rejected, reason } or { text, sessionTaint, stateDropped }.
export function prepareScheduledMessage({ task, previousState = null, firedAt }) {
  const prompt = taskPrompt(task);
  if (!prompt) return { rejected: true, reason: "no_prompt" };
  if (prompt.length > PROMPT_MAX_CHARS) return { rejected: true, reason: "prompt_too_long" };
  const promptScan = scanInjection(prompt);
  if (fencesOutput(promptScan.threatLevel)) {
    return {
      rejected: true,
      reason: "prompt_rejected",
      findings: [...new Set(promptScan.findings.map((finding) => finding.patternName))],
    };
  }

  let stateText = typeof previousState?.summary === "string" ? previousState.summary : "";
  let stateDropped = false;
  let stateScan = null;
  if (stateText) {
    stateScan = scanInjection(stateText);
    if (fencesOutput(stateScan.threatLevel)) {
      stateText = "";
      stateDropped = true;
    }
  }

  const parts = [
    `[Scheduled task "${task.name}" fired at ${firedAt.toISOString()}. ` +
      "No user is present. Actions that require approval will wait for the user.]",
  ];
  if (stateText) parts.push(`## Previous State\n${stateText}`);
  parts.push(`## Task\n${prompt}`);
  const text = parts.join("\n\n");

  let sessionTaint = autoDetectTaint(text);
  if (!promptScan.isClean || (stateScan && !stateScan.isClean)) {
    sessionTaint = unionTaint(sessionTaint, [TaintLabel.EXTERNAL]);
  }
  return { rejected: false, text, sessionTaint, stateDropped };
}
