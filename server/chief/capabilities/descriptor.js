// Capability descriptors. The model receives this metadata. It never receives
// a handler, a connection, or a credential.

export const Effect = Object.freeze({
  READ: "read",
  WRITE: "write",
  DESTRUCTIVE: "destructive",
  EXTERNAL: "external",
  HIGH_IMPACT: "high_impact",
});

export const Confirmation = Object.freeze({
  NONE: "none",
  REQUIRED: "required",
});

export const AuditPolicy = Object.freeze({
  DENY_ONLY: "deny_only",
  FULL: "full",
});

export const Exposure = Object.freeze({
  BASELINE: "baseline",
  ON_DEMAND: "on_demand",
});

const EFFECT_VALUES = new Set(Object.values(Effect));
const CONFIRMATION_VALUES = new Set(Object.values(Confirmation));
const AUDIT_VALUES = new Set(Object.values(AuditPolicy));
const EXPOSURE_VALUES = new Set(Object.values(Exposure));

const EXPLICIT_EFFECTS = new Set([Effect.DESTRUCTIVE, Effect.HIGH_IMPACT]);

export function effectRequiresExplicitConfirmation(effect) {
  return EXPLICIT_EFFECTS.has(effect);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function requireSchema(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON schema object`);
  }
  if (value.type !== "object" && value.type !== "string") {
    throw new TypeError(`${label} must describe an object or a string`);
  }
  return value;
}

function requireNames(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError("requiredCapabilities must be an array of nonempty strings");
  }
  return Object.freeze([...value]);
}

/**
 * Validate a capability descriptor. The returned object is frozen and has no
 * execute function. `parameters` mirrors `inputSchema` so the existing tool
 * spec contract keeps working.
 */
export function defineCapability(fields) {
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError("capability descriptor must be an object");
  }
  if (typeof fields.execute === "function" || typeof fields.handler === "function") {
    throw new TypeError(`capability '${fields.name ?? ""}' must not include a handler`);
  }
  const name = requireString(fields.name, "capability name");
  const description = requireString(fields.description, "capability description");
  const inputSchema = requireSchema(fields.inputSchema ?? fields.parameters, "inputSchema");
  const outputSchema = requireSchema(fields.outputSchema, "outputSchema");
  const subsystem = requireString(fields.subsystem, "subsystem");
  if (!EFFECT_VALUES.has(fields.effect)) {
    throw new TypeError(`capability '${name}' has an unknown effect`);
  }
  if (!CONFIRMATION_VALUES.has(fields.confirmation)) {
    throw new TypeError(`capability '${name}' has an unknown confirmation policy`);
  }
  if (!AUDIT_VALUES.has(fields.audit)) {
    throw new TypeError(`capability '${name}' has an unknown audit policy`);
  }
  if (!EXPOSURE_VALUES.has(fields.exposure)) {
    throw new TypeError(`capability '${name}' has an unknown exposure policy`);
  }
  if (fields.effect === Effect.READ && fields.confirmation !== Confirmation.NONE) {
    throw new TypeError(`read capability '${name}' cannot require confirmation`);
  }
  if (
    (fields.effect === Effect.WRITE ||
      fields.effect === Effect.DESTRUCTIVE ||
      fields.effect === Effect.HIGH_IMPACT) &&
    fields.confirmation !== Confirmation.REQUIRED
  ) {
    throw new TypeError(`capability '${name}' must require confirmation`);
  }
  if (effectRequiresExplicitConfirmation(fields.effect) && fields.audit !== AuditPolicy.FULL) {
    throw new TypeError(`capability '${name}' requires a full audit record`);
  }
  const timeoutSeconds = fields.timeoutSeconds ?? 30;
  if (!(timeoutSeconds > 0)) {
    throw new TypeError(`capability '${name}' timeoutSeconds must be positive`);
  }
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ ...inputSchema }),
    outputSchema: Object.freeze({ ...outputSchema }),
    parameters: Object.freeze({ ...inputSchema }),
    subsystem,
    effect: fields.effect,
    requiredCapabilities: requireNames(fields.requiredCapabilities ?? []),
    confirmation: fields.confirmation,
    audit: fields.audit,
    exposure: fields.exposure,
    requiresConfirmation: fields.confirmation === Confirmation.REQUIRED,
    category: typeof fields.category === "string" ? fields.category : subsystem,
    timeoutSeconds,
    metadata: Object.freeze({ ...(fields.metadata ?? {}) }),
  });
}
