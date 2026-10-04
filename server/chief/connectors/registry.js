// Connected-system registry. A connector contributes capabilities and, only
// while it is connected, tools. TurnMachine does not learn each integration.
// Disconnected connectors stay in the inventory so CHIEF can say why a
// capability is missing. They do not register a tool and they do not invent data.

import { defineCapability } from "../capabilities/descriptor.js";

function requireId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value.trim();
}

export function defineConnector(fields) {
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError("connector must be an object");
  }
  const id = requireId(fields.id, "connector id");
  const capabilities = (fields.capabilities ?? []).map((capability) => {
    if (typeof capability !== "object" || capability === null) {
      throw new TypeError(`connector '${id}' capability must be an object`);
    }
    return Object.freeze({
      id: requireId(capability.id, `connector '${id}' capability id`),
      effect: requireId(capability.effect, `connector '${id}' effect`),
      grant: requireId(capability.grant, `connector '${id}' grant`),
      confirmation: capability.confirmation === "required" ? "required" : "none",
      tools: Object.freeze(
        (capability.tools ?? []).map((name) => requireId(name, `connector '${id}' tool`))
      ),
      kind: capability.effect === "read" ? "read" : "action",
      reason: typeof capability.reason === "string" ? capability.reason : null,
    });
  });
  return Object.freeze({
    id,
    label: typeof fields.label === "string" && fields.label.trim() ? fields.label.trim() : id,
    connected: fields.connected === true,
    unavailableReason:
      typeof fields.unavailableReason === "string" && fields.unavailableReason.trim()
        ? fields.unavailableReason.trim()
        : `${id} is not connected.`,
    capabilities: Object.freeze(capabilities),
    createTools: typeof fields.createTools === "function" ? fields.createTools : () => [],
  });
}

export function defaultConnectors() {
  return [
    defineConnector({
      id: "email",
      label: "Email",
      connected: false,
      unavailableReason:
        "Email read access is unavailable because no email connector is currently connected.",
      capabilities: [
        {
          id: "email:read",
          effect: "read",
          grant: "email:read",
          confirmation: "none",
          tools: ["email_search"],
          reason:
            "Email read access is unavailable because no email connector is currently connected.",
        },
        {
          id: "email:send",
          effect: "external",
          grant: "email:send",
          confirmation: "required",
          tools: ["email_send"],
          reason: "Email send is unavailable because no email connector is currently connected.",
        },
      ],
    }),
    defineConnector({
      id: "calendar",
      label: "Calendar",
      connected: false,
      unavailableReason:
        "Calendar access is unavailable because no calendar connector is currently connected.",
      capabilities: [
        {
          id: "calendar:read",
          effect: "read",
          grant: "calendar:read",
          confirmation: "none",
          tools: ["calendar_list"],
          reason:
            "Calendar read access is unavailable because no calendar connector is currently connected.",
        },
        {
          id: "calendar:write",
          effect: "write",
          grant: "calendar:write",
          confirmation: "required",
          tools: ["calendar_write"],
          reason:
            "Calendar changes are unavailable because no calendar connector is currently connected.",
        },
      ],
    }),
    defineConnector({
      id: "drive",
      label: "Drive",
      connected: false,
      unavailableReason:
        "Cloud file access is unavailable because no drive connector is currently connected.",
      capabilities: [
        {
          id: "drive:read",
          effect: "read",
          grant: "drive:read",
          confirmation: "none",
          tools: ["drive_read"],
          reason:
            "Cloud file read access is unavailable because no drive connector is currently connected.",
        },
      ],
    }),
    defineConnector({
      id: "github",
      label: "GitHub",
      connected: false,
      unavailableReason:
        "GitHub account access is unavailable because no GitHub connector is currently connected.",
      capabilities: [
        {
          id: "github:read",
          effect: "read",
          grant: "github:read",
          confirmation: "none",
          tools: ["github_read"],
          reason:
            "GitHub read access is unavailable because no GitHub connector is currently connected. Repository source uses code:read and is separate.",
        },
        {
          id: "github:write",
          effect: "write",
          grant: "github:write",
          confirmation: "required",
          tools: ["github_write"],
          reason:
            "GitHub write access is unavailable because no GitHub connector is currently connected.",
        },
      ],
    }),
    defineConnector({
      id: "files",
      label: "Files",
      connected: false,
      unavailableReason: "File access is unavailable because no filesystem connector is connected.",
      capabilities: [
        {
          id: "file:read",
          effect: "read",
          grant: "file:read",
          confirmation: "none",
          tools: ["file_read"],
          reason:
            "File read access is unavailable because no filesystem connector is connected. Repository source uses code:read.",
        },
        {
          id: "file:write",
          effect: "write",
          grant: "file:write",
          confirmation: "required",
          tools: ["file_write"],
          reason: "File write access is unavailable because no filesystem connector is connected.",
        },
      ],
    }),
  ];
}

export function loadConnectorTools(connectors = defaultConnectors()) {
  const tools = [];
  for (const connector of connectors) {
    if (connector?.connected !== true) continue;
    const created = connector.createTools();
    if (!Array.isArray(created)) {
      throw new TypeError(`connector '${connector.id}' createTools must return an array`);
    }
    for (const tool of created) tools.push(tool);
  }
  return tools;
}

export function descriptorFromConnectorTool(spec) {
  const confirmation =
    spec.confirmation === "required" || spec.requiresConfirmation === true ? "required" : "none";
  const effect = spec.effect;
  const audit =
    spec.audit ||
    (effect === "destructive" || effect === "high_impact" || effect !== "read"
      ? "full"
      : "deny_only");
  return defineCapability({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters ?? { type: "object", properties: {} },
    outputSchema: spec.outputSchema ?? { type: "string" },
    subsystem: spec.subsystem || spec.category || "connector",
    effect,
    requiredCapabilities: spec.requiredCapabilities ?? [],
    confirmation,
    audit: effect === "destructive" || effect === "high_impact" ? "full" : audit,
    exposure: spec.exposure || "baseline",
    category: spec.category,
    timeoutSeconds: spec.timeoutSeconds,
  });
}
