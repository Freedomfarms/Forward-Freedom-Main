-- Plain identity fields captured during conversational "+ New Agent" intake.
-- Stored on AgentConfig (no separate soul/identity abstraction yet).

ALTER TABLE "AgentConfig"
  ADD COLUMN IF NOT EXISTS "personalityNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "boundaries" TEXT,
  ADD COLUMN IF NOT EXISTS "workingFromNotes" TEXT;
