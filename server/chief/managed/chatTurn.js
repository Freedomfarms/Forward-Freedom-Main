import { randomUUID } from "node:crypto";

import {
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
import { redactSecrets } from "./redact.js";
import { createPrismaWorkQueue } from "./workQueue.js";
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

function appendAssistant(checkpoint, text) {
  if (!text) return;
  const transcript = checkpoint.transcript;
  const last = transcript[transcript.length - 1];
  if (last?.role === "assistant" && last.content === text) return;
  transcript.push({ role: "assistant", content: text });
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
      onEmit(eventMsg.turnAborted(turnId, "interrupted"));
      checkpoint.context.seenEventIds = [...seen];
      return "aborted";
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
      if (store) await store.saveWithEvents(userId, sessionId, { checkpoint });
      continue;
    }
    const idle =
      events.some((event) => event.type === "session.status_idle") || session?.status === "idle";
    if (idle) {
      checkpoint.context.seenEventIds = [...seen];
      checkpoint.executionStats = {
        modelSteps: (checkpoint.executionStats?.modelSteps ?? 0) + 1,
        toolCalls: checkpoint.executionStats?.toolCalls ?? 0,
      };
      return "completed";
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
} = {}) {
  const parsed = resume ? null : parseSubmission(submission);
  const submissionId = parsed?.id ?? null;
  const emit = (msg) => onEvent?.(makeEvent(msg, submissionId));
  const turnId = randomUUID();

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

  if (!resume && parsed.op.type !== OpType.MESSAGE && parsed.op.type !== OpType.EXEC_APPROVAL) {
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
    throw error;
  }

  const resolvedSpecs = specsFrom(toolSpecs, toolExecutor);
  emit(eventMsg.turnStarted(turnId));
  const bindingStore = bindings ?? createPrismaBindingStore();
  const threadStore = threads ?? createPrismaThreadStore();
  const managed = await ensureResources({
    client,
    userId,
    toolSpecs: resolvedSpecs,
    bindings: bindingStore,
    managed: checkpoint.context.managed || null,
  });

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
  } else if (!resume && parsed.op.type === OpType.MESSAGE) {
    const text = messageText(parsed);
    checkpoint.transcript.push({ role: "user", content: text });
    checkpoint.context.outboundPrompt = text;
  }

  if (checkpoint.context?.pendingPrompt && !managed.providerSessionId) {
    const text = checkpoint.context.pendingPrompt;
    checkpoint.transcript.push({ role: "user", content: text });
    checkpoint.context.pendingPrompt = null;
    checkpoint.context.outboundPrompt = text;
  }

  checkpoint.context.scheduleCaller = scheduleCaller;
  checkpoint.context.managed = managed;
  let status;
  try {
    if (checkpoint.context.outboundPrompt) {
      const text = checkpoint.context.outboundPrompt;
      checkpoint.context.outboundPrompt = null;
      await openOrContinue({
        client,
        managed,
        checkpoint,
        sessionId: record.id,
        prompt: text,
      });
    }
    if (!managed.providerSessionId) {
      throw new Error("Claude Managed Agents did not return a session id.");
    }
    status = await collect({
      client,
      checkpoint,
      sessionId: record.id,
      providerSessionId: managed.providerSessionId,
      userId,
      toolSpecs: resolvedSpecs,
      toolExecutor,
      onEmit: emit,
      turnId,
      budgetMs,
      sleepFn,
      signal,
      resolveToolId,
      caller: scheduleCaller,
      store,
    });
  } catch (error) {
    const reason = skipReason(error);
    checkpoint.context.managed = managed;
    await store.saveWithEvents(userId, record.id, { checkpoint });
    if (reason) {
      emit(eventMsg.turnAborted(turnId, reason));
      return { sessionId: record.id, status: "aborted", abortReason: reason, checkpoint };
    }
    throw error;
  }
  checkpoint.context.managed = managed;
  await store.saveWithEvents(userId, record.id, { checkpoint });
  await persistThread(threadStore, userId, record.id, managed, status);
  if (status === "continuing") {
    const queue = jobs ?? createPrismaWorkQueue();
    try {
      await queue.enqueue({ userId, threadId: record.id });
    } catch {
      // The session id is already stored. The next cron drain continues it.
    }
  }
  if (status === "completed") emit(eventMsg.turnComplete(turnId));
  return { sessionId: record.id, status, checkpoint };
}

async function openOrContinue({ client, managed, checkpoint, sessionId, prompt }) {
  if (!managed.providerSessionId) {
    const opened = await client.createSession(
      productionSessionBody({
        agentId: managed.agentId,
        agentVersion: managed.agentVersion,
        environmentId: managed.environmentId,
        memoryStoreId: managed.memoryStoreId,
        sessionId,
        prompt,
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
  const due = await jobs.claimDue(now, 2);
  if (!due.length) return { drained: 0 };
  let anthropic = client;
  if (!anthropic) {
    if (!env.ANTHROPIC_API_KEY) {
      for (const job of due) await jobs.release(job);
      return { drained: 0, blocked: "ANTHROPIC_API_KEY" };
    }
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
      const settled = afterTurn ? await afterTurn({ job, result, error: null }) : null;
      if (result?.status === "continuing" || settled?.keepQueued) await jobs.release(job);
      else await jobs.complete(job);
      drained += 1;
    } catch (error) {
      const settled = afterTurn
        ? await afterTurn({ job, result: null, error })
        : { keepQueued: true };
      if (settled?.keepQueued !== false) await jobs.release(job);
      else await jobs.complete(job);
      console.error("[chief/managed] drain", redactSecrets(error?.message || "Error"));
    }
  }
  return { drained };
}
