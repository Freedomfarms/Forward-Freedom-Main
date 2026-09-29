// CHIEF tool executor — the only path that runs a tool.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/tools/_stubs.py (ToolExecutor.execute)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Gate order matches the Phase 3 constant. Upstream skips a gate when its
// dependency was not injected (fail-open). CHIEF installs every gate and
// refuses the call when one is missing.
//
// Confirmation does not call a callback and does not write an approval row.
// ApprovalCoordinator already decided. This gate only checks that a tool
// with requiresConfirmation was granted mutationApproved by that decision.
//
// Output scan fences non-local results after the timed call returns and
// before the result is released. The scan gate is still mandatory: a missing
// scanner refuses the call before execution. Upstream swallows scanner
// exceptions; CHIEF returns an error and does not release the raw text.
//
// Timeout is a wait bound. The timer aborts an AbortSignal the tool may
// observe. A tool that ignores the signal keeps running; this module does
// not claim that work was cancelled. Python cannot cancel a running thread
// either (see _BoundedToolRunner in the upstream file).
//
// The Rust executor (rust/crates/openjarvis-tools/src/executor.rs) is not
// used. It has no rate limit, boundary, confirmation, or output scan.

import { EventType } from "../core/events.js";
import { canonicalToolCapabilities } from "../core/capabilities.js";
import { BoundaryGuard } from "../security/boundary.js";
import { MemoryAuditLog } from "../security/audit.js";
import { fenceUntrustedOutput, fencesOutput, scanInjection } from "../security/injection.js";
import { RateLimiter, rateLimitKey } from "../security/rate-limit.js";
import { autoDetectTaint, checkTaint, normalizeTaint, unionTaint } from "../security/taint.js";
import { CHIEF_TOOL_INVENTORY, assertToolAllowed } from "./inventory.js";

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

const PRE_EXECUTION = Object.freeze([
  "rate_limit",
  "boundary_guard",
  "capability_rbac",
  "taint_policy",
  "confirmation",
]);

export class ToolExecutor {
  constructor({
    tools = [],
    bus = null,
    policy = null,
    rateLimiter = new RateLimiter(),
    boundaryGuard = new BoundaryGuard(),
    audit = new MemoryAuditLog(),
    inventory = CHIEF_TOOL_INVENTORY,
    onGate = null,
    omitGates = [],
  } = {}) {
    this._tools = new Map();
    for (const tool of tools) {
      assertToolAllowed(tool.spec);
      if (this._tools.has(tool.spec.name)) {
        throw new Error(`tool '${tool.spec.name}' is already registered`);
      }
      this._tools.set(tool.spec.name, tool);
    }
    this._bus = bus;
    this._policy = policy;
    this._rateLimiter = rateLimiter;
    this._boundaryGuard = boundaryGuard;
    this._audit = audit;
    this._inventory = inventory;
    this._onGate = onGate;
    this._gates = {
      rate_limit: (state) => this._rateLimit(state),
      boundary_guard: (state) => this._boundary(state),
      capability_rbac: (state) => this._capability(state),
      taint_policy: (state) => this._taint(state),
      confirmation: (state) => this._confirmation(state),
      timeout: (state) => this._timeout(state),
      output_scan: (state) => this._outputScan(state),
    };
    for (const name of omitGates) delete this._gates[name];
    this.gatesInstalled = TOOL_EXECUTOR_GATE_ORDER.every(
      (name) => typeof this._gates[name] === "function"
    );
  }

