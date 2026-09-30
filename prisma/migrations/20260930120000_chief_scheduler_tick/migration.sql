-- CHIEF Phase 5: scheduler tick. Additive only.
-- New run statuses: AWAITING_APPROVAL (the scheduled turn suspended on an
-- approval request) and RETRYING (a bounded re-run is parked on the task).
ALTER TYPE "ChiefTaskRunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL';
ALTER TYPE "ChiefTaskRunStatus" ADD VALUE IF NOT EXISTS 'RETRYING';

-- The CHIEF session a run executed in. Plain column, no FK: the run record
-- outlives session cleanup.
ALTER TABLE "chief_task_run" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "chief_task_run_status_startedAt_idx" ON "chief_task_run"("status", "startedAt");
