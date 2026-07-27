// ─────────────────────────────────────────────────────────────────────────────
// Migration inventory: ceoReasoning.js residual surface area.
//
// Phase 2A: removed from decision shaping (no question ranking / mission
// classification in the CEO hot path).
// Phase 2B: Plan store is the durable ACTIVE MISSION source. Sketcher runs
// only when no Plan exists (temporary inferred metadata). Never auto-convert.
// ─────────────────────────────────────────────────────────────────────────────

/** Still called on the Brain hot path — but only when no Plan exists. */
export const CEO_REASONING_HOT_PATH = Object.freeze([
  Object.freeze({
    file: "server/brain/ceoContextAssembler.js",
    usage:
      "Calls sketchMissionFromConversation only when loadPrimaryActivePlan returns null. Populates transitional inferred ACTIVE MISSION metadata. Not used for question ordering, control-plane steering, or Plan seeding.",
    authority: "inferred_metadata_only_when_no_plan",
    phase2b: "Delete sketcher call once Plans cover continuity; keep dual-read until then.",
  }),
  Object.freeze({
    file: "server/brain/ceoContextAssembler.js",
    usage: "logCeoReasoning(activeMission) only on the no-Plan inferred path.",
    authority: "observability",
    phase2b: "Plan path logs via logPlanEvent / logCeoContextAssembly plan meta.",
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
  phase: "2B",
  role: "inferred_metadata_only",
  judgmentOwner: "llm_plus_world_model",
  activeMissionSource: "plan_when_present_else_inferred",
  decisionShaping: false,
  questionRankingInHotPath: false,
  missionClassificationInHotPath: false,
  autoConvertInferredToPlan: false,
  deletionCandidate: true,
  doNotExpand: true,
});
