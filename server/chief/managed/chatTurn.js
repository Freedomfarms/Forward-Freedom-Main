import { randomUUID } from "node:crypto";

import {
  MessageDelivery,
  OpType,
  ReviewDecisionType,
  eventMsg,
  makeEvent,
  parseReviewDecision,
  parseSubmission,
} from "../protocol/index.js";
import { createPrismaBindingStore, createPrismaThreadStore } from "./bindings.js";
import { createAnthropicManagedClient } from "./client.js";
import {
  ENVIRONMENT_KEY,
  MANAGED_MODEL_ROUTE,
  MANAGED_ORIGIN,
  MANAGED_SCHEDULE_ORIGIN,
  agentKeyFor,
  localToolName,
  memoryKeyFor,
  productionAgentBody,
  productionEnvironmentBody,
  productionSessionBody,
  workspaceDocuments,
} from "./productionAgent.js";
import { providerErrorFields } from "./redact.js";
import { createPrismaWorkQueue } from "./workQueue.js";
import { syncPersonalityMemory } from "../personality/memory.js";
import { readChiefPersonality } from "../personality/store.js";
import {
  fittedPersonalityGuidance,
  personalityDelivery,
  undeliveredTurnPrompt,
} from "./personalityDelivery.js";
import {
  normalizeChiefPersonality,
  personalityDigest,
} from "../../../src/utils/chiefPersonality.js";
import { MISSING_CHIEF_ANSWER } from "../../../src/utils/chiefProtocol.js";
import { SCHEDULED_TURN_EXCLUDED_TOOLS } from "../tools/inventory.js";

const LEGACY_MESSAGE =
  "This conversation belongs to the previous CHIEF runtime. Start a new conversation.";

function skipReason(error) {
  if (error?.name === "BudgetExceededError") return "budget_exceeded";
  if (error?.name === "ModelLayerPausedError") return error.name;
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metadataMatch(key) {
  return (row) => row?.metadata?.freedom_os_key === key;
}

async function findOrCreate({ cachedId, retrieve, list, create, key }) {
  if (cachedId) {
    const cached = await retrieve(cachedId);
    if (cached?.id) return cached;
  }
  const rows = await list();
  const found = (rows || []).find(metadataMatch(key));
  if (found?.id) {
    const full = await retrieve(found.id);
    return full?.id ? full : found;
  }
  return create();
}

function messageText(submission) {
  const text = submission?.op?.message?.text;
  return typeof text === "string" ? text : "";
}

function partsOf(event) {
  const blocks = Array.isArray(event?.content) ? event.content : [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" || block.type === "reasoning") {
      const text = block.thinking || block.text || "";
      if (text) parts.push({ phase: "reasoning", text });
    } else if (typeof block.text === "string" && block.text) {
      parts.push({ phase: "final_answer", text: block.text });
    }
  }
  if (!parts.length && typeof event?.text === "string" && event.text) {
    parts.push({ phase: "final_answer", text: event.text });
  }
  return parts;
}

function toolCallOf(event) {
  if (event?.type !== "agent.custom_tool_use") return null;
  const name = localToolName(event.name || event.tool_name);
  if (!name || !event.id) return null;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  return { id: event.id, name, input };
}

function specsFrom(toolSpecs, toolExecutor) {
  if (Array.isArray(toolSpecs) && toolSpecs.length) return toolSpecs;
  if (toolExecutor?._tools) return [...toolExecutor._tools.values()].map((tool) => tool.spec);
  return [];
}

function rememberTurnStatus(checkpoint, status) {
  if (!checkpoint.context || typeof checkpoint.context !== "object") checkpoint.context = {};
  checkpoint.context.turnStatus = status;
}

// One worker may collect a provider session at a time. The browser follow and
// the cron drain both take this lease; the loser leaves the session alone.
async function holdFollowLease(jobs, userId, threadId) {
  const queue = jobs ?? createPrismaWorkQueue();
  if (typeof queue?.claimThread !== "function") return { queue, lease: null, deferred: false };
  const claimed = await queue.claimThread({ userId, threadId, now: new Date() });
  if (claimed == null) return { queue, lease: null, deferred: true };
  if (claimed.missing) return { queue, lease: null, deferred: false };
  return { queue, lease: claimed, deferred: false };
}

async function settleFollowLease(queue, lease, status) {
  if (!lease || typeof queue?.release !== "function") return;
  if (status === "continuing") await queue.release(lease);
  else await queue.complete(lease);
}

function appendAssistant(checkpoint, text) {
  if (!text) return;
  const transcript = checkpoint.transcript;
  const last = transcript[transcript.length - 1];
  if (last?.role === "assistant" && last.content === text) return;
  transcript.push({ role: "assistant", content: text });
}

const ACTIVE_PROVIDER = new Set(["running", "rescheduling", "working", "in_progress"]);

function eventIdentity(event, index) {
  if (typeof event?.id === "string" && event.id) return event.id;
  if (event?.type === "agent.message") {
    return `message:${partsOf(event)
      .map((part) => part.text)
      .join("")}`;
  }
  return `${event?.type || "event"}#${index}`;
}

function eventIdentities(events) {
  return (events || []).map((event, index) => eventIdentity(event, index));
}

function providerStatus(session) {
  return typeof session?.status === "string" ? session.status : "";
}

function sessionIsActive(session) {
  return ACTIVE_PROVIDER.has(providerStatus(session));
}

