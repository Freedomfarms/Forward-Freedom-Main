-- Conversation archive on the existing chief_session row.
-- status stays the runtime state (ACTIVE / PENDING_APPROVAL). saveWithEvents
-- rewrites status, so archive is archivedAt and is not a second table.

ALTER TABLE "chief_session" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "chief_session_userId_archivedAt_idx"
  ON "chief_session"("userId", "archivedAt");
