import crypto from "crypto";

import { withUserContext } from "../db/prisma.js";
import { AgentError } from "../agents/errors.js";
import { decryptJson, encryptJson } from "../security/envelope.js";
import { isCeoObservabilityEnabled } from "./observability.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Plan Store — durable executive memory (Phase 2B).
//
// Plan answers: "What are we trying to accomplish?"
// Execution (tools / runs / validated system state) answers: "What happened?"
//
// Plans never contain required next questions, conversation order, branching,
// tool permissions, or execution authority. The CEO decides actions from Plan.
// ─────────────────────────────────────────────────────────────────────────────

export const PLAN_BODY_VERSION = 1;
export const PLAN_STATUSES = Object.freeze(["ACTIVE", "WAITING", "COMPLETED", "ABANDONED"]);
export const PLAN_CONFIDENCE = Object.freeze(["low", "medium", "high"]);
export const DEFAULT_MISSION_SCOPE = "default";

const MAX_TITLE = 120;
const MAX_STRING = 500;
const MAX_REASON = 300;
const MAX_KNOWN = 20;
const MAX_ASSUMPTIONS = 12;
const MAX_CONSTRAINTS = 12;
const MAX_RELEVANT_CONTEXT = 12;
const MAX_PREFERENCES = 20;
const MAX_DECISIONS = 40;
const MAX_OPEN_ITEMS = 20;
const MAX_ACTIONS = 40;
const MAX_CHANGE_LOG = 50;
const MAX_OPS_PER_UPDATE = 20;

/** Ops the LLM may propose. Unknown ops are rejected (fail closed). */
export const ALLOWED_PLAN_OPS = Object.freeze([
  "set_objective",
  "set_status",
  "set_horizon",
  "add_known",
  "add_assumption",
  "add_constraint",
  "add_relevant_context",
  "remove_situation",
  "add_decision",
  "add_open_item",
  "resolve_open_item",
  "add_action",
  "complete_action",
  "fail_action",
  "record_preference",
  "remove_preference",
  "note",
]);

/** Explicitly blocked — never store workflow/execution authority in Plan. */
export const BLOCKED_PLAN_OPS = Object.freeze([
  "set_permissions",
  "grant_permission",
  "create_capability",
  "set_tool_permission",
  "set_execution_authority",
  "set_next_question",
  "set_required_question",
  "set_branch",
  "set_workflow",
  "mark_done",
  "claim_complete",
  "replace_body",
]);

const BLOCKED_BODY_KEYS = Object.freeze([
  "permissions",
  "toolPermissions",
  "executionAuthority",
  "requiredNextQuestion",
  "nextQuestion",
  "selectedQuestion",
  "workflow",
  "branches",
  "missionKind",
]);

export function normalizeMissionScope(scope) {
  const raw = String(scope || "").trim().toLowerCase();
  if (!raw || raw === "primary" || raw === "default") return DEFAULT_MISSION_SCOPE;
  return raw.slice(0, 80);
}

export function normalizeObjectiveKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function nowIso() {
  return new Date().toISOString();
}

function clip(text, max = MAX_STRING) {
  return String(text || "").trim().slice(0, max);
}

function newId() {
  return crypto.randomUUID();
}

export function emptyPlanBody({ objective, confidence = "medium", createdAt = nowIso() } = {}) {
  const text = clip(objective, MAX_STRING);
  return {
    v: PLAN_BODY_VERSION,
    objective: {
      text,
      confidence: PLAN_CONFIDENCE.includes(confidence) ? confidence : "medium",
      createdAt,
      updatedAt: createdAt,
    },
    situation: {
      known: [],
      assumptions: [],
      constraints: [],
      relevantContext: [],
      preferences: [],
    },
    decisions: [],
    openItems: [],
    actions: [],
    changeLog: [],
  };
}

export function assertPlanBodySafe(body) {
  if (!body || typeof body !== "object") {
    throw new AgentError("Plan body must be an object.", "INVALID_PLAN", 400);
  }
  for (const key of BLOCKED_BODY_KEYS) {
    if (key in body) {
      throw new AgentError(
        `Plan must not contain workflow/execution field "${key}".`,
        "PLAN_FORBIDDEN_FIELD",
        400
      );
    }
  }
  if (body.v !== PLAN_BODY_VERSION) {
    throw new AgentError("Unsupported Plan body version.", "INVALID_PLAN", 400);
  }
}

