-- Phase 2B: durable CEO Plan store.
-- Plans persist executive intent across conversations. Encrypted body holds
-- objective / situation / decisions / open items / actions. RLS mirrors other
-- user-scoped agent tables. Plans never grant execution authority.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlanStatus') THEN
    CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'WAITING', 'COMPLETED', 'ABANDONED');
  END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Plan" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "contentCiphertext" TEXT NOT NULL,
  "missionScope" TEXT,
  "horizon" TEXT,
  "sourceConversationId" TEXT,
  "lastReviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Plan_userId_status_updatedAt_idx"
  ON "Plan"("userId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "Plan_userId_missionScope_status_idx"
  ON "Plan"("userId", "missionScope", "status");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Plan_userId_fkey'
  ) THEN
    ALTER TABLE "Plan"
      ADD CONSTRAINT "Plan_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Row-level security: forced per-user isolation.
ALTER TABLE "Plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Plan" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "Plan";
CREATE POLICY "user_isolation" ON "Plan"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Plan" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Plan" TO freedom_service;
  END IF;
END
$$;