function sessionIsIdle(session) {
  return providerStatus(session) === "idle";
}

function turnWatchOf(checkpoint) {
  const watch = checkpoint.context?.turnWatch;
  return watch && typeof watch === "object" ? watch : null;
}

function heldPrompts(checkpoint) {
  const value = checkpoint.context?.heldPrompts;
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim());
}

function sentHeldPrompts(checkpoint) {
  const value = checkpoint.context?.sentHeldPrompts;
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item);
}

function queueHeldPrompt(checkpoint, text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  const list = heldPrompts(checkpoint);
  if (list[list.length - 1] === trimmed) {
    checkpoint.context.heldPrompts = list;
    return trimmed;
  }
  list.push(trimmed);
  checkpoint.context.heldPrompts = list;
  return trimmed;
}

function takeHeldPrompt(checkpoint) {
  const list = heldPrompts(checkpoint);
  if (!list.length) return "";
  const [next, ...rest] = list;
  checkpoint.context.heldPrompts = rest;
  const sent = sentHeldPrompts(checkpoint);
  sent.push(next);
  checkpoint.context.sentHeldPrompts = sent.slice(-20);
  return next;
}

function mergeHeldPrompts(disk, local, sent) {
  const skip = new Set(sent || []);
  const merged = [];
  for (const text of [...(disk || []), ...(local || [])]) {
    if (typeof text !== "string" || !text.trim() || skip.has(text) || merged.includes(text)) {
      continue;
    }
    merged.push(text);
  }
  return merged;
}

function ensureUserMessage(checkpoint, text) {
  const transcript = checkpoint.transcript;
  const last = transcript[transcript.length - 1];
  if (last?.role === "user" && last.content === text) return;
  transcript.push({ role: "user", content: text });
}

function retractLastUser(checkpoint, text) {
  const transcript = checkpoint.transcript;
  const last = transcript[transcript.length - 1];
  if (last?.role === "user" && last.content === text) transcript.pop();
}

function absorbUnseen(checkpoint, events) {
  const seen = new Set(checkpoint.context.seenEventIds || []);
  (events || []).forEach((event, index) => {
    if (event?.type !== "agent.message") return;
    const eventId =
      typeof event.id === "string" && event.id ? event.id : eventIdentity(event, index);
    if (seen.has(eventId)) return;
    let answer = "";
    for (const part of partsOf(event)) {
      if (part.phase === "final_answer") answer += part.text;
    }
    appendAssistant(checkpoint, answer);
    seen.add(eventId);
  });
  checkpoint.context.seenEventIds = [...seen];
}

function freshProviderEvents(events, baselineIds) {
  const baseline = new Set(baselineIds || []);
  const fresh = [];
  (events || []).forEach((event, index) => {
    if (!baseline.has(eventIdentity(event, index))) fresh.push(event);
  });
  return fresh;
}

function stopReasonType(event) {
  const reason = event?.stop_reason;
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  return typeof reason.type === "string" ? reason.type : "";
}

function latestIdleEvent(events) {
  let idle = null;
  for (const event of events || []) {
    if (event?.type === "session.status_idle" || event?.type === "session.status_idled") {
      idle = event;
    }
  }
  return idle;
}

function turnHasAssistantAnswer(checkpoint) {
  const transcript = checkpoint?.transcript || [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.role === "user") return false;
    if (message?.role === "assistant" && String(message.content || "").trim()) return true;
  }
  return false;
}

const TERMINAL_STOP_MESSAGE = Object.freeze({
  refusal: "CHIEF declined that request.",
  retries_exhausted: "CHIEF could not finish that response.",
  budget_reached: "CHIEF stopped because the response budget was reached.",
});

// A turn is done when the provider is idle for this turn's own end_turn.
// listEvents returns the whole session, so an older session.status_idle must
// not finish the question that was just submitted. A custom tool pauses the
// session with stop_reason requires_action; that idle is not the answer, even
// after the session has already been seen running. refusal, retries_exhausted,
// and budget_reached are terminal failures, not a cue to keep polling.
function freshStop(events, watch, session) {
  if (!sessionIsIdle(session)) return null;
  const fresh = freshProviderEvents(events, watch?.baselineIds);
  const idle = latestIdleEvent(fresh);
  if (!idle) return null;
  const reason = stopReasonType(idle);
  if (reason === "requires_action") return { kind: "pause" };
  if (reason === "end_turn") return { kind: "end_turn" };
  if (Object.hasOwn(TERMINAL_STOP_MESSAGE, reason)) {
    return { kind: "failed", message: TERMINAL_STOP_MESSAGE[reason] };
  }
  if (reason !== "") return null;
  if (watch?.sawRunning === true || fresh.some((event) => event?.type === "agent.message")) {
    return { kind: "end_turn" };
  }
  return null;
}

function currentTurnSettled(events, watch, session) {
  return freshStop(events, watch, session)?.kind === "end_turn";
}

function previousTurnInFlight(checkpoint) {
  const watch = turnWatchOf(checkpoint);
  return Boolean(watch && watch.dispatched === true && watch.settled !== true);
}

function retryableProviderError(error) {
  if (!error || error.name === "AbortError") return false;
  if (
    error.status === 503 &&
    typeof error.message === "string" &&
    error.message.startsWith("Claude Managed Agents is not configured")
  ) {
    return false;
  }
  const status = error.status;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (status == null && (error.name === "TypeError" || error.name === "FetchError")) return true;
  return false;
}

