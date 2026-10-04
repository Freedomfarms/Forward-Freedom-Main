-- Voice lifecycle steps. Additive. Existing turn step types are unchanged.
-- Audio and transcript text are not columns on this table.

ALTER TYPE "ChiefTraceStepType" ADD VALUE IF NOT EXISTS 'VOICE';
