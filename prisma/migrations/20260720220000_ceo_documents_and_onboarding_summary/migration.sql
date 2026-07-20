-- CEO onboarding summary cache + encrypted reference documents the CEO can read.

ALTER TABLE "CeoAgentConfig"
  ADD COLUMN IF NOT EXISTS "onboardingSummaryCiphertext" TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingSummaryAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "CeoDocument" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ceoAgentConfigId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "contentCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CeoDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CeoDocument_userId_createdAt_idx"
  ON "CeoDocument"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "CeoDocument_ceoAgentConfigId_createdAt_idx"
  ON "CeoDocument"("ceoAgentConfigId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CeoDocument_userId_fkey'
  ) THEN
    ALTER TABLE "CeoDocument"
      ADD CONSTRAINT "CeoDocument_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CeoDocument_ceoAgentConfigId_fkey'
  ) THEN
    ALTER TABLE "CeoDocument"
      ADD CONSTRAINT "CeoDocument_ceoAgentConfigId_fkey"
      FOREIGN KEY ("ceoAgentConfigId") REFERENCES "CeoAgentConfig"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "CeoDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CeoDocument" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "CeoDocument";
CREATE POLICY "user_isolation" ON "CeoDocument"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- DEFAULT PRIVILEGES from the runtime-role remediation cover new tables for
-- freedom_app / freedom_service when those roles exist; also grant explicitly
-- so environments that created roles after DEFAULT PRIVILEGES were set still work.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CeoDocument" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CeoDocument" TO freedom_service;
  END IF;
END
$$;
