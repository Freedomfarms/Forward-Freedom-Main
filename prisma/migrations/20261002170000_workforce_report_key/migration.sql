-- Self-report key hash on the existing workforce binding.
-- Additive. Does not change row-level security, source/trust checks, or
-- chief_agent tables. Enterprise OpenTelemetry is not part of this migration.

ALTER TABLE "workforce_binding" ADD COLUMN IF NOT EXISTS "reportKeyHash" TEXT;
ALTER TABLE "workforce_binding" ADD COLUMN IF NOT EXISTS "reportKeyIssuedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_binding_reportKeyHash_key"
    ON "workforce_binding"("reportKeyHash");
