-- Multi-conversation support: AgentConversation parent + conversationId on
-- AgentChatMessage. Backfills one "Original thread" per CEO and per sub-agent
-- so existing chat rows keep working. RLS mirrors other agent-scoped tables.

CREATE TABLE IF NOT EXISTS "AgentConversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentConfigId" TEXT,
  "ceoAgentConfigId" TEXT,
  "title" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMP(3),
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentConversation_userId_agentConfigId_updatedAt_idx"
  ON "AgentConversation"("userId", "agentConfigId", "updatedAt");

CREATE INDEX IF NOT EXISTS "AgentConversation_userId_ceoAgentConfigId_updatedAt_idx"
  ON "AgentConversation"("userId", "ceoAgentConfigId", "updatedAt");

CREATE INDEX IF NOT EXISTS "AgentConversation_userId_updatedAt_idx"
  ON "AgentConversation"("userId", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentConversation_userId_fkey'
  ) THEN
    ALTER TABLE "AgentConversation"
      ADD CONSTRAINT "AgentConversation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentConversation_agentConfigId_fkey'
  ) THEN
    ALTER TABLE "AgentConversation"
      ADD CONSTRAINT "AgentConversation_agentConfigId_fkey"
      FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentConversation_ceoAgentConfigId_fkey'
  ) THEN
    ALTER TABLE "AgentConversation"
      ADD CONSTRAINT "AgentConversation_ceoAgentConfigId_fkey"
      FOREIGN KEY ("ceoAgentConfigId") REFERENCES "CeoAgentConfig"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AgentConversation_exactly_one_chat_target_check'
  ) THEN
    ALTER TABLE "AgentConversation"
      ADD CONSTRAINT "AgentConversation_exactly_one_chat_target_check"
      CHECK ((("agentConfigId" IS NULL) <> ("ceoAgentConfigId" IS NULL)));
  END IF;
END
$$;

ALTER TABLE "AgentConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentConversation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "AgentConversation";
CREATE POLICY "user_isolation" ON "AgentConversation"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentConversation" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AgentConversation" TO freedom_service;
  END IF;
END
$$;

-- Nullable first so existing rows can be backfilled before NOT NULL.
ALTER TABLE "AgentChatMessage"
  ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

-- One Original thread per CEO Agent (including those with zero messages).
INSERT INTO "AgentConversation" (
  "id",
  "userId",
  "agentConfigId",
  "ceoAgentConfigId",
  "title",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "isSystem"
)
SELECT
  'c' || replace(gen_random_uuid()::text, '-', ''),
  c."userId",
  NULL,
  c."id",
  'Original thread',
  COALESCE(
    (SELECT MIN(m."createdAt") FROM "AgentChatMessage" m WHERE m."ceoAgentConfigId" = c."id"),
    c."createdAt"
  ),
  COALESCE(
    (SELECT MAX(m."createdAt") FROM "AgentChatMessage" m WHERE m."ceoAgentConfigId" = c."id"),
    c."updatedAt"
  ),
  NULL,
  false
FROM "CeoAgentConfig" c
WHERE NOT EXISTS (
  SELECT 1
  FROM "AgentConversation" ac
  WHERE ac."ceoAgentConfigId" = c."id"
    AND ac."agentConfigId" IS NULL
    AND ac."isSystem" = false
    AND ac."title" = 'Original thread'
);

-- One Original thread per sub-agent (including those with zero messages).
INSERT INTO "AgentConversation" (
  "id",
  "userId",
  "agentConfigId",
  "ceoAgentConfigId",
  "title",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "isSystem"
)
SELECT
  'c' || replace(gen_random_uuid()::text, '-', ''),
  a."userId",
  a."id",
  NULL,
  'Original thread',
  COALESCE(
    (SELECT MIN(m."createdAt") FROM "AgentChatMessage" m WHERE m."agentConfigId" = a."id"),
    a."createdAt"
  ),
  COALESCE(
    (SELECT MAX(m."createdAt") FROM "AgentChatMessage" m WHERE m."agentConfigId" = a."id"),
    a."updatedAt"
  ),
  NULL,
  false
FROM "AgentConfig" a
WHERE NOT EXISTS (
  SELECT 1
  FROM "AgentConversation" ac
  WHERE ac."agentConfigId" = a."id"
    AND ac."ceoAgentConfigId" IS NULL
    AND ac."isSystem" = false
    AND ac."title" = 'Original thread'
);

-- Point existing CEO messages at that agent's Original thread.
UPDATE "AgentChatMessage" AS m
SET "conversationId" = ac."id"
FROM "AgentConversation" AS ac
WHERE m."conversationId" IS NULL
  AND m."ceoAgentConfigId" IS NOT NULL
  AND ac."ceoAgentConfigId" = m."ceoAgentConfigId"
  AND ac."agentConfigId" IS NULL
  AND ac."isSystem" = false
  AND ac."title" = 'Original thread';

-- Point existing sub-agent messages at that agent's Original thread.
UPDATE "AgentChatMessage" AS m
SET "conversationId" = ac."id"
FROM "AgentConversation" AS ac
WHERE m."conversationId" IS NULL
  AND m."agentConfigId" IS NOT NULL
  AND ac."agentConfigId" = m."agentConfigId"
  AND ac."ceoAgentConfigId" IS NULL
  AND ac."isSystem" = false
  AND ac."title" = 'Original thread';

-- Fail loudly if any message could not be attributed (should not happen while
-- AgentChatMessage FKs to CeoAgentConfig / AgentConfig remain intact).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AgentChatMessage" WHERE "conversationId" IS NULL
  ) THEN
    RAISE EXCEPTION
      'AgentChatMessage backfill left conversationId NULL; aborting migration';
  END IF;
END
$$;

ALTER TABLE "AgentChatMessage"
  ALTER COLUMN "conversationId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "AgentChatMessage_conversationId_createdAt_idx"
  ON "AgentChatMessage"("conversationId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AgentChatMessage_conversationId_fkey'
  ) THEN
    ALTER TABLE "AgentChatMessage"
      ADD CONSTRAINT "AgentChatMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
