-- Per-user CHIEF Module 02 read switch. No row means OFF.
-- module02Read never authorizes a Module 02 write.

CREATE TABLE IF NOT EXISTS "chief_module_access" (
    "userId" TEXT NOT NULL,
    "module02Read" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chief_module_access_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chief_module_access_userId_fkey') THEN
    ALTER TABLE "chief_module_access" ADD CONSTRAINT "chief_module_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "chief_module_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_module_access" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "chief_module_access";
CREATE POLICY "user_isolation" ON "chief_module_access"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_module_access" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_module_access" TO freedom_service;
  END IF;
END
$$;
