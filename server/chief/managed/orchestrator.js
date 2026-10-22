import { ICM_ARCHITECT_PIN, REQUIRED_WORKSPACE_PATHS } from "./constants.js";
import {
  proofAgentBody,
  proofEnvironmentBody,
  proofSessionBody,
  recordModelEvidence,
} from "./client.js";
import { buildLatencySample } from "./latency.js";
import { sha256Text } from "./memoryStore.js";
import {
  acquireWriteLease,
  canReleaseWriteOwnership,
  planSync,
  rejectIncoming,
  sessionCanResume,
} from "./ownership.js";
import { deliverProofPing } from "./proofPing.js";
import { ensureResource, hasIdentity, metadataMatch } from "./resources.js";
import { accessFor, assertPromptHasNoTranscript, promptFor } from "./scenario.js";
import { evaluateSkillRead, inspectWorkspace } from "./skillEvidence.js";
import { buildIcmArchitectZip } from "./skillPackage.js";
import { redactSecrets } from "./redact.js";

const SKILL_KEY = `skill:icm-architect:${ICM_ARCHITECT_PIN}`;
const AGENT_KEY = `agent:chief:${ICM_ARCHITECT_PIN}`;
const ENVIRONMENT_KEY = "environment:chief-cloud-limited:v1";

export async function advanceRun({
  store,
  client,
  runId,
  now = new Date(),
  actor = "awaited_start",
  budgetMs = 25_000,
  routeStartedAt = null,
  buildZip = buildIcmArchitectZip,
}) {
  const deadline = now.getTime() + budgetMs;
  let promptSubmitted = false;
  while (Date.now() <= deadline) {
    const run = await store.getRun(runId);
    if (!run) return { ok: false, error: "missing_run", promptSubmitted };
    if (run.providerSessionId) promptSubmitted = true;
    if (run.status === "failed")
      return { ok: false, error: run.lastError || "failed", promptSubmitted, run };
    const job = await store.openJob(runId);
    if (!job) return { ok: true, done: true, promptSubmitted, run };
    const claim = await store.claimJob(job.id, new Date());
    if (!claim.claimed) return { ok: true, busy: true, promptSubmitted, run };
    try {
      const outcome = await runStep({
        store,
        client,
        run,
        job: claim.job,
        now: new Date(),
        actor,
        routeStartedAt,
        buildZip,
      });
      if (outcome.promptSubmitted) promptSubmitted = true;
      if (outcome.done) {
        await store.completeJob(claim.job.id, claim.job.leaseGeneration);
        return { ok: true, done: true, promptSubmitted, run: await store.getRun(runId) };
      }
      await store.releaseJob(claim.job.id, claim.job.leaseGeneration);
      if (outcome.yield) {
        return {
          ok: true,
          yielded: true,
          reason: outcome.reason,
          promptSubmitted,
          run: await store.getRun(runId),
        };
      }
    } catch (error) {
      await store.abandonJob(claim.job.id, claim.job.leaseGeneration, redactSecrets(error.message));
      const failed = await store.getRun(runId);
      failed.lastError = redactSecrets(error.message);
      await store.saveRun(failed);
      return { ok: false, error: failed.lastError, promptSubmitted };
    }
  }
  const job = await store.openJob(runId);
  if (job?.status === "running") await store.releaseJob(job.id, job.leaseGeneration);
  return {
    ok: true,
    yielded: true,
    reason: "budget",
    promptSubmitted,
    run: await store.getRun(runId),
  };
}

async function runStep({ store, client, run, job, now, actor, routeStartedAt, buildZip }) {
  if (job.cursor === "close") return closeRun({ store, run, now });
  if (job.cursor === "setup") return setup({ store, client, run, job, now, buildZip });
  if (job.cursor === "seed") return seed({ store, client, run, job, now });
  if (job.cursor === "open_session") return openSession({ store, client, run, job, now, actor });
  if (job.cursor === "collect")
    return collect({ store, client, run, job, now, actor, routeStartedAt });
  if (job.cursor === "sync") return sync({ store, client, run, job, now, actor, routeStartedAt });
  return { done: true };
}

