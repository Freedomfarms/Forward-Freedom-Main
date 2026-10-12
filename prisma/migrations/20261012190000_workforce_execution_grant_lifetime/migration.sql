-- Bind an explicit execution grant to the existing owner-scoped ledger row.
-- Additive. Does not alter chief_approval or weaken workforce row-level security.

ALTER TABLE "workforce_execution" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "workforce_execution" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
