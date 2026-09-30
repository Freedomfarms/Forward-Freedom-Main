// CHIEF trace collector — observe one turn and record its steps.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/traces/collector.py (TraceCollector)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - subscribe to inference_start, inference_end, tool_call_start,
//     tool_call_end, and memory_retrieve for the duration of one run
//   - append a final RESPOND step when the turn finishes
//   - persist once, then publish trace_complete
//   - step types are the OpenJarvis StepType values
// Documented adaptations (CHIEF-specific reasons):
//   - This object does not wrap an agent and does not call run(). The
//     TurnMachine already ran the turn. The collector only listens.
//   - ROUTE is recorded from inference_start. Upstream StepType defines it;
//     TraceCollector itself never emitted it.
//   - A capability_denied event becomes a failed TOOL_CALL. Upstream records
//     TOOL_CALL from tool_call_end, which CHIEF publishes only after the
//     tool body has run. A gate refusal must still be visible, and it is
//     not retried.
//   - Detail is an allowlist: model, provider, token counts, retrieval
//     counts, tool name, and success. Query, answer, messages, arguments,
//     and tool output are dropped.
//   - trace_complete carries an id and counts, not the trace body.
//   - A store error is logged and dropped. It does not change the turn.

import { EventType } from "../core/events.js";

export const TRACE_STEP = Object.freeze({
  ROUTE: "ROUTE",
  RETRIEVE: "RETRIEVE",
  GENERATE: "GENERATE",
  TOOL_CALL: "TOOL_CALL",
  RESPOND: "RESPOND",
});

const FORBIDDEN_DETAIL_KEYS = new Set([
  "arguments",
  "content",
  "content_blocks",
  "input",
  "messages",
  "output",
  "query",
  "result",
  "text",
  "tool_calls",
  "tool_results",
]);

export function assertDetailSafe(detail) {
  if (detail == null) return;
  if (typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("trace detail must be a plain object");
  }
  for (const key of Object.keys(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key)) {
      throw new Error(`trace detail cannot store '${key}'`);
    }
  }
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageCount(usage, primary, alias) {
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage[primary] === "number") return usage[primary];
  if (typeof usage[alias] === "number") return usage[alias];
  return 0;
}

function toolName(data) {
  return typeof data?.tool === "string" ? data.tool : "";
}

export class TraceCollector {
  constructor({
    bus = null,
    store = null,
    userId,
    sessionId,
    agentId = "chief",
    logger = console,
  } = {}) {
    if (!userId) throw new TypeError("TraceCollector requires userId");
    this._bus = bus;
    this._store = store;
    this._userId = userId;
    this._sessionId = sessionId ?? null;
    this._agentId = agentId;
    this._logger = logger;
    this._steps = [];
    this._model = null;
    this._provider = null;
    this._engine = null;
    this._turnId = null;
    this._tokensInput = 0;
    this._tokensOutput = 0;
    this._pendingTool = null;
    this._startedAt = new Date();
    this._handlers = null;
  }

  start() {
    if (this._handlers || !this._bus) return;
    this._handlers = [
      [EventType.INFERENCE_START, (event) => this._onInferenceStart(event)],
      [EventType.INFERENCE_END, (event) => this._onInferenceEnd(event)],
      [EventType.TOOL_CALL_START, (event) => this._onToolStart(event)],
      [EventType.TOOL_CALL_END, (event) => this._onToolEnd(event)],
      [EventType.MEMORY_RETRIEVE, (event) => this._onRetrieve(event)],
      [EventType.CAPABILITY_DENIED, (event) => this._onCapabilityDenied(event)],
    ];
    for (const [eventType, handler] of this._handlers) {
      this._bus.subscribe(eventType, handler);
    }
  }

  stop() {
    if (!this._handlers || !this._bus) {
      this._handlers = null;
      return;
    }
    for (const [eventType, handler] of this._handlers) {
      this._bus.unsubscribe(eventType, handler);
    }
    this._handlers = null;
  }

