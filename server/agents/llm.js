import { generateText as aiGenerateText, generateObject as aiGenerateObject } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";

import { AgentError } from "./errors.js";
import { DEFAULT_AGENT_MODEL } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// Single chokepoint for every model call the agent platform makes.
//
// All agent modules call generateAgentText / generateAgentObject with a model
// ID STRING; this module resolves it against the platform Anthropic provider
// (one shared ANTHROPIC_API_KEY — users never supply their own key). Tests
// replace the implementation with setLlmImplementationForTesting so no unit
// test can ever reach the real Anthropic API, and so tests can capture the
// exact prompt payload for data-minimization assertions.
// ─────────────────────────────────────────────────────────────────────────────

// Cheap fast tier used for invisible background jobs (profile extraction,
// conversation titles). Not user-selectable — stays on Haiku regardless of
// the CEO / sub-agent model pickers.
export const PROFILE_EXTRACTION_MODEL = "claude-haiku-4-5";

// Fallback when a stored CEO model is missing/unmigrated. Prefer the value on
// CeoAgentConfig.model at call sites.
export const CEO_AGENT_MODEL = DEFAULT_AGENT_MODEL;

let llmImplementationOverride = null;

export function setLlmImplementationForTesting(implementation) {
  llmImplementationOverride = implementation || null;
}

export function isLlmConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getProvider() {
  if (!isLlmConfigured()) {
    // Degrade cleanly when the platform key is missing: a typed error the
    // runner records as a failed run instead of an unhandled crash.
    throw new AgentError(
      "The AI service is not configured (missing ANTHROPIC_API_KEY).",
      "LLM_NOT_CONFIGURED",
      503
    );
  }
  return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Anthropic's provider-executed web search tool — the ONLY tool any agent may
// use, and it is read-only by construction (Anthropic executes the search;
// no code or network access runs on our side).
export function getWebSearchTools({ maxUses = 5 } = {}) {
  return { web_search: anthropic.tools.webSearch_20250305({ maxUses }) };
}

// `model` is always a string model id (e.g. from AgentConfig.model); it is
// resolved to a provider model here so callers never touch the provider.
export async function generateAgentText({ model, ...options }) {
  if (llmImplementationOverride?.generateText) {
    return llmImplementationOverride.generateText({ model, ...options });
  }
  return aiGenerateText({ model: getProvider()(model), ...options });
}

export async function generateAgentObject({ model, ...options }) {
  if (llmImplementationOverride?.generateObject) {
    return llmImplementationOverride.generateObject({ model, ...options });
  }
  return aiGenerateObject({ model: getProvider()(model), ...options });
}
