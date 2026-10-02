// CHIEF turn state machine — one durable turn, resumable across invocations.
//
// PORT/ADAPT of möbius (citizenhicks, Apache-2.0; NOTICE reproduced in
// THIRD_PARTY_NOTICES.md — derived in part from OpenAI Codex and Ratatui)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source files: src/agent/turn.rs, src/agent/turn/model.rs, src/agent/mod.rs
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//   License text: licenses/MOBIUS-LICENSE-APACHE-2.0.txt (NOTICE: licenses/MOBIUS-NOTICE.txt)
//
// Preserved upstream semantics:
//   - phases prepare → model → tool authorize (execute vs approval) → execute
//     → model → completion
//   - pending_approval suspends the turn; a later invocation re-emits the
//     request until an ExecApproval for that id arrives
//   - denied calls become synthetic error tool results; abort ends the turn
//   - approved_for_session sticky keys survive on the checkpoint
//   - interrupts end the turn
//   - provider-private fields are not written to the checkpoint
// Documented adaptations (CHIEF-specific reasons):
//   - A turn runs inside one HTTP invocation and suspends by returning.
//     There is no resident task (docs/CHIEF_ARCHITECTURE.md §7.2).
//   - The model step is AI SDK streamText on engine.openStream's resolved
//     LanguageModel. Vendor SDKs are not imported here.
//   - Tool calls are never executed by the AI SDK. Authorize, then
//     ToolExecutor. requiresConfirmation tools are the mutation ids passed
//     to ApprovalCoordinator. Read tools are not. The executor re-checks
//     that grant; it does not approve anything itself.
//   - caller on the tool call is the same caller as the model call, including
//     kind "schedule". This file does not schedule.
//   - A batch that needs approval is not half-executed before suspension.
//     Calls already allowed by policy are stored as preApprovedCallIds and
//     run, with the decision, on resume. Denied siblings still get synthetic
//     errors (möbius partial-batch rule).
//   - A crash during streamText leaves the checkpoint at phase "model", so
//     resume repeats the model step (at-least-once). The checkpoint is saved
//     before the call and after it, not mid-token.
//   - caller on the model call defaults to user_turn. The scheduler tick
//     (server/chief/scheduler/tick.js) passes kind "schedule" and trigger
//     "schedule:<taskId>" into the same machine; this file does not schedule.

import { randomUUID } from "node:crypto";

import { jsonSchema, tool } from "ai";

import { BudgetExceededError } from "../models/budget.js";
import { ModelLayerPausedError, ModelUnavailableError } from "../models/engine.js";
import {
  EventMsgType,
  ModelStepContentPhase,
  OpType,
  eventMsg,
  makeEvent,
  parseReviewDecision,
  parseSubmission,
  tokenUsageCheckedAdd,
} from "../protocol/index.js";
import { ApprovalCoordinator, ReviewDecisionType } from "./approvals.js";
import { HANDOFF_STATE_KEY, compactTranscript } from "./compaction.js";
import { lastTurnUserText } from "../context/assemble.js";
import { TraceCollector } from "../traces/collector.js";
import { effectRequiresExplicitConfirmation } from "../capabilities/descriptor.js";
import { ToolExecutor } from "../tools/executor.js";

export function classifyToolCalls(calls, specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return { mutationIds: calls.map((call) => call.callId), readIds: [], explicitIds: [] };
  }
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const mutationIds = [];
  const readIds = [];
  const explicitIds = [];
  for (const call of calls) {
    const spec = byName.get(call.name);
    if (spec && spec.requiresConfirmation !== true) {
      readIds.push(call.callId);
    } else {
      mutationIds.push(call.callId);
      if (effectRequiresExplicitConfirmation(spec?.effect)) explicitIds.push(call.callId);
    }
  }
  return { mutationIds, readIds, explicitIds };
}

export const TurnPhase = Object.freeze({
  PREPARE: "prepare",
  MODEL: "model",
  TOOL_AUTHORIZE: "tool_authorize",
  EXECUTE: "execute",
  COMPLETION: "completion",
});

export const MAX_MODEL_STEPS = 8;