  async finish({ outcome = "completed", sessionId = this._sessionId } = {}) {
    this.stop();
    if (this._pendingTool) {
      this._pushTool(this._pendingTool, false);
      this._pendingTool = null;
    }
    const status = String(outcome || "completed");
    this._push({
      stepType: TRACE_STEP.RESPOND,
      name: null,
      status,
      detail: { outcome: status },
    });
    const record = {
      userId: this._userId,
      sessionId: sessionId ?? this._sessionId,
      turnId: this._turnId,
      agentId: this._agentId,
      model: this._model,
      tokensInput: this._tokensInput,
      tokensOutput: this._tokensOutput,
      outcome: status,
      feedback: null,
      startedAt: this._startedAt,
      completedAt: new Date(),
      steps: this._steps,
    };
    if (!this._store) return { saved: false, trace: null };
    try {
      const saved = await this._store.save(record);
      this._bus?.publish(EventType.TRACE_COMPLETE, {
        traceId: saved?.id ?? null,
        outcome: status,
        stepCount: this._steps.length,
        model: this._model,
      });
      return { saved: true, trace: saved };
    } catch {
      this._logger?.error?.("[chief/traces] save failed");
      return { saved: false, trace: null };
    }
  }

  _rememberCaller(data) {
    const id = data?.caller?.id;
    if (typeof id === "string" && id) this._turnId = id;
  }

  _onInferenceStart(event) {
    const data = event?.data ?? {};
    this._rememberCaller(data);
    if (typeof data.model === "string" && data.model) this._model = data.model;
    if (typeof data.provider === "string" && data.provider) this._provider = data.provider;
    if (typeof data.engine === "string" && data.engine) this._engine = data.engine;
    this._push({
      stepType: TRACE_STEP.ROUTE,
      name: this._model,
      status: "ok",
      detail: {
        model: this._model,
        provider: this._provider,
        engine: this._engine,
      },
    });
  }

  _onInferenceEnd(event) {
    const data = event?.data ?? {};
    this._rememberCaller(data);
    if (typeof data.model === "string" && data.model) this._model = data.model;
    const promptTokens = usageCount(data.usage, "prompt_tokens", "input_tokens");
    const completionTokens = usageCount(data.usage, "completion_tokens", "output_tokens");
    const totalTokens = usageCount(data.usage, "total_tokens", "total");
    this._tokensInput += promptTokens;
    this._tokensOutput += completionTokens;
    this._push({
      stepType: TRACE_STEP.GENERATE,
      name: this._model,
      status: "ok",
      detail: {
        model: this._model,
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || promptTokens + completionTokens,
      },
    });
  }

  _onRetrieve(event) {
    const data = event?.data ?? {};
    this._push({
      stepType: TRACE_STEP.RETRIEVE,
      name: null,
      status: "ok",
      detail: {
        numResults: numberOrZero(data.num_results),
        numFacts: numberOrZero(data.num_facts),
      },
    });
  }

  _onToolStart(event) {
    this._rememberCaller(event?.data);
    this._pendingTool = toolName(event?.data);
  }

  _onToolEnd(event) {
    this._rememberCaller(event?.data);
    const name = toolName(event?.data) || this._pendingTool || "";
    this._pendingTool = null;
    this._pushTool(name, event?.data?.success === true);
  }

  _onCapabilityDenied(event) {
    this._rememberCaller(event?.data);
    this._pendingTool = null;
    this._pushTool(toolName(event?.data), false);
  }

  _pushTool(name, success) {
    this._push({
      stepType: TRACE_STEP.TOOL_CALL,
      name: name || null,
      status: success ? "ok" : "error",
      detail: { tool: name || null, success: Boolean(success) },
    });
  }

  _push(step) {
    assertDetailSafe(step.detail);
    const now = new Date();
    this._steps.push({
      stepType: step.stepType,
      name: step.name ?? null,
      status: step.status ?? null,
      detail: step.detail,
      startedAt: now,
      completedAt: now,
    });
  }
}
