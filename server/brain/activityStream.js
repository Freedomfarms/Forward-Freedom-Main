import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Activity Stream — observable system events for the OS UI.
//
// Controlled vocabulary only. Never carries chain-of-thought, private model
// deliberation, user message bodies, or decrypted Plan contents.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVITY_PHASES = Object.freeze({
  ASSESSING: "ASSESSING",
  PLANNING: "PLANNING",
  WORKING: "WORKING",
  VERIFYING: "VERIFYING",
  REPORTING: "REPORTING",
});

export const ACTIVITY_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
});

/**
 * Backend-defined activity keys → phase + user-facing label.
 * The LLM must never invent labels; only these keys may be emitted.
 */
export const ACTIVITY_CATALOG = Object.freeze({
  UNDERSTANDING_REQUEST: Object.freeze({
    phase: ACTIVITY_PHASES.ASSESSING,
    label: "Understanding request",
  }),
  REVIEWING_CONTEXT: Object.freeze({
    phase: ACTIVITY_PHASES.ASSESSING,
    label: "Reviewing context",
  }),
  CHECKING_CONSTRAINTS: Object.freeze({
    phase: ACTIVITY_PHASES.ASSESSING,
    label: "Checking constraints",
  }),
  EVALUATING_ACTIVE_PLANS: Object.freeze({
    phase: ACTIVITY_PHASES.PLANNING,
    label: "Evaluating active plans",
  }),
  UPDATING_MISSION: Object.freeze({
    phase: ACTIVITY_PHASES.PLANNING,
    label: "Updating mission",
  }),
  PRIORITIZING_ACTIONS: Object.freeze({
    phase: ACTIVITY_PHASES.PLANNING,
    label: "Prioritizing actions",
  }),
  RUNNING_ANALYSIS: Object.freeze({
    phase: ACTIVITY_PHASES.WORKING,
    label: "Running analysis",
  }),
  COORDINATING_AGENT: Object.freeze({
    phase: ACTIVITY_PHASES.WORKING,
    label: "Coordinating agent",
  }),
  GATHERING_INFORMATION: Object.freeze({
    phase: ACTIVITY_PHASES.WORKING,
    label: "Gathering information",
  }),
  CHECKING_EVIDENCE: Object.freeze({
    phase: ACTIVITY_PHASES.VERIFYING,
    label: "Checking evidence",
  }),
  VALIDATING_RESULTS: Object.freeze({
    phase: ACTIVITY_PHASES.VERIFYING,
    label: "Validating results",
  }),
  CONFIRMING_COMPLETION: Object.freeze({
    phase: ACTIVITY_PHASES.VERIFYING,
    label: "Confirming completion",
  }),
  PREPARING_SUMMARY: Object.freeze({
    phase: ACTIVITY_PHASES.REPORTING,
    label: "Preparing summary",
  }),
  FORMATTING_RECOMMENDATION: Object.freeze({
    phase: ACTIVITY_PHASES.REPORTING,
    label: "Formatting recommendation",
  }),
});

export const ACTIVITY_KEYS = Object.freeze(Object.keys(ACTIVITY_CATALOG));

const SAFE_META_KEYS = Object.freeze(["agentName", "agentType", "toolName", "planStatus"]);

