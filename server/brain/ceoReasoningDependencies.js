// ─────────────────────────────────────────────────────────────────────────────
// Migration inventory: ceoReasoning.js residual surface area.
//
// Phase 2A: removed from decision shaping (no question ranking / mission
// classification in the CEO hot path). Sketch may still run as inferred
// metadata until Plan store exists.
// ─────────────────────────────────────────────────────────────────────────────

/** Still called on the Brain hot path — but only as inferred metadata. */
export const CEO_REASONING_HOT_PATH = Object.freeze([
  Object.freeze({
    file: "server/brain/ceoContextAssembler.js",
    usage:
      "Calls sketchMissionFromConversation to populate ACTIVE MISSION inferred metadata only (possible_objective / confidence). Not used for question ordering or control-plane steering.",
    authority: "inferred_metadata_only",
    phase2b: "Replace with durable Plan / ActiveMission store; then delete sketcher call.",
  }),
  Object.freeze({
    file: "server/brain/ceoContextAssembler.js",
    usage: "logCeoReasoning(activeMission) for debug observability.",
    authority: "observability",
    phase2b: "Log durable plan + world-model meta instead.",
  }),
]);

/** Offline / test-only — not part of CEO judgment. */
export const CEO_REASONING_OFFLINE = Object.freeze([
  Object.freeze({
    file: "server/agents/ceoEfficiencyMetrics.js",
    usage: "Efficiency metrics consume sketcher missionExecutable / questionsAsked.",
    authority: "metrics_only",
  }),
  Object.freeze({
    file: "test/ceo-reasoning.test.js",
    usage: "Unit coverage of sketcher heuristics (legacy).",
    authority: "tests",
  }),
  Object.freeze({
    file: "test/ceo-brain-acceptance.test.js",
    usage: "Acceptance suite asserts sketcher missionKinds / gaps (legacy).",
    authority: "tests",
  }),
  Object.freeze({
    file: "test/ceo-brain-continuity.test.js",
    usage: "Multi-turn continuity via advanceMissionState (legacy).",
    authority: "tests",
  }),
  Object.freeze({
    file: "test/ceo-brain-efficiency-metrics.test.js",
    usage: "Efficiency ceilings against sketcher outputs (legacy).",
    authority: "tests",
  }),
]);

/** @deprecated Use CEO_REASONING_HOT_PATH + CEO_REASONING_OFFLINE. */
export const CEO_REASONING_DEPENDENCIES = Object.freeze([
  ...CEO_REASONING_HOT_PATH,
  ...CEO_REASONING_OFFLINE,
]);

export const CEO_REASONING_MIGRATION_STATUS = Object.freeze({
  phase: "2A",
  role: "inferred_metadata_only",
  judgmentOwner: "llm_plus_world_model",
  decisionShaping: false,
  questionRankingInHotPath: false,
  missionClassificationInHotPath: false,
  deletionCandidate: true,
  doNotExpand: true,
});
