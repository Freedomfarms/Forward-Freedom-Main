// Provider-neutral read contract between CHIEF and an execution workforce.
//
// CHIEF asks this object what the workforce has been observed doing.
// The object does not run tools, edit a repository, or submit work.
// Grok Bot is the current provider. A later provider implements the same
// reads. Command methods are absent because neither provider is connected
// as a control plane.

export const AGENT_RUNTIME_EFFECTS = Object.freeze(["read"]);

const READS = Object.freeze(["listAgents", "getAgent", "listEvents", "picture"]);

export function assertReadRuntime(runtime) {
  if (typeof runtime?.provider !== "string" || runtime.provider.trim() === "") {
    throw new TypeError("agent runtime requires a provider");
  }
  if (
    !Array.isArray(runtime.effects) ||
    runtime.effects.length !== 1 ||
    runtime.effects[0] !== "read"
  ) {
    throw new TypeError("agent runtime effects are read only");
  }
  for (const name of READS) {
    if (typeof runtime[name] !== "function") {
      throw new TypeError(`agent runtime is missing ${name}`);
    }
  }
  return runtime;
}