/** Map Brain tool names → activity keys (controlled). */
export const TOOL_ACTIVITY_KEYS = Object.freeze({
  web_search: "GATHERING_INFORMATION",
  create_agent: "COORDINATING_AGENT",
  update_agent: "COORDINATING_AGENT",
  run_agent: "COORDINATING_AGENT",
  delete_agent: "COORDINATING_AGENT",
  set_timezone: "CHECKING_CONSTRAINTS",
  update_digest: "PREPARING_SUMMARY",
  create_plan: "UPDATING_MISSION",
  update_plan: "UPDATING_MISSION",
  get_plan: "EVALUATING_ACTIVE_PLANS",
});

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const out = {};
  for (const key of SAFE_META_KEYS) {
    if (meta[key] == null) continue;
    const value = String(meta[key]).trim().slice(0, 80);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function assertKnownKey(key) {
  if (!ACTIVITY_CATALOG[key]) {
    throw new Error(`Unknown activity key: ${key}`);
  }
}

/**
 * Create a per-turn activity recorder. Emits only catalog keys.
 * @param {{ onEvent?: (event: object) => void }} [options]
 */
export function createActivityRecorder({ onEvent } = {}) {
  const startedAt = Date.now();
  /** @type {Map<string, object>} */
  const byKey = new Map();
  const order = [];

  function publicEvent(row) {
    const catalog = ACTIVITY_CATALOG[row.key];
    return {
      id: row.id,
      key: row.key,
      phase: catalog.phase,
      label: formatLabel(row.key, row.meta),
      status: row.status,
      at: row.at,
      elapsedMs: row.elapsedMs,
      ...(row.meta ? { meta: row.meta } : {}),
    };
  }

  function upsert(key, status, meta) {
    assertKnownKey(key);
    const safeMeta = sanitizeMeta(meta);
    const existing = byKey.get(key);
    const now = Date.now();
    if (existing) {
      existing.status = status;
      existing.at = new Date(now).toISOString();
      existing.elapsedMs = now - startedAt;
      if (safeMeta) existing.meta = { ...existing.meta, ...safeMeta };
      const event = publicEvent(existing);
      try {
        onEvent?.(event);
      } catch {
        // UI streaming must never fail the turn.
      }
      return event;
    }
    const row = {
      id: crypto.randomUUID(),
      key,
      status,
      at: new Date(now).toISOString(),
      elapsedMs: now - startedAt,
      meta: safeMeta,
    };
    byKey.set(key, row);
    order.push(key);
    const event = publicEvent(row);
    try {
      onEvent?.(event);
    } catch {
      // ignore
    }
    return event;
  }

  function completeActiveExcept(keepKey = null) {
    for (const key of order) {
      if (keepKey && key === keepKey) continue;
      const row = byKey.get(key);
      if (row?.status === ACTIVITY_STATUS.ACTIVE) {
        upsert(key, ACTIVITY_STATUS.COMPLETED, row.meta);
      }
    }
  }

  return {
    start(key, meta) {
      completeActiveExcept(key);
      return upsert(key, ACTIVITY_STATUS.ACTIVE, meta);
    },
    complete(key, meta) {
      if (!byKey.has(key) && ACTIVITY_CATALOG[key]) {
        upsert(key, ACTIVITY_STATUS.COMPLETED, meta);
        return;
      }
      return upsert(key, ACTIVITY_STATUS.COMPLETED, meta);
    },
    fail(key, meta) {
      return upsert(key, ACTIVITY_STATUS.FAILED, meta);
    },
    /** Snapshot for API / tests — never includes private reasoning. */
    list() {
      return order.map((key) => publicEvent(byKey.get(key)));
    },
    startedAt,
  };
}

function formatLabel(key, meta) {
  const base = ACTIVITY_CATALOG[key].label;
  if (key === "COORDINATING_AGENT" && meta?.agentName) {
    return `Coordinating ${meta.agentName}`;
  }
  if (key === "RUNNING_ANALYSIS" && meta?.toolName) {
    return `Running ${meta.toolName} analysis`;
  }
  if (key === "GATHERING_INFORMATION" && meta?.toolName === "web_search") {
    return "Gathering information";
  }
  return base;
}

/** Reject any free-form / CoT-looking payload before it reaches the UI. */
export function assertSafeActivityEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (!ACTIVITY_CATALOG[event.key]) return false;
  if (event.phase !== ACTIVITY_CATALOG[event.key].phase) return false;
  const label = String(event.label || "");
  // Block long prose / reasoning-shaped labels.
  if (label.length > 120) return false;
  if (/\b(i think|because|reason|chain of thought|let me)\b/i.test(label)) return false;
  return true;
}

export function activityKeyForTool(toolName) {
  const name = String(toolName || "").trim();
  return TOOL_ACTIVITY_KEYS[name] || null;
}
