-- Durable execution approval and Cursor run ledger.
-- Additive. Does not alter chief_approval, chief_agent, or the observation journal.
-- verified is forced false: Cursor FINISHED is not proof the objective succeeded.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkforceExecutionState') THEN
    CREATE TYPE "WorkforceExecutionState" AS ENUM (
      'APPROVED',
      'SUBMITTING',
      'SUBMITTED',
      'AMBIGUOUS',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'EXPIRED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "workforce_execution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "intentionId" TEXT,
    "provider" TEXT NOT NULL,
    "objectiveCiphertext" TEXT NOT NULL,
    "constraintsCiphertext" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "startingRef" TEXT NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "state" "WorkforceExecutionState" NOT NULL DEFAULT 'APPROVED',
    "platformStatus" TEXT,
    "platformCode" TEXT,
    "agentId" TEXT,
    "runId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "ambiguousAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "statementCiphertext" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_execution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workforce_execution_verified_false" CHECK ("verified" = false)
);

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_execution_approvalId_key"
    ON "workforce_execution"("approvalId");

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_execution_agentId_key"
    ON "workforce_execution"("agentId");

CREATE INDEX IF NOT EXISTS "workforce_execution_userId_state_idx"
    ON "workforce_execution"("userId", "state");

CREATE INDEX IF NOT EXISTS "workforce_execution_state_updatedAt_idx"
    ON "workforce_execution"("state", "updatedAt");

CREATE INDEX IF NOT EXISTS "workforce_execution_agentId_runId_idx"
    ON "workforce_execution"("agentId", "runId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workforce_execution_userId_fkey'
  ) THEN
    ALTER TABLE "workforce_execution"
      ADD CONSTRAINT "workforce_execution_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "workforce_execution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce_execution" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "workforce_execution";
CREATE POLICY "user_isolation" ON "workforce_execution"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workforce_execution" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workforce_execution" TO freedom_service;
  END IF;
END
$$;
