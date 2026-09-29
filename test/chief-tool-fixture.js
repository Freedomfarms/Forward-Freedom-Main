// Shared fixture for turn/API tests that need a real gated executor.
// lookup is uninventoried, so the capability floor is system:admin, and the
// policy grants exactly that. requiresConfirmation matches the mutation bit
// the turn classifies.

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { BaseTool } from "../server/chief/tools/spec.js";

export function lookupExecutor({ onExecute, requiresConfirmation = true, output = "found" } = {}) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", Capability.SYSTEM_ADMIN);
  const tool = new BaseTool({
    isLocal: true,
    spec: {
      name: "lookup",
      description: "find",
      requiresConfirmation,
      timeoutSeconds: 5,
      requiredCapabilities: [Capability.SYSTEM_ADMIN],
      parameters: { type: "object", properties: { q: { type: "string" } } },
    },
    async execute(_params, context) {
      onExecute?.(context.call, context);
      return { output };
    },
  });
  return new ToolExecutor({ tools: [tool], policy });
}