async function setup({ store, client, run, job, now, buildZip }) {
  const identifiable = hasIdentity;
  const skill = await ensureResource({
    store,
    now,
    spec: {
      kind: "skill",
      idempotencyKey: SKILL_KEY,
      fingerprint: ICM_ARCHITECT_PIN,
      matches: (item) =>
        item.display_title === `icm-architect ${ICM_ARCHITECT_PIN}` ||
        metadataMatch(SKILL_KEY)(item),
      identifiable,
    },
    list: () => client.listSkills(),
    retrieve: (id) => client.retrieveSkill(id),
    create: async () => {
      const zip = await buildZip();
      const created = await client.createSkill({
        filename: zip.filename,
        zipBytes: zip.bytes,
        displayTitle: `icm-architect ${ICM_ARCHITECT_PIN}`,
      });
      return { id: created.id, version: created.latest_version || created.version };
    },
  });
  if (skill.blocked) return blocked(run, store, skill.resource.detail);
  const version = skill.resource.version;
  if (!version) return blocked(run, store, "skill_version_missing");

  const agent = await ensureResource({
    store,
    now,
    spec: {
      kind: "agent",
      idempotencyKey: AGENT_KEY,
      fingerprint: ICM_ARCHITECT_PIN,
      matches: metadataMatch(AGENT_KEY),
      identifiable,
    },
    list: () => client.listAgents(),
    retrieve: (id) => client.retrieveAgent(id),
    create: () =>
      client.createAgent(
        proofAgentBody({
          skillId: skill.resource.providerId,
          skillVersion: version,
          idempotencyKey: AGENT_KEY,
        })
      ),
  });
  if (agent.blocked) return blocked(run, store, agent.resource.detail);
  if (!agent.resource.version) return blocked(run, store, "agent_version_missing");

  const environment = await ensureResource({
    store,
    now,
    spec: {
      kind: "environment",
      idempotencyKey: ENVIRONMENT_KEY,
      fingerprint: "cloud-limited-v1",
      matches: metadataMatch(ENVIRONMENT_KEY),
      identifiable,
    },
    list: () => client.listEnvironments(),
    retrieve: (id) => client.retrieveEnvironment(id),
    create: () => client.createEnvironment(proofEnvironmentBody(ENVIRONMENT_KEY)),
  });
  if (environment.blocked) return blocked(run, store, environment.resource.detail);
  job.cursor = "seed";
  return { done: false };
}