const DECISION_ENUM = {
  [ReviewDecisionType.APPROVED]: "APPROVED",
  [ReviewDecisionType.APPROVED_FOR_SESSION]: "APPROVED_FOR_SESSION",
  [ReviewDecisionType.DENIED]: "DENIED",
  [ReviewDecisionType.ABORT]: "ABORTED",
};

function lastAssistantText(transcript) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

function lastUserText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
  }
  return "";
}

export function toolSpecsToAiTools(specs = []) {
  const tools = {};
  for (const spec of specs) {
    if (typeof spec.execute === "function") {
      throw new Error(`refusing executable tool spec '${spec.name}'`);
    }
    const definition = tool({
      description: spec.description ?? spec.name,
      inputSchema: jsonSchema(spec.parameters ?? { type: "object", properties: {} }),
    });
    if (typeof definition.execute === "function") {
      throw new Error(`refusing executable tool spec '${spec.name}'`);
    }
    tools[spec.name] = definition;
  }
  return Object.keys(tools).length ? tools : undefined;
}

export class TurnMachine {
  constructor({
    store,
    engine,
    approvals = new ApprovalCoordinator(),
    toolExecutor = new ToolExecutor(),
    maxModelSteps = MAX_MODEL_STEPS,
    callerKind = "user_turn",
    callerTrigger = "turn",
    contextAssembler = null,
    compaction = null,
    onTurnComplete = null,
    traceStore = null,
    eventBus = null,
  }) {
    if (!store || !engine) throw new TypeError("TurnMachine requires store and engine");
    this._store = store;
    this._engine = engine;
    this._approvals = approvals;
    this._toolExecutor = toolExecutor;
    this._maxModelSteps = maxModelSteps;
    this._callerKind = callerKind;
    this._callerTrigger = callerTrigger;
    this._contextAssembler = contextAssembler;
    this._compaction = compaction;
    this._onTurnComplete = onTurnComplete;
    this._traceStore = traceStore;
    this._eventBus = eventBus;
  }

  async run({ userId, sessionId = null, submission, signal, onEvent, toolSpecs = [] } = {}) {
    const parsed = parseSubmission(submission);
    this._userId = userId;
    this._submissionId = parsed.id;
    this._signal = signal;
    this._onEvent = onEvent;
    this._toolSpecs = toolSpecs;
    this._unsaved = [];
    this._drained = false;
    this._status = "completed";

    let record = sessionId ? await this._store.load(userId, sessionId) : null;
    if (!record && parsed.op.type === OpType.SET_MODEL) {
      if (!this._modelAvailable(parsed.op.route)) {
        this._emit(eventMsg.submissionRejected("That model is not available."));
        return this._closeTrace(this._done("rejected"));
      }
      record = await this._store.createSession({ userId, sessionId: sessionId ?? undefined });
    } else if (!record) {
      if (parsed.op.type !== OpType.MESSAGE) {
        throw new Error("session not found");
      }
      record = await this._store.createSession({ userId, sessionId: sessionId ?? undefined });
    }
    this._sessionId = record.id;
    this._checkpoint = record.checkpoint;
    if (!Array.isArray(this._checkpoint.sessionTaint)) this._checkpoint.sessionTaint = [];
    this._approvals.restore(record.id, this._checkpoint.approvedForSession ?? []);
    this._openCollector();

    try {
      return await this._dispatch(parsed.op);
    } catch (error) {
      await this._closeTrace(this._done("failure"));
      throw error;
    }
  }