function annotateProviderError(error, fields) {
  if (!error || typeof error !== "object") return error;
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    if (error[key] == null || error[key] === "") error[key] = value;
  }
  return error;
}

async function persistCheckpoint(store, userId, sessionId, checkpoint) {
  const fresh = await store.load(userId, sessionId);
  const disk = fresh?.checkpoint;
  if (disk?.context) {
    checkpoint.context.heldPrompts = mergeHeldPrompts(
      disk.context.heldPrompts,
      checkpoint.context.heldPrompts,
      [
        ...sentHeldPrompts(checkpoint),
        ...(Array.isArray(disk.context.sentHeldPrompts) ? disk.context.sentHeldPrompts : []),
      ]
    );
    if ((disk.transcript?.length || 0) > (checkpoint.transcript?.length || 0)) {
      checkpoint.transcript = disk.transcript;
    }
    const seen = new Set([
      ...(Array.isArray(disk.context.seenEventIds) ? disk.context.seenEventIds : []),
      ...(Array.isArray(checkpoint.context.seenEventIds) ? checkpoint.context.seenEventIds : []),
    ]);
    checkpoint.context.seenEventIds = [...seen];
  }
  await store.saveWithEvents(userId, sessionId, { checkpoint });
}

async function rememberHeldPrompt(store, userId, sessionId, text) {
  const fresh = await store.load(userId, sessionId);
  if (!fresh?.checkpoint) return null;
  queueHeldPrompt(fresh.checkpoint, text);
  await store.saveWithEvents(userId, sessionId, { checkpoint: fresh.checkpoint });
  return fresh.checkpoint;
}

