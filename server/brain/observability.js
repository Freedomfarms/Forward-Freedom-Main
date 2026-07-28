// ─────────────────────────────────────────────────────────────────────────────
// CEO decision observability — structured logs without sensitive finance data.
// Never log balances, merchants, account numbers, category totals, or raw state.
// ─────────────────────────────────────────────────────────────────────────────

export function isCeoObservabilityEnabled() {
  const raw = String(process.env.FREEDOM_OS_DEBUG_CEO || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * Log what context/capabilities were available for a CEO turn (pre-reasoning).
 * @param {object} event
 */
export function logCeoContextAssembly(event = {}) {
  if (!isCeoObservabilityEnabled()) return;
  const payload = {
    phase: "context_assembly",
    conversationId: event.conversationId || null,
    contextSections: Array.isArray(event.contextSections) ? event.contextSections : [],
    capabilitiesAvailable: event.capabilitiesAvailable || [],
    capabilitiesUnavailable: event.capabilitiesUnavailable || [],
    toolsEnabled: event.toolsEnabled || [],
    worldModel: sanitizeWorldModelMeta(event.worldModelMeta),
    activeMission: {
      kind: event.activeMissionKind || null,
      executable: event.missionExecutable === true,
      authority: event.activeMissionAuthority || "transitional_sketch",
      planId: event.planId || null,
      planStatus: event.planStatus || null,
    },
    memoryCount: Number(event.memoryCount) || 0,
  };
  console.info(`[ceo-observability] ${JSON.stringify(payload)}`);
}

/**
 * Log post-turn decision summary (tools used + safety checks).
 * Call after the model finishes; never include reply body or finance numbers.
 */
export function logCeoDecision(event = {}) {
  if (!isCeoObservabilityEnabled()) return;
  const payload = {
    phase: "decision",
    conversationId: event.conversationId || null,
    toolsInvoked: event.toolsInvoked || [],
    actionSelected: event.actionSelected || null,
    safetyChecksTriggered: event.safetyChecksTriggered || [],
    confirmationsCount: Number(event.confirmationsCount) || 0,
    agentCreated: event.agentCreated === true,
    runDelegated: event.runDelegated === true,
    claimCount: Number.isFinite(event.claimCount) ? event.claimCount : undefined,
  };
  console.info(`[ceo-observability] ${JSON.stringify(payload)}`);
}

function sanitizeWorldModelMeta(meta = {}) {
  return {
    lightFinancialStatus: meta.lightFinancialStatus || null,
    aggregatesStatus: meta.aggregatesStatus || null,
    aggregatesCacheHit: meta.aggregatesCacheHit === true,
    workspaceStatus: meta.workspaceStatus || null,
    hasSnapshot: meta.hasSnapshot === true,
    plaidItemCount: Number.isFinite(meta.plaidItemCount) ? meta.plaidItemCount : null,
    unavailableDomains: Array.isArray(meta.unavailableDomains) ? meta.unavailableDomains : [],
  };
}
