-- External Claude and ChatGPT transcripts. These tables are not chief_session
-- and they do not store a TurnMachine checkpoint. Message bodies and titles
-- are envelope ciphertext. recallDocument is a redacted projection for later
-- search. A missing conversation in a later export is not a delete.

CREATE TABLE IF NOT EXISTS "external_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "titleCiphertext" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "model" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "unsupportedCount" INTEGER NOT NULL DEFAULT 0,
    "omittedBranchCount" INTEGER NOT NULL DEFAULT 0,
    "recallDocument" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_conversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_conversation_provider_check" CHECK ("provider" IN ('claude', 'chatgpt'))
);

CREATE TABLE IF NOT EXISTS "external_message" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "externalId" TEXT,
    "role" TEXT NOT NULL,
    "model" TEXT,
    "parentExternalId" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "contentCiphertext" TEXT NOT NULL,
    "hasUnsupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_message_role_check" CHECK ("role" IN ('user', 'assistant', 'system', 'tool', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "external_conversation_userId_provider_externalId_key"
  ON "external_conversation"("userId", "provider", "externalId");

CREATE INDEX IF NOT EXISTS "external_conversation_userId_updatedAt_idx"
  ON "external_conversation"("userId", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "external_message_conversationId_ordinal_key"
  ON "external_message"("conversationId", "ordinal");

CREATE INDEX IF NOT EXISTS "external_message_userId_conversationId_idx"
  ON "external_message"("userId", "conversationId");

CREATE INDEX IF NOT EXISTS "external_conversation_recall_document_fts_idx"
  ON "external_conversation"
  USING GIN (to_tsvector('simple', coalesce("recallDocument", '')));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_conversation_userId_fkey') THEN
    ALTER TABLE "external_conversation" ADD CONSTRAINT "external_conversation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_message_userId_fkey') THEN
    ALTER TABLE "external_message" ADD CONSTRAINT "external_message_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_message_conversationId_fkey') THEN
    ALTER TABLE "external_message" ADD CONSTRAINT "external_message_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "external_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "external_conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_conversation" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "external_conversation";
CREATE POLICY "user_isolation" ON "external_conversation"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "external_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_message" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "external_message";
CREATE POLICY "user_isolation" ON "external_message"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