  async _dispatch(op) {
    if (this._checkpoint.pendingApproval && op.type !== OpType.EXEC_APPROVAL) {
      if (op.type === OpType.MESSAGE) {
        this._checkpoint.pendingMessages.push({
          text: op.message.text,
          submissionId: this._submissionId,
        });
        await this._persist();
      }
      if (op.type === OpType.INTERRUPT) {
        await this._abort(op.turn_id, "interrupted");
        return this._closeTrace(this._done("aborted"));
      }
      this._emit(eventMsg.execApprovalRequest(this._checkpoint.pendingApproval));
      await this._persist();
      return this._closeTrace(this._done("suspended"));
    }

    switch (op.type) {
      case OpType.MESSAGE:
        if (this._checkpoint.pendingMessages.length && !this._checkpoint.activeExecution) {
          this._checkpoint.pendingMessages.push({
            text: op.message.text,
            submissionId: this._submissionId,
          });
          await this._drainOnePending();
        } else {
          await this._beginTurn(op.message.text);
        }
        break;
      case OpType.RESUME_SESSION:
        if (this._checkpoint.activeExecution) await this._modelLoop();
        else if (this._checkpoint.pendingMessages.length) await this._drainOnePending();
        else this._emit(eventMsg.warning("nothing to resume"));
        break;
      case OpType.EXEC_APPROVAL:
        await this._resumeApproval(op);
        break;
      case OpType.INTERRUPT:
        await this._abort(op.turn_id, "interrupted");
        break;
      case OpType.SET_MODEL:
        if (!this._modelAvailable(op.route)) {
          this._emit(eventMsg.submissionRejected("That model is not available."));
          this._status = "rejected";
          break;
        }
        this._checkpoint.modelRoute = op.route;
        this._emit({ type: EventMsgType.MODEL_CHANGED, route: op.route });
        await this._persist();
        break;
      default:
        this._emit(eventMsg.warning(`op '${op.type}' is not handled by the turn machine`));
        break;
    }
    return this._closeTrace(this._done(this._status));
  }

  _openCollector() {
    this._traceClosed = false;
    if (!this._traceStore) {
      this._collector = null;
      return;
    }
    this._collector = new TraceCollector({
      bus: this._eventBus,
      store: this._traceStore,
      userId: this._userId,
      sessionId: this._sessionId,
    });
    this._collector.start();
  }

  async _closeTrace(result) {
    if (this._traceClosed) return result;
    this._traceClosed = true;
    const collector = this._collector;
    this._collector = null;
    if (!collector) return result;
    try {
      await collector.finish({ outcome: result.status, sessionId: this._sessionId });
    } catch {
      // The collector already swallows store errors. A trace cannot change the turn.
    }
    return result;
  }

  _done(status) {
    return { sessionId: this._sessionId, status, checkpoint: this._checkpoint };
  }

  _modelAvailable(route) {
    if (typeof route !== "string" || !route) return false;
    if (typeof this._engine.availableModelKeys !== "function") return false;
    return this._engine.availableModelKeys().includes(route);
  }

  _emit(msg) {
    const event = makeEvent(msg, this._submissionId);
    this._unsaved.push(event);
    this._onEvent?.(event);
  }

  async _persist({ transcriptDelta = null, approval = null } = {}) {
    const events = this._unsaved;
    this._unsaved = [];
    try {
      await this._store.saveWithEvents(this._userId, this._sessionId, {
        checkpoint: this._checkpoint,
        events,
        transcriptDelta,
        approval,
      });
    } catch (error) {
      this._unsaved = events.concat(this._unsaved);
      throw error;
    }
  }

  async _beginTurn(text) {
    const turnId = randomUUID();
    this._checkpoint.activeExecution = { turnId, phase: TurnPhase.PREPARE, modelSteps: 0 };
    this._checkpoint.transcript.push({ role: "user", content: text });
    this._emit(eventMsg.turnStarted(turnId));
    await this._persist({ transcriptDelta: [{ role: "user", content: text }] });
    await this._modelLoop();
  }

