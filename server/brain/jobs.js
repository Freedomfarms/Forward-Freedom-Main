import { withUserContext } from "../db/prisma.js";
import { extractMemoryFromConversation } from "../memory/extraction.js";

// ─────────────────────────────────────────────────────────────────────────────
// BrainJob queue — the Brain's background work, decoupled from the chat
// critical path.
//
// Delivery model (serverless-safe, at-least-once):
//   1. brainTurn ENQUEUES a job and returns the reply immediately;
//   2. a best-effort in-process worker tries the job right away (same pattern
//      as scheduleConversationTitle — the function instance usually lives
//      long enough);
//   3. the 15-minute cron sweep picks up anything still PENDING (instance
//      died) or stuck RUNNING past the stale threshold (crashed mid-job).
//
// Claims go through updateMany conditioned on the current status, so the
// immediate worker and the cron sweep can never double-process one job.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
/** RUNNING jobs older than this are presumed crashed and get re-queued. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

export const BRAIN_JOB_KINDS = Object.freeze({
  MEMORY_EXTRACTION: "memory_extraction",
});

// kind → handler({ userId, payload }). Fail-closed: unknown kinds error out
// and the job lands in FAILED after MAX_ATTEMPTS instead of looping forever.
const JOB_HANDLERS = Object.freeze({
  [BRAIN_JOB_KINDS.MEMORY_EXTRACTION]: ({ userId, payload }) =>
    extractMemoryFromConversation({
      userId,
      conversationId: payload?.conversationId ?? null,
    }),
});

/**
 * Creates a PENDING BrainJob. payload must contain row IDs only — never
 * plaintext content (it is stored unencrypted for queue introspection).
 */
export async function enqueueBrainJob({ userId, kind, payload = null }) {
  if (!userId || !kind) return null;
  return withUserContext(userId, (tx) =>
    tx.brainJob.create({
      data: { userId, kind, payload },
      select: { id: true, userId: true, kind: true },
    })
  );
}

/**
 * Claims and runs one job (by id) inside the owner's RLS context. Returns
 * "completed" | "failed" | "retrying" | "skipped" (not claimable).
 */
export async function processBrainJob({ userId, jobId }) {
  if (!userId || !jobId) return "skipped";

  const claimed = await withUserContext(userId, async (tx) => {
    const now = new Date();
    const result = await tx.brainJob.updateMany({
      where: { id: jobId, userId, status: "PENDING", runAfter: { lte: now } },
      data: { status: "RUNNING", lockedAt: now, attempts: { increment: 1 } },
    });
    if (!result.count) return null;
    return tx.brainJob.findFirst({
      where: { id: jobId, userId },
      select: { id: true, kind: true, payload: true, attempts: true },
    });
  });
  if (!claimed) return "skipped";

  try {
    const handler = JOB_HANDLERS[claimed.kind];
    if (!handler) {
      throw new Error(`Unknown BrainJob kind "${claimed.kind}".`);
    }
    await handler({ userId, payload: claimed.payload });
    await withUserContext(userId, (tx) =>
      tx.brainJob.updateMany({
        where: { id: jobId, userId },
        data: { status: "COMPLETED", completedAt: new Date(), lastError: null },
      })
    );
    return "completed";
  } catch (error) {
    const lastError = String(error?.message || error).slice(0, 500);
    const exhausted = claimed.attempts >= MAX_ATTEMPTS;
    await withUserContext(userId, (tx) =>
      tx.brainJob.updateMany({
        where: { id: jobId, userId },
        data: exhausted
          ? { status: "FAILED", lastError, completedAt: new Date() }
          : {
              status: "PENDING",
              lastError,
              lockedAt: null,
              runAfter: new Date(Date.now() + RETRY_BACKOFF_MS),
            },
      })
    ).catch(() => {
      // Losing the bookkeeping write only delays the job until the sweep.
    });
    return exhausted ? "failed" : "retrying";
  }
}

/**
 * Fire-and-forget immediate processing right after a chat reply. Never blocks
 * or fails the caller; the cron sweep is the safety net if this instance dies.
 */
export function kickBrainJobSoon({ userId, jobId } = {}) {
  if (!userId || !jobId) return;
  void processBrainJob({ userId, jobId }).catch(() => {
    // Best-effort by contract — the sweep will retry.
  });
}

/**
 * Cron-sweep entry: enumerate due jobs with the service-role client (the only
 * cross-user step), then process each inside its owner's RLS context. Also
 * re-queues jobs stuck RUNNING past the stale threshold. Returns counters.
 */
export async function sweepPendingBrainJobs(service, { limit = 25, now = new Date() } = {}) {
  if (!service) return { processed: 0, failed: 0, requeuedStale: 0 };

  // Recover crashed workers: stale RUNNING → PENDING (service role; the
  // per-job claim below still runs user-scoped).
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS);
  const requeued = await service.brainJob.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: staleBefore } },
    data: { status: "PENDING", lockedAt: null },
  });

  const due = await service.brainJob.findMany({
    where: { status: "PENDING", runAfter: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, userId: true },
  });

  let processed = 0;
  let failed = 0;
  for (const job of due) {
    try {
      const outcome = await processBrainJob({ userId: job.userId, jobId: job.id });
      if (outcome === "completed") processed += 1;
      if (outcome === "failed") failed += 1;
    } catch {
      failed += 1;
    }
  }

  return { processed, failed, requeuedStale: requeued?.count ?? 0 };
}
