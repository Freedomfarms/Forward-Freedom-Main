// Read one caller-owned interactive transcript from the checkpoint store.
//
// ADAPT of möbius (citizenhicks, Apache-2.0)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source file: crates/mobius-gateway/src/server/dispatch.rs (get_session_history)
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//
// The checkpoint remains the only transcript. This module does not open a
// session runtime, does not write, and does not return a scheduled run.
// A scheduled session (context.origin === "schedule") is not an interactive
// history. Fenced message text is withheld.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { messageText } from "./compaction.js";

const INTERACTIVE_ROLES = new Set(["user", "assistant", "tool"]);

export function projectInteractiveHistory(record) {
  if (!record?.id || !record.checkpoint) return { error: "not_found" };
  if (record.checkpoint.context?.origin === "schedule") return { error: "not_found" };
  const messages = [];
  for (const message of record.checkpoint.transcript ?? []) {
    const role = message?.role;
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const text = messageText(message);
    if (text && fencesOutput(scanInjection(text).threatLevel)) {
      messages.push({ role, text: null });
      continue;
    }
    messages.push({ role, text });
  }
  return { sessionId: record.id, messages };
}