  async execute(call, context = {}) {
    const sessionTaint = normalizeTaint(context.sessionTaint);
    const missing = TOOL_EXECUTOR_GATE_ORDER.filter(
      (name) => typeof this._gates[name] !== "function"
    );
    if (!this.gatesInstalled || missing.length > 0) {
      return this._denied(call, context, sessionTaint, {
        action: "tool.gate_missing",
        output: `${TOOLS_UNAVAILABLE} (missing: ${missing.join(", ") || "pipeline"})`,
        event: null,
      });
    }

    const tool = this._tools.get(call?.name);
    if (!tool) {
      return this._denied(call, context, sessionTaint, {
        action: "tool.unknown",
        output: `Unknown tool: ${call?.name ?? ""}`,
        event: null,
      });
    }

    let params;
    try {
      params = argumentsOf(call);
    } catch (error) {
      return this._denied(call, context, sessionTaint, {
        action: "tool.invalid_arguments",
        output: `Invalid arguments: ${error.message || "expected a JSON object"}`,
      });
    }

    const state = {
      call,
      context,
      tool,
      params,
      sessionTaint,
      output: "",
      isError: false,
    };
    for (const name of PRE_EXECUTION) {
      this._onGate?.(name);
      const verdict = await this._gates[name](state);
      if (!verdict.allow) {
        return this._denied(call, context, state.sessionTaint, verdict);
      }
    }

    this._onGate?.("timeout");
    const ran = await this._gates.timeout(state);
    if (!ran.allow) {
      return this._denied(call, context, state.sessionTaint, ran);
    }

    this._onGate?.("output_scan");
    const scanned = await this._gates.output_scan(state);
    if (!scanned.allow) {
      return this._denied(call, context, state.sessionTaint, scanned);
    }

    this._publish(EventType.TOOL_CALL_END, {
      tool: tool.spec.name,
      success: !state.isError,
      result: String(state.output ?? "").slice(0, 10240),
      agent: context.agentId || "chief",
      caller: context.caller ?? null,
    });
    return {
      callId: call.callId,
      name: call.name,
      output: state.output,
      isError: state.isError,
      sessionTaint: state.sessionTaint,
      cancelled: false,
    };
  }

  async _rateLimit(state) {
    const key = rateLimitKey({
      userId: state.context.userId,
      agentId: state.context.agentId || "chief",
      toolName: state.tool.spec.name,
    });
    const { allowed, waitSeconds } = this._rateLimiter.check(key);
    if (allowed) return { allow: true };
    this._publish(EventType.RATE_LIMITED, {
      agent_id: state.context.agentId || "chief",
      tool: state.tool.spec.name,
      wait_seconds: waitSeconds,
      caller: state.context.caller ?? null,
    });
    return {
      allow: false,
      action: "tool.rate_limited",
      output: `Rate limit exceeded for tool '${state.tool.spec.name}'. Retry after ${waitSeconds.toFixed(1)}s.`,
      event: EventType.RATE_LIMITED,
    };
  }

  async _boundary(state) {
    const verdict = this._boundaryGuard.check(state.tool);
    if (verdict.allow) return { allow: true };
    this._publish(EventType.SECURITY_ALERT, {
      source: "boundary_guard",
      destination: `tool:${state.tool.spec.name}`,
      mode: "block",
      caller: state.context.caller ?? null,
    });
    return {
      allow: false,
      action: "tool.boundary_blocked",
      output: verdict.output,
      event: EventType.SECURITY_BLOCK,
    };
  }

  async _capability(state) {
    if (!this._policy) {
      return {
        allow: false,
        action: "tool.capability_denied",
        output: "capability policy is missing; refusing the call",
      };
    }
    const remote = state.tool.isLocal === false;
    const required = [...state.tool.spec.requiredCapabilities];
    for (const cap of canonicalToolCapabilities(state.tool.spec.name, {
      remote,
      inventory: this._inventory,
    })) {
      if (!required.includes(cap)) required.push(cap);
    }
    const agentId = state.context.agentId ?? "chief";
    for (const cap of required) {
      if (!this._policy.check(agentId, cap, state.tool.spec.name)) {
        this._publish(EventType.CAPABILITY_DENIED, {
          agent_id: agentId,
          capability: cap,
          tool: state.tool.spec.name,
          caller: state.context.caller ?? null,
        });
        return {
          allow: false,
          action: "tool.capability_denied",
          output: `Capability '${cap}' denied for agent '${agentId}' on tool '${state.tool.spec.name}'.`,
          event: EventType.CAPABILITY_DENIED,
        };
      }
    }
    return { allow: true };
  }

  async _taint(state) {
    const detected = autoDetectTaint(safeJson(state.params));
    state.sessionTaint = unionTaint(state.sessionTaint, detected);
    const violation = checkTaint(state.tool.spec.name, state.sessionTaint);
    if (!violation) return { allow: true };
    this._publish(EventType.TAINT_VIOLATION, {
      tool: state.tool.spec.name,
      violation,
      caller: state.context.caller ?? null,
    });
    return {
      allow: false,
      action: "tool.taint_violation",
      output: `Taint violation: ${violation}`,
      event: EventType.TAINT_VIOLATION,
    };
  }

