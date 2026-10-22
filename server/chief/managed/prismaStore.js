import { JOB_LEASE_MS } from "./constants.js";
import { withUserContext } from "../../db/prisma.js";
import { getServicePrismaClient } from "../../db/servicePrisma.js";
import { canClaimJob, nextJobLease } from "./jobs.js";
import { authorizeCommit } from "./ownership.js";
import { decrypt, encrypt } from "../../security/envelope.js";

// Service-role access is limited to provider resource ids and to resolving a
// webhook session to a user. Document bodies are read and written only inside
// withUserContext. Null-userId resource rows are invisible under forced RLS,
// so the service role is the only writer for those deployment ids.

function serviceDb() {
  const client = getServicePrismaClient();
  if (!client) {
    const error = new Error("Database client is not configured.");
    error.status = 503;
    throw error;
  }
  return client;
}

function seal(value) {
  return encrypt(value ?? "");
}

function open(payload) {
  if (payload == null || payload === "") return null;
  return decrypt(payload);
}

function toRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    priorRunId: row.priorRunId,
    phase: row.phase,
    status: row.status,
    promptClass: row.promptClass,
    prompt: open(row.promptCiphertext) || "",
    providerSessionId: row.providerSessionId,
    memoryStoreId: row.memoryStoreId,
    priorStoreId: row.priorStoreId,
    attachedStoreIds: row.attachedStoreIds || [],
    baseRevision: row.baseRevision,
    baseHashes: row.baseHashes || {},
    modelEvidence: row.modelEvidence,
    skillEvidence: row.skillEvidence,
    workspaceEvidence: row.workspaceEvidence,
    assistantText: open(row.assistantCiphertext),
    promptSubmittedBy: row.promptSubmittedBy,
    synced: row.synced,
    lastError: row.lastError,
    providerStatus: row.providerStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

function runUpdate(run) {
  return {
    status: run.status,
    providerSessionId: run.providerSessionId,
    memoryStoreId: run.memoryStoreId,
    priorStoreId: run.priorStoreId,
    attachedStoreIds: run.attachedStoreIds || undefined,
    baseRevision: run.baseRevision,
    baseHashes: run.baseHashes || undefined,
    modelEvidence: run.modelEvidence || undefined,
    skillEvidence: run.skillEvidence || undefined,
    workspaceEvidence: run.workspaceEvidence || undefined,
    assistantCiphertext: run.assistantText ? seal(run.assistantText) : null,
    promptSubmittedBy: run.promptSubmittedBy,
    synced: Boolean(run.synced),
    lastError: run.lastError,
    closedAt: run.closedAt,
  };
}

