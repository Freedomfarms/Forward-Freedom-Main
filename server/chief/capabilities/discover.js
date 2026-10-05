// Read-only view of what this user can actually use.
// The model, the system prompt, and the access sheet all read this object.
// It does not grant, execute, or return credentials.

import { codeSourceAvailable } from "../resources/localCode.js";
import { defaultConnectors } from "../connectors/registry.js";
import { resolveWebSearchCredential } from "../tools/web-search.js";
import { builtInCapabilities } from "./vocabulary.js";

function policyLoaded(policy) {
  return Boolean(policy && typeof policy.check === "function");
}

function isGranted(policy, agentId, grant, resource) {
  if (!policyLoaded(policy)) return null;
  return policy.check(agentId, grant, resource) === true;
}

function exposedSet(exposedTools) {
  if (exposedTools == null) return null;
  return exposedTools instanceof Set ? exposedTools : new Set(exposedTools);
}

function applyExposure(row, exposed) {
  if (!exposed) return row;
  if (row.availability !== "ready" && row.availability !== "gated") return row;
  if (row.tools.length === 0) return row;
  if (row.tools.some((name) => exposed.has(name))) return row;
  return {
    ...row,
    availability: "not_exposed",
    reason: "Not included in this turn.",
  };
}

function rowFrom(entry, fields) {
  const confirmation = entry.confirmation === "required" ? "required" : "none";
  return {
    id: entry.id,
    kind: entry.kind,
    effect: entry.effect,
    grant: entry.grant,
    tools: fields.tools ?? [...(entry.tools ?? [])],
    confirmation,
    readOnly: entry.kind === "read",
    changes: entry.kind !== "read",
    granted: fields.granted,
    availability: fields.availability,
    reason: fields.reason ?? null,
    connector: entry.connector ?? null,
    summary: entry.summary ?? "",
  };
}

function readinessFor(entry, ctx) {
  const resource = entry.tools?.[0] || entry.id;
  const granted = isGranted(ctx.policy, ctx.agentId, entry.grant, resource);
  if (entry.readiness === "static-unavailable") {
    return rowFrom(entry, {
      granted: granted === true,
      availability: "unavailable",
      reason: entry.reason,
      tools: [],
    });
  }
  if (!ctx.policyLoaded) {
    return rowFrom(entry, { granted: null, availability: "unknown", reason: null });
  }
  if (granted !== true) {
    return rowFrom(entry, {
      granted: false,
      availability: "not_granted",
      reason: `${entry.id} is not granted for this user.`,
    });
  }
  if (entry.readiness === "code" && ctx.codeEnabled !== true) {
    return rowFrom(entry, {
      granted: true,
      availability: "unavailable",
      reason:
        "Code read is granted, but code intelligence is unavailable because no repository read credential is configured.",
    });
  }
  if (entry.readiness === "web" && ctx.webCredentialPresent !== true) {
    return rowFrom(entry, {
      granted: true,
      availability: "unavailable",
      reason:
        "Web read is granted, but web search is currently unavailable because no search credential is configured.",
    });
  }
  if (entry.readiness === "freedomFinancial") {
    if (ctx.freedomFinancialReadable === false) {
      return rowFrom(entry, {
        granted: true,
        availability: "unavailable",
        reason: "Freedom Financial access could not be read.",
      });
    }
    if (ctx.freedomFinancialRead !== true) {
      return rowFrom(entry, {
        granted: true,
        availability: "gated",
        reason:
          "The grant is on. Freedom Financial record data stays off until Freedom Financial read access is turned on.",
      });
    }
  }
  return rowFrom(entry, {
    granted: true,
    availability: "ready",
    reason: confirmationReason(entry),
  });
}

function confirmationReason(entry) {
  if (entry.confirmation !== "required") return null;
  if (entry.effect === "destructive" || entry.effect === "high_impact") {
    return "Confirmation is required for this action, including after an earlier approval in the session.";
  }
  return "Confirmation is required before this action runs.";
}

function connectorRow(connector, capability, ctx) {
  const entry = {
    id: capability.id,
    kind: capability.kind,
    effect: capability.effect,
    grant: capability.grant,
    tools: capability.tools,
    confirmation: capability.confirmation,
    connector: connector.id,
    summary: capability.reason || connector.unavailableReason,
    readiness: "connector",
  };
  const granted = isGranted(
    ctx.policy,
    ctx.agentId,
    capability.grant,
    capability.tools[0] || capability.id
  );
  if (connector.connected !== true) {
    return rowFrom(entry, {
      granted: granted === true,
      availability: "unavailable",
      reason: capability.reason || connector.unavailableReason,
      tools: [],
    });
  }
  if (!ctx.policyLoaded) {
    return rowFrom(entry, { granted: null, availability: "unknown", reason: null });
  }
  if (granted !== true) {
    return rowFrom(entry, {
      granted: false,
      availability: "not_granted",
      reason: `${capability.id} is not granted for this user.`,
    });
  }
  return rowFrom(entry, {
    granted: true,
    availability: "ready",
    reason: confirmationReason(entry),
  });
}

