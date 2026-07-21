-- Cached long-form CEO "Read your Profile" narrative (encrypted).
-- Column-only add on an already-RLS'd table — no policy changes required.

ALTER TABLE "CeoAgentConfig"
  ADD COLUMN IF NOT EXISTS "narrativeProfileCiphertext" TEXT,
  ADD COLUMN IF NOT EXISTS "narrativeProfileAt" TIMESTAMP(3);
