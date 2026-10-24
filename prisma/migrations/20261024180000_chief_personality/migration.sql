-- Per-user CHIEF conversational preferences. No row means the JARVIS default.
-- A missing table must not change User reads. Personality code treats that as
-- the default until this migration is applied.

CREATE TABLE IF NOT EXISTS "chief_personality" (
    "userId" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "responseLength" TEXT NOT NULL,
    "humor" INTEGER NOT NULL,
    "directness" INTEGER NOT NULL,
    "proactiveness" INTEGER NOT NULL,
    "customInstructions" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_personality_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_personality_userId_fkey') THEN
    ALTER TABLE "chief_personality" ADD CONSTRAINT "chief_personality_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "chief_personality" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_personality" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_personality";
CREATE POLICY "user_isolation" ON "chief_personality"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_personality" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_personality" TO freedom_service;
  END IF;
END
$$;
