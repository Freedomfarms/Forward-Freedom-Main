-- Production CHIEF runtime pointers for Claude Managed Agents.
-- Not a proof migration: the folder name does not contain chief_managed_proof
-- and there is no PROOF_ONLY marker. Safe to apply on the application database.
-- Existing Freedom Financial tables are not modified.

CREATE TABLE IF NOT EXISTS "chief_managed_binding" (
  "userId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "agentVersion" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "memoryStoreId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_managed_binding_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "chief_managed_thread" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "providerSessionId" TEXT,
  "memoryStoreId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_managed_thread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_managed_work" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_managed_work_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chief_managed_thread_userId_updatedAt_idx"
  ON "chief_managed_thread"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "chief_managed_work_status_leaseUntil_idx"
  ON "chief_managed_work"("status", "leaseUntil");
CREATE INDEX IF NOT EXISTS "chief_managed_work_userId_threadId_idx"
  ON "chief_managed_work"("userId", "threadId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_managed_binding_userId_fkey') THEN
    ALTER TABLE "chief_managed_binding"
      ADD CONSTRAINT "chief_managed_binding_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_managed_thread_userId_fkey') THEN
    ALTER TABLE "chief_managed_thread"
      ADD CONSTRAINT "chief_managed_thread_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_managed_work_userId_fkey') THEN
    ALTER TABLE "chief_managed_work"
      ADD CONSTRAINT "chief_managed_work_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_managed_work_threadId_fkey') THEN
    ALTER TABLE "chief_managed_work"
      ADD CONSTRAINT "chief_managed_work_threadId_fkey"
      FOREIGN KEY ("threadId") REFERENCES "chief_managed_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'chief_managed_binding',
    'chief_managed_thread',
    'chief_managed_work'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS user_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY user_isolation ON %I FOR ALL USING ("userId" = current_setting(''app.current_user_id'', true)) WITH CHECK ("userId" = current_setting(''app.current_user_id'', true))',
      table_name
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO freedom_app', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO freedom_service', table_name);
    END IF;
  END LOOP;
END
$$;