export function discoverCapabilities({
  policy = null,
  agentId = "chief",
  connectors = null,
  freedomFinancialRead = false,
  freedomFinancialReadable = true,
  webCredentialPresent = null,
  codeEnabled = null,
  exposedTools = null,
} = {}) {
  const activeConnectors = connectors ?? defaultConnectors();
  const ctx = {
    policy,
    policyLoaded: policyLoaded(policy),
    agentId: agentId || "chief",
    freedomFinancialRead: freedomFinancialRead === true,
    freedomFinancialReadable: freedomFinancialReadable !== false,
    webCredentialPresent:
      webCredentialPresent === null
        ? Boolean(resolveWebSearchCredential())
        : webCredentialPresent === true,
    codeEnabled: codeEnabled === null ? codeSourceAvailable() : codeEnabled === true,
  };
  const exposed = exposedSet(exposedTools);
  const capabilities = [];
  for (const entry of builtInCapabilities()) {
    capabilities.push(applyExposure(readinessFor(entry, ctx), exposed));
  }
  const connectorState = [];
  for (const connector of activeConnectors) {
    connectorState.push({
      id: connector.id,
      label: connector.label,
      connected: connector.connected === true,
      reason: connector.connected === true ? null : connector.unavailableReason,
    });
    for (const capability of connector.capabilities ?? []) {
      capabilities.push(applyExposure(connectorRow(connector, capability, ctx), exposed));
    }
  }
  return {
    agentId: ctx.agentId,
    capabilities,
    connectors: connectorState,
  };
}

export function renderCapabilityContext(snapshot, { discoverExposed = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.capabilities)) return "";
  const lines = [
    "Control plane for this user, generated from the capability inventory. Do not invent connectors, accounts, or email addresses.",
  ];
  if (discoverExposed) {
    lines.push("Call capability_discover to read the inventory again.");
  }
  const visible = snapshot.capabilities.filter((row) => row.availability !== "unknown");
  const reads = visible.filter(
    (row) => row.kind === "read" && (row.availability === "ready" || row.availability === "gated")
  );
  const actions = visible.filter(
    (row) => row.kind === "action" && (row.availability === "ready" || row.availability === "gated")
  );
  const unavailable = visible.filter((row) => row.availability === "unavailable");
  const hidden = visible.filter((row) => row.availability === "not_exposed").map((row) => row.id);
  const formatReady = (row) =>
    row.availability === "gated" && row.reason ? `${row.id} (${row.reason})` : row.id;
  lines.push(`Reads: ${reads.map(formatReady).join(", ") || "none"}.`);
  lines.push(
    `Actions: ${
      actions
        .map((row) =>
          row.confirmation === "required" ? `${row.id} (confirmation required)` : row.id
        )
        .join(", ") || "none"
    }.`
  );
  if (hidden.length) lines.push(`Not on this turn: ${hidden.join(", ")}.`);
  if (unavailable.length) {
    lines.push("Unavailable:");
    for (const row of unavailable) lines.push(`- ${row.id}: ${row.reason}`);
  }
  return lines.join("\n");
}

export function projectAccessInventory(snapshot) {
  const capabilities = snapshot?.capabilities ?? [];
  const connectors = snapshot?.connectors ?? [];
  const usable = (row) => row.availability === "ready" || row.availability === "gated";
  return {
    connected: connectors
      .filter((connector) => connector.connected)
      .map((connector) => connector.label),
    read: capabilities
      .filter((row) => row.kind === "read" && usable(row))
      .map((row) => ({ id: row.id, state: row.availability, detail: row.reason || "" })),
    actions: capabilities
      .filter((row) => row.kind === "action" && usable(row))
      .map((row) => ({
        id: row.id,
        approval: row.confirmation === "required",
        detail: row.reason || "",
      })),
    approvalRequired: capabilities
      .filter(
        (row) =>
          row.confirmation === "required" &&
          row.granted === true &&
          row.availability !== "unavailable" &&
          row.availability !== "not_granted"
      )
      .map((row) => row.id),
    unavailable: capabilities
      .filter((row) => row.availability === "unavailable")
      .map((row) => ({ id: row.id, detail: row.reason || "" })),
  };
}
