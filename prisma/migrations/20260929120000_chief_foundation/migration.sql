-- Freedom OS Module 03 (CHIEF) — Phase 1 foundation.
--
-- Creates every chief_* table (docs/CHIEF_ARCHITECTURE.md §5.4). Table shapes
-- are ported from the audited upstreams (docs/CHIEF_GITHUB_REUSE_AUDIT.md §8,
-- THIRD_PARTY_NOTICES.md):
--   - chief_session / chief_transcript_delta / chief_execution_journal /
--     chief_event_journal / chief_middleware_state: möbius checkpoint schema
--   - chief_agent* / chief_trace* / chief_fact / chief_knowledge_* /
--     chief_scheduled_task: OpenJarvis agents.db, traces.db, FactStore, KG,
--     scheduler
--   - chief_approval / chief_capability_grant: möbius approval semantics +
--     OpenJarvis RBAC
--
-- Cross-cutting rules applied here (§5.4):
--   - RLS ENABLE + FORCE with the standard "user_isolation" policy on every
--     table (same pattern as 20260718200000_freedom_os_row_level_security)
--   - the only foreign key into non-CHIEF tables is "User"
--   - sensitive text lives in *Ciphertext columns (encrypted by the app)
--   - pgvector is OPTIONAL: the extension and the "embedding" columns are
--     created only when the extension is available. Without it, retrieval
--     falls back to FTS over plaintext knowledge-entity names (index below)
--     plus recency — fact content is ciphertext and is never FTS-indexed.
--   - conditional grants for freedom_app / freedom_service, matching the RLS
--     rollout convention.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefSessionStatus') THEN
    CREATE TYPE "ChiefSessionStatus" AS ENUM ('ACTIVE', 'PENDING_APPROVAL', 'ARCHIVED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefTrustTier') THEN
    CREATE TYPE "ChiefTrustTier" AS ENUM ('AUTO', 'TRUSTED', 'UNTRUSTED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefApprovalDecision') THEN
    CREATE TYPE "ChiefApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'APPROVED_FOR_SESSION', 'DENIED', 'ABORTED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefTaskKind') THEN
    CREATE TYPE "ChiefTaskKind" AS ENUM ('ONCE', 'INTERVAL', 'CRON');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefScheduledTaskStatus') THEN
    CREATE TYPE "ChiefScheduledTaskStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefTaskRunStatus') THEN
    CREATE TYPE "ChiefTaskRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefTraceStepType') THEN
    CREATE TYPE "ChiefTraceStepType" AS ENUM ('ROUTE', 'RETRIEVE', 'GENERATE', 'TOOL_CALL', 'RESPOND');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChiefRelationOrigin') THEN
    CREATE TYPE "ChiefRelationOrigin" AS ENUM ('EXPLICIT', 'SEMANTIC');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "chief_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" "ChiefSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "checkpointVersion" INTEGER NOT NULL DEFAULT 1,
    "contextJson" JSONB,
    "modelRoute" TEXT,
    "forkedFromSessionId" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_transcript_delta" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "itemsCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_transcript_delta_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_execution_journal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "turnId" TEXT,
    "phase" TEXT,
    "stateCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_execution_journal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_event_journal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "submissionId" TEXT,
    "eventType" TEXT NOT NULL,
    "payloadCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_event_journal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_middleware_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "middlewareId" TEXT NOT NULL,
    "stateCiphertext" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_middleware_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "configJson" JSONB,
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "lastTickAt" TIMESTAMP(3),
    "statsJson" JSONB,
    "summaryCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_agent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_agent_task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "descriptionCiphertext" TEXT,
    "resultCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "chief_agent_task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_agent_message" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fromAgentId" TEXT,
    "contentCiphertext" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_agent_message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_trace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "turnId" TEXT,
    "agentId" TEXT,
    "model" TEXT,
    "tokensInput" INTEGER,
    "tokensOutput" INTEGER,
    "estimatedCostUsd" DECIMAL(10,6),
    "outcome" TEXT,
    "feedback" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "chief_trace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_trace_step" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepType" "ChiefTraceStepType" NOT NULL,
    "name" TEXT,
    "status" TEXT,
    "detailCiphertext" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "chief_trace_step_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_fact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "trustTier" "ChiefTrustTier" NOT NULL DEFAULT 'AUTO',
    "source" TEXT,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "expiresAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_fact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_knowledge_entity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entityType" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "nodeRole" TEXT,
    "attributesCiphertext" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_knowledge_entity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_knowledge_relation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "origin" "ChiefRelationOrigin" NOT NULL DEFAULT 'EXPLICIT',
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "lastReinforcedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_knowledge_relation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_scheduled_task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ChiefTaskKind" NOT NULL,
    "cronExpr" TEXT,
    "intervalSeconds" INTEGER,
    "runAt" TIMESTAMP(3),
    "payload" JSONB,
    "agentId" TEXT,
    "status" "ChiefScheduledTaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_scheduled_task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_task_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scheduledTaskId" TEXT,
    "status" "ChiefTaskRunStatus" NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "resultCiphertext" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "chief_task_run_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_approval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "turnId" TEXT,
    "reason" TEXT NOT NULL,
    "callsCiphertext" TEXT NOT NULL,
    "decision" "ChiefApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "stickyKey" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_approval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_capability_grant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "pattern" TEXT NOT NULL DEFAULT '*',
    "deny" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_capability_grant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "summary" TEXT,
    "detailCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chief_budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "periodType" TEXT NOT NULL DEFAULT 'month',
    "capUsd" DECIMAL(12,6) NOT NULL,
    "spentUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_budget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chief_session_userId_updatedAt_idx" ON "chief_session"("userId", "updatedAt");

