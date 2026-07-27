// ─────────────────────────────────────────────────────────────────────────────
// Migration inventory: ceoReasoning.js is a transitional shadow reasoner.
//
// Phase 1: keep ACTIVE MISSION continuity support; do not expand; do not let it
// override CEO judgment. World model + tools + constitution are authoritative.
// Phase 2: replace with durable plan state and delete the regex sketcher.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every live/call-site dependency on server/agents/ceoReasoning.js.
 * Keep this list honest when wiring changes — tests assert it stays documented.
 */
export const CEO_REASONING_DEPENDENCIES = Object.freeze([
  Object.freeze({
    file: "server/brain/ceoContextAssembler.js",
    usage: "Calls sketchMissionFromConversation for transitional ACTIVE MISSION continuity.",
    authority: "hint_only",
    phase2: "Replace with durable Plan / ActiveMission store.",
  }),
  Object.freeze({
    file: "server/brain/controlPlane.js",
    usage: "Reads missionState.missionKind / createsNewCapability for intent + capability assessment.",
    authority: "hint_only",
    phase2: "Drive control-plane assessment from durable plan + tool proofs only.",
  }),
  Object.freeze({
    file: "server/brain/prompts.js",
    usage: "Imports CEO_MISSION_REASONING_RULES into BRAIN_SYSTEM_PROMPT.",
    authority: "steering_copy",
    phase2: "Replace with a short constitution (truth/permissions/Done) without interview pipeline copy.",
  }),
  Object.freeze({
    file: "server/brain/index.js",
    usage: "logCeoReasoning(activeMission) for debug observability.",
    authority: "observability",
    phase2: "Log durable plan + world-model meta instead.",
  }),
  Object.freeze({
    file: "server/agents/ceoEfficiencyMetrics.js",
    usage: "Efficiency metrics consume sketcher missionExecutable / questionsAsked.",
    authority: "metrics_only",
    phase2: "Retarget metrics at durable plan resolution, or drop.",
  }),
  Object.freeze({
    file: "test/ceo-reasoning.test.js",
    usage: "Unit coverage of sketcher heuristics.",
    authority: "tests",
    phase2: "Delete or rewrite against Plan store.",
  }),
  Object.freeze({
    file: "test/ceo-brain-acceptance.test.js",
    usage: "Acceptance suite asserts sketcher missionKinds / gaps.",
    authority: "tests",
    phase2: "Retarget to world-model + tool-proof behavior.",
  }),
  Object.freeze({
    file: "test/ceo-brain-continuity.test.js",
    usage: "Multi-turn continuity via advanceMissionState.",
    authority: "tests",
    phase2: "Retarget to durable plan continuity.",
  }),
  Object.freeze({
    file: "test/ceo-brain-efficiency-metrics.test.js",
    usage: "Efficiency ceilings against sketcher outputs.",
    authority: "tests",
    phase2: "Retarget or retire with sketcher.",
  }),
]);

export const CEO_REASONING_MIGRATION_STATUS = Object.freeze({
  phase: 1,
  role: "transitional_continuity_sketch",
  judgmentOwner: "llm_plus_world_model",
  deletionCandidate: true,
  doNotExpand: true,
});
