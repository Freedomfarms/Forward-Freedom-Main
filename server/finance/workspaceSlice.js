// Workspace plan slice. Same allowlist the CEO world model already returns.
// Decrypt and sanitize happen here; the raw blob is never part of the result.
// This module does not import an agent, a model, or CHIEF.

import { withUserContext } from "../db/prisma.js";
import { getSchemaCapabilities } from "../db/schemaCapabilities.js";
import { decryptJson } from "../security/envelope.js";
import { sanitizeWorkspaceStateForPersistence } from "../../src/utils/workspacePersistence.js";

export const STORED_METRIC_KEYS = Object.freeze([
  "trueCash",
  "liquidCash",
  "creditCardDebt",
  "reserves",
  "capturedAt",
  "asOf",
  "date",
  "month",
  "year",
]);

const LABEL_MAX_CHARS = 80;
const LABEL_MAX_ENTRIES = 40;

export function summarizeStoredMetricSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { status: "unavailable_server_summary" };
  }
  // Pass through only already-stored numeric/summary fields — do not recompute.
  const out = {};
  for (const key of STORED_METRIC_KEYS) {
    if (snapshot[key] == null) continue;
    const value = snapshot[key];
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return {
    status: Object.keys(out).length ? "available" : "unavailable_server_summary",
    fields: out,
    fieldNames: Object.keys(out),
  };
}

export function uniqueLabels(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const label = String(value || "").trim();
    if (!label || label.length > LABEL_MAX_CHARS) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= LABEL_MAX_ENTRIES) break;
  }
  return out;
}

function emptySlice({ hasSnapshot, updatedAt = null, parseError = false }) {
  return {
    status: "available",
    hasSnapshot,
    updatedAt,
    ...(parseError ? { parseError: true } : {}),
    workspaceUserCount: 0,
    budgetRowCount: 0,
    budgetCategoryLabels: [],
    incomeStreamCount: 0,
    incomeStreamLabels: [],
    objectiveCount: 0,
    planYears: [],
    storedMetricSnapshots: { status: "unavailable_server_summary", count: 0 },
  };
}

export function sliceSanitizedWorkspace(state, snapshot) {
  const updatedAt = snapshot?.updatedAt ? new Date(snapshot.updatedAt).toISOString() : null;
  if (!state || typeof state !== "object") {
    return emptySlice({ hasSnapshot: true, updatedAt, parseError: true });
  }

  const users = Array.isArray(state.users) ? state.users : [];
  const activeUser = users.find((u) => u?.id && u.id === state.activeUserId) || users[0] || null;

  const budgetRows = Array.isArray(activeUser?.budgetRows) ? activeUser.budgetRows : [];
  const incomeStreams = Array.isArray(activeUser?.incomeStreams) ? activeUser.incomeStreams : [];
  const objectives = Array.isArray(activeUser?.objectives) ? activeUser.objectives : [];
  const plansByYear =
    activeUser?.plansByYear && typeof activeUser.plansByYear === "object"
      ? activeUser.plansByYear
      : {};
  const metricSnapshots = Array.isArray(activeUser?.metricSnapshots)
    ? activeUser.metricSnapshots
    : [];
  const latestMetric = metricSnapshots.length ? metricSnapshots[metricSnapshots.length - 1] : null;

  return {
    status: "available",
    hasSnapshot: true,
    updatedAt,
    source: snapshot?.source || null,
    workspaceUserCount: users.length,
    activeUserPresent: Boolean(activeUser),
    budgetRowCount: budgetRows.length,
    budgetCategoryLabels: uniqueLabels(
      budgetRows.map((row) => row?.name || row?.category || row?.label)
    ),
    incomeStreamCount: incomeStreams.length,
    incomeStreamLabels: uniqueLabels(incomeStreams.map((row) => row?.name || row?.label)),
    objectiveCount: objectives.length,
    planYears: Object.keys(plansByYear).map(String).sort(),
    storedMetricSnapshots: latestMetric
      ? {
          status: "available",
          count: metricSnapshots.length,
          latest: summarizeStoredMetricSnapshot(latestMetric),
        }
      : { status: "unavailable_server_summary", count: 0 },
  };
}

/**
 * User-scoped decrypt of WorkspaceSnapshot. The sanitized state is returned to
 * server callers. It is not a tool payload.
 */
export async function loadSanitizedWorkspaceState(
  userId,
  {
    withUser = withUserContext,
    getCapabilities = getSchemaCapabilities,
    decryptState = decryptJson,
    sanitize = sanitizeWorkspaceStateForPersistence,
  } = {}
) {
  if (!userId) {
    return { state: null, snapshot: null, reason: "missing_user" };
  }

  const caps = await getCapabilities().catch(() => ({ encryptionColumns: true }));
  const snapshot = await withUser(userId, async (tx) => {
    if (caps.encryptionColumns !== false) {
      return tx.workspaceSnapshot.findUnique({ where: { userId } });
    }
    return tx.workspaceSnapshot.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        state: true,
        source: true,
        lastClientUpdatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  if (!snapshot) return { state: null, snapshot: null };

  let state;
  try {
    const decoded =
      snapshot.stateCiphertext != null
        ? decryptState(snapshot.stateCiphertext)
        : (snapshot.state ?? null);
    state = sanitize(decoded);
  } catch {
    state = null;
  }

  if (!state || typeof state !== "object") {
    return { state: null, snapshot, parseError: true };
  }
  return { state, snapshot, parseError: false };
}

/**
 * User-scoped read of WorkspaceSnapshot. Returns the existing world-model slice.
 * The decrypted blob is sanitized, then reduced. It is not returned.
 */
export async function loadWorkspacePlanSummary(userId, options = {}) {
  if (!userId) {
    return { status: "unavailable_server_summary", reason: "missing_user" };
  }

  try {
    const loaded = await loadSanitizedWorkspaceState(userId, options);
    if (!loaded.snapshot) return emptySlice({ hasSnapshot: false });
    if (!loaded.state) {
      return emptySlice({
        hasSnapshot: true,
        updatedAt: loaded.snapshot.updatedAt
          ? new Date(loaded.snapshot.updatedAt).toISOString()
          : null,
        parseError: true,
      });
    }
    return sliceSanitizedWorkspace(loaded.state, loaded.snapshot);
  } catch (error) {
    console.warn("[workspace-slice] workspace slice failed:", error?.message || error);
    return {
      status: "unavailable_server_summary",
      reason: "load_failed",
    };
  }
}
