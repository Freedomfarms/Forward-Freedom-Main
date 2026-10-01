// CHIEF checkpoint store — durable session state for the turn machine.
//
// PORT/ADAPT of möbius (citizenhicks, Apache-2.0; NOTICE reproduced in
// THIRD_PARTY_NOTICES.md — derived in part from OpenAI Codex and Ratatui)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source file: src/backend/checkpoint/sqlite.rs (schema v10)
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//   License text: licenses/MOBIUS-LICENSE-APACHE-2.0.txt (NOTICE: licenses/MOBIUS-NOTICE.txt)
//
// Preserved upstream semantics:
//   - one session root plus transcript deltas, an execution journal, and an
//     event journal committed together (save_with_events)
//   - checkpoint fields needed to resume: context, context_epoch,
//     compaction_count, total_usage, pending_messages, active_execution,
//     pending_approval, execution_stats
//   - fork() copies state onto a new session that records its parent; deleting
//     the parent does not delete the fork (the schema's onDelete: SetNull)
//   - provider-private data never enters the checkpoint
// Documented adaptations (CHIEF-specific reasons):
//   - Postgres via an injected transaction helper instead of SQLite. The
//     in-memory store implements the same commit rule for tests and for any
//     caller that does not have a database.
//   - Sensitive payloads are encrypted at rest (platform envelope) in the
//     Prisma store. The memory store holds plaintext objects; it never leaves
//     the process.
//   - fork() copies transcript, usage, and sticky approvals, and clears
//     active_execution and pending_approval. Two serverless instances must not
//     both resume the same in-flight tool batch.
//   - Schema evolution is a version field plus Prisma migrations, not
//     möbius's reject-on-mismatch (docs/CHIEF_ARCHITECTURE.md §7.2).
//   - Per-session middleware state (chief_middleware_state) is keyed by
//     middleware id and encrypted like the checkpoint. It is not part of the
//     checkpoint journal and fork() does not copy it.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { decryptJson, encryptJson } from "../../security/envelope.js";
import { emptyTokenUsage } from "../protocol/index.js";

export const CHECKPOINT_VERSION = 1;

const PRIVATE_KEYS = new Set([
  "providerMetadata",
  "providerOptions",
  "providerExecuted",
  "rawFinishReason",
  "request",
  "response",
]);

export function emptyCheckpoint() {
  return {
    version: CHECKPOINT_VERSION,
    context: {},
    contextEpoch: 0,
    compactionCount: 0,
    totalUsage: emptyTokenUsage(),
    pendingMessages: [],
    activeExecution: null,
    pendingApproval: null,
    executionStats: { modelSteps: 0, toolCalls: 0 },
    transcript: [],
    approvedForSession: [],
    modelRoute: null,
    // Labels accumulated from tool arguments and outputs. Persisted so a
    // later invocation of this session applies the same taint policy.
    sessionTaint: [],
  };
}

export function assertNoProviderPrivate(value, path = "checkpoint") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProviderPrivate(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) {
      throw new Error(`provider-private field '${path}.${key}' cannot enter a checkpoint`);
    }
    assertNoProviderPrivate(child, `${path}.${key}`);
  }
}

function clone(value) {
  return structuredClone(value);
}

export class MemoryCheckpointStore {
  constructor() {
    this.sessions = new Map();
  }

  async createSession({ userId, sessionId = randomUUID(), context = {} } = {}) {
    if (!userId) throw new Error("createSession requires userId");
    const checkpoint = emptyCheckpoint();
    checkpoint.context = context ?? {};
    const now = new Date();
    const record = {
      id: sessionId,
      userId,
      title: null,
      status: "ACTIVE",
      archivedAt: null,
      forkedFromSessionId: null,
      lastSequence: 0,
      createdAt: now,
      updatedAt: now,
      checkpoint,
      journal: [],
    };
    this.sessions.set(sessionId, record);
    return clone(record);
  }

