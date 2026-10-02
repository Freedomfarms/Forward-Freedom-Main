// Server-side capability registry. Lookup returns metadata. The implementation
// stays on the entry and is reachable only through resolve(), which the
// ToolExecutor path uses. The model cannot register, grant, or supply a handler.

import { BaseTool } from "../tools/spec.js";
import { defineCapability } from "./descriptor.js";
import { catalogEntry } from "./catalog.js";

export class CapabilityRegistry {
  constructor() {
    this._entries = new Map();
  }

  register({ descriptor, execute, isLocal = true } = {}) {
    if (typeof descriptor?.execute === "function" || typeof descriptor?.handler === "function") {
      throw new TypeError(`capability '${descriptor?.name ?? ""}' must not include a handler`);
    }
    const defined = defineCapability(descriptor);
    if (typeof execute !== "function") {
      throw new TypeError(`capability '${defined.name}' requires a server implementation`);
    }
    if (this._entries.has(defined.name)) {
      throw new Error(`capability '${defined.name}' is already registered`);
    }
    this._entries.set(
      defined.name,
      Object.freeze({
        descriptor: defined,
        execute,
        isLocal: isLocal !== false,
      })
    );
    return defined;
  }

  registerFromModel() {
    throw new Error("the model cannot register a capability");
  }

  grantFromModel() {
    throw new Error("the model cannot change capability permissions");
  }

  has(name) {
    return this._entries.has(name);
  }

  get(name) {
    return this._entries.get(name)?.descriptor ?? null;
  }

  resolve(name) {
    return this._entries.get(name) ?? null;
  }

  list({ exposure, subsystem, effect } = {}) {
    const descriptors = [];
    for (const entry of this._entries.values()) {
      const descriptor = entry.descriptor;
      if (exposure && descriptor.exposure !== exposure) continue;
      if (subsystem && descriptor.subsystem !== subsystem) continue;
      if (effect && descriptor.effect !== effect) continue;
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  search(query) {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    if (!needle) return [];
    return this.list().filter((descriptor) => {
      const haystack =
        `${descriptor.name} ${descriptor.description} ${descriptor.subsystem}`.toLowerCase();
      return haystack.includes(needle);
    });
  }

  names() {
    return [...this._entries.keys()];
  }

  toBaseTools() {
    return [...this._entries.values()].map(
      (entry) =>
        new BaseTool({
          spec: entry.descriptor,
          isLocal: entry.isLocal,
          execute: entry.execute,
        })
    );
  }
}

export function descriptorForTool(spec) {
  const meta = catalogEntry(spec?.name);
  if (!meta) {
    throw new Error(`tool '${spec?.name ?? ""}' has no capability descriptor`);
  }
  return defineCapability({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters,
    outputSchema: meta.outputSchema,
    subsystem: meta.subsystem,
    effect: meta.effect,
    requiredCapabilities: spec.requiredCapabilities,
    confirmation: meta.confirmation,
    audit: meta.audit,
    exposure: meta.exposure,
    category: spec.category,
    timeoutSeconds: spec.timeoutSeconds,
    metadata: spec.metadata,
  });
}

export function registerTool(registry, tool) {
  return registry.register({
    descriptor: descriptorForTool(tool.spec),
    execute: (params, context) => tool.execute(params, context),
    isLocal: tool.isLocal,
  });
}