async function seedWorkspace(client, memoryStoreId) {
  let existing;
  try {
    existing = (await client.listMemories(memoryStoreId)) || [];
  } catch {
    existing = [];
  }
  const have = new Set(
    (existing || []).map((item) => String(item.path || "").replace(/^\/+/, "")).filter(Boolean)
  );
  for (const doc of workspaceDocuments()) {
    if (have.has(doc.path)) continue;
    try {
      await client.createMemory(memoryStoreId, { path: `/${doc.path}`, content: doc.content });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
}

async function ensureResources({ client, userId, toolSpecs, bindings, managed }) {
  const agentKey = agentKeyFor(toolSpecs);
  const skillId = process.env.CHIEF_MANAGED_SKILL_ID || "";
  const skillVersion = process.env.CHIEF_MANAGED_SKILL_VERSION || "";
  const agent = await findOrCreate({
    cachedId: managed?.agentKey === agentKey ? managed.agentId : null,
    retrieve: (id) => client.retrieveAgent(id),
    list: () => client.listAgents(),
    key: agentKey,
    create: () =>
      client.createAgent(
        productionAgentBody({
          toolSpecs,
          idempotencyKey: agentKey,
          skillId,
          skillVersion,
        })
      ),
  });
  const agentVersion = agent?.version || agent?.latest_version;
  if (!agent?.id || !agentVersion) {
    throw new Error("Claude Managed Agents did not return an agent version.");
  }
  const environment = await findOrCreate({
    cachedId: managed?.environmentId || null,
    retrieve: (id) => client.retrieveEnvironment(id),
    list: () => client.listEnvironments(),
    key: ENVIRONMENT_KEY,
    create: () => client.createEnvironment(productionEnvironmentBody()),
  });
  if (!environment?.id) throw new Error("Claude Managed Agents did not return an environment.");
  const memoryKey = memoryKeyFor(userId);
  const memory = await findOrCreate({
    cachedId: managed?.memoryKey === memoryKey ? managed.memoryStoreId : null,
    retrieve: async (id) => ({ id, metadata: { freedom_os_key: memoryKey } }),
    list: () => client.listMemoryStores(),
    key: memoryKey,
    create: () =>
      client.createMemoryStore({
        name: `chief-${userId}`.slice(0, 80),
        metadata: { freedom_os_key: memoryKey },
      }),
  });
  if (!memory?.id) throw new Error("Claude Managed Agents did not return a memory store.");
  if (!managed?.workspaceSeeded || managed.memoryStoreId !== memory.id) {
    await seedWorkspace(client, memory.id);
  }
  const next = {
    agentId: agent.id,
    agentVersion,
    agentKey,
    environmentId: environment.id,
    memoryStoreId: memory.id,
    memoryKey,
    providerSessionId: managed?.providerSessionId || null,
    personalityDigest: managed?.personalityDigest || null,
    workspaceSeeded: true,
  };
  if (bindings) {
    try {
      await bindings.save(userId, {
        agentId: next.agentId,
        agentVersion: next.agentVersion,
        environmentId: next.environmentId,
        memoryStoreId: next.memoryStoreId,
      });
    } catch {
      // The provider metadata remains the source of truth when the table is absent.
    }
  }
  return next;
}

async function executeTool({ toolExecutor, call, userId, sessionId, approved, caller }) {
  if (!toolExecutor) {
    return { output: `Tool ${call.name} is not available.`, isError: true };
  }
  const result = await toolExecutor.execute(
    { callId: call.id, name: call.name, arguments: call.input },
    {
      userId,
      sessionId,
      agentId: "chief",
      mutationApproved: approved === true,
      caller: caller || { kind: "user_turn", trigger: "turn" },
    }
  );
  const output =
    typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? "");
  return { output: output.slice(0, 20_000), isError: result?.isError === true };
}

async function collect({
  client,
  checkpoint,
  sessionId,
  providerSessionId,
  userId,
  toolSpecs,
  toolExecutor,
  onEmit,
  turnId,
  budgetMs,
  sleepFn,
  signal,
  resolveToolId,
  caller,
  store,
}) {
  const seen = new Set(checkpoint.context.seenEventIds || []);
  const deadline = Date.now() + budgetMs;
  let spins = 0;
  while (spins < 70 && Date.now() <= deadline) {
    spins += 1;
    if (signal?.aborted) {
      // The request ended. The provider session is still the same one, so the
      // checkpoint stays continuable for the open page or the cron drain.
      checkpoint.context.seenEventIds = [...seen];
      return "continuing";
    }
    const session = await client.retrieveSession(providerSessionId);
    const events = (await client.listEvents(providerSessionId)) || [];
    for (const event of events) {
      if (event?.type !== "agent.message") continue;
      const eventId =
        event.id ||
        `message:${partsOf(event)
          .map((part) => part.text)
          .join("")}`;
      if (seen.has(eventId)) continue;
      let answer = "";
      for (const part of partsOf(event)) {
        onEmit(
          eventMsg.assistantContentDelta({
            sessionId,
            turnId,
            modelStepId: eventId,
            delta: part.text,
            phase: part.phase,
          })
        );
        if (part.phase === "final_answer") answer += part.text;
      }
      appendAssistant(checkpoint, answer);
      seen.add(eventId);
    }
    const toolEvent = events.find((event) => {
      const call = toolCallOf(event);
      return call?.id && !seen.has(call.id);
    });
    const call = toolEvent ? toolCallOf(toolEvent) : null;
    if (call) {
      const spec = (toolSpecs || []).find((item) => item.name === call.name);
      const excluded =
        caller?.kind === "schedule" && SCHEDULED_TURN_EXCLUDED_TOOLS.includes(call.name);
      const needsApproval =
        !excluded && spec?.requiresConfirmation === true && call.id !== resolveToolId;
      if (needsApproval) {
        checkpoint.pendingApproval = {
          id: `approval-${call.id}`,
          turnId,
          reason: "tool requires confirmation",
          calls: [{ callId: call.id, name: call.name, arguments: call.input }],
          toolEventId: call.id,
        };
        onEmit(
          eventMsg.execApprovalRequest({
            id: checkpoint.pendingApproval.id,
            turnId,
            calls: checkpoint.pendingApproval.calls,
            reason: checkpoint.pendingApproval.reason,
          })
        );
        checkpoint.context.seenEventIds = [...seen];
        return "suspended";
      }
      onEmit(
        eventMsg.toolCallBegin({
          turnId,
          callId: call.id,
          name: call.name,
          args: call.input,
        })
      );
      const executed = excluded
        ? { output: `Tool ${call.name} is not available on a scheduled run.`, isError: true }
        : await executeTool({
            toolExecutor,
            call,
            userId,
            sessionId,
            approved: spec?.requiresConfirmation === true,
            caller,
          });
      onEmit(
        eventMsg.toolCallEnd({
          turnId,
          callId: call.id,
          name: call.name,
          output: executed.output,
          isError: executed.isError,
        })
      );
      await client.sendEvents(providerSessionId, [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: call.id,
          content: [{ type: "text", text: executed.output }],
          is_error: executed.isError,
        },
      ]);
      seen.add(call.id);
      checkpoint.pendingApproval = null;
      checkpoint.context.seenEventIds = [...seen];
      checkpoint.executionStats = {
        modelSteps: checkpoint.executionStats?.modelSteps ?? 0,
        toolCalls: (checkpoint.executionStats?.toolCalls ?? 0) + (excluded ? 0 : 1),
      };
      if (store) await persistCheckpoint(store, userId, sessionId, checkpoint);
      continue;
    }
    const watch = turnWatchOf(checkpoint) || {
      baselineIds: [],
      sawRunning: false,
      settled: false,
    };
    if (!checkpoint.context.turnWatch) checkpoint.context.turnWatch = watch;
    if (sessionIsActive(session)) watch.sawRunning = true;
    const liveStatus = providerStatus(session);
    if (liveStatus) checkpoint.context.providerStatus = liveStatus;
    const stop = freshStop(events, watch, session);
    if (stop?.kind === "end_turn" || stop?.kind === "failed") {
      watch.settled = true;
      checkpoint.context.seenEventIds = [...seen];
      checkpoint.executionStats = {
        modelSteps: (checkpoint.executionStats?.modelSteps ?? 0) + 1,
        toolCalls: checkpoint.executionStats?.toolCalls ?? 0,
      };
      if (turnHasAssistantAnswer(checkpoint)) return "completed";
      if (stop.kind === "failed") {
        checkpoint.context.turnFailureMessage = stop.message;
        return "failed";
      }
      return "empty";
    }
    if (Date.now() >= deadline) break;
    await sleepFn(400);
  }
  checkpoint.context.seenEventIds = [...seen];
  return "continuing";
}

async function persistThread(threads, userId, sessionId, managed, status) {
  if (!threads) return;
  try {
    await threads.save(userId, {
      id: sessionId,
      providerSessionId: managed.providerSessionId,
      memoryStoreId: managed.memoryStoreId,
      status,
    });
  } catch {
    // Checkpoint context still holds the provider ids.
  }
}