function pushUnique(list, text, max) {
  const value = clip(text);
  if (!value) return { changed: false };
  const key = value.toLowerCase();
  if (list.some((item) => String(item).toLowerCase() === key)) {
    return { changed: false };
  }
  if (list.length >= max) {
    throw new AgentError(`Plan list exceeds cap (${max}).`, "PLAN_CAP", 400);
  }
  list.push(value);
  return { changed: true, value };
}

function appendChangeLog(body, op, summary, reason) {
  body.changeLog.unshift({
    at: nowIso(),
    op,
    summary: clip(summary, 240),
    reason: reason ? clip(reason, MAX_REASON) : undefined,
  });
  if (body.changeLog.length > MAX_CHANGE_LOG) {
    body.changeLog.length = MAX_CHANGE_LOG;
  }
}

function findAction(body, id) {
  return body.actions.find((a) => a.id === id) || null;
}

function findOpenItem(body, id) {
  return body.openItems.find((item) => item.id === id) || null;
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  const kind = String(evidence.kind || "").trim();
  if (!["tool_result", "execution_record", "system_state"].includes(kind)) return null;
  const summary = clip(evidence.summary, MAX_STRING);
  if (!summary) return null;
  return {
    kind,
    summary,
    ref: evidence.ref ? clip(evidence.ref, 120) : undefined,
  };
}

/**
 * Sanitize model-proposed ops. Drops malformed entries; does not apply them.
 */
export function sanitizePlanOps(ops) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  for (const raw of ops.slice(0, MAX_OPS_PER_UPDATE)) {
    if (!raw || typeof raw !== "object") continue;
    const op = String(raw.op || "").trim();
    if (!op) continue;
    if (BLOCKED_PLAN_OPS.includes(op)) {
      out.push({ op, __blocked: true });
      continue;
    }
    if (!ALLOWED_PLAN_OPS.includes(op)) {
      out.push({ op, __unknown: true });
      continue;
    }
    out.push({ ...raw, op });
  }
  return out;
}

/**
 * Validate + apply ops to a Plan body. Returns { ok, body, fieldsChanged, errors }.
 * Never mutates the input body.
 */