  async load(userId, sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) return null;
    return clone(record);
  }

  async saveWithEvents(
    userId,
    sessionId,
    { checkpoint, events = [], transcriptDelta = null } = {}
  ) {
    const current = this.sessions.get(sessionId);
    if (!current || current.userId !== userId) {
      throw new Error(`checkpoint session '${sessionId}' was not found`);
    }
    assertNoProviderPrivate(checkpoint);
    if (transcriptDelta != null) assertNoProviderPrivate(transcriptDelta);
    for (const event of events) assertNoProviderPrivate(event);

    const sequence = current.lastSequence + 1;
    const next = {
      ...current,
      lastSequence: sequence,
      status: checkpoint.pendingApproval ? "PENDING_APPROVAL" : "ACTIVE",
      updatedAt: new Date(),
      checkpoint: clone(checkpoint),
      journal: [
        ...current.journal,
        {
          sequence,
          events: clone(events),
          transcriptDelta: transcriptDelta == null ? null : clone(transcriptDelta),
        },
      ],
    };
    this.sessions.set(sessionId, next);
    return clone(next);
  }

  async fork(userId, sessionId) {
    const parent = await this.load(userId, sessionId);
    if (!parent) throw new Error(`checkpoint session '${sessionId}' was not found`);
    const checkpoint = clone(parent.checkpoint);
    checkpoint.activeExecution = null;
    checkpoint.pendingApproval = null;
    checkpoint.pendingMessages = [];
    const now = new Date();
    const child = {
      id: randomUUID(),
      userId,
      title: null,
      status: "ACTIVE",
      archivedAt: null,
      forkedFromSessionId: parent.id,
      lastSequence: 1,
      createdAt: now,
      updatedAt: now,
      checkpoint,
      journal: [{ sequence: 1, events: [], transcriptDelta: clone(checkpoint.transcript) }],
    };
    this.sessions.set(child.id, child);
    return clone(child);
  }

  async listOwnedSessions(userId) {
    if (!userId) return [];
    const rows = [];
    for (const record of this.sessions.values()) {
      if (record.userId !== userId) continue;
      rows.push({
        id: record.id,
        title: record.title ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archivedAt: record.archivedAt ?? null,
        context: clone(record.checkpoint?.context ?? {}),
      });
    }
    return rows;
  }

  async listPending(userId) {
    const pending = [];
    for (const record of this.sessions.values()) {
      if (record.userId === userId && record.checkpoint.pendingApproval) {
        pending.push({
          sessionId: record.id,
          approval: clone(record.checkpoint.pendingApproval),
        });
      }
    }
    return pending;
  }

  async loadMiddlewareState(userId, sessionId, middlewareId) {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) return null;
    const state = record.middlewareState?.[middlewareId];
    return state === undefined ? null : clone(state);
  }

  async saveMiddlewareState(userId, sessionId, middlewareId, state) {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) {
      throw new Error(`checkpoint session '${sessionId}' was not found`);
    }
    assertNoProviderPrivate(state, `middlewareState.${middlewareId}`);
    record.middlewareState = { ...(record.middlewareState ?? {}), [middlewareId]: clone(state) };
  }

  _ownedInteractive(userId, sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId) return null;
    if (record.checkpoint?.context?.origin === "schedule") return null;
    return record;
  }

  async setTitleIfEmpty(userId, sessionId, title) {
    const record = this.sessions.get(sessionId);
    if (!record || record.userId !== userId || !title) return false;
    if (record.checkpoint?.context?.origin === "schedule") return false;
    if (record.archivedAt) return false;
    if (typeof record.title === "string" && record.title.trim()) return false;
    record.title = title;
    return true;
  }

  async renameSession(userId, sessionId, title) {
    const record = this._ownedInteractive(userId, sessionId);
    if (!record) return null;
    record.title = title;
    record.updatedAt = new Date();
    return clone(record);
  }

  async setArchived(userId, sessionId, archived) {
    const record = this._ownedInteractive(userId, sessionId);
    if (!record) return null;
    record.archivedAt = archived ? (record.archivedAt ?? new Date()) : null;
    record.updatedAt = new Date();
    return clone(record);
  }

  async deleteOwnedSession(userId, sessionId) {
    const record = this._ownedInteractive(userId, sessionId);
    if (!record) return false;
    this.sessions.delete(sessionId);
    if (Array.isArray(this.approvals)) {
      this.approvals = this.approvals.filter((approval) => approval.sessionId !== sessionId);
    }
    return true;
  }
}

export class PrismaCheckpointStore {
  constructor({ withUser = withUserContext, encrypt = encryptJson, decrypt = decryptJson } = {}) {
    this._withUser = withUser;
    this._encrypt = encrypt;
    this._decrypt = decrypt;
  }