CREATE INDEX IF NOT EXISTS "chief_session_userId_status_idx" ON "chief_session"("userId", "status");

CREATE INDEX IF NOT EXISTS "chief_transcript_delta_userId_idx" ON "chief_transcript_delta"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_transcript_delta_sessionId_sequence_key" ON "chief_transcript_delta"("sessionId", "sequence");

CREATE INDEX IF NOT EXISTS "chief_execution_journal_userId_idx" ON "chief_execution_journal"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_execution_journal_sessionId_sequence_key" ON "chief_execution_journal"("sessionId", "sequence");

CREATE INDEX IF NOT EXISTS "chief_event_journal_userId_createdAt_idx" ON "chief_event_journal"("userId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_event_journal_sessionId_sequence_eventIndex_key" ON "chief_event_journal"("sessionId", "sequence", "eventIndex");

CREATE INDEX IF NOT EXISTS "chief_middleware_state_userId_idx" ON "chief_middleware_state"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_middleware_state_sessionId_middlewareId_key" ON "chief_middleware_state"("sessionId", "middlewareId");

CREATE INDEX IF NOT EXISTS "chief_agent_userId_idx" ON "chief_agent"("userId");

CREATE INDEX IF NOT EXISTS "chief_agent_task_agentId_createdAt_idx" ON "chief_agent_task"("agentId", "createdAt");

CREATE INDEX IF NOT EXISTS "chief_agent_task_userId_createdAt_idx" ON "chief_agent_task"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "chief_agent_message_agentId_createdAt_idx" ON "chief_agent_message"("agentId", "createdAt");

CREATE INDEX IF NOT EXISTS "chief_trace_userId_startedAt_idx" ON "chief_trace"("userId", "startedAt");

CREATE INDEX IF NOT EXISTS "chief_trace_sessionId_startedAt_idx" ON "chief_trace"("sessionId", "startedAt");

CREATE INDEX IF NOT EXISTS "chief_trace_step_userId_idx" ON "chief_trace_step"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_trace_step_traceId_stepIndex_key" ON "chief_trace_step"("traceId", "stepIndex");

CREATE INDEX IF NOT EXISTS "chief_fact_userId_trustTier_idx" ON "chief_fact"("userId", "trustTier");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_fact_userId_dedupeKey_key" ON "chief_fact"("userId", "dedupeKey");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_knowledge_entity_userId_name_key" ON "chief_knowledge_entity"("userId", "name");

CREATE INDEX IF NOT EXISTS "chief_knowledge_relation_targetEntityId_idx" ON "chief_knowledge_relation"("targetEntityId");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_knowledge_relation_userId_sourceEntityId_targetEntity_key" ON "chief_knowledge_relation"("userId", "sourceEntityId", "targetEntityId", "relationType");

CREATE INDEX IF NOT EXISTS "chief_scheduled_task_status_nextRunAt_idx" ON "chief_scheduled_task"("status", "nextRunAt");

CREATE INDEX IF NOT EXISTS "chief_scheduled_task_userId_idx" ON "chief_scheduled_task"("userId");

CREATE INDEX IF NOT EXISTS "chief_task_run_scheduledTaskId_startedAt_idx" ON "chief_task_run"("scheduledTaskId", "startedAt");

CREATE INDEX IF NOT EXISTS "chief_task_run_userId_startedAt_idx" ON "chief_task_run"("userId", "startedAt");

CREATE INDEX IF NOT EXISTS "chief_approval_userId_createdAt_idx" ON "chief_approval"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "chief_approval_sessionId_stickyKey_idx" ON "chief_approval"("sessionId", "stickyKey");

CREATE INDEX IF NOT EXISTS "chief_capability_grant_userId_agentId_idx" ON "chief_capability_grant"("userId", "agentId");

CREATE INDEX IF NOT EXISTS "chief_audit_log_userId_createdAt_idx" ON "chief_audit_log"("userId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "chief_budget_userId_scope_periodType_key" ON "chief_budget"("userId", "scope", "periodType");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_session_userId_fkey') THEN
    ALTER TABLE "chief_session" ADD CONSTRAINT "chief_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_session_forkedFromSessionId_fkey') THEN
    ALTER TABLE "chief_session" ADD CONSTRAINT "chief_session_forkedFromSessionId_fkey" FOREIGN KEY ("forkedFromSessionId") REFERENCES "chief_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_transcript_delta_userId_fkey') THEN
    ALTER TABLE "chief_transcript_delta" ADD CONSTRAINT "chief_transcript_delta_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_transcript_delta_sessionId_fkey') THEN
    ALTER TABLE "chief_transcript_delta" ADD CONSTRAINT "chief_transcript_delta_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chief_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_execution_journal_userId_fkey') THEN
    ALTER TABLE "chief_execution_journal" ADD CONSTRAINT "chief_execution_journal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_execution_journal_sessionId_fkey') THEN
    ALTER TABLE "chief_execution_journal" ADD CONSTRAINT "chief_execution_journal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chief_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_event_journal_userId_fkey') THEN
    ALTER TABLE "chief_event_journal" ADD CONSTRAINT "chief_event_journal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_event_journal_sessionId_fkey') THEN
    ALTER TABLE "chief_event_journal" ADD CONSTRAINT "chief_event_journal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chief_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_middleware_state_userId_fkey') THEN
    ALTER TABLE "chief_middleware_state" ADD CONSTRAINT "chief_middleware_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_middleware_state_sessionId_fkey') THEN
    ALTER TABLE "chief_middleware_state" ADD CONSTRAINT "chief_middleware_state_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chief_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_agent_userId_fkey') THEN
    ALTER TABLE "chief_agent" ADD CONSTRAINT "chief_agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_agent_task_userId_fkey') THEN
    ALTER TABLE "chief_agent_task" ADD CONSTRAINT "chief_agent_task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_agent_task_agentId_fkey') THEN
    ALTER TABLE "chief_agent_task" ADD CONSTRAINT "chief_agent_task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "chief_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_agent_message_userId_fkey') THEN
    ALTER TABLE "chief_agent_message" ADD CONSTRAINT "chief_agent_message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_agent_message_agentId_fkey') THEN
    ALTER TABLE "chief_agent_message" ADD CONSTRAINT "chief_agent_message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "chief_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_trace_userId_fkey') THEN
    ALTER TABLE "chief_trace" ADD CONSTRAINT "chief_trace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_trace_step_userId_fkey') THEN
    ALTER TABLE "chief_trace_step" ADD CONSTRAINT "chief_trace_step_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_trace_step_traceId_fkey') THEN
    ALTER TABLE "chief_trace_step" ADD CONSTRAINT "chief_trace_step_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "chief_trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_fact_userId_fkey') THEN
    ALTER TABLE "chief_fact" ADD CONSTRAINT "chief_fact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_knowledge_entity_userId_fkey') THEN
    ALTER TABLE "chief_knowledge_entity" ADD CONSTRAINT "chief_knowledge_entity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_knowledge_relation_userId_fkey') THEN
    ALTER TABLE "chief_knowledge_relation" ADD CONSTRAINT "chief_knowledge_relation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_knowledge_relation_sourceEntityId_fkey') THEN
    ALTER TABLE "chief_knowledge_relation" ADD CONSTRAINT "chief_knowledge_relation_sourceEntityId_fkey" FOREIGN KEY ("sourceEntityId") REFERENCES "chief_knowledge_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_knowledge_relation_targetEntityId_fkey') THEN
    ALTER TABLE "chief_knowledge_relation" ADD CONSTRAINT "chief_knowledge_relation_targetEntityId_fkey" FOREIGN KEY ("targetEntityId") REFERENCES "chief_knowledge_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_scheduled_task_userId_fkey') THEN
    ALTER TABLE "chief_scheduled_task" ADD CONSTRAINT "chief_scheduled_task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_task_run_userId_fkey') THEN
    ALTER TABLE "chief_task_run" ADD CONSTRAINT "chief_task_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_task_run_scheduledTaskId_fkey') THEN
    ALTER TABLE "chief_task_run" ADD CONSTRAINT "chief_task_run_scheduledTaskId_fkey" FOREIGN KEY ("scheduledTaskId") REFERENCES "chief_scheduled_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_approval_userId_fkey') THEN
    ALTER TABLE "chief_approval" ADD CONSTRAINT "chief_approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_capability_grant_userId_fkey') THEN
    ALTER TABLE "chief_capability_grant" ADD CONSTRAINT "chief_capability_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_audit_log_userId_fkey') THEN
    ALTER TABLE "chief_audit_log" ADD CONSTRAINT "chief_audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_budget_userId_fkey') THEN
    ALTER TABLE "chief_budget" ADD CONSTRAINT "chief_budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── pgvector (optional) ──────────────────────────────────────────────────────
-- CREATE EXTENSION requires privileges some managed databases withhold; the
-- FTS/recency fallback keeps CHIEF functional without it.

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pgvector extension unavailable (%); CHIEF retrieval will use the FTS/recency fallback', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "chief_fact" ADD COLUMN IF NOT EXISTS "embedding" vector;
    ALTER TABLE "chief_knowledge_entity" ADD COLUMN IF NOT EXISTS "embedding" vector;
  END IF;
END
$$;

-- FTS fallback index over plaintext knowledge-entity names (fact content is
-- encrypted and never FTS-indexed by design).
CREATE INDEX IF NOT EXISTS "chief_knowledge_entity_name_fts_idx"
  ON "chief_knowledge_entity"
  USING GIN (to_tsvector('simple', "name"));

-- ── Row-level security: forced per-user isolation on every chief_* table ────

ALTER TABLE "chief_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_session" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_session";
CREATE POLICY "user_isolation" ON "chief_session"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_transcript_delta" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_transcript_delta" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_transcript_delta";
CREATE POLICY "user_isolation" ON "chief_transcript_delta"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_execution_journal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_execution_journal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_execution_journal";
CREATE POLICY "user_isolation" ON "chief_execution_journal"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_event_journal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_event_journal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_event_journal";
CREATE POLICY "user_isolation" ON "chief_event_journal"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_middleware_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_middleware_state" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_middleware_state";
CREATE POLICY "user_isolation" ON "chief_middleware_state"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_agent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_agent";
CREATE POLICY "user_isolation" ON "chief_agent"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_agent_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_agent_task" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_agent_task";
CREATE POLICY "user_isolation" ON "chief_agent_task"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_agent_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_agent_message" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_agent_message";
CREATE POLICY "user_isolation" ON "chief_agent_message"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_trace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_trace" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_trace";
CREATE POLICY "user_isolation" ON "chief_trace"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_trace_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_trace_step" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_trace_step";
CREATE POLICY "user_isolation" ON "chief_trace_step"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_fact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_fact" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_fact";
CREATE POLICY "user_isolation" ON "chief_fact"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_knowledge_entity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_knowledge_entity" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_knowledge_entity";
CREATE POLICY "user_isolation" ON "chief_knowledge_entity"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_knowledge_relation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_knowledge_relation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_knowledge_relation";
CREATE POLICY "user_isolation" ON "chief_knowledge_relation"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_scheduled_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_scheduled_task" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_scheduled_task";
CREATE POLICY "user_isolation" ON "chief_scheduled_task"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_task_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_task_run" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_task_run";
CREATE POLICY "user_isolation" ON "chief_task_run"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_approval" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_approval";
CREATE POLICY "user_isolation" ON "chief_approval"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_capability_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_capability_grant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_capability_grant";
CREATE POLICY "user_isolation" ON "chief_capability_grant"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_audit_log" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_audit_log";
CREATE POLICY "user_isolation" ON "chief_audit_log"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "chief_budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_budget" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_budget";
CREATE POLICY "user_isolation" ON "chief_budget"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- ── Grants for the runtime roles (conditional, RLS rollout convention) ───────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_session" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_transcript_delta" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_execution_journal" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_event_journal" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_middleware_state" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent_task" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent_message" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_trace" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_trace_step" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_fact" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_knowledge_entity" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_knowledge_relation" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_scheduled_task" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_task_run" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_approval" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_capability_grant" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_audit_log" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_budget" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_session" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_transcript_delta" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_execution_journal" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_event_journal" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_middleware_state" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent_task" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_agent_message" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_trace" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_trace_step" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_fact" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_knowledge_entity" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_knowledge_relation" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_scheduled_task" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_task_run" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_approval" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_capability_grant" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_audit_log" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_budget" TO freedom_service;
  END IF;
END
$$;