export function createUserStore({ userId, withUser = withUserContext }) {
  const tx = (fn) => withUser(userId, fn);
  return {
    async createProject({ title, now = new Date() }) {
      return tx((db) =>
        db.chiefProofProject.create({
          data: { userId, title, createdAt: now, updatedAt: now },
        })
      );
    },
    async getProject(projectId) {
      return tx((db) => db.chiefProofProject.findFirst({ where: { id: projectId, userId } }));
    },
    async compareAndSetProject(projectId, expectedGeneration, patch) {
      return tx(async (db) => {
        const result = await db.chiefProofProject.updateMany({
          where: { id: projectId, userId, leaseGeneration: expectedGeneration },
          data: patch,
        });
        const project = await db.chiefProofProject.findFirst({ where: { id: projectId, userId } });
        return { ok: result.count === 1, project };
      });
    },
    async listDocuments(projectId) {
      const rows = await tx((db) =>
        db.chiefProofDocument.findMany({ where: { projectId, userId } })
      );
      return rows.map((row) => ({
        path: row.path,
        content: open(row.contentCiphertext) || "",
        contentSha256: row.contentSha256,
        revision: row.revision,
        userId: row.userId,
        projectId: row.projectId,
      }));
    },
    async insertConflict(row) {
      return tx((db) =>
        db.chiefProofConflict.create({
          data: {
            userId,
            projectId: row.projectId,
            path: row.path,
            writeSessionId: row.writeSessionId || null,
            leaseGeneration: row.leaseGeneration,
            baseSha256: row.baseSha256 || null,
            currentSha256: row.currentSha256 || null,
            reason: row.reason,
            rejectedCiphertext: seal(row.rejectedContent || ""),
          },
        })
      );
    },
    async createRun(input) {
      const row = await tx((db) =>
        db.chiefProofRun.create({
          data: {
            userId,
            projectId: input.projectId,
            priorRunId: input.priorRunId,
            phase: input.phase,
            status: input.status || "queued",
            promptClass: input.promptClass,
            promptCiphertext: seal(input.prompt || ""),
            createdAt: input.createdAt,
          },
        })
      );
      return toRun(row);
    },
    async getRun(runId) {
      return toRun(await tx((db) => db.chiefProofRun.findFirst({ where: { id: runId, userId } })));
    },
    async saveRun(run) {
      const row = await tx((db) =>
        db.chiefProofRun.update({
          where: { id: run.id },
          data: runUpdate(run),
        })
      );
      return toRun(row);
    },
    async runsForProject(projectId) {
      const rows = await tx((db) => db.chiefProofRun.findMany({ where: { projectId, userId } }));
      return rows.map(toRun);
    },
    async createJob(input) {
      return tx((db) =>
        db.chiefProofJob.create({
          data: {
            userId,
            runId: input.runId,
            kind: input.kind,
            cursor: input.cursor,
            webhookEventId: input.webhookEventId || null,
            createdAt: input.createdAt,
          },
        })
      );
    },
    async getJobByWebhook(webhookEventId) {
      return tx((db) => db.chiefProofJob.findFirst({ where: { webhookEventId, userId } }));
    },
    async openJob(runId) {
      return tx((db) =>
        db.chiefProofJob.findFirst({
          where: { runId, userId, status: { not: "completed" } },
          orderBy: { createdAt: "desc" },
        })
      );
    },
    async claimJob(jobId, now) {
      return tx(async (db) => {
        const current = await db.chiefProofJob.findFirst({ where: { id: jobId, userId } });
        if (!canClaimJob(current, now)) return { claimed: false, job: current };
        const next = nextJobLease(current, now, JOB_LEASE_MS);
        const result = await db.chiefProofJob.updateMany({
          where: {
            id: jobId,
            userId,
            leaseGeneration: current.leaseGeneration,
            status: { not: "completed" },
          },
          data: next,
        });
        const job = await db.chiefProofJob.findFirst({ where: { id: jobId, userId } });
        return { claimed: result.count === 1, job };
      });
    },
    async releaseJob(jobId, generation) {
      return tx(async (db) => {
        const result = await db.chiefProofJob.updateMany({
          where: { id: jobId, userId, leaseGeneration: generation, status: { not: "completed" } },
          data: { status: "pending", leaseExpiresAt: null, availableAt: new Date() },
        });
        return { ok: result.count === 1 };
      });
    },
    async completeJob(jobId, generation) {
      return tx(async (db) => {
        const result = await db.chiefProofJob.updateMany({
          where: { id: jobId, userId, leaseGeneration: generation },
          data: { status: "completed", completedAt: new Date() },
        });
        return { ok: result.count === 1 };
      });
    },
    async abandonJob(jobId, generation, error) {
      return tx(async (db) => {
        const result = await db.chiefProofJob.updateMany({
          where: { id: jobId, userId, leaseGeneration: generation, status: { not: "completed" } },
          data: {
            status: "pending",
            leaseExpiresAt: null,
            lastError: error,
            availableAt: new Date(),
          },
        });
        return { ok: result.count === 1 };
      });
    },
    async getResource(idempotencyKey) {
      return serviceDb().chiefManagedResource.findUnique({ where: { idempotencyKey } });
    },
    async saveResource(resource) {
      const data = {
        userId: resource.userId || null,
        projectId: resource.projectId || null,
        kind: resource.kind,
        idempotencyKey: resource.idempotencyKey,
        providerId: resource.providerId,
        version: resource.version,
        status: resource.status,
        fingerprint: resource.fingerprint,
        detail: resource.detail,
      };
      return serviceDb().chiefManagedResource.upsert({
        where: { idempotencyKey: resource.idempotencyKey },
        create: resource.id ? { ...data, id: resource.id } : data,
        update: data,
      });
    },
    async insertPing({ toolEventId, runId, now = new Date() }) {
      try {
        const row = await tx((db) =>
          db.chiefProofPing.create({ data: { userId, runId, toolEventId, createdAt: now } })
        );
        return { created: true, row };
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const row = await tx((db) =>
          db.chiefProofPing.findFirst({ where: { toolEventId, userId } })
        );
        return { created: false, row };
      }
    },
    async getToolCall(toolEventId) {
      const row = await tx((db) =>
        db.chiefProofToolCall.findFirst({ where: { providerToolEventId: toolEventId, userId } })
      );
      if (!row) return null;
      return { ...row, result: open(row.resultCiphertext) };
    },
    async saveToolCall(tool) {
      const data = {
        userId,
        runId: tool.runId,
        providerToolEventId: tool.providerToolEventId,
        name: tool.name,
        status: tool.status,
        resultCiphertext: tool.result ? seal(JSON.stringify(tool.result)) : null,
        postedAt: tool.postedAt || null,
        completedAt: tool.completedAt || null,
      };
      return tx((db) =>
        db.chiefProofToolCall.upsert({
          where: { providerToolEventId: tool.providerToolEventId },
          create: data,
          update: data,
        })
      );
    },
    async unfinishedToolCalls(runId) {
      return tx((db) =>
        db.chiefProofToolCall.count({
          where: { runId, userId, status: { not: "completed" } },
        })
      );
    },
    async addSample(sample) {
      return tx((db) =>
        db.chiefProofLatencySample.create({
          data: {
            userId,
            runId: sample.runId,
            kind: sample.kind,
            delayClass: sample.delayClass,
            phase: sample.phase,
            actor: sample.actor,
            startedAt: sample.startedAt,
            firstTextAt: sample.firstTextAt,
            completedAt: sample.completedAt,
            processedAt: sample.processedAt,
            observedAt: sample.observedAt,
            routeMs: sample.routeMs,
            pollDelayMs: sample.pollDelayMs,
            note: sample.note,
          },
        })
      );
    },
    async listSamples(runId) {
      return tx((db) =>
        db.chiefProofLatencySample.findMany({
          where: { runId, userId },
          orderBy: { createdAt: "asc" },
        })
      );
    },
    async applyCommit({
      projectId,
      writeSessionId,
      leaseGeneration,
      now,
      writes,
      deletes,
      conflicts,
    }) {
      return tx(async (db) => {
        const project = await db.chiefProofProject.findFirst({ where: { id: projectId, userId } });
        const auth = authorizeCommit({ project, writeSessionId, leaseGeneration, now });
        if (!auth.ok) {
          for (const row of conflicts || []) {
            await db.chiefProofConflict.create({
              data: conflictData(userId, projectId, writeSessionId, leaseGeneration, row),
            });
          }
          return { ok: false, reason: auth.reason, project };
        }
        for (const write of writes || []) {
          const current = await db.chiefProofDocument.findFirst({
            where: { projectId, userId, path: write.path },
          });
          if (write.op === "insert" && !current) {
            await db.chiefProofDocument.create({
              data: {
                userId,
                projectId,
                path: write.path,
                revision: project.revision + 1,
                contentSha256: write.contentSha256,
                contentCiphertext: seal(write.content),
              },
            });
          } else if (write.op === "update" && current?.contentSha256 === write.expectedSha256) {
            await db.chiefProofDocument.update({
              where: { id: current.id },
              data: {
                contentSha256: write.contentSha256,
                contentCiphertext: seal(write.content),
                revision: project.revision + 1,
              },
            });
          } else {
            await db.chiefProofConflict.create({
              data: conflictData(userId, projectId, writeSessionId, leaseGeneration, {
                path: write.path,
                reason: "hash_conflict",
                rejectedContent: write.content,
                baseSha256: write.expectedSha256 || null,
                currentSha256: current?.contentSha256 || null,
              }),
            });
          }
        }
        for (const deletion of deletes || []) {
          const current = await db.chiefProofDocument.findFirst({
            where: { projectId, userId, path: deletion.path },
          });
          if (current?.contentSha256 === deletion.expectedSha256) {
            await db.chiefProofDocument.delete({ where: { id: current.id } });
          }
        }
        for (const row of conflicts || []) {
          await db.chiefProofConflict.create({
            data: conflictData(userId, projectId, writeSessionId, leaseGeneration, row),
          });
        }
        if ((writes || []).length || (deletes || []).length) {
          await db.chiefProofProject.update({
            where: { id: project.id },
            data: { revision: { increment: 1 } },
          });
        }
        return { ok: true, project };
      });
    },
  };
}

function conflictData(userId, projectId, writeSessionId, leaseGeneration, row) {
  return {
    userId,
    projectId,
    path: row.path,
    writeSessionId: writeSessionId || null,
    leaseGeneration,
    baseSha256: row.baseSha256 || null,
    currentSha256: row.currentSha256 || null,
    reason: row.reason,
    rejectedCiphertext: seal(row.rejectedContent || ""),
  };
}

export async function listClaimableJobs(now = new Date()) {
  const rows = await serviceDb().chiefProofJob.findMany({
    where: {
      OR: [
        { status: "pending" },
        { status: "running", leaseExpiresAt: { lte: now } },
        { status: "running", leaseExpiresAt: null },
      ],
    },
    select: { id: true, userId: true, runId: true, status: true, leaseExpiresAt: true },
  });
  return rows.filter((job) => canClaimJob(job, now));
}

export async function findRunByProviderSession(sessionId) {
  return serviceDb().chiefProofRun.findFirst({
    where: { providerSessionId: sessionId },
    select: { id: true, userId: true, status: true },
  });
}
