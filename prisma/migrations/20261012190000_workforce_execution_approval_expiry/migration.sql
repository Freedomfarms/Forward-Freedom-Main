-- Server-assigned execution approval expiry, and one open execution per
-- owner and scope. Additive. Does not alter chief_approval.
-- A Cursor 404 does not release the reserved agent id, so this migration
-- does not add a resubmit path.

ALTER TABLE "workforce_execution" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

UPDATE "workforce_execution"
SET "expiresAt" = "createdAt" + INTERVAL '15 minutes'
WHERE "expiresAt" IS NULL;

ALTER TABLE "workforce_execution" ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_execution_active_scope_key"
    ON "workforce_execution" ("userId", "scopeHash")
    WHERE "state" IN ('APPROVED', 'SUBMITTING', 'SUBMITTED', 'AMBIGUOUS', 'RUNNING');
