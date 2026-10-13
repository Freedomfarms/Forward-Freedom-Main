-- One capture credential per user. The plaintext token is not stored.
-- Provider switches default off. This is not a second archive.

CREATE TABLE IF NOT EXISTS "external_capture_credential" (
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT,
  "issuedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "claudeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "chatgptEnabled" BOOLEAN NOT NULL DEFAULT false,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "lastSuccessAt" TIMESTAMP(3),
  "lastErrorAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastProvider" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_capture_credential_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "external_capture_credential_tokenHash_key"
  ON "external_capture_credential"("tokenHash");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_capture_credential_userId_fkey') THEN
    ALTER TABLE "external_capture_credential" ADD CONSTRAINT "external_capture_credential_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "external_capture_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_capture_credential" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_isolation" ON "external_capture_credential";
CREATE POLICY "user_isolation" ON "external_capture_credential"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "external_capture_credential" TO freedom_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "external_capture_credential" TO freedom_service;
  END IF;
END
$$;