export function createManagedClient(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) {
    const error = new Error(
      "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server."
    );
    error.status = 503;
    error.operation = "configure";
    throw error;
  }
  return createAnthropicManagedClient({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function runManagedChiefTurn({
  userId,
  sessionId = null,
  submission,
  store,
  client,
  toolExecutor = null,
  toolSpecs = [],
  bindings = null,
  threads = null,
  jobs = null,
  onEvent,
  budgetMs = 25_000,
  signal,
  sleepFn = delay,
  resume = false,
  caller = null,
  readPersonality = readChiefPersonality,
} = {}) {
  const parsed = resume ? null : parseSubmission(submission);
  const submissionId = parsed?.id ?? null;
  const emit = (msg) => onEvent?.(makeEvent(msg, submissionId));
  let turnId = randomUUID();

  let record = sessionId ? await store.load(userId, sessionId) : null;
  if (!resume && parsed.op.type === OpType.SET_MODEL) {
    if (parsed.op.route !== MANAGED_MODEL_ROUTE) {
      emit(
        eventMsg.submissionRejected(
          "CHIEF is pinned to Claude Managed Agents. Choose claude-opus-5-5 or start a message."
        )
      );
      return {
        sessionId: record?.id ?? null,
        status: "rejected",
        checkpoint: record?.checkpoint ?? null,
      };
    }
    if (!record) {
      record = await store.createSession({
        userId,
        context: { origin: MANAGED_ORIGIN },
      });
    }
    record.checkpoint.modelRoute = MANAGED_MODEL_ROUTE;
    record.checkpoint.context = { ...(record.checkpoint.context || {}), origin: MANAGED_ORIGIN };
    await store.saveWithEvents(userId, record.id, { checkpoint: record.checkpoint });
    emit({ type: "model_changed", route: MANAGED_MODEL_ROUTE });
    return { sessionId: record.id, status: "completed", checkpoint: record.checkpoint };
  }

  const resumeSession = !resume && parsed?.op?.type === OpType.RESUME_SESSION;
  if (resumeSession && !record) {
    emit(eventMsg.submissionRejected("That conversation is not available."));
    return { sessionId: sessionId ?? null, status: "rejected", checkpoint: null };
  }

  if (
    !resume &&
    !resumeSession &&
    parsed.op.type !== OpType.MESSAGE &&
    parsed.op.type !== OpType.EXEC_APPROVAL
  ) {
    if (!record && parsed.op.type !== OpType.MESSAGE) {
      emit(eventMsg.submissionRejected("That command is not available on Claude Managed Agents."));
      return { sessionId: null, status: "rejected", checkpoint: null };
    }
  }

  if (!record) {
    if (resume || parsed.op.type !== OpType.MESSAGE) {
      throw new Error("session not found");
    }
    record = await store.createSession({
      userId,
      sessionId: sessionId ?? undefined,
      context: { origin: MANAGED_ORIGIN },
    });
  }

  const checkpoint = record.checkpoint;
  if (checkpoint.context?.origin === "schedule") {
    emit(eventMsg.submissionRejected(LEGACY_MESSAGE));
    return { sessionId: record.id, status: "rejected", checkpoint };
  }
  if (checkpoint.context?.origin !== MANAGED_SCHEDULE_ORIGIN) {
    checkpoint.context = { ...(checkpoint.context || {}), origin: MANAGED_ORIGIN };
  }
  const scheduleCaller =
    caller ||
    checkpoint.context?.scheduleCaller ||
    (checkpoint.context?.origin === MANAGED_SCHEDULE_ORIGIN
      ? {
          kind: "schedule",
          trigger: `schedule:${checkpoint.context.scheduledTaskId || "task"}`,
        }
      : { kind: "user_turn", trigger: "turn" });
  checkpoint.modelRoute = MANAGED_MODEL_ROUTE;
  if (!Array.isArray(checkpoint.transcript)) checkpoint.transcript = [];
  if (!checkpoint.executionStats) checkpoint.executionStats = { modelSteps: 0, toolCalls: 0 };

  if (!resume && parsed.op.type === OpType.EXEC_APPROVAL) {
    const decision = parseReviewDecision(parsed.op.decision);
    const pending = checkpoint.pendingApproval;
    if (!pending || pending.id !== parsed.op.id) {
      emit(eventMsg.submissionRejected("That approval is no longer pending."));
      return { sessionId: record.id, status: "rejected", checkpoint };
    }
    if (
      (decision.type === ReviewDecisionType.ABORT || decision.type === ReviewDecisionType.DENIED) &&
      !checkpoint.context?.managed?.providerSessionId
    ) {
      checkpoint.pendingApproval = null;
      await store.saveWithEvents(userId, record.id, { checkpoint });
      const abortReason =
        decision.type === ReviewDecisionType.ABORT ? "approval_abort" : decision.type;
      emit(eventMsg.turnAborted(turnId, abortReason));
      return { sessionId: record.id, status: "aborted", abortReason, checkpoint };
    }
  }

  if (!client) {
    const error = new Error(
      "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server."
    );
    error.status = 503;
    error.operation = "configure";
    throw error;
  }

  const resolvedSpecs = specsFrom(toolSpecs, toolExecutor);
  if (turnWatchOf(checkpoint)?.turnId) turnId = checkpoint.context.turnWatch.turnId;
  const bindingStore = bindings ?? createPrismaBindingStore();
  const threadStore = threads ?? createPrismaThreadStore();
  let managed;
  try {
    managed = await ensureResources({
      client,
      userId,
      toolSpecs: resolvedSpecs,
      bindings: bindingStore,
      managed: checkpoint.context.managed || null,
    });
  } catch (error) {
    throw annotateProviderError(error, {
      stage: "ensure_resources",
      submissionId,
      turnId,
      sessionId: record.id,
    });
  }

  let resolveToolId = null;
  if (!resume && parsed.op.type === OpType.EXEC_APPROVAL) {
    const decision = parseReviewDecision(parsed.op.decision);
    const pending = checkpoint.pendingApproval;
    if (!pending || pending.id !== parsed.op.id) {
      emit(eventMsg.submissionRejected("That approval is no longer pending."));
      return { sessionId: record.id, status: "rejected", checkpoint };
    }
    if (decision.type === ReviewDecisionType.ABORT || decision.type === ReviewDecisionType.DENIED) {
      resolveToolId = null;
      if (managed.providerSessionId && pending.toolEventId) {
        const note =
          decision.type === ReviewDecisionType.DENIED
            ? `denied: ${decision.rejection ?? "rejected"}`
            : "aborted";
        checkpoint.transcript.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: pending.calls?.[0]?.callId || pending.toolEventId,
              toolName: pending.calls?.[0]?.name || "tool",
              output: { type: "text", value: note },
            },
          ],
        });
        await client.sendEvents(managed.providerSessionId, [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: pending.toolEventId,
            content: [{ type: "text", text: note }],
            is_error: true,
          },
        ]);
        checkpoint.context.seenEventIds = [
          ...(checkpoint.context.seenEventIds || []),
          pending.toolEventId,
        ];
      }
      checkpoint.pendingApproval = null;
      if (decision.type === ReviewDecisionType.ABORT) {
        emit(eventMsg.turnAborted(turnId, "approval_abort"));
        await store.saveWithEvents(userId, record.id, { checkpoint });
        return {
          sessionId: record.id,
          status: "aborted",
          abortReason: "approval_abort",
          checkpoint,
        };
      }
    } else {
      resolveToolId = pending.toolEventId;
      checkpoint.pendingApproval = null;
    }
  } else if (!resume && !resumeSession && parsed.op.type === OpType.MESSAGE) {
    checkpoint.context.outboundPrompt = messageText(parsed);
  }

  if (checkpoint.context?.pendingPrompt && !managed.providerSessionId) {
    const text = checkpoint.context.pendingPrompt;
    checkpoint.transcript.push({ role: "user", content: text });
    checkpoint.context.pendingPrompt = null;
    checkpoint.context.outboundPrompt = text;
  }

  checkpoint.context.scheduleCaller = scheduleCaller;
  checkpoint.context.managed = managed;
  let followLease = null;
  let followQueue = null;
  let leaseStatus = "continuing";
  const startedTurns = new Set();
  const emitTurnStarted = (id) => {
    if (!id || startedTurns.has(id)) return;
    startedTurns.add(id);
    emit(eventMsg.turnStarted(id));
  };
  const turnErrorFields = (stage) => ({
    stage,
    submissionId,
    turnId: turnWatchOf(checkpoint)?.turnId || turnId,
    sessionId: record.id,
    providerStatus: checkpoint.context?.providerStatus || "",
  });

  if (resume || resumeSession || checkpoint.context.outboundPrompt) {
    const held = await holdFollowLease(jobs, userId, record.id);
    if (held.deferred) {
      const waiting = checkpoint.context.outboundPrompt;
      if (waiting) {
        checkpoint.context.outboundPrompt = null;
        const saved = await rememberHeldPrompt(store, userId, record.id, waiting);
        emit(
          eventMsg.userTurn({
            turnId: saved?.context?.turnWatch?.turnId || turnWatchOf(checkpoint)?.turnId || null,
            delivery: MessageDelivery.QUEUE,
          })
        );
        return {
          sessionId: record.id,
          status: "continuing",
          checkpoint: saved || checkpoint,
          deferred: true,
        };
      }
      return { sessionId: record.id, status: "continuing", checkpoint, deferred: true };
    }
    followLease = held.lease;
    followQueue = held.queue;
  }
  const personalityState = await loadTurnPersonality(userId, readPersonality);

  async function dispatchOutbound() {
    const text = checkpoint.context.outboundPrompt;
    if (!text) return "idle";
    let priorEvents = [];
    if (managed.providerSessionId) {
      const session = await client.retrieveSession(managed.providerSessionId);
      priorEvents = (await client.listEvents(managed.providerSessionId)) || [];
      const liveStatus = providerStatus(session);
      if (liveStatus) checkpoint.context.providerStatus = liveStatus;
      absorbUnseen(checkpoint, priorEvents);
      const watch = turnWatchOf(checkpoint);
      if (
        watch &&
        previousTurnInFlight(checkpoint) &&
        sessionIsIdle(session) &&
        currentTurnSettled(priorEvents, watch, session)
      ) {
        watch.settled = true;
      }
      if (sessionIsActive(session) || previousTurnInFlight(checkpoint)) {
        queueHeldPrompt(checkpoint, text);
        checkpoint.context.outboundPrompt = null;
        emit(
          eventMsg.userTurn({
            turnId: turnWatchOf(checkpoint)?.turnId || null,
            delivery: MessageDelivery.QUEUE,
          })
        );
        return "held";
      }
    }

    const previousWatch = turnWatchOf(checkpoint);
    const nextTurnId = randomUUID();
    checkpoint.context.turnWatch = {
      turnId: nextTurnId,
      submissionId,
      baselineIds: eventIdentities(priorEvents),
      sawRunning: false,
      dispatched: false,
      settled: false,
    };
    turnId = nextTurnId;
    ensureUserMessage(checkpoint, text);
    emitTurnStarted(nextTurnId);
    emit(
      eventMsg.userTurn({
        turnId: nextTurnId,
        delivery: MessageDelivery.TURN,
      })
    );
    const delivery = personalityDelivery({
      providerSessionId: managed.providerSessionId,
      boundDigest: managed.personalityDigest || null,
      digest: personalityState.digest,
      userText: text,
      guidance: personalityState.guidance,
    });
    const priorError =
      typeof checkpoint.context.turnError === "string" ? checkpoint.context.turnError.trim() : "";
    const providerPrompt = priorError
      ? undeliveredTurnPrompt(delivery.providerPrompt, priorError)
      : delivery.providerPrompt;
    checkpoint.context.heldPrompts = heldPrompts(checkpoint).filter((item) => item !== text);
    try {
      await openOrContinue({
        client,
        managed,
        checkpoint,
        sessionId: record.id,
        prompt: providerPrompt,
        instructions: personalityState.instructions,
      });
    } catch (error) {
      annotateProviderError(error, turnErrorFields("dispatch_prompt"));
      if (error?.status === 409) {
        retractLastUser(checkpoint, text);
        checkpoint.context.turnWatch = previousWatch;
        turnId = previousWatch?.turnId || turnId;
        queueHeldPrompt(checkpoint, text);
        checkpoint.context.outboundPrompt = null;
        emit(
          eventMsg.userTurn({
            turnId: previousWatch?.turnId || null,
            delivery: MessageDelivery.QUEUE,
          })
        );
        return "held";
      }
      if (retryableProviderError(error)) {
        rememberTurnStatus(checkpoint, "continuing");
        checkpoint.context.managed = managed;
        await persistCheckpoint(store, userId, record.id, checkpoint);
        return "stop";
      }
      throw error;
    }
    checkpoint.context.turnWatch.dispatched = true;
    checkpoint.context.outboundPrompt = null;
    managed.personalityDigest = delivery.nextDigest;
    return "sent";
  }

  try {
    try {
      await syncPersonalityMemory(client, managed.memoryStoreId, personalityState.guidance);
    } catch (error) {
      console.error("[chief/personality] memory_sync", error?.status || error?.code || "failed");
    }
    // A follow-up resumes the provider session already opened for this turn.
    // It must not send the user text again once that prompt was accepted.
    // A prompt that never reached Managed Agents stays outbound and is retried.
    // Scheduled runs still use resume:true to deliver their first prompt.
    if (resumeSession && turnWatchOf(checkpoint)?.dispatched === true) {
      checkpoint.context.outboundPrompt = null;
    }
    rememberTurnStatus(checkpoint, "running");
    const startedAt = Date.now();
    let status = "continuing";
    try {
      let chained = 0;
      while (chained < 4) {
        chained += 1;
        if (signal?.aborted) {
          status = "continuing";
          break;
        }
        const watch = turnWatchOf(checkpoint);
        if (
          !checkpoint.context.outboundPrompt &&
          heldPrompts(checkpoint).length &&
          (!watch || watch.settled === true) &&
          managed.providerSessionId
        ) {
          const session = await client.retrieveSession(managed.providerSessionId);
          if (sessionIsIdle(session)) {
            checkpoint.context.outboundPrompt = takeHeldPrompt(checkpoint);
          }
        }
        if (checkpoint.context.outboundPrompt) {
          const outcome = await dispatchOutbound();
          if (outcome === "stop") {
            status = "continuing";
            break;
          }
        }
        if (!managed.providerSessionId) {
          const error = new Error("Claude Managed Agents did not return a session id.");
          error.stage = "dispatch_prompt";
          throw error;
        }
        emitTurnStarted(turnWatchOf(checkpoint)?.turnId || turnId);
        const remaining = Math.max(0, budgetMs - (Date.now() - startedAt));
        status = await collect({
          client,
          checkpoint,
          sessionId: record.id,
          providerSessionId: managed.providerSessionId,
          userId,
          toolSpecs: resolvedSpecs,
          toolExecutor,
          onEmit: emit,
          turnId: turnWatchOf(checkpoint)?.turnId || turnId,
          budgetMs: remaining,
          sleepFn,
          signal,
          resolveToolId,
          caller: scheduleCaller,
          store,
        });
        if (status !== "completed" || !heldPrompts(checkpoint).length) break;
        if (Date.now() - startedAt >= budgetMs) {
          status = "continuing";
          break;
        }
      }
    } catch (error) {
      const reason = skipReason(error);
      annotateProviderError(error, turnErrorFields(error?.stage || "collect"));
      checkpoint.context.managed = managed;
      if (reason) {
        rememberTurnStatus(checkpoint, "aborted");
        await persistCheckpoint(store, userId, record.id, checkpoint);
        leaseStatus = "aborted";
        emit(eventMsg.turnAborted(turnWatchOf(checkpoint)?.turnId || turnId, reason));
        return { sessionId: record.id, status: "aborted", abortReason: reason, checkpoint };
      }
      if (retryableProviderError(error)) {
        rememberTurnStatus(checkpoint, "continuing");
        await persistCheckpoint(store, userId, record.id, checkpoint);
        status = "continuing";
      } else {
        rememberTurnStatus(checkpoint, checkpoint.context.turnStatus || "running");
        await persistCheckpoint(store, userId, record.id, checkpoint);
        throw error;
      }
    }
    if (heldPrompts(checkpoint).length && status === "completed") status = "continuing";
    checkpoint.context.managed = managed;
    rememberTurnStatus(checkpoint, status);
    if (status === "completed") {
      if (checkpoint.context.turnError) checkpoint.context.turnError = "";
      checkpoint.context.turnFailureMessage = "";
    } else if (status === "empty") {
      checkpoint.context.turnError = MISSING_CHIEF_ANSWER;
    } else if (status === "failed") {
      checkpoint.context.turnError =
        checkpoint.context.turnFailureMessage || TERMINAL_STOP_MESSAGE.retries_exhausted;
    }
    await persistCheckpoint(store, userId, record.id, checkpoint);
    await persistThread(threadStore, userId, record.id, managed, status);
    leaseStatus = status;
    if (status === "continuing") {
      const queue = jobs ?? followQueue ?? createPrismaWorkQueue();
      try {
        await queue.enqueue({ userId, threadId: record.id });
      } catch {
        // The session id is already stored. The next cron drain continues it.
      }
    }
    if (status === "completed") {
      emit(eventMsg.turnComplete(turnWatchOf(checkpoint)?.turnId || turnId));
    } else if (status === "empty" || status === "failed") {
      emit(
        eventMsg.error({
          kind: status,
          message: checkpoint.context.turnError,
          retryable: false,
        })
      );
    }
    return { sessionId: record.id, status, checkpoint };
  } finally {
    if (followLease) await settleFollowLease(followQueue, followLease, leaseStatus);
  }
}

