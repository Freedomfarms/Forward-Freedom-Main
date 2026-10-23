import { proofEnabled, SLICE_BUDGET_MS } from "./constants.js";
import { acknowledgeDispatch } from "./kick.js";
import { summarizeLatency } from "./latency.js";
import { queueProofRun } from "./queue.js";
import { decideWebhookDelivery } from "./jobs.js";
import { bearerMatches, readBearer } from "./secret.js";
import { readRawBody, readSessionIdled, verifyStandardWebhook } from "./webhookVerify.js";
import { advanceRun } from "./orchestrator.js";

export async function handleManagedRunStart(request, response, deps = {}) {
  if (!allow(request, response, deps)) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
    return;
  }
  const userId = await userFrom(request, response, deps);
  if (!userId) return;
  const body = request.body || {};
  const phase = typeof body.phase === "string" ? body.phase : "initial";
  const store = deps.storeFor(userId);
  let queued;
  try {
    queued = await queueProofRun(store, {
      userId,
      phase,
      projectId: body.projectId || null,
      priorRunId: body.priorRunId || null,
      title: body.title,
    });
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message || "unable to queue run" });
    return;
  }
  let acknowledged;
  try {
    acknowledged = await acknowledgeDispatch(deps.dispatch, queued.run.id);
  } catch {
    acknowledged = { accepted: false, reason: "dispatch_failed" };
  }
  response.status(202).json({
    runId: queued.run.id,
    projectId: queued.project.id,
    promptSubmitted: false,
    status: "queued",
    dispatchAcknowledged: acknowledged.accepted,
    reason: acknowledged.reason,
  });
}

export async function handleManagedRunStatus(request, response, deps = {}) {
  if (!allow(request, response, deps)) return;
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }
  if (deps.advance) {
    response.status(500).json({ error: "status must not drain" });
    return;
  }
  const userId = await userFrom(request, response, deps);
  if (!userId) return;
  const runId = request.params?.runId || request.query?.runId || "";
  const store = deps.storeFor(userId);
  const run = await store.getRun(runId);
  if (!run || run.userId !== userId) {
    response.status(404).json({ error: "run not found" });
    return;
  }
  const samples = await store.listSamples(runId);
  response.status(200).json({
    run: publicRun(run),
    latency: summarizeLatency(samples),
  });
}

export async function handleManagedDrain(request, response, deps = {}) {
  if (!allow(request, response, deps, { proofOnly: true })) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
    return;
  }
  const secret = deps.drainSecret ?? process.env.CHIEF_DRAIN_SECRET;
  if (!secret) {
    response.status(503).json({ error: "CHIEF drain is not configured" });
    return;
  }
  if (!bearerMatches(readBearer(request), secret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const depth = Number(
    request.headers?.["x-chief-chain-depth"] || request.headers?.["X-Chief-Chain-Depth"] || 0
  );
  const actor = request.headers?.["x-chief-actor"] === "supervisor" ? "supervisor" : "self_post";
  const jobs = await deps.listClaimable(new Date());
  const results = [];
  for (const job of jobs) {
    const store = deps.storeFor(job.userId);
    try {
      results.push(
        await advanceRun({
          store,
          client: deps.client,
          runId: job.runId,
          actor,
          budgetMs: deps.budgetMs || SLICE_BUDGET_MS,
        })
      );
    } catch {
      results.push({ ok: false, yielded: true, reason: "kick_failed", runId: job.runId });
    }
  }
  let chained = false;
  const more = results.some((result) => result.yielded);
  if (more && deps.selfPost && depth < 3) {
    await deps.selfPost({ depth: depth + 1 });
    chained = true;
  }
  response.status(200).json({ drained: results.length, chained, actor });
}

export async function handleManagedWebhook(request, response, deps = {}) {
  if (!allow(request, response, deps, { proofOnly: true })) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
    return;
  }
  const rawBody = await readRawBody(request);
  const verified = verifyStandardWebhook({
    rawBody,
    headers: request.headers,
    secret: deps.webhookSecret ?? process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY,
    now: (deps.now || new Date()).getTime(),
  });
  if (!verified.ok) {
    response.status(verified.status).json({ error: "webhook rejected" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    response.status(400).json({ error: "webhook body is not json" });
    return;
  }
  const sessionId = readSessionIdled(payload);
  if (!sessionId) {
    response.status(200).json({ ignored: true });
    return;
  }
  const located = await deps.findRunBySession(sessionId);
  if (!located) {
    response.status(200).json({ ignored: true });
    return;
  }
  const store = deps.storeFor(located.userId);
  const existing = await store.getJobByWebhook(verified.webhookId);
  const decision = decideWebhookDelivery(existing, deps.now || new Date());
  if (decision.action === "insert") {
    await store.createJob({
      userId: located.userId,
      runId: located.id,
      kind: "webhook",
      cursor: located.status === "idle" ? "sync" : "collect",
      webhookEventId: verified.webhookId,
    });
  }
  let dispatchAcknowledged = false;
  if (decision.action === "wake" || decision.action === "insert") {
    try {
      const ack = await acknowledgeDispatch(deps.dispatch, located.id);
      dispatchAcknowledged = ack.accepted;
    } catch {
      dispatchAcknowledged = false;
    }
  }
  response.status(200).json({ delivery: decision.action, dispatchAcknowledged });
}

function allow(request, response, deps, { proofOnly = false } = {}) {
  const enabled = deps.enabled ?? proofEnabled();
  if (!enabled) {
    response.status(503).json({ error: "managed proof runtime is disabled" });
    return false;
  }
  if (proofOnly) return true;
  return true;
}

async function userFrom(request, response, deps) {
  try {
    const authenticate = deps.authenticate;
    if (!authenticate) {
      response.status(503).json({ error: "auth is not configured" });
      return null;
    }
    const userId = (await authenticate(request)).uid;
    if (!userId) {
      response.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return userId;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return null;
  }
}

function publicRun(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    phase: run.phase,
    status: run.status,
    promptClass: run.promptClass,
    providerSessionId: run.providerSessionId,
    memoryStoreId: run.memoryStoreId,
    priorStoreId: run.priorStoreId,
    attachedStoreIds: run.attachedStoreIds || [],
    promptSubmittedBy: run.promptSubmittedBy,
    modelEvidence: run.modelEvidence,
    skillEvidence: run.skillEvidence,
    workspaceEvidence: run.workspaceEvidence,
    assistantText: run.assistantText || null,
    synced: Boolean(run.synced),
    lastError: run.lastError || null,
    createdAt: run.createdAt,
    closedAt: run.closedAt,
  };
}
