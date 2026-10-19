// Questions whose answer is an operational Freedom OS setting or grant.
// Pure model-identity questions stay with the runtime identity rewrite.
// This module does not read settings, call tools, or see credentials.

import { isModelIdentityQuestion } from "../models/identity.js";

const SETTINGS_READ_QUESTION =
  /\b(?:time\s*zone|timezone|eleven\s*labs|elevenlabs|voice (?:settings|configuration|config|status)|speech (?:settings|configuration|config)|model settings)\b/i;

const CAPABILITY_READ_QUESTION =
  /\b(?:permissions|access and permissions|capabilit(?:y|ies)|integrations|connectors|connected systems|what (?:can|could) you (?:see|access|read)|your grants)\b/i;

export function needsSettingsRead(text) {
  return SETTINGS_READ_QUESTION.test(String(text ?? ""));
}

export function needsCapabilityRead(text) {
  return CAPABILITY_READ_QUESTION.test(String(text ?? ""));
}

// The orchestrator uses this to tell the model a live read is required.
// Injection of the tool call is narrower and stays in settleReply.
export function needsOperationalSettingsContext(text) {
  const raw = String(text ?? "");
  return needsSettingsRead(raw) || needsCapabilityRead(raw) || isModelIdentityQuestion(raw);
}