async function loadTurnPersonality(userId, readPersonality) {
  let loaded = null;
  if (typeof readPersonality === "function") {
    try {
      loaded = await readPersonality(userId);
    } catch (error) {
      console.error("[chief/personality]", error?.code || error?.name || "read_failed");
    }
  }
  const fitted = fittedPersonalityGuidance(
    normalizeChiefPersonality(loaded?.personality ?? loaded)
  );
  return {
    guidance: fitted.guidance,
    instructions: fitted.instructions,
    digest: personalityDigest(fitted.guidance),
  };
}

async function openOrContinue({ client, managed, checkpoint, sessionId, prompt, instructions }) {
  if (!managed.providerSessionId) {
    const opened = await client.createSession(
      productionSessionBody({
        agentId: managed.agentId,
        agentVersion: managed.agentVersion,
        environmentId: managed.environmentId,
        memoryStoreId: managed.memoryStoreId,
        sessionId,
        prompt,
        instructions,
      })
    );
    if (!opened?.id) throw new Error("Claude Managed Agents did not return a session id.");
    managed.providerSessionId = opened.id;
    checkpoint.totalUsage = {
      ...(checkpoint.totalUsage || {}),
      total_tokens: Math.max(checkpoint.totalUsage?.total_tokens ?? 0, 1),
    };
    return;
  }
  await client.sendEvents(managed.providerSessionId, [
    { type: "user.message", content: [{ type: "text", text: prompt }] },
  ]);
}