async function seed({ store, client, run, job, now }) {
  const project = await store.getProject(run.projectId);
  const recovery = run.phase === "recover";
  const key = recovery ? `memory:${project.id}:recovery:${run.id}` : `memory:${project.id}:primary`;
  const memory = await ensureResource({
    store,
    now,
    spec: {
      id: undefined,
      userId: run.userId,
      projectId: project.id,
      kind: "memory_store",
      idempotencyKey: key,
      fingerprint: key,
      matches: metadataMatch(key),
      identifiable: hasIdentity,
    },
    list: () => client.listMemoryStores(),
    retrieve: async (id) => ({ id }),
    create: () =>
      client.createMemoryStore({
        name: recovery ? `chief-proof-recovery-${run.id}` : `chief-proof-${project.id}`,
        metadata: { freedom_os_key: key },
      }),
  });
  if (memory.blocked) return blocked(run, store, memory.resource.detail);
  const documents = await store.listDocuments(project.id);
  if (recovery && project.memoryStoreId && memory.resource.providerId === project.memoryStoreId) {
    return blocked(run, store, "recovery_reused_original_store");
  }
  const baseHashes = {};
  for (const doc of documents) {
    baseHashes[doc.path] = doc.contentSha256;
    try {
      await client.createMemory(memory.resource.providerId, {
        path: `/${doc.path}`,
        content: doc.content,
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  run.baseHashes = baseHashes;
  run.baseRevision = project.revision;
  run.memoryStoreId = memory.resource.providerId;
  run.priorStoreId = recovery ? project.memoryStoreId : null;
  if (!recovery && !project.memoryStoreId) {
    const saved = await store.compareAndSetProject(project.id, project.leaseGeneration, {
      memoryStoreId: memory.resource.providerId,
    });
    if (!saved.ok) return blocked(run, store, "project_changed_during_seed");
  }
  await store.saveRun(run);
  job.cursor = "open_session";
  return { done: false };
}

async function openSession({ store, client, run, job, now, actor }) {
  const project = await store.getProject(run.projectId);
  const runs = await store.runsForProject(project.id);
  const owner = runs.find(
    (item) =>
      item.providerSessionId === project.writeSessionId ||
      `pending:${item.id}` === project.writeSessionId
  );
  const unfinished = owner ? await store.unfinishedToolCalls(owner.id) : 0;
  const ownerCanResume = Boolean(
    project.writeSessionId &&
    sessionCanResume({
      runStatus: owner?.status || "running",
      providerStatus: owner?.providerStatus || "idle",
      unfinishedToolCalls: unfinished,
    })
  );
  const access = accessFor(run.phase, { ownerCanResume, sameSession: false });
  const prompt = promptFor(run.phase);
  const leak = assertPromptHasNoTranscript(prompt, owner?.assistantText || "");
  if (!leak.ok) return blocked(run, store, leak.reason);
  if (run.phase === "recover" && run.priorStoreId && run.memoryStoreId === run.priorStoreId) {
    return blocked(run, store, "recovery_attached_original_store");
  }

  const pendingId = `pending:${run.id}`;
  if (access === "read_write") {
    const lease = acquireWriteLease({
      project,
      sessionId: pendingId,
      now,
      ownerCanResume: ownerCanResume && project.writeSessionId !== pendingId,
    });
    if (!lease.ok) return { done: false, yield: true, reason: lease.reason };
    const saved = await store.compareAndSetProject(project.id, project.leaseGeneration, {
      writeSessionId: lease.writeSessionId,
      leaseGeneration: lease.leaseGeneration,
      writeLeaseExpiresAt: lease.writeLeaseExpiresAt,
    });
    if (!saved.ok) return { done: false, yield: true, reason: "lease_race" };
  }

  const agent = await store.getResource(AGENT_KEY);
  const environment = await store.getResource(ENVIRONMENT_KEY);
  const sessionKey = `session:${run.id}`;
  const existing = (await client.listSessions()).filter(
    (item) => item?.metadata?.freedom_os_key === sessionKey
  );
  if (existing.length > 1) return blocked(run, store, "multiple_sessions");
  let session = existing[0] || null;
  if (!session) {
    session = await client.createSession(
      proofSessionBody({
        agentId: agent.providerId,
        agentVersion: agent.version,
        environmentId: environment.providerId,
        storeId: run.memoryStoreId,
        access,
        prompt,
        runId: run.id,
      })
    );
  }
  if (!session?.id) return blocked(run, store, "session_missing_id");
  const attached = (
    session.resources || [{ type: "memory_store", memory_store_id: run.memoryStoreId }]
  )
    .filter((item) => item.type === "memory_store")
    .map((item) => item.memory_store_id);
  if (run.phase === "recover" && run.priorStoreId && attached.includes(run.priorStoreId)) {
    return blocked(run, store, "recovery_attached_original_store");
  }
  if (access === "read_write") {
    const current = await store.getProject(project.id);
    const saved = await store.compareAndSetProject(project.id, current.leaseGeneration, {
      writeSessionId: session.id,
    });
    if (!saved.ok) return blocked(run, store, "ownership_moved_after_create");
  }
  run.providerSessionId = session.id;
  run.attachedStoreIds = attached;
  run.promptSubmittedBy = run.promptSubmittedBy || actor;
  run.status = "running";
  run.modelEvidence = recordModelEvidence(session);
  await store.saveRun(run);
  job.cursor = "collect";
  return { done: false, promptSubmitted: true };
}

async function collect({ store, client, run, job, now, actor, routeStartedAt }) {
  const session = await client.retrieveSession(run.providerSessionId);
  const events = await client.listEvents(run.providerSessionId);
  run.providerStatus = session?.status || null;
  run.modelEvidence = recordModelEvidence(session);
  const assistant = events
    .filter((event) => event.type === "agent.message")
    .map(messageText)
    .filter(Boolean);
  if (assistant.length && !run.assistantText) {
    run.assistantText = assistant.join("\n");
    const first = events.find((event) => event.type === "agent.message");
    await store.addSample(
      buildLatencySample({
        run,
        actor,
        now,
        routeStartedAt,
        processedAt: first?.processed_at || null,
        firstTextAt: first?.processed_at || now,
        phase: run.phase,
      })
    );
  }
  run.skillEvidence = evaluateSkillRead(events);
  for (const event of events) {
    if (
      event.type === "agent.custom_tool_use" &&
      (event.name === "proof_ping" || event.tool_name === "proof_ping")
    ) {
      await deliverProofPing({
        toolEventId: event.id,
        runId: run.id,
        userId: run.userId,
        store,
        now,
        postResult: async () => {
          await client.sendEvents(run.providerSessionId, [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: `stored:${event.id}` }],
              is_error: false,
            },
          ]);
          return { ok: true };
        },
      });
    }
  }
  await renewWriteLease(store, run, now);
  await store.saveRun(run);
  const idle =
    events.some((event) => event.type === "session.status_idle") || session?.status === "idle";
  if (!idle) {
    run.status = "waiting";
    await store.saveRun(run);
    return { done: false, yield: true, reason: "waiting_for_provider" };
  }
  run.status = "idle";
  await store.saveRun(run);
  job.cursor = "sync";
  return { done: false };
}

async function sync({ store, client, run, now, actor, routeStartedAt }) {
  let listed = null;
  let listOk;
  try {
    listed = await client.listMemories(run.memoryStoreId);
    listOk = Array.isArray(listed);
  } catch {
    listOk = false;
  }
  const incoming = listOk
    ? listed
        .map((item) => ({
          path: String(item.path || "").replace(/^\/+/, ""),
          content: typeof item.content === "string" ? item.content : "",
          contentSha256: sha256Text(typeof item.content === "string" ? item.content : ""),
        }))
        .filter((item) => item.path)
    : [];
  const live = await store.listDocuments(run.projectId);
  const project = await store.getProject(run.projectId);
  const plan = planSync({
    baseHashes: run.baseHashes || {},
    liveDocuments: live,
    incoming,
    listOk,
  });
  const changed = incoming.filter((doc) => {
    const current = live.find((row) => row.path === doc.path);
    return !current || current.contentSha256 !== doc.contentSha256;
  });
  const ownsWrite = project.writeSessionId === run.providerSessionId;
  if (ownsWrite) await renewWriteLease(store, run, now);
  const current = await store.getProject(project.id);
  const auth = current.writeSessionId === run.providerSessionId;
  await store.applyCommit({
    projectId: project.id,
    writeSessionId: auth ? run.providerSessionId : current.writeSessionId,
    leaseGeneration: current.leaseGeneration,
    now,
    writes: auth ? plan.writes : [],
    deletes: auth ? plan.deletes : [],
    conflicts: auth
      ? plan.conflicts
      : rejectIncoming({
          incoming: changed,
          reason: "not_write_owner",
          baseHashes: run.baseHashes || {},
        }),
  });
  const files = await store.listDocuments(run.projectId);
  run.workspaceEvidence = inspectWorkspace(files, REQUIRED_WORKSPACE_PATHS);
  run.synced = true;
  run.status = "idle";
  await store.addSample(
    buildLatencySample({
      run,
      actor,
      now,
      routeStartedAt,
      completedAt: now,
      firstTextAt: null,
      phase: `${run.phase}:sync`,
    })
  );
  await store.saveRun(run);
  return { done: true };
}

async function closeRun({ store, run, now }) {
  const prior = run.priorRunId ? await store.getRun(run.priorRunId) : null;
  const project = await store.getProject(run.projectId);
  const unfinished = prior ? await store.unfinishedToolCalls(prior.id) : 0;
  const releasable = canReleaseWriteOwnership({
    runStatus: "closed",
    providerStatus: prior?.providerStatus || "idle",
    unfinishedToolCalls: unfinished,
  });
  if (!releasable) return { done: false, yield: true, reason: "owner_can_resume" };
  if (prior) {
    prior.status = "closed";
    prior.closedAt = now;
    await store.saveRun(prior);
  }
  if (project.writeSessionId && (!prior || project.writeSessionId === prior.providerSessionId)) {
    await store.compareAndSetProject(project.id, project.leaseGeneration, {
      writeSessionId: null,
      leaseGeneration: project.leaseGeneration + 1,
      writeLeaseExpiresAt: null,
    });
  }
  run.status = "closed";
  run.closedAt = now;
  await store.saveRun(run);
  return { done: true };
}

async function renewWriteLease(store, run, now) {
  const project = await store.getProject(run.projectId);
  if (project.writeSessionId !== run.providerSessionId) return;
  const lease = acquireWriteLease({
    project,
    sessionId: run.providerSessionId,
    now,
    ownerCanResume: false,
  });
  if (!lease.ok) return;
  await store.compareAndSetProject(project.id, project.leaseGeneration, {
    writeLeaseExpiresAt: lease.writeLeaseExpiresAt,
  });
}

async function blocked(run, store, detail) {
  run.status = "failed";
  run.lastError = detail || "needs_reconciliation";
  await store.saveRun(run);
  return { done: true };
}

function messageText(event) {
  if (typeof event.text === "string") return event.text;
  const content = event.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => block?.text || "").join("");
  return "";
}