export function validateAndApplyOps(inputBody, ops, { reason } = {}) {
  const errors = [];
  const fieldsChanged = [];
  const updateReason = clip(reason, MAX_REASON);
  if (!updateReason) {
    return {
      ok: false,
      body: null,
      fieldsChanged: [],
      errors: ["update_plan requires a non-empty reason (anti-thrash)."],
    };
  }

  let body;
  try {
    body = structuredClone(inputBody);
    assertPlanBodySafe(body);
  } catch (error) {
    return { ok: false, body: null, fieldsChanged: [], errors: [error.message] };
  }

  const sanitized = sanitizePlanOps(ops);
  if (!sanitized.length) {
    return {
      ok: false,
      body: null,
      fieldsChanged: [],
      errors: ["No valid Plan ops provided."],
    };
  }

  for (const raw of sanitized) {
    if (raw.__blocked) {
      errors.push(`Blocked Plan op: ${raw.op} (Plan cannot grant execution authority).`);
      continue;
    }
    if (raw.__unknown) {
      errors.push(`Unknown Plan op: ${raw.op}`);
      continue;
    }

    try {
      const changed = applyOneOp(body, raw);
      if (changed) {
        fieldsChanged.push(changed);
        appendChangeLog(body, raw.op, changed, updateReason);
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  if (errors.length) {
    return { ok: false, body: null, fieldsChanged: [], errors };
  }
  if (!fieldsChanged.length) {
    return {
      ok: false,
      body: null,
      fieldsChanged: [],
      errors: ["No meaningful Plan changes (rejected to prevent thrashing)."],
    };
  }

  assertPlanBodySafe(body);
  return { ok: true, body, fieldsChanged, errors: [] };
}

function applyOneOp(body, raw) {
  switch (raw.op) {
    case "set_objective": {
      const text = clip(raw.text);
      if (!text) throw new AgentError("set_objective requires text.", "INVALID_PLAN_OP", 400);
      const confidence = PLAN_CONFIDENCE.includes(raw.confidence) ? raw.confidence : body.objective.confidence;
      const same =
        body.objective.text === text && body.objective.confidence === confidence;
      if (same) return null;
      body.objective.text = text;
      body.objective.confidence = confidence;
      body.objective.updatedAt = nowIso();
      return `objective → ${text.slice(0, 80)} (${confidence})`;
    }
    case "set_status": {
      const status = String(raw.status || "").trim().toUpperCase();
      if (!PLAN_STATUSES.includes(status)) {
        throw new AgentError(`Invalid Plan status: ${status}`, "INVALID_PLAN_OP", 400);
      }
      // Status is row-level; body op only records intent for changeLog when used
      // through updatePlan which syncs row.status. Marker field for apply layer.
      body.__pendingStatus = status;
      return `status → ${status}`;
    }
    case "set_horizon": {
      const horizon = String(raw.horizon || "").trim().toLowerCase();
      if (horizon && !["weeks", "months", "quarters"].includes(horizon)) {
        throw new AgentError("horizon must be weeks|months|quarters.", "INVALID_PLAN_OP", 400);
      }
      body.__pendingHorizon = horizon || null;
      return `horizon → ${horizon || "(cleared)"}`;
    }
    case "add_known":
      return pushUnique(body.situation.known, raw.text, MAX_KNOWN).changed
        ? `known + ${clip(raw.text, 80)}`
        : null;
    case "add_assumption":
      return pushUnique(body.situation.assumptions, raw.text, MAX_ASSUMPTIONS).changed
        ? `assumption + ${clip(raw.text, 80)}`
        : null;
    case "add_constraint":
      return pushUnique(body.situation.constraints, raw.text, MAX_CONSTRAINTS).changed
        ? `constraint + ${clip(raw.text, 80)}`
        : null;
    case "add_relevant_context":
      return pushUnique(body.situation.relevantContext, raw.text, MAX_RELEVANT_CONTEXT).changed
        ? `relevantContext + ${clip(raw.text, 80)}`
        : null;
    case "record_preference":
      return pushUnique(body.situation.preferences, raw.text, MAX_PREFERENCES).changed
        ? `preference + ${clip(raw.text, 80)}`
        : null;
    case "remove_preference": {
      const target = clip(raw.text).toLowerCase();
      const before = body.situation.preferences.length;
      body.situation.preferences = body.situation.preferences.filter(
        (p) => String(p).toLowerCase() !== target
      );
      return before !== body.situation.preferences.length
        ? `preference - ${clip(raw.text, 80)}`
        : null;
    }
    case "remove_situation": {
      const field = String(raw.field || "").trim();
      const map = {
        known: "known",
        assumptions: "assumptions",
        constraints: "constraints",
        relevantContext: "relevantContext",
        preferences: "preferences",
      };
      const key = map[field];
      if (!key) throw new AgentError("remove_situation field invalid.", "INVALID_PLAN_OP", 400);
      const target = clip(raw.text).toLowerCase();
      const before = body.situation[key].length;
      body.situation[key] = body.situation[key].filter((p) => String(p).toLowerCase() !== target);
      return before !== body.situation[key].length ? `${key} - ${clip(raw.text, 80)}` : null;
    }
    case "add_decision": {
      const text = clip(raw.text);
      const rationale = clip(raw.rationale);
      const by = raw.by === "ceo" ? "ceo" : "user";
      if (!text || !rationale) {
        throw new AgentError("add_decision requires text and rationale.", "INVALID_PLAN_OP", 400);
      }
      if (body.decisions.length >= MAX_DECISIONS) {
        throw new AgentError("Too many decisions on Plan.", "PLAN_CAP", 400);
      }
      body.decisions.push({ id: newId(), text, by, rationale, at: nowIso() });
      return `decision + ${text.slice(0, 80)}`;
    }
    case "add_open_item": {
      const text = clip(raw.text);
      const kind = String(raw.kind || "").trim();
      if (!text || !["question", "blocker", "dependency"].includes(kind)) {
        throw new AgentError(
          "add_open_item requires kind question|blocker|dependency and text.",
          "INVALID_PLAN_OP",
          400
        );
      }
      // Memory only — never a forced next question / interview script.
      if (body.openItems.length >= MAX_OPEN_ITEMS) {
        throw new AgentError("Too many open items on Plan.", "PLAN_CAP", 400);
      }
      body.openItems.push({ id: newId(), kind, text, createdAt: nowIso() });
      return `openItem(${kind}) + ${text.slice(0, 80)}`;
    }
    case "resolve_open_item": {
      const id = String(raw.id || "").trim();
      const item = findOpenItem(body, id);
      if (!item) throw new AgentError("open item not found.", "INVALID_PLAN_OP", 400);
      body.openItems = body.openItems.filter((x) => x.id !== id);
      return `openItem resolved ${id.slice(0, 8)}`;
    }
    case "add_action": {
      const text = clip(raw.text);
      if (!text) throw new AgentError("add_action requires text.", "INVALID_PLAN_OP", 400);
      const owner = ["user", "ceo", "agent"].includes(raw.owner) ? raw.owner : "ceo";
      if (body.actions.length >= MAX_ACTIONS) {
        throw new AgentError("Too many actions on Plan.", "PLAN_CAP", 400);
      }
      // Planned only — completion requires execution evidence later.
      body.actions.push({
        id: newId(),
        text,
        owner,
        status: "planned",
        createdAt: nowIso(),
      });
      return `action planned + ${text.slice(0, 80)}`;
    }
    case "complete_action": {
      const id = String(raw.id || "").trim();
      const action = findAction(body, id);
      if (!action) throw new AgentError("action not found.", "INVALID_PLAN_OP", 400);
      if (action.status === "completed") return null;
      const evidence = validateEvidence(raw.evidence);
      if (!evidence) {
        throw new AgentError(
          "complete_action requires execution evidence (tool_result | execution_record | system_state).",
          "PLAN_EVIDENCE_REQUIRED",
          400
        );
      }
      action.status = "completed";
      action.completedAt = nowIso();
      action.evidence = evidence;
      delete action.failureReason;
      return `action completed ${id.slice(0, 8)} via ${evidence.kind}`;
    }
    case "fail_action": {
      const id = String(raw.id || "").trim();
      const action = findAction(body, id);
      if (!action) throw new AgentError("action not found.", "INVALID_PLAN_OP", 400);
      const evidence = validateEvidence(raw.evidence);
      if (!evidence) {
        throw new AgentError(
          "fail_action requires execution evidence (tool_result | execution_record | system_state).",
          "PLAN_EVIDENCE_REQUIRED",
          400
        );
      }
      action.status = "failed";
      action.completedAt = nowIso();
      action.evidence = evidence;
      action.failureReason = clip(raw.reason || evidence.summary);
      return `action failed ${id.slice(0, 8)} via ${evidence.kind}`;
    }
    case "note": {
      const summary = clip(raw.summary);
      if (!summary) throw new AgentError("note requires summary.", "INVALID_PLAN_OP", 400);
      return `note: ${summary.slice(0, 80)}`;
    }
    default:
      throw new AgentError(`Unknown Plan op: ${raw.op}`, "INVALID_PLAN_OP", 400);
  }
}

export function decodePlanRow(row) {
  if (!row) return null;
  const body = decryptJson(row.contentCiphertext);
  assertPlanBodySafe(body);
  // Strip any pending markers if somehow persisted
  delete body.__pendingStatus;
  delete body.__pendingHorizon;
  return { row, body };
}

export function toActiveMissionFromPlan(row, body) {
  const planned = (body.actions || []).filter((a) => a.status === "planned").slice(0, 8);
  const recentDecisions = (body.decisions || []).slice(-5);
  const openItems = (body.openItems || []).slice(0, 10);
  return {
    authority: "plan",
    judgmentOwner: "llm_plus_world_model",
    planId: row.id,
    status: row.status,
    missionScope: normalizeMissionScope(row.missionScope),
    mission: body.objective?.text || row.title,
    confidence: body.objective?.confidence || "medium",
    objectiveCreatedAt: body.objective?.createdAt || row.createdAt,
    known: body.situation?.known || [],
    assumptions: body.situation?.assumptions || [],
    constraints: body.situation?.constraints || [],
    preferences: body.situation?.preferences || [],
    decisions: recentDecisions,
    openItems,
    plannedActions: planned,
    // Explicitly absent sketcher / workflow fields
    missionKind: null,
    missionExecutable: null,
    selectedQuestion: null,
    missing: [],
  };
}

export function renderPlanMission(activeMission) {
  if (!activeMission || activeMission.authority !== "plan") {
    return "(no active plan)";
  }
  const lines = [
    "authority: plan",
    "role: durable_executive_memory",
    `plan_id: ${activeMission.planId}`,
    `status: ${activeMission.status}`,
    `mission_scope: ${activeMission.missionScope || DEFAULT_MISSION_SCOPE}`,
    `objective: ${activeMission.mission || "(unset)"}`,
    `confidence: ${activeMission.confidence || "medium"}`,
    "note: Plan is memory of intent — not a workflow, interview script, or proof of execution. You decide next actions. Completion requires tool/execution evidence, not Plan alone.",
  ];
  if (activeMission.known?.length) {
    lines.push(`situation.known: ${activeMission.known.slice(0, 8).join("; ")}`);
  }
  if (activeMission.assumptions?.length) {
    lines.push(`situation.assumptions: ${activeMission.assumptions.slice(0, 6).join("; ")}`);
  }
  if (activeMission.constraints?.length) {
    lines.push(`situation.constraints: ${activeMission.constraints.slice(0, 6).join("; ")}`);
  }
  if (activeMission.preferences?.length) {
    lines.push(`preferences: ${activeMission.preferences.slice(0, 6).join("; ")}`);
  }
  if (activeMission.openItems?.length) {
    lines.push(
      `open_items: ${activeMission.openItems
        .map((i) => `[${i.kind}] ${i.text}`)
        .slice(0, 8)
        .join("; ")}`
    );
  }
  if (activeMission.plannedActions?.length) {
    lines.push(
      `planned_actions: ${activeMission.plannedActions
        .map((a) => `${a.text} (${a.owner})`)
        .join("; ")}`
    );
  }
  if (activeMission.decisions?.length) {
    lines.push(
      `recent_decisions: ${activeMission.decisions
        .map((d) => `${d.text} [${d.by}]`)
        .join("; ")}`
    );
  }
  return lines.join("\n");
}

export function logPlanEvent(event = {}) {
  if (!isCeoObservabilityEnabled()) return;
  const payload = {
    phase: "plan",
    event: event.event || "plan_event",
    planId: event.planId || null,
    status: event.status || null,
    missionScope: event.missionScope || null,
    fieldsChanged: Array.isArray(event.fieldsChanged) ? event.fieldsChanged : [],
    validationErrors: Array.isArray(event.validationErrors)
      ? event.validationErrors.map((e) => String(e).slice(0, 200))
      : [],
    reasonPresent: Boolean(event.reason),
    confidence: event.confidence || null,
    // Never log encrypted or decrypted Plan contents.
  };
  console.info(`[ceo-observability] ${JSON.stringify(payload)}`);
}

function titleFromObjective(objective) {
  const text = clip(objective, MAX_TITLE);
  return text || "Untitled plan";
}

function objectivesSimilar(a, b) {
  const left = normalizeObjectiveKey(a);
  const right = normalizeObjectiveKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 24 && right.includes(left)) return true;
  if (right.length >= 24 && left.includes(right)) return true;
  // Token overlap for near-duplicates
  const leftTokens = new Set(left.split(" ").filter((t) => t.length > 2));
  const rightTokens = right.split(" ").filter((t) => t.length > 2);
  if (leftTokens.size < 3 || rightTokens.length < 3) return false;
  const overlap = rightTokens.filter((t) => leftTokens.has(t)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.length) >= 0.75;
}

async function listActivePlans(tx, userId) {
  return tx.plan.findMany({
    where: { userId, status: "ACTIVE" },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Load the primary ACTIVE plan for dual-read ACTIVE MISSION.
 * Prefers missionScope=default; otherwise most recently updated ACTIVE.
 */
export async function loadPrimaryActivePlan(userId) {
  return withUserContext(userId, async (tx) => {
    const active = await listActivePlans(tx, userId);
    if (!active.length) return null;
    const primary =
      active.find((p) => normalizeMissionScope(p.missionScope) === DEFAULT_MISSION_SCOPE) ||
      active[0];
    try {
      return decodePlanRow(primary);
    } catch {
      logPlanEvent({
        event: "plan_decode_failed",
        planId: primary.id,
        status: primary.status,
        validationErrors: ["decode_failed"],
      });
      return null;
    }
  });
}

export async function getPlan({ userId, planId = null }) {
  return withUserContext(userId, async (tx) => {
    let row;
    if (planId) {
      row = await tx.plan.findFirst({ where: { id: planId, userId } });
    } else {
      const active = await listActivePlans(tx, userId);
      row =
        active.find((p) => normalizeMissionScope(p.missionScope) === DEFAULT_MISSION_SCOPE) ||
        active[0] ||
        null;
    }
    if (!row) {
      return { ok: false, error: "No Plan found.", code: "PLAN_NOT_FOUND" };
    }
    const decoded = decodePlanRow(row);
    return {
      ok: true,
      plan: publicPlanView(decoded.row, decoded.body),
    };
  });
}

function publicPlanView(row, body) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    missionScope: normalizeMissionScope(row.missionScope),
    horizon: row.horizon || null,
    sourceConversationId: row.sourceConversationId || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastReviewedAt: row.lastReviewedAt,
    objective: body.objective,
    situation: body.situation,
    decisions: body.decisions,
    openItems: body.openItems,
    actions: body.actions,
    changeLog: body.changeLog.slice(0, 10),
    // Explicit non-authority markers for the model
    grantsExecutionAuthority: false,
    grantsToolPermissions: false,
    isWorkflow: false,
  };
}

/**
 * Create a Plan from durable intent. Rejects near-duplicate ACTIVE plans in
 * the same mission scope; independent scopes require independent=true.
 */
export async function createPlan({
  userId,
  objective,
  confidence = "medium",
  title = null,
  missionScope = DEFAULT_MISSION_SCOPE,
  independent = false,
  horizon = null,
  sourceConversationId = null,
  reason = "durable_intent",
}) {
  const objectiveText = clip(objective);
  if (!objectiveText) {
    logPlanEvent({ event: "plan_validation_failed", validationErrors: ["empty_objective"] });
    throw new AgentError("create_plan requires a non-empty objective.", "INVALID_ARGUMENT", 400);
  }

  const scope = normalizeMissionScope(missionScope);
  const body = emptyPlanBody({ objective: objectiveText, confidence });
  appendChangeLog(body, "create_plan", `created: ${objectiveText.slice(0, 80)}`, reason);

  return withUserContext(userId, async (tx) => {
    const active = await listActivePlans(tx, userId);

    for (const existing of active) {
      let existingBody;
      try {
        existingBody = decryptJson(existing.contentCiphertext);
      } catch {
        continue;
      }
      const existingScope = normalizeMissionScope(existing.missionScope);
      const similar = objectivesSimilar(existingBody?.objective?.text || existing.title, objectiveText);

      if (existingScope === scope) {
        // Same scope: never create a duplicate ACTIVE plan — return existing.
        logPlanEvent({
          event: "plan_create_deduped",
          planId: existing.id,
          status: existing.status,
          missionScope: scope,
          fieldsChanged: [],
        });
        return {
          ok: true,
          created: false,
          deduped: true,
          plan: publicPlanView(existing, existingBody),
          result: "An ACTIVE Plan already exists for this mission scope — updated context reused instead of creating a duplicate.",
        };
      }

      if (similar && !independent) {
        logPlanEvent({
          event: "plan_create_rejected_similar",
          planId: existing.id,
          status: existing.status,
          missionScope: existingScope,
          validationErrors: ["similar_active_plan"],
        });
        return {
          ok: false,
          created: false,
          error:
            "A similar ACTIVE Plan already exists. Update that Plan, or pass independent=true with a distinct missionScope for a clearly separate objective.",
          code: "PLAN_DUPLICATE",
          plan: publicPlanView(existing, existingBody),
        };
      }
    }

    // Enforce one ACTIVE per (userId, missionScope)
    const sameScopeActive = active.filter(
      (p) => normalizeMissionScope(p.missionScope) === scope
    );
    if (sameScopeActive.length) {
      const existing = sameScopeActive[0];
      const existingBody = decryptJson(existing.contentCiphertext);
      return {
        ok: true,
        created: false,
        deduped: true,
        plan: publicPlanView(existing, existingBody),
        result: "ACTIVE Plan already exists for this scope.",
      };
    }

    if (horizon && !["weeks", "months", "quarters"].includes(String(horizon))) {
      throw new AgentError("horizon must be weeks|months|quarters.", "INVALID_ARGUMENT", 400);
    }

    const row = await tx.plan.create({
      data: {
        userId,
        title: clip(title || titleFromObjective(objectiveText), MAX_TITLE),
        status: "ACTIVE",
        contentCiphertext: encryptJson(body),
        missionScope: scope === DEFAULT_MISSION_SCOPE ? null : scope,
        horizon: horizon || null,
        sourceConversationId: sourceConversationId || null,
        lastReviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logPlanEvent({
      event: "plan_created",
      planId: row.id,
      status: row.status,
      missionScope: scope,
      confidence: body.objective.confidence,
      reason: true,
      fieldsChanged: ["objective", "status"],
    });

    return {
      ok: true,
      created: true,
      deduped: false,
      plan: publicPlanView(row, body),
      result: `Plan created (${row.id}).`,
    };
  });
}

export async function updatePlan({
  userId,
  planId = null,
  ops,
  reason,
}) {
  const updateReason = clip(reason, MAX_REASON);
  if (!updateReason) {
    logPlanEvent({
      event: "plan_validation_failed",
      validationErrors: ["missing_reason"],
    });
    return {
      ok: false,
      error: "update_plan requires a non-empty reason.",
      code: "PLAN_REASON_REQUIRED",
    };
  }

  return withUserContext(userId, async (tx) => {
    let row;
    if (planId) {
      row = await tx.plan.findFirst({ where: { id: planId, userId } });
    } else {
      const active = await listActivePlans(tx, userId);
      row =
        active.find((p) => normalizeMissionScope(p.missionScope) === DEFAULT_MISSION_SCOPE) ||
        active[0] ||
        null;
    }
    if (!row) {
      return { ok: false, error: "No Plan found to update.", code: "PLAN_NOT_FOUND" };
    }

    let body;
    try {
      body = decryptJson(row.contentCiphertext);
      assertPlanBodySafe(body);
    } catch (error) {
      logPlanEvent({
        event: "plan_validation_failed",
        planId: row.id,
        validationErrors: [error.message],
      });
      return { ok: false, error: "Plan body could not be decoded.", code: "INVALID_PLAN" };
    }

    const applied = validateAndApplyOps(body, ops, { reason: updateReason });
    if (!applied.ok) {
      logPlanEvent({
        event: "plan_validation_failed",
        planId: row.id,
        status: row.status,
        validationErrors: applied.errors,
        reason: true,
      });
      return {
        ok: false,
        error: applied.errors.join(" "),
        code: "PLAN_UPDATE_REJECTED",
        validationErrors: applied.errors,
      };
    }

    const nextBody = applied.body;
    const pendingStatus = nextBody.__pendingStatus;
    const pendingHorizon = nextBody.__pendingHorizon;
    delete nextBody.__pendingStatus;
    delete nextBody.__pendingHorizon;

    if (pendingStatus && pendingStatus !== row.status) {
      if (pendingStatus === "ACTIVE") {
        const scope = normalizeMissionScope(row.missionScope);
        const others = await listActivePlans(tx, userId);
        const conflict = others.find(
          (p) => p.id !== row.id && normalizeMissionScope(p.missionScope) === scope
        );
        if (conflict) {
          return {
            ok: false,
            error: "Another ACTIVE Plan already exists for this mission scope.",
            code: "PLAN_ACTIVE_CONFLICT",
          };
        }
      }
    }

    // If objective text changed, refresh plaintext title.
    const nextTitle = nextBody.objective?.text
      ? clip(nextBody.objective.text, MAX_TITLE)
      : row.title;

    const updated = await tx.plan.update({
      where: { id: row.id },
      data: {
        title: nextTitle,
        status: pendingStatus || row.status,
        horizon: pendingHorizon !== undefined ? pendingHorizon : row.horizon,
        contentCiphertext: encryptJson(nextBody),
        lastReviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    logPlanEvent({
      event: "plan_updated",
      planId: updated.id,
      status: updated.status,
      missionScope: normalizeMissionScope(updated.missionScope),
      fieldsChanged: applied.fieldsChanged,
      confidence: nextBody.objective?.confidence,
      reason: true,
    });

    return {
      ok: true,
      plan: publicPlanView(updated, nextBody),
      fieldsChanged: applied.fieldsChanged,
      result: `Plan updated (${applied.fieldsChanged.length} change(s)).`,
    };
  });
}
