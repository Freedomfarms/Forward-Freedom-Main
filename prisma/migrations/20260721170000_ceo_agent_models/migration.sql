-- Per-CEO model choice + default model for newly created sub-agents.
-- AgentConfig.model already exists (defaults to Sonnet).

ALTER TABLE "CeoAgentConfig"
  ADD COLUMN IF NOT EXISTS "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
  ADD COLUMN IF NOT EXISTS "defaultSubAgentModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-5';
