-- Assignment 1 isolated proof schema. Not the production memory system.
-- Forced RLS matches the other user-scoped tables. Deployment resource rows
-- keep a null userId and are invisible to freedom_app; the service role
-- (BYPASSRLS) writes those rows. App-role queries with a user context see
-- only that user's proof rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefManagedJobStatus') THEN
    CREATE TYPE "ChiefManagedJobStatus" AS ENUM ('pending', 'running', 'completed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefManagedRunStatus') THEN
    CREATE TYPE "ChiefManagedRunStatus" AS ENUM ('queued', 'running', 'waiting', 'idle', 'closed', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefManagedResourceStatus') THEN
    CREATE TYPE "ChiefManagedResourceStatus" AS ENUM ('creating', 'ready', 'needs_reconciliation');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "chief_managed_resource" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "projectId" TEXT,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerId" TEXT,
  "version" TEXT,
  "status" "ChiefManagedResourceStatus" NOT NULL DEFAULT 'creating',
  "fingerprint" TEXT NOT NULL,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_managed_resource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_managed_resource_idempotencyKey_key"
  ON "chief_managed_resource"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "chief_managed_resource_kind_status_idx"
  ON "chief_managed_resource"("kind", "status");

CREATE TABLE IF NOT EXISTS "chief_proof_project" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "writeSessionId" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "writeLeaseExpiresAt" TIMESTAMP(3),
  "memoryStoreId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_project_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chief_proof_project_userId_updatedAt_idx"
  ON "chief_proof_project"("userId", "updatedAt");

CREATE TABLE IF NOT EXISTS "chief_proof_document" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "contentCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_proof_document_projectId_path_key"
  ON "chief_proof_document"("projectId", "path");
CREATE INDEX IF NOT EXISTS "chief_proof_document_userId_projectId_idx"
  ON "chief_proof_document"("userId", "projectId");

CREATE TABLE IF NOT EXISTS "chief_proof_conflict" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "writeSessionId" TEXT,
  "leaseGeneration" INTEGER NOT NULL,
  "baseSha256" TEXT,
  "currentSha256" TEXT,
  "reason" TEXT NOT NULL,
  "rejectedCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_conflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chief_proof_conflict_userId_projectId_createdAt_idx"
  ON "chief_proof_conflict"("userId", "projectId", "createdAt");

CREATE TABLE IF NOT EXISTS "chief_proof_run" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "priorRunId" TEXT,
  "phase" TEXT NOT NULL,
  "status" "ChiefManagedRunStatus" NOT NULL DEFAULT 'queued',
  "promptClass" TEXT NOT NULL,
  "promptCiphertext" TEXT NOT NULL,
  "providerSessionId" TEXT,
  "memoryStoreId" TEXT,
  "priorStoreId" TEXT,
  "attachedStoreIds" JSONB,
  "baseRevision" INTEGER,
  "baseHashes" JSONB,
  "modelEvidence" JSONB,
  "skillEvidence" JSONB,
  "workspaceEvidence" JSONB,
  "assistantCiphertext" TEXT,
  "promptSubmittedBy" TEXT,
  "synced" BOOLEAN NOT NULL DEFAULT false,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "chief_proof_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_proof_run_providerSessionId_key"
  ON "chief_proof_run"("providerSessionId");
CREATE INDEX IF NOT EXISTS "chief_proof_run_userId_projectId_createdAt_idx"
  ON "chief_proof_run"("userId", "projectId", "createdAt");

CREATE TABLE IF NOT EXISTS "chief_proof_job" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" "ChiefManagedJobStatus" NOT NULL DEFAULT 'pending',
  "cursor" TEXT NOT NULL,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "webhookEventId" TEXT,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "chief_proof_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_proof_job_webhookEventId_key"
  ON "chief_proof_job"("webhookEventId");
CREATE INDEX IF NOT EXISTS "chief_proof_job_status_availableAt_idx"
  ON "chief_proof_job"("status", "availableAt");
CREATE INDEX IF NOT EXISTS "chief_proof_job_runId_status_idx"
  ON "chief_proof_job"("runId", "status");

CREATE TABLE IF NOT EXISTS "chief_proof_tool_call" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "providerToolEventId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ChiefManagedJobStatus" NOT NULL DEFAULT 'pending',
  "resultCiphertext" TEXT,
  "postedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_tool_call_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_proof_tool_call_providerToolEventId_key"
  ON "chief_proof_tool_call"("providerToolEventId");
CREATE INDEX IF NOT EXISTS "chief_proof_tool_call_userId_runId_idx"
  ON "chief_proof_tool_call"("userId", "runId");

CREATE TABLE IF NOT EXISTS "chief_proof_ping" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "toolEventId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_ping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chief_proof_ping_toolEventId_key"
  ON "chief_proof_ping"("toolEventId");
CREATE INDEX IF NOT EXISTS "chief_proof_ping_userId_runId_idx"
  ON "chief_proof_ping"("userId", "runId");

CREATE TABLE IF NOT EXISTS "chief_proof_latency_sample" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "delayClass" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "firstTextAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "observedAt" TIMESTAMP(3) NOT NULL,
  "routeMs" INTEGER,
  "pollDelayMs" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chief_proof_latency_sample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chief_proof_latency_sample_userId_runId_createdAt_idx"
  ON "chief_proof_latency_sample"("userId", "runId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_managed_resource_userId_fkey') THEN
    ALTER TABLE "chief_managed_resource"
      ADD CONSTRAINT "chief_managed_resource_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_project_userId_fkey') THEN
    ALTER TABLE "chief_proof_project"
      ADD CONSTRAINT "chief_proof_project_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_document_userId_fkey') THEN
    ALTER TABLE "chief_proof_document"
      ADD CONSTRAINT "chief_proof_document_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_document_projectId_fkey') THEN
    ALTER TABLE "chief_proof_document"
      ADD CONSTRAINT "chief_proof_document_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "chief_proof_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_conflict_userId_fkey') THEN
    ALTER TABLE "chief_proof_conflict"
      ADD CONSTRAINT "chief_proof_conflict_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_conflict_projectId_fkey') THEN
    ALTER TABLE "chief_proof_conflict"
      ADD CONSTRAINT "chief_proof_conflict_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "chief_proof_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_run_userId_fkey') THEN
    ALTER TABLE "chief_proof_run"
      ADD CONSTRAINT "chief_proof_run_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_run_projectId_fkey') THEN
    ALTER TABLE "chief_proof_run"
      ADD CONSTRAINT "chief_proof_run_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "chief_proof_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_job_userId_fkey') THEN
    ALTER TABLE "chief_proof_job"
      ADD CONSTRAINT "chief_proof_job_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_job_runId_fkey') THEN
    ALTER TABLE "chief_proof_job"
      ADD CONSTRAINT "chief_proof_job_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "chief_proof_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_tool_call_userId_fkey') THEN
    ALTER TABLE "chief_proof_tool_call"
      ADD CONSTRAINT "chief_proof_tool_call_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_tool_call_runId_fkey') THEN
    ALTER TABLE "chief_proof_tool_call"
      ADD CONSTRAINT "chief_proof_tool_call_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "chief_proof_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_ping_userId_fkey') THEN
    ALTER TABLE "chief_proof_ping"
      ADD CONSTRAINT "chief_proof_ping_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_ping_runId_fkey') THEN
    ALTER TABLE "chief_proof_ping"
      ADD CONSTRAINT "chief_proof_ping_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "chief_proof_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_latency_sample_userId_fkey') THEN
    ALTER TABLE "chief_proof_latency_sample"
      ADD CONSTRAINT "chief_proof_latency_sample_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_proof_latency_sample_runId_fkey') THEN
    ALTER TABLE "chief_proof_latency_sample"
      ADD CONSTRAINT "chief_proof_latency_sample_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "chief_proof_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'chief_managed_resource',
    'chief_proof_project',
    'chief_proof_document',
    'chief_proof_conflict',
    'chief_proof_run',
    'chief_proof_job',
    'chief_proof_tool_call',
    'chief_proof_ping',
    'chief_proof_latency_sample'
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
