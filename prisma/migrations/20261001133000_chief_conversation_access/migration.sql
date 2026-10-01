-- Per-user CHIEF conversation permissions. No row means read, organize,
-- and delete are all OFF. These flags do not grant Module 02 access.

CREATE TABLE IF NOT EXISTS "chief_conversation_access" (
    "userId" TEXT NOT NULL,
    "conversationRead" BOOLEAN NOT NULL DEFAULT false,
    "conversationOrganize" BOOLEAN NOT NULL DEFAULT false,
    "conversationDelete" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_conversation_access_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_conversation_access_userId_fkey') THEN
    ALTER TABLE "chief_conversation_access" ADD CONSTRAINT "chief_conversation_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "chief_conversation_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_conversation_access" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_conversation_access";
CREATE POLICY "user_isolation" ON "chief_conversation_access"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_conversation_access" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_conversation_access" TO freedom_service;
  END IF;
END
$$;
