-- One open managed-work row per user and thread.
-- Stops overlapping cron drains from queueing a second continuation
-- for the same CHIEF session. Succeeded rows are not constrained.
-- Existing tables are not rewritten.

CREATE UNIQUE INDEX IF NOT EXISTS "chief_managed_work_open_thread_idx"
  ON "chief_managed_work" ("userId", "threadId")
  WHERE "status" IN ('queued', 'running');