  async createSession({ userId, sessionId = randomUUID(), context = {} } = {}) {
    if (!userId) throw new Error("createSession requires userId");
    await this._withUser(userId, (tx) =>
      tx.chiefSession.create({
        data: {
          id: sessionId,
          userId,
          status: "ACTIVE",
          checkpointVersion: CHECKPOINT_VERSION,
          contextJson: context ?? {},
          lastSequence: 0,
        },
      })
    );
    return {
      id: sessionId,
      userId,
      status: "ACTIVE",
      forkedFromSessionId: null,
      lastSequence: 0,
      checkpoint: { ...emptyCheckpoint(), context: context ?? {} },
    };
  }

  async load(userId, sessionId) {
    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({ where: { id: sessionId, userId } });
      if (!session) return null;
      const latest = await tx.chiefExecutionJournal.findFirst({
        where: { sessionId },
        orderBy: { sequence: "desc" },
      });
      const checkpoint = latest ? this._decrypt(latest.stateCiphertext) : emptyCheckpoint();
      return {
        id: session.id,
        userId: session.userId,
        title: session.title ?? null,
        status: session.status,
        archivedAt: session.archivedAt ?? null,
        forkedFromSessionId: session.forkedFromSessionId ?? null,
        lastSequence: session.lastSequence,
        checkpoint,
      };
    });
  }

  async saveWithEvents(
    userId,
    sessionId,
    { checkpoint, events = [], transcriptDelta = null, approval = null } = {}
  ) {
    assertNoProviderPrivate(checkpoint);
    if (transcriptDelta != null) assertNoProviderPrivate(transcriptDelta);
    for (const event of events) assertNoProviderPrivate(event);

    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({ where: { id: sessionId, userId } });
      if (!session) throw new Error(`checkpoint session '${sessionId}' was not found`);
      const sequence = session.lastSequence + 1;
      const status = checkpoint.pendingApproval ? "PENDING_APPROVAL" : "ACTIVE";
      await tx.chiefSession.update({
        where: { id: sessionId },
        data: {
          lastSequence: sequence,
          status,
          checkpointVersion: checkpoint.version ?? CHECKPOINT_VERSION,
          modelRoute: checkpoint.modelRoute,
          contextJson: checkpoint.context ?? {},
        },
      });
      await tx.chiefExecutionJournal.create({
        data: {
          userId,
          sessionId,
          sequence,
          turnId: checkpoint.activeExecution?.turnId ?? checkpoint.pendingApproval?.turnId ?? null,
          phase:
            checkpoint.activeExecution?.phase ??
            (checkpoint.pendingApproval ? "tool_authorize" : null),
          stateCiphertext: this._encrypt(checkpoint),
        },
      });
      if (transcriptDelta != null) {
        await tx.chiefTranscriptDelta.create({
          data: {
            userId,
            sessionId,
            sequence,
            itemsCiphertext: this._encrypt(transcriptDelta),
          },
        });
      }
      if (events.length > 0) {
        await tx.chiefEventJournal.createMany({
          data: events.map((event, eventIndex) => ({
            userId,
            sessionId,
            sequence,
            eventIndex,
            submissionId: event.submission_id ?? null,
            eventType: event.msg?.type ?? "unknown",
            payloadCiphertext: this._encrypt(event),
          })),
        });
      }
      if (approval?.opened) {
        await tx.chiefApproval.create({
          data: {
            id: checkpoint.pendingApproval.id,
            userId,
            sessionId,
            turnId: checkpoint.pendingApproval.turnId,
            reason: checkpoint.pendingApproval.reason,
            callsCiphertext: this._encrypt(checkpoint.pendingApproval.calls),
            decision: "PENDING",
          },
        });
      }
      if (approval?.decided) {
        await tx.chiefApproval.update({
          where: { id: approval.id },
          data: {
            decision: approval.decision,
            rejectionReason: approval.rejection ?? null,
            decidedAt: new Date(),
          },
        });
      }
      return { id: sessionId, userId, status, lastSequence: sequence, checkpoint };
    });
  }

  async fork(userId, sessionId) {
    const parent = await this.load(userId, sessionId);
    if (!parent) throw new Error(`checkpoint session '${sessionId}' was not found`);
    const checkpoint = clone(parent.checkpoint);
    checkpoint.activeExecution = null;
    checkpoint.pendingApproval = null;
    checkpoint.pendingMessages = [];
    const childId = randomUUID();
    await this._withUser(userId, (tx) =>
      tx.chiefSession.create({
        data: {
          id: childId,
          userId,
          status: "ACTIVE",
          checkpointVersion: CHECKPOINT_VERSION,
          forkedFromSessionId: parent.id,
          contextJson: checkpoint.context ?? {},
          modelRoute: checkpoint.modelRoute,
          lastSequence: 0,
        },
      })
    );
    const saved = await this.saveWithEvents(userId, childId, {
      checkpoint,
      transcriptDelta: checkpoint.transcript,
    });
    return { ...saved, forkedFromSessionId: parent.id };
  }

  async listOwnedSessions(userId) {
    if (!userId) return [];
    return this._withUser(userId, async (tx) => {
      const sessions = await tx.chiefSession.findMany({
        where: { userId },
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          archivedAt: true,
          contextJson: true,
        },
      });
      return sessions.map((session) => ({
        id: session.id,
        title: session.title ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archivedAt: session.archivedAt ?? null,
        context: session.contextJson ?? {},
      }));
    });
  }

  async listPending(userId) {
    return this._withUser(userId, async (tx) => {
      const sessions = await tx.chiefSession.findMany({
        where: { userId, status: "PENDING_APPROVAL" },
      });
      const pending = [];
      for (const session of sessions) {
        const latest = await tx.chiefExecutionJournal.findFirst({
          where: { sessionId: session.id },
          orderBy: { sequence: "desc" },
        });
        const checkpoint = latest ? this._decrypt(latest.stateCiphertext) : null;
        if (checkpoint?.pendingApproval) {
          pending.push({ sessionId: session.id, approval: checkpoint.pendingApproval });
        }
      }
      return pending;
    });
  }

  async loadMiddlewareState(userId, sessionId, middlewareId) {
    return this._withUser(userId, async (tx) => {
      const row = await tx.chiefMiddlewareState.findFirst({
        where: { sessionId, middlewareId, userId },
      });
      return row ? this._decrypt(row.stateCiphertext) : null;
    });
  }

  async saveMiddlewareState(userId, sessionId, middlewareId, state) {
    assertNoProviderPrivate(state, `middlewareState.${middlewareId}`);
    const stateCiphertext = this._encrypt(state);
    await this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({ where: { id: sessionId, userId } });
      if (!session) throw new Error(`checkpoint session '${sessionId}' was not found`);
      await tx.chiefMiddlewareState.upsert({
        where: { sessionId_middlewareId: { sessionId, middlewareId } },
        create: { userId, sessionId, middlewareId, stateCiphertext },
        update: { stateCiphertext },
      });
    });
  }

  async setTitleIfEmpty(userId, sessionId, title) {
    if (!userId || !sessionId || !title) return false;
    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({
        where: { id: sessionId, userId },
        select: { id: true, title: true, archivedAt: true, contextJson: true },
      });
      if (!session || session.title || session.archivedAt) return false;
      if (session.contextJson?.origin === "schedule") return false;
      const updated = await tx.chiefSession.updateMany({
        where: { id: sessionId, userId, title: null },
        data: { title },
      });
      return updated.count === 1;
    });
  }

  async renameSession(userId, sessionId, title) {
    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({ where: { id: sessionId, userId } });
      if (!session || session.contextJson?.origin === "schedule") return null;
      return tx.chiefSession.update({
        where: { id: session.id },
        data: { title },
      });
    });
  }

  async setArchived(userId, sessionId, archived) {
    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({ where: { id: sessionId, userId } });
      if (!session || session.contextJson?.origin === "schedule") return null;
      return tx.chiefSession.update({
        where: { id: session.id },
        data: { archivedAt: archived ? (session.archivedAt ?? new Date()) : null },
      });
    });
  }

  async deleteOwnedSession(userId, sessionId) {
    return this._withUser(userId, async (tx) => {
      const session = await tx.chiefSession.findFirst({
        where: { id: sessionId, userId },
        select: { id: true, contextJson: true },
      });
      if (!session || session.contextJson?.origin === "schedule") return false;
      await tx.chiefApproval.deleteMany({ where: { userId, sessionId } });
      await tx.chiefSession.delete({ where: { id: session.id } });
      return true;
    });
  }
}
