-- Guarded CHIEF workspace files. Postgres is authoritative. Recovery copies
-- live rows into a new memory store and skips rows with deletedAt set.

CREATE TABLE "chief_workspace_document" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "contentSha256" TEXT NOT NULL DEFAULT '',
    "contentCiphertext" TEXT NOT NULL DEFAULT '',
    "conflictCiphertext" TEXT,
    "conflictSha256" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_workspace_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chief_workspace_document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "chief_workspace_document_userId_path_key" ON "chief_workspace_document"("userId", "path");

CREATE INDEX "chief_workspace_document_userId_updatedAt_idx" ON "chief_workspace_document"("userId", "updatedAt");

ALTER TABLE "chief_workspace_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chief_workspace_document" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_isolation" ON "chief_workspace_document"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_workspace_document" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_workspace_document" TO freedom_service;
  END IF;
END
$$;