  async _modelLoop() {
    const execution = this._checkpoint.activeExecution;
    if (!execution) return;
    while (execution.modelSteps < this._maxModelSteps) {
      if (this._signal?.aborted) {
        await this._abort(execution.turnId, "interrupted");
        return;
      }
      execution.phase = TurnPhase.MODEL;
      execution.modelSteps += 1;
      this._checkpoint.executionStats.modelSteps += 1;
      await this._persist();

      let streamed;
      try {
        streamed = await this._consumeModel(execution);
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          this._emit(eventMsg.error({ kind: "budget_exceeded", message: error.message }));
          await this._abort(execution.turnId, "budget_exceeded");
          return;
        }
        if (error instanceof ModelLayerPausedError || error instanceof ModelUnavailableError) {
          this._emit(eventMsg.error({ kind: "model_unavailable", message: error.message }));
          await this._abort(execution.turnId, error.name);
          return;
        }
        if (error?.name === "TurnInterrupted") {
          await this._abort(execution.turnId, "interrupted");
          return;
        }
        throw error;
      }

      this._checkpoint.transcript.push(streamed.assistant);
      if (streamed.usage) {
        tokenUsageCheckedAdd(this._checkpoint.totalUsage, streamed.usage);
        this._emit(eventMsg.tokenCount(this._checkpoint.totalUsage));
      }

      if (streamed.toolCalls.length === 0) {
        execution.phase = TurnPhase.COMPLETION;
        this._emit(eventMsg.turnComplete(execution.turnId));
        this._checkpoint.activeExecution = null;
        await this._persist({ transcriptDelta: [streamed.assistant] });
        await this._rememberTurn();
        await this._drainOnePending();
        return;
      }

      const outcome = await this._authorize(execution, streamed.toolCalls);
      if (outcome === "suspended") return;
      if (outcome === "aborted") return;
      if (outcome === "session_deleted") return;
    }
    await this._abort(execution.turnId, "max_model_steps");
  }

  async _modelMessages() {
    const transcript = this._checkpoint.transcript;
    if (!this._contextAssembler) return transcript;
    try {
      const system = await this._contextAssembler({
        userId: this._userId,
        sessionId: this._sessionId,
        transcript,
        checkpoint: this._checkpoint,
        availableTools: this._toolSpecs.map((spec) => spec.name),
      });
      if (!system) return transcript;
      return [{ role: "system", content: system }, ...transcript];
    } catch {
      return transcript;
    }
  }

  async _maybeCompact(execution) {
    if (!this._compaction) return;
    const result = await compactTranscript({
      transcript: this._checkpoint.transcript,
      engine: this._engine,
      userId: this._userId,
      caller: {
        kind: this._callerKind,
        id: execution.turnId,
        trigger: `${this._callerTrigger}:compact`,
      },
      atTokens: this._compaction.atTokens,
      keepRecentTokens: this._compaction.keepRecentTokens,
      contextWindow: this._compaction.contextWindow,
    });
    if (!result) return;
    this._checkpoint.transcript = result.transcript;
    this._checkpoint.compactionCount += 1;
    this._checkpoint.contextEpoch += 1;
    this._emit(eventMsg.contextCompacted());
    await this._persist();
    if (typeof this._store.saveMiddlewareState === "function") {
      await this._store.saveMiddlewareState(
        this._userId,
        this._sessionId,
        HANDOFF_STATE_KEY,
        result.summary
      );
    }
  }

  async _rememberTurn() {
    if (!this._onTurnComplete) return;
    try {
      await this._onTurnComplete({
        userId: this._userId,
        sessionId: this._sessionId,
        userText: lastTurnUserText(this._checkpoint.transcript),
        assistantText: lastAssistantText(this._checkpoint.transcript),
      });
    } catch {
      // Extraction is best-effort. A failure must not change the turn result.
    }
  }

  async _consumeModel(execution) {
    await this._maybeCompact(execution);
    const tools = toolSpecsToAiTools(this._toolSpecs);
    const opened = await this._engine.openStream(await this._modelMessages(), {
      model: this._checkpoint.modelRoute,
      query: lastUserText(this._checkpoint.transcript),
      caller: { kind: this._callerKind, id: execution.turnId, trigger: this._callerTrigger },
      userId: this._userId,
      tools,
      abortSignal: this._signal,
    });
    let text = "";
    const toolCalls = [];
    const modelStepId = randomUUID();
    for await (const part of opened.fullStream) {
      if (this._signal?.aborted) {
        const abortError = new Error("interrupted");
        abortError.name = "TurnInterrupted";
        throw abortError;
      }
      if (part.type === "text-delta" && part.text) {
        text += part.text;
        this._emit(
          eventMsg.assistantContentDelta({
            sessionId: this._sessionId,
            turnId: execution.turnId,
            modelStepId,
            delta: part.text,
            phase: ModelStepContentPhase.FINAL_ANSWER,
          })
        );
      } else if (part.type === "reasoning-delta" && part.text) {
        this._emit(
          eventMsg.assistantContentDelta({
            sessionId: this._sessionId,
            turnId: execution.turnId,
            modelStepId,
            delta: part.text,
            phase: ModelStepContentPhase.REASONING,
          })
        );
      } else if (part.type === "tool-call") {
        toolCalls.push({
          callId: part.toolCallId,
          name: part.toolName,
          arguments: part.input ?? {},
        });
      } else if (part.type === "tool-result" || part.type === "tool-error") {
        throw new Error("model stream executed a tool outside ToolExecutor");
      }
    }
    const finalized = await opened.finalize();
    const content = [];
    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: call.callId,
        toolName: call.name,
        input: call.arguments,
      });
    }
    return {
      assistant: {
        role: "assistant",
        content: content.length === 1 && content[0].type === "text" ? text : content,
      },
      toolCalls,
      usage: usageForCheckpoint(finalized.usage),
    };
  }

  async _authorize(execution, toolCalls) {
    execution.phase = TurnPhase.TOOL_AUTHORIZE;
    const classification = classifyToolCalls(toolCalls, this._toolSpecs);
    const decision = this._approvals.authorize(
      this._sessionId,
      toolCalls,
      classification.mutationIds,
      { explicitCallIds: classification.explicitIds }
    );
    if (decision.type === "execute") {
      const granted = new Set(
        classification.mutationIds.filter((callId) => decision.permissions.forCall(callId).mutation)
      );
      const ran = await this._executeCalls(execution, toolCalls, granted);
      if (ran === "session_deleted") return "session_deleted";
      return "continue";
    }
    const preApprovedCallIds = classification.mutationIds.filter(
      (callId) => decision.permissions.forCall(callId).mutation
    );
    this._checkpoint.pendingApproval = {
      id: decision.request.id,
      turnId: execution.turnId,
      reason: decision.request.reason,
      calls: toolCalls,
      requestedCallIds: decision.request.callIds,
      preApprovedCallIds,
      mutationCallIds: classification.mutationIds,
      readCallIds: classification.readIds,
      explicitCallIds: classification.explicitIds,
    };
    this._emit(eventMsg.execApprovalRequest(this._checkpoint.pendingApproval));
    await this._persist({ approval: { opened: true } });
    this._status = "suspended";
    return "suspended";
  }

  async _executeCalls(execution, calls, grantedMutations = new Set()) {
    execution.phase = TurnPhase.EXECUTE;
    const results = [];
    let deletedSessionId = null;
    for (const call of calls) {
      this._emit(
        eventMsg.toolCallBegin({
          turnId: execution.turnId,
          callId: call.callId,
          name: call.name,
          args: call.arguments,
        })
      );
      const result = await this._toolExecutor.execute(call, {
        userId: this._userId,
        sessionId: this._sessionId,
        turnId: execution.turnId,
        agentId: "chief",
        caller: { kind: this._callerKind, id: execution.turnId, trigger: this._callerTrigger },
        mutationApproved: grantedMutations.has(call.callId),
        sessionTaint: this._checkpoint.sessionTaint ?? [],
        saveMiddlewareState: (middlewareId, state) =>
          this._store.saveMiddlewareState(this._userId, this._sessionId, middlewareId, state),
      });
      if (Array.isArray(result.sessionTaint)) {
        this._checkpoint.sessionTaint = result.sessionTaint;
      }
      this._checkpoint.executionStats.toolCalls += 1;
      this._emit(
        eventMsg.toolCallEnd({
          turnId: execution.turnId,
          callId: call.callId,
          name: call.name,
          output: result.output,
          isError: result.isError,
        })
      );
      results.push(toolResultMessage(call, result.output));
      if (typeof result.deletedSessionId === "string") deletedSessionId = result.deletedSessionId;
    }
    this._checkpoint.transcript.push(...results);
    if (deletedSessionId === this._sessionId) {
      this._status = "completed";
      this._checkpoint.activeExecution = null;
      this._checkpoint.pendingApproval = null;
      this._emit(eventMsg.turnComplete(execution.turnId));
      return "session_deleted";
    }
    await this._persist({ transcriptDelta: results });
    return "continue";
  }

  async _resumeApproval(op) {
    const pending = this._checkpoint.pendingApproval;
    if (!pending || pending.id !== op.id) {
      this._emit(eventMsg.error({ kind: "approval", message: "no matching pending approval" }));
      this._status = pending ? "suspended" : this._status;
      await this._persist();
      return;
    }
    const decision = parseReviewDecision(op.decision);
    const execution = this._checkpoint.activeExecution ?? {
      turnId: pending.turnId,
      phase: TurnPhase.TOOL_AUTHORIZE,
      modelSteps: 1,
    };
    this._checkpoint.activeExecution = execution;
    if (decision.type === ReviewDecisionType.ABORT) {
      this._checkpoint.pendingApproval = null;
      await this._persist({
        approval: { decided: true, id: pending.id, decision: "ABORTED" },
      });
      await this._abort(pending.turnId, "approval_abort");
      return;
    }
    const permissions = this._approvals.authorize(
      this._sessionId,
      pending.calls,
      pending.preApprovedCallIds ?? []
    ).permissions;
    this._approvals.resolve(
      this._sessionId,
      pending.calls,
      pending.requestedCallIds,
      decision,
      permissions,
      { explicitCallIds: pending.explicitCallIds ?? [] }
    );
    this._checkpoint.approvedForSession = this._approvals.exportKeys(this._sessionId);
    const mutationCallIds = pending.mutationCallIds ?? pending.calls.map((call) => call.callId);
    const readCallIds = pending.readCallIds ?? [];
    const granted = new Set(
      decision.type === ReviewDecisionType.DENIED ? [] : pending.requestedCallIds
    );
    for (const callId of pending.preApprovedCallIds ?? []) granted.add(callId);
    for (const callId of readCallIds) granted.add(callId);
    const grantedMutations = new Set(
      [...granted].filter((callId) => mutationCallIds.includes(callId))
    );
    const toRun = [];
    const denied = [];
    for (const call of pending.calls) {
      if (granted.has(call.callId)) toRun.push(call);
      else denied.push(call);
    }
    this._checkpoint.pendingApproval = null;
    await this._persist({
      approval: {
        decided: true,
        id: pending.id,
        decision: DECISION_ENUM[decision.type],
        rejection: decision.rejection ?? null,
      },
    });
    const deniedMessages = [];
    for (const call of denied) {
      const output = `denied: ${decision.rejection ?? "rejected"}`;
      this._emit(
        eventMsg.toolCallEnd({
          turnId: execution.turnId,
          callId: call.callId,
          name: call.name,
          output,
          isError: true,
        })
      );
      const message = toolResultMessage(call, output);
      this._checkpoint.transcript.push(message);
      deniedMessages.push(message);
    }
    if (deniedMessages.length) await this._persist({ transcriptDelta: deniedMessages });
    if (toRun.length) {
      const ran = await this._executeCalls(execution, toRun, grantedMutations);
      if (ran === "session_deleted") return;
    }
    await this._modelLoop();
  }

  async _abort(turnId, reason) {
    this._status = "aborted";
    this._checkpoint.pendingApproval = null;
    this._checkpoint.activeExecution = null;
    this._emit(eventMsg.turnAborted(turnId, reason));
    await this._persist();
  }

  async _drainOnePending() {
    if (this._drained) return;
    const next = this._checkpoint.pendingMessages.shift();
    if (!next) return;
    this._drained = true;
    await this._beginTurn(next.text);
  }
}

function toolResultMessage(call, output) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.callId,
        toolName: call.name,
        output: { type: "text", value: output },
      },
    ],
  };
}

function usageForCheckpoint(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    cached_input_tokens: usage.cached_prompt_tokens ?? 0,
    cache_write_input_tokens: 0,
    output_tokens: usage.completion_tokens ?? 0,
    reasoning_output_tokens: usage.reasoning_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}
