import crypto from "node:crypto";

import { canClaimJob, nextJobLease } from "./jobs.js";
import { authorizeCommit } from "./ownership.js";

export function sha256Text(content) {
  return crypto.createHash("sha256").update(String(content), "utf8").digest("hex");
}

export function createMemoryStore() {
  const projects = new Map();
  const documents = new Map();
  const conflicts = [];
  const runs = new Map();
  const jobs = new Map();
  const tools = new Map();
  const pings = new Map();
  const resources = new Map();
  const samples = [];
  let seq = 0;
  const nextId = (prefix) => `${prefix}_${++seq}`;

  function docsFor(projectId) {
    if (!documents.has(projectId)) documents.set(projectId, new Map());
    return documents.get(projectId);
  }

  return {
    nextId,
    async createProject({ userId, title, now = new Date() }) {
      const project = {
        id: nextId("prj"),
        userId,
        title,
        revision: 0,
        writeSessionId: null,
        leaseGeneration: 0,
        writeLeaseExpiresAt: null,
        memoryStoreId: null,
        createdAt: now,
        updatedAt: now,
      };
      projects.set(project.id, project);
      return project;
    },
    async getProject(projectId) {
      return projects.get(projectId) || null;
    },
    async compareAndSetProject(projectId, expectedGeneration, patch) {
      const project = projects.get(projectId);
      if (!project || project.leaseGeneration !== expectedGeneration) return { ok: false, project };
      Object.assign(project, patch, { updatedAt: new Date() });
      return { ok: true, project };
    },
    async listDocuments(projectId) {
      return [...docsFor(projectId).values()].map((doc) => ({ ...doc }));
    },
    async insertConflict(row) {
      const conflict = { id: nextId("cnf"), createdAt: new Date(), ...row };
      conflicts.push(conflict);
      return conflict;
    },
    async listConflicts(projectId) {
      return conflicts.filter((row) => row.projectId === projectId);
    },
    async createRun(input) {
      const run = {
        status: "queued",
        synced: false,
        providerSessionId: null,
        memoryStoreId: null,
        priorStoreId: null,
        attachedStoreIds: [],
        baseRevision: null,
        baseHashes: {},
        modelEvidence: null,
        skillEvidence: null,
        workspaceEvidence: null,
        assistantText: null,
        promptSubmittedBy: null,
        lastError: null,
        closedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...input,
        id: input.id || nextId("run"),
      };
      runs.set(run.id, run);
      return run;
    },
    async getRun(runId) {
      return runs.get(runId) || null;
    },
    async saveRun(run) {
      run.updatedAt = new Date();
      runs.set(run.id, run);
      return run;
    },
    async runsForProject(projectId) {
      return [...runs.values()].filter((run) => run.projectId === projectId);
    },
    async findRunBySession(sessionId) {
      return [...runs.values()].find((run) => run.providerSessionId === sessionId) || null;
    },
    async createJob(input) {
      const job = {
        status: "pending",
        leaseGeneration: 0,
        leaseExpiresAt: null,
        webhookEventId: null,
        availableAt: new Date(),
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        ...input,
        id: input.id || nextId("job"),
      };
      jobs.set(job.id, job);
      return job;
    },
    async getJob(jobId) {
      return jobs.get(jobId) || null;
    },
    async getJobByWebhook(webhookEventId) {
      return [...jobs.values()].find((job) => job.webhookEventId === webhookEventId) || null;
    },
    async openJob(runId) {
      return (
        [...jobs.values()]
          .filter((job) => job.runId === runId && job.status !== "completed")
          .sort((a, b) => b.createdAt - a.createdAt)[0] || null
      );
    },
    async claimJob(jobId, now) {
      const job = jobs.get(jobId);
      if (!canClaimJob(job, now)) return { claimed: false, job };
      Object.assign(job, nextJobLease(job, now), { updatedAt: now });
      return { claimed: true, job };
    },
    async releaseJob(jobId, generation) {
      const job = jobs.get(jobId);
      if (!job || job.leaseGeneration !== generation || job.status === "completed")
        return { ok: false, job };
      job.status = "pending";
      job.leaseExpiresAt = null;
      job.availableAt = new Date();
      job.updatedAt = new Date();
      return { ok: true, job };
    },
    async completeJob(jobId, generation) {
      const job = jobs.get(jobId);
      if (!job || job.leaseGeneration !== generation) return { ok: false, job };
      job.status = "completed";
      job.completedAt = new Date();
      job.updatedAt = job.completedAt;
      return { ok: true, job };
    },
    async abandonJob(jobId, generation, error) {
      const job = jobs.get(jobId);
      if (!job || job.leaseGeneration !== generation || job.status === "completed")
        return { ok: false, job };
      job.status = "pending";
      job.leaseExpiresAt = null;
      job.lastError = error;
      job.availableAt = new Date();
      job.updatedAt = new Date();
      return { ok: true, job };
    },
    async listClaimableJobs(now) {
      return [...jobs.values()].filter((job) => canClaimJob(job, now));
    },
    async getResource(idempotencyKey) {
      return resources.get(idempotencyKey) || null;
    },
    async saveResource(resource) {
      resource.updatedAt = new Date();
      resources.set(resource.idempotencyKey, resource);
      return resource;
    },
    async insertPing({ toolEventId, runId, userId, now = new Date() }) {
      const existing = pings.get(toolEventId);
      if (existing) return { created: false, row: existing };
      const row = { id: nextId("ping"), toolEventId, runId, userId, createdAt: now };
      pings.set(toolEventId, row);
      return { created: true, row };
    },
    async getToolCall(toolEventId) {
      return tools.get(toolEventId) || null;
    },
    async saveToolCall(tool) {
      const current = tools.get(tool.providerToolEventId) || {};
      const next = { ...current, ...tool, updatedAt: new Date() };
      tools.set(tool.providerToolEventId, next);
      return next;
    },
    async unfinishedToolCalls(runId) {
      return [...tools.values()].filter(
        (tool) => tool.runId === runId && tool.status !== "completed"
      ).length;
    },
    async addSample(sample) {
      const row = { id: nextId("lat"), createdAt: new Date(), ...sample };
      samples.push(row);
      return row;
    },
    async listSamples(runId) {
      return samples.filter((sample) => sample.runId === runId);
    },
    async applyCommit({
      projectId,
      writeSessionId,
      leaseGeneration,
      now,
      writes,
      deletes,
      conflicts: rejected,
    }) {
      const project = projects.get(projectId);
      const auth = authorizeCommit({ project, writeSessionId, leaseGeneration, now });
      if (!auth.ok) {
        for (const row of rejected || []) {
          await this.insertConflict({
            ...row,
            projectId,
            userId: project?.userId,
            writeSessionId,
            leaseGeneration,
          });
        }
        return { ok: false, reason: auth.reason, project };
      }
      const docs = docsFor(projectId);
      for (const write of writes) {
        const current = docs.get(write.path);
        if (write.op === "insert") {
          if (current) {
            await this.insertConflict({
              projectId,
              userId: project.userId,
              path: write.path,
              writeSessionId,
              leaseGeneration,
              reason: "insert_conflict",
              rejectedContent: write.content,
              baseSha256: null,
              currentSha256: current.contentSha256,
            });
            continue;
          }
          docs.set(write.path, {
            path: write.path,
            content: write.content,
            contentSha256: write.contentSha256,
            revision: project.revision + 1,
            userId: project.userId,
            projectId,
          });
        } else if (current && current.contentSha256 === write.expectedSha256) {
          docs.set(write.path, {
            ...current,
            content: write.content,
            contentSha256: write.contentSha256,
            revision: project.revision + 1,
          });
        } else {
          await this.insertConflict({
            projectId,
            userId: project.userId,
            path: write.path,
            writeSessionId,
            leaseGeneration,
            reason: "hash_conflict",
            rejectedContent: write.content,
            baseSha256: write.expectedSha256,
            currentSha256: current?.contentSha256 || null,
          });
        }
      }
      for (const deletion of deletes) {
        const current = docs.get(deletion.path);
        if (current && current.contentSha256 === deletion.expectedSha256)
          docs.delete(deletion.path);
      }
      for (const row of rejected || []) {
        await this.insertConflict({
          ...row,
          projectId,
          userId: project.userId,
          writeSessionId,
          leaseGeneration,
        });
      }
      if (writes.length || deletes.length) project.revision += 1;
      project.updatedAt = now;
      return { ok: true, project };
    },
  };
}
