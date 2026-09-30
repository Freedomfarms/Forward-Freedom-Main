// CHIEF trace store — one ChiefTrace per finished turn.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/traces/store.py (TraceStore.save)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - save writes the trace and its ordered steps once
//   - step index follows subscription order, with RESPOND last
// Documented adaptations (CHIEF-specific reasons):
//   - Postgres via withUserContext, not a SQLite file. RLS stays the
//     isolation boundary. There is no FTS table and no second database.
//   - The Prisma models have no query, result, or messages columns. Those
//     fields are not added. Step detail is encrypted and holds only the
//     collector's allowlisted object.
//   - feedback is always null. Learned routing is not this store's job.

import { withUserContext } from "../../db/prisma.js";
import { encryptJson } from "../../security/envelope.js";

export class MemoryTraceStore {
  constructor() {
    this.traces = [];
    this.failSave = false;
  }

  async save(trace) {
    if (this.failSave) throw new Error("trace store unavailable");
    const saved = {
      id: `trace-${this.traces.length + 1}`,
      ...trace,
      feedback: null,
      steps: (trace.steps ?? []).map((step, index) => ({ ...step, stepIndex: index })),
    };
    this.traces.push(saved);
    return saved;
  }
}

export class PrismaTraceStore {
  constructor({ withUser = withUserContext, encrypt = encryptJson } = {}) {
    this._withUser = withUser;
    this._encrypt = encrypt;
  }

  async save(trace) {
    if (!trace?.userId) throw new TypeError("trace save requires userId");
    return this._withUser(trace.userId, async (tx) => {
      const created = await tx.chiefTrace.create({
        data: {
          userId: trace.userId,
          sessionId: trace.sessionId ?? null,
          turnId: trace.turnId ?? null,
          agentId: trace.agentId ?? null,
          model: trace.model ?? null,
          tokensInput: trace.tokensInput ?? null,
          tokensOutput: trace.tokensOutput ?? null,
          outcome: trace.outcome ?? null,
          feedback: null,
          startedAt: trace.startedAt ?? new Date(),
          completedAt: trace.completedAt ?? new Date(),
          steps: {
            create: (trace.steps ?? []).map((step, index) => ({
              userId: trace.userId,
              stepIndex: index,
              stepType: step.stepType,
              name: step.name ?? null,
              status: step.status ?? null,
              detailCiphertext: this._encrypt(step.detail ?? {}),
              startedAt: step.startedAt ?? new Date(),
              completedAt: step.completedAt ?? new Date(),
            })),
          },
        },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });
      return created;
    });
  }
}
