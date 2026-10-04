-- Workforce observation journal. Additive. Does not alter chief_agent,
-- chief_agent_task, or chief_agent_message.
--
-- source/trust pairs are fixed: OTEL is PLATFORM, SELF_REPORT is UNTRUSTED.
-- A payload cannot store the other combination.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkforceSource') THEN
    CREATE TYPE "WorkforceSource" AS ENUM ('OTEL', 'SELF_REPORT');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkforceTrust') THEN
    CREATE TYPE "WorkforceTrust" AS ENUM ('PLATFORM', 'UNTRUSTED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkforceLiveness') THEN
    CREATE TYPE "WorkforceLiveness" AS ENUM ('ACTIVE', 'IDLE', 'STALE', 'UNKNOWN');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkforceBindingStatus') THEN
    CREATE TYPE "WorkforceBindingStatus" AS ENUM ('ACTIVE', 'REVOKED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "workforce_binding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WorkforceBindingStatus" NOT NULL DEFAULT 'ACTIVE',
    "cursorAccountId" TEXT,
    "emailCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_binding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_binding_userId_key" ON "workforce_binding"("userId");

CREATE TABLE IF NOT EXISTS "observed_agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT,
    "role" TEXT,
    "identityTrust" "WorkforceTrust",
    "lastEventAt" TIMESTAMP(3),
    "lastTurnId" TEXT,
    "liveness" "WorkforceLiveness" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observed_agent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "observed_agent_userId_externalId_key" ON "observed_agent"("userId", "externalId");
CREATE INDEX IF NOT EXISTS "observed_agent_bindingId_idx" ON "observed_agent"("bindingId");

CREATE TABLE IF NOT EXISTS "activity_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "source" "WorkforceSource" NOT NULL,
    "trust" "WorkforceTrust" NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentExternalId" TEXT NOT NULL,
    "turnId" TEXT,
    "rootTurnId" TEXT,
    "toolCallId" TEXT,
    "sequence" INTEGER,
    "provenance" TEXT,
    "coded" JSONB,
    "textCiphertext" TEXT,

    CONSTRAINT "activity_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activity_event_source_trust_pair" CHECK (
        ("source" = 'OTEL' AND "trust" = 'PLATFORM')
        OR ("source" = 'SELF_REPORT' AND "trust" = 'UNTRUSTED')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "activity_event_userId_source_sourceEventId_key"
    ON "activity_event"("userId", "source", "sourceEventId");
CREATE INDEX IF NOT EXISTS "activity_event_userId_occurredAt_idx"
    ON "activity_event"("userId", "occurredAt");
CREATE INDEX IF NOT EXISTS "activity_event_userId_agentExternalId_occurredAt_idx"
    ON "activity_event"("userId", "agentExternalId", "occurredAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workforce_binding_userId_fkey') THEN
    ALTER TABLE "workforce_binding" ADD CONSTRAINT "workforce_binding_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observed_agent_userId_fkey') THEN
    ALTER TABLE "observed_agent" ADD CONSTRAINT "observed_agent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observed_agent_bindingId_fkey') THEN
    ALTER TABLE "observed_agent" ADD CONSTRAINT "observed_agent_bindingId_fkey"
      FOREIGN KEY ("bindingId") REFERENCES "workforce_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_event_userId_fkey') THEN
    ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_event_bindingId_fkey') THEN
    ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_bindingId_fkey"
      FOREIGN KEY ("bindingId") REFERENCES "workforce_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "workforce_binding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce_binding" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_isolation" ON "workforce_binding";
CREATE POLICY "user_isolation" ON "workforce_binding"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "observed_agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "observed_agent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_isolation" ON "observed_agent";
CREATE POLICY "user_isolation" ON "observed_agent"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "activity_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_event" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_isolation" ON "activity_event";
CREATE POLICY "user_isolation" ON "activity_event"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workforce_binding" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "observed_agent" TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "activity_event" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workforce_binding" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "observed_agent" TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "activity_event" TO freedom_service;
  END IF;
END
$$;
