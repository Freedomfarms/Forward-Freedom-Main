// ─────────────────────────────────────────────────────────────────────────────
// Context Assembler entry — Freedom Brain.
//
// Phase 1: the CEO world-model assembler lives in ceoContextAssembler.js.
// This module re-exports the stable `assembleBrainContext` name so existing
// imports keep working.
// ─────────────────────────────────────────────────────────────────────────────

export {
  assembleBrainContext,
  assembleCeoContext,
  CEO_ENABLED_TOOLS,
  renderApplicationState,
} from "./ceoContextAssembler.js";
