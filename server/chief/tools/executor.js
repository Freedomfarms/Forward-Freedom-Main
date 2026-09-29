// CHIEF tool-execution boundary.
//
// Phase 3 does not implement the OpenJarvis ToolExecutor gate pipeline. That
// pipeline (rate limit → boundary guard → capability RBAC → taint policy →
// confirmation → timeout → output scan) is Phase 4 and will be the body of
// `execute()` below, in this order, before any tool function runs.
//
// Until those gates exist, execute() fail-closes. The turn machine has no
// other way to run a tool: AI SDK tool `execute` callbacks are refused by
// the model engine. A test may inject `handler` to observe the boundary;
// production does not.

export const TOOL_EXECUTOR_GATE_ORDER = Object.freeze([
  "rate_limit",
  "boundary_guard",
  "capability_rbac",
  "taint_policy",
  "confirmation",
  "timeout",
  "output_scan",
]);

export const TOOLS_UNAVAILABLE =
  "tool execution is unavailable until the ToolExecutor gate pipeline is installed";

export class ToolExecutor {
  constructor({ handler = null } = {}) {
    this._handler = handler;
    this.gatesInstalled = false;
  }

  async execute(call, context) {
    if (!this._handler) {
      return {
        callId: call.callId,
        name: call.name,
        output: TOOLS_UNAVAILABLE,
        isError: true,
      };
    }
    const result = await this._handler(call, context);
    return {
      callId: call.callId,
      name: call.name,
      output: typeof result?.output === "string" ? result.output : "",
      isError: Boolean(result?.isError),
    };
  }
}