  async _confirmation(state) {
    if (!state.tool.spec.requiresConfirmation) return { allow: true };
    if (state.context.mutationApproved === true) return { allow: true };
    return {
      allow: false,
      action: "tool.confirmation_required",
      output:
        `Tool '${state.tool.spec.name}' requires confirmation ` +
        "but ApprovalCoordinator has not granted this call.",
    };
  }

  async _timeout(state) {
    const timeoutSeconds = state.tool.spec.timeoutSeconds;
    const controller = new AbortController();
    let timer;
    const timed = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ timedOut: true });
      }, timeoutSeconds * 1000);
    });
    this._publish(EventType.TOOL_CALL_START, {
      tool: state.tool.spec.name,
      arguments: state.params,
      agent: state.context.agentId || "chief",
      caller: state.context.caller ?? null,
    });
    const execution = Promise.resolve()
      .then(() =>
        state.tool.execute(state.params, {
          ...state.context,
          call: state.call,
          signal: controller.signal,
          sessionTaint: state.sessionTaint,
        })
      )
      .then((result) => ({ timedOut: false, result }))
      .catch((error) => ({ timedOut: false, error }));
    const winner = await Promise.race([execution, timed]);
    clearTimeout(timer);
    if (winner.timedOut) {
      this._publish(EventType.TOOL_TIMEOUT, {
        tool: state.tool.spec.name,
        timeout: timeoutSeconds,
        cancelled: false,
        caller: state.context.caller ?? null,
      });
      return {
        allow: false,
        action: "tool.timeout",
        output:
          `Tool '${state.tool.spec.name}' timed out after ${timeoutSeconds}s. ` +
          "The wait bound elapsed; the underlying operation was not cancelled.",
        event: EventType.TOOL_TIMEOUT,
        cancelled: false,
      };
    }
    if (winner.error) {
      state.output = `Tool execution error: ${winner.error.message || winner.error}`;
      state.isError = true;
      return { allow: true };
    }
    const result = winner.result ?? {};
    state.output = typeof result.output === "string" ? result.output : "";
    state.isError = Boolean(result.isError);
    if (Array.isArray(result.sessionTaint)) {
      state.sessionTaint = unionTaint(state.sessionTaint, result.sessionTaint);
    }
    return { allow: true };
  }

  async _outputScan(state) {
    if (state.isError || state.tool.isLocal !== false || !state.output) {
      if (!state.isError && state.output) {
        state.sessionTaint = unionTaint(state.sessionTaint, autoDetectTaint(state.output));
      }
      return { allow: true };
    }
    let scan;
    try {
      scan = scanInjection(state.output);
    } catch (error) {
      state.output = "";
      return {
        allow: false,
        action: "tool.output_scan_failed",
        output: `output scan failed closed: ${error.message || "scanner error"}`,
      };
    }
    state.sessionTaint = unionTaint(state.sessionTaint, autoDetectTaint(state.output));
    if (scan.isClean) return { allow: true };
    this._publish(EventType.SECURITY_ALERT, {
      source: "tool_output_injection_scan",
      tool: state.tool.spec.name,
      threat_level: scan.threatLevel,
      findings: scan.findings.length,
      caller: state.context.caller ?? null,
    });
    if (fencesOutput(scan.threatLevel)) {
      state.output = fenceUntrustedOutput(state.output);
      await this._writeAudit(state.call, state.context, {
        action: "tool.output_fenced",
        output: `fenced ${scan.threatLevel} injection pattern in '${state.tool.spec.name}' output`,
      });
    }
    return { allow: true };
  }

  async _denied(call, context, sessionTaint, verdict) {
    await this._writeAudit(call, context, verdict);
    return {
      callId: call?.callId,
      name: call?.name,
      output: verdict.output,
      isError: true,
      sessionTaint,
      cancelled: verdict.cancelled === true ? false : false,
    };
  }

  async _writeAudit(call, context, verdict) {
    if (!this._audit || !verdict?.action) return;
    try {
      await this._audit.write({
        userId: context?.userId ?? null,
        actor: context?.caller?.kind || context?.agentId || "chief",
        action: verdict.action,
        resource: call?.name ?? null,
        summary: verdict.output,
      });
    } catch {
      // The denial still stands when the audit write fails.
    }
  }

  _publish(eventType, data) {
    this._bus?.publish(eventType, data);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

function argumentsOf(call) {
  const value = call?.arguments;
  if (value == null) return {};
  if (typeof value === "string") {
    if (value.trim() === "") return {};
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("tool arguments must be an object");
    }
    return parsed;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value;
}
