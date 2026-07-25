-- CEO-as-OS Phase 1: user local timezone + AgentRun operational lineage.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timezone" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "trigger" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "triggeredByConversationId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "parentRunId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_triggeredByConversationId_startedAt_idx"
  ON "AgentRun"("triggeredByConversationId", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_triggeredByConversationId_fkey'
  ) THEN
    ALTER TABLE "AgentRun"
      ADD CONSTRAINT "AgentRun_triggeredByConversationId_fkey"
      FOREIGN KEY ("triggeredByConversationId") REFERENCES "AgentConversation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_parentRunId_fkey'
  ) THEN
    ALTER TABLE "AgentRun"
      ADD CONSTRAINT "AgentRun_parentRunId_fkey"
      FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
