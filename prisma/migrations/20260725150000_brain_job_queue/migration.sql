-- Freedom Brain vertical slice: BrainJob background work queue.
-- The Brain chat path enqueues jobs (memory extraction) instead of doing that
-- work inline; a post-response worker plus the 15-minute cron sweep process
-- them. RLS mirrors the other user-scoped agent tables.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BrainJobStatus') THEN
    CREATE TYPE "BrainJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
  END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "BrainJob" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB,
  "status" "BrainJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "BrainJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrainJob_status_runAfter_idx"
  ON "BrainJob"("status", "runAfter");

CREATE INDEX IF NOT EXISTS "BrainJob_userId_kind_createdAt_idx"
  ON "BrainJob"("userId", "kind", "createdAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BrainJob_userId_fkey'
  ) THEN
    ALTER TABLE "BrainJob"
      ADD CONSTRAINT "BrainJob_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Row-level security: same forced per-user isolation as every other
-- user-scoped table. The cron sweep enumerates jobs with the service role,
-- then processes each inside the owner's withUserContext.
ALTER TABLE "BrainJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrainJob" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "BrainJob";
CREATE POLICY "user_isolation" ON "BrainJob"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrainJob" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BrainJob" TO freedom_service;
  END IF;
END
$$;
