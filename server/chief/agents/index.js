// CHIEF depends on these factories, not on a workforce provider.
// createAgentRuntime is the read path. grokbot is connected there.
// createExecutionRuntime is the command path. cursor-cloud is connected there.
// The two contracts are not interchangeable.

import { agentContextReader } from "./context.js";
import { assertReadRuntime } from "./contract.js";
import { createCursorCloudRuntime } from "./cursorCloud.js";
import { assertExecutionRuntime } from "./execution.js";
import { createGrokBotRuntime } from "./grokbot.js";

const READ_PROVIDERS = Object.freeze({
  grokbot: createGrokBotRuntime,
});

const EXECUTION_PROVIDERS = Object.freeze({
  "cursor-cloud": createCursorCloudRuntime,
});

export function createAgentRuntime(options = {}) {
  const provider = options.provider ?? "grokbot";
  const factory = READ_PROVIDERS[provider];
  if (!factory) {
    const error = new Error(`agent runtime provider '${provider}' is not connected`);
    error.code = "AGENT_RUNTIME_NOT_CONNECTED";
    throw error;
  }
  const rest = { ...options };
  delete rest.provider;
  return assertReadRuntime(factory(rest));
}

export function createExecutionRuntime(options = {}) {
  const provider = options.provider ?? "cursor-cloud";
  const factory = EXECUTION_PROVIDERS[provider];
  if (!factory) {
    const error = new Error(
      provider === "grokbot"
        ? "agent execution provider 'grokbot' is read only"
        : `agent execution provider '${provider}' is not connected`
    );
    error.code = "AGENT_EXECUTION_NOT_CONNECTED";
    throw error;
  }
  const rest = { ...options };
  delete rest.provider;
  return assertExecutionRuntime(factory(rest));
}

export { agentContextReader, assertExecutionRuntime, assertReadRuntime };
