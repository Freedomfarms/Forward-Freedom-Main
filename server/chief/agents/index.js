// CHIEF depends on this factory, not on a workforce provider.
// grokbot is connected. hermes is a later provider of the same reads.

import { agentContextReader } from "./context.js";
import { assertReadRuntime } from "./contract.js";
import { createGrokBotRuntime } from "./grokbot.js";

const PROVIDERS = Object.freeze({
  grokbot: createGrokBotRuntime,
});

export function createAgentRuntime(options = {}) {
  const provider = options.provider ?? "grokbot";
  const factory = PROVIDERS[provider];
  if (!factory) {
    const error = new Error(`agent runtime provider '${provider}' is not connected`);
    error.code = "AGENT_RUNTIME_NOT_CONNECTED";
    throw error;
  }
  const rest = { ...options };
  delete rest.provider;
  return assertReadRuntime(factory(rest));
}

export { agentContextReader, assertReadRuntime };