export async function drainManagedWork({
  jobs = createPrismaWorkQueue(),
  client,
  store,
  env = process.env,
  runTurn = runManagedChiefTurn,
  now = new Date(),
  createTooling = null,
  afterTurn = null,
  sleepFn,
} = {}) {
  const due = typeof jobs.listDue === "function" ? await jobs.listDue(now, 2) : [];
  if (!due.length) return { drained: 0 };
  let anthropic = client;
  if (!anthropic) {
    if (!env.ANTHROPIC_API_KEY) return { drained: 0, blocked: "ANTHROPIC_API_KEY" };
    anthropic = createManagedClient(env);
  }
  let drained = 0;
  for (const job of due) {
    let toolExecutor = null;
    let toolSpecs = [];
    if (createTooling) {
      try {
        const tooling = await createTooling({ userId: job.userId });
        toolExecutor = tooling?.executor ?? null;
        toolSpecs = tooling?.specs ?? [];
      } catch {
        toolExecutor = null;
      }
    }
    try {
      const result = await runTurn({
        userId: job.userId,
        sessionId: job.threadId,
        store,
        client: anthropic,
        resume: true,
        jobs,
        toolExecutor,
        toolSpecs,
        budgetMs: 20_000,
        sleepFn,
      });
      if (result?.deferred) continue;
      const settled = afterTurn ? await afterTurn({ job, result, error: null }) : null;
      if (settled?.keepQueued && result?.status !== "continuing") {
        await jobs.enqueue({ userId: job.userId, threadId: job.threadId });
      }
      drained += 1;
    } catch (error) {
      const settled = afterTurn
        ? await afterTurn({ job, result: null, error })
        : { keepQueued: true };
      if (settled?.keepQueued === false && typeof jobs.claimThread === "function") {
        const claimed = await jobs.claimThread({
          userId: job.userId,
          threadId: job.threadId,
          now,
        });
        if (claimed && !claimed.missing) await jobs.complete(claimed);
      }
      const logged = providerErrorFields(error);
      console.error("[chief/managed] drain", logged.operation, logged.status, logged.message);
    }
  }
  return { drained };
}
