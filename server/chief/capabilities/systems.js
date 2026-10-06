// Read-only connected-system inventory for CHIEF Settings.
// Rows come from the capability snapshot and the control plane.
// A missing connector stays "not connected". This module does not grant access.

import { CONTROL_PLANE, ControlStatus } from "../control/plane.js";

const GROUPS = Object.freeze([
  Object.freeze({
    id: "freedom-financial",
    name: "Freedom Financial",
    note: "Module 02",
    ids: Object.freeze(["finance:read", "workspace:read"]),
  }),
  Object.freeze({
    id: "web-search",
    name: "Web Search",
    ids: Object.freeze(["web:read"]),
  }),
  Object.freeze({
    id: "codebase",
    name: "Codebase",
    ids: Object.freeze(["code:read"]),
  }),
]);

function rowsFor(capabilities, ids) {
  return capabilities.filter((row) => ids.includes(row.id));
}

function accessOf(rows) {
  const live = rows.filter((row) => row.availability === "ready");
  const read = live.some((row) => row.kind === "read" || row.effect === "read");
  const write = live.some(
    (row) =>
      row.kind === "action" &&
      row.effect !== "read" &&
      row.effect !== "external" &&
      (row.effect === "write" || row.effect === "destructive" || row.effect === "high_impact")
  );
  if (read && write) return "read_write";
  if (write) return "write";
  if (read) return "read";
  return "not_connected";
}

function statusOf(rows, access) {
  if (!rows.length) return "Not connected";
  if (rows.some((row) => row.availability === "unknown")) return "Unavailable";
  if (access !== "not_connected") return "Connected";
  if (rows.some((row) => row.availability === "gated")) return "Off";
  return "Not connected";
}

function detailOf(rows) {
  const gated = rows.find((row) => row.availability === "gated" && row.reason);
  if (gated) return gated.reason;
  const blocked = rows.find(
    (row) =>
      (row.availability === "unavailable" || row.availability === "not_granted") && row.reason
  );
  return blocked?.reason || "";
}

export function projectConnectedSystems(snapshot) {
  const capabilities = Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : [];
  const systems = [];
  for (const group of GROUPS) {
    const rows = rowsFor(capabilities, group.ids);
    if (!rows.length) continue;
    const access = accessOf(rows);
    const detail = [group.note, detailOf(rows)].filter(Boolean).join(". ");
    systems.push({
      id: group.id,
      name: group.name,
      status: statusOf(rows, access),
      access,
      detail,
    });
  }
  for (const connector of snapshot?.connectors ?? []) {
    if (!connector || typeof connector.id !== "string") continue;
    const rows = capabilities.filter((row) => row.connector === connector.id);
    const connected = connector.connected === true;
    const access = connected ? accessOf(rows) : "not_connected";
    systems.push({
      id: connector.id,
      name: typeof connector.label === "string" && connector.label ? connector.label : connector.id,
      status: connected && access !== "not_connected" ? "Connected" : "Not connected",
      access,
      detail: connected ? detailOf(rows) : connector.reason || "",
    });
  }
  const workforce = CONTROL_PLANE.find((entry) => entry.id === "workforce.observe");
  if (workforce?.status === ControlStatus.LIVE) {
    systems.push({
      id: "grokbot",
      name: "GrokBot",
      status: "Read only",
      access: "read",
      detail:
        "Read-only observation journal. Live agent status appears only after activity is recorded. CHIEF cannot start, stop, or edit agents.",
    });
  } else if (workforce) {
    systems.push({
      id: "grokbot",
      name: "GrokBot",
      status: "Not connected",
      access: "not_connected",
      detail: "Workforce observation is not a live CHIEF capability.",
    });
  }
  return systems;
}
