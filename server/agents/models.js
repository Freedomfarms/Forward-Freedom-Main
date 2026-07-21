// Allowlisted Anthropic model ids for CEO Agent and sub-agents.
// Background jobs (profile extraction, conversation titles) stay on Haiku
// via PROFILE_EXTRACTION_MODEL in llm.js and are not user-selectable.

export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-5";

export const ALLOWED_AGENT_MODELS = Object.freeze([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-1",
]);

/** Friendly labels for UI / chat prompts (no billing language). */
export const AGENT_MODEL_OPTIONS = Object.freeze([
  {
    value: "claude-haiku-4-5",
    shortLabel: "Haiku",
    label: "Haiku — Fastest",
    description: "Quick replies for everyday questions.",
  },
  {
    value: "claude-sonnet-4-5",
    shortLabel: "Sonnet",
    label: "Sonnet — Balanced (recommended)",
    description: "Strong default for most chats and agents.",
  },
  {
    value: "claude-opus-4-1",
    shortLabel: "Opus",
    label: "Opus — Smartest",
    description: "Deepest reasoning for harder decisions.",
  },
]);

export function isValidAgentModel(value) {
  return typeof value === "string" && ALLOWED_AGENT_MODELS.includes(value);
}

export function normalizeAgentModel(value, fallback = DEFAULT_AGENT_MODEL) {
  return isValidAgentModel(value) ? value : fallback;
}

/** Parse casual chat answers like "haiku", "sonnet please", "use opus". */
export function parseAgentModelChoice(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower.trim()) return null;
  // Prefer explicit model names before skip/default synonyms.
  if (/\bhaiku\b/.test(lower)) return "claude-haiku-4-5";
  if (/\bopus\b/.test(lower)) return "claude-opus-4-1";
  if (/\bsonnet\b/.test(lower)) return "claude-sonnet-4-5";
  if (/\b(skip|default|recommended)\b/.test(lower)) return "claude-sonnet-4-5";
  return null;
}

export function getAgentModelLabel(value) {
  return (
    AGENT_MODEL_OPTIONS.find((option) => option.value === value)?.label ||
    AGENT_MODEL_OPTIONS.find((option) => option.value === DEFAULT_AGENT_MODEL).label
  );
}
