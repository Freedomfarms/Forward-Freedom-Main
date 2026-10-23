// Assignment 1 proof constants. Production chat does not read this module.

export const PROOF_MODEL = Object.freeze({
  id: "claude-opus-5-5",
  effort: "medium",
});

export const SESSION_BETA = "managed-agents-2026-04-01";
export const MEMORY_BETA = "agent-memory-2026-07-22";
export const ANTHROPIC_VERSION = "2023-06-01";

export const ICM_ARCHITECT_PIN = "e16cafe6a664dcf6d787a726b452adba77d913f4";
export const ICM_METHODOLOGY_PIN = "02ba5d85c7871b75c7c702a2d8da6524723d53d4";

// Implementer choices. The job lease outlives one slice. Write ownership is
// not stolen when this clock passes; see ownership.js.
export const JOB_LEASE_MS = 90_000;
export const WRITE_LEASE_MS = 90_000;
export const SLICE_BUDGET_MS = 25_000;
export const SUPERVISOR_INTERVAL_MS = 30_000;
export const SESSION_BUDGET_CENTS = "200";
// First live experiment cap. This is a proposal, not spend approval.
export const PROPOSED_PROOF_SESSION_CAP = 5;
export const PROPOSED_PROOF_LEDGER_CENTS = 1000;
export const BASE_MIGRATION = "20250604120000_init";
export const PROOF_MIGRATION = "20261022193000_chief_managed_proof";

export const REQUIRED_WORKSPACE_PATHS = Object.freeze([
  "requirements.md",
  "decisions.md",
  "open-questions.md",
  "next-step.md",
]);

export const PROOF_PHASES = Object.freeze([
  "initial",
  "close",
  "continue_same_store",
  "correct",
  "confirm",
  "recover",
]);

export const PROOF_TABLES = Object.freeze([
  "chief_managed_resource",
  "chief_proof_project",
  "chief_proof_document",
  "chief_proof_conflict",
  "chief_proof_run",
  "chief_proof_job",
  "chief_proof_tool_call",
  "chief_proof_ping",
  "chief_proof_latency_sample",
]);

export function proofEnabled(env = process.env) {
  return env.CHIEF_MANAGED_PROOF === "1";
}

export function runtimeMode(env = process.env) {
  return env.CHIEF_RUNTIME === "managed" ? "managed" : "legacy";
}
