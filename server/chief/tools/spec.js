// CHIEF ToolSpec — declarative tool metadata.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/tools/_stubs.py (ToolSpec, BaseTool)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// requiresConfirmation is the möbius ApprovalRequirement::Always bit
// (src/middleware/tools.rs, commit 3e1aaf5). The turn passes only those call
// ids to ApprovalCoordinator. The spec never carries an execute function;
// ToolExecutor is the only caller of BaseTool.execute.
// A spec the control plane forbids cannot be constructed.

import { assertToolAllowed } from "./inventory.js";

export function defineToolSpec(fields) {
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError("tool spec must be an object");
  }
  if (typeof fields.execute === "function") {
    throw new TypeError(`tool spec '${fields.name ?? ""}' must not include execute`);
  }
  if (typeof fields.name !== "string" || fields.name.trim() === "") {
    throw new TypeError("tool spec name must be a nonempty string");
  }
  const timeoutSeconds = fields.timeoutSeconds ?? 30;
  if (!(timeoutSeconds > 0)) {
    throw new TypeError(`tool '${fields.name}' timeoutSeconds must be positive`);
  }
  const confirmation =
    fields.confirmation === "required" || fields.confirmation === "none"
      ? fields.confirmation
      : null;
  const spec = {
    name: fields.name,
    description: fields.description || fields.name,
    parameters: fields.parameters ?? fields.inputSchema ?? { type: "object", properties: {} },
    category: fields.category ?? "",
    requiresConfirmation: confirmation
      ? confirmation === "required"
      : fields.requiresConfirmation === true,
    timeoutSeconds,
    requiredCapabilities: Object.freeze([...(fields.requiredCapabilities ?? [])]),
    metadata: Object.freeze({ ...(fields.metadata ?? {}) }),
  };
  if (typeof fields.effect === "string") spec.effect = fields.effect;
  if (typeof fields.subsystem === "string") spec.subsystem = fields.subsystem;
  if (confirmation) spec.confirmation = confirmation;
  if (typeof fields.audit === "string") spec.audit = fields.audit;
  if (typeof fields.exposure === "string") spec.exposure = fields.exposure;
  if (fields.inputSchema && typeof fields.inputSchema === "object") {
    spec.inputSchema = fields.inputSchema;
  }
  if (fields.outputSchema && typeof fields.outputSchema === "object") {
    spec.outputSchema = fields.outputSchema;
  }
  const frozen = Object.freeze(spec);
  assertToolAllowed(frozen);
  return frozen;
}

export class BaseTool {
  constructor({ spec, isLocal = true, execute }) {
    if (typeof execute !== "function") {
      throw new TypeError(`tool '${spec?.name}' requires execute`);
    }
    this.spec = defineToolSpec(spec);
    this.isLocal = isLocal !== false;
    this._execute = execute;
  }

  execute(params, context) {
    return this._execute(params, context);
  }
}
