// Public, read-only model identity derived from the running model engine.
// This intentionally exposes catalog labels and model keys only. Provider
// credentials, environment variable names, and provider-private metadata do
// not enter this description.

// Only questions about the model CHIEF itself is configured with or running on
// are answered from runtime metadata. Advice, comparisons, and recommendations
// about which model to use stay with the model's own reasoning.
const MODEL_WORD = /\b(?:ai\s+|llm\s+|language\s+)?model\b/i;
const QUESTION_FORM =
  /\b(?:what|which|is|are|do|does|am)\b|\?/i;
const SELF_REFERENCE =
  /\b(?:you|your|yourself|chief(?:'s)?|this (?:conversation|session|chat|reply|response))\b|\b(?:default|fallback|active|configured|current(?:ly)?)\b[^?]{0,24}\bmodel\b|\bmodel\b[^?]{0,24}\b(?:default|fallback|active|configured|running|in use|right now|currently)\b/i;
const ADVICE_OR_COMPARISON =
  /\b(?:should|would|could|best|better|recommend\w*|suggest\w*|prefer\w*|choose|pick|compare|comparison|comparing|versus|vs\.?|cheaper|faster|stronger|smarter|more (?:accurate|capable|reliable)|for (?:my|a|an|the|our)\b|to use for|good for|right for|trade-?offs?)\b/i;
const NON_AI_MODEL =
  /\bmodel\s+(?:year|number|no\.?|#)\b|\b(?:truck|car|tractor|vehicle|phone|laptop|mower|boat|trailer|generator|printer|camera|financial model|business model|pricing model|threat model|data model|domain model)\b/i;

export function isModelIdentityQuestion(query) {
  const text = String(query ?? "");
  if (!MODEL_WORD.test(text) || !QUESTION_FORM.test(text)) return false;
  if (!SELF_REFERENCE.test(text)) return false;
  if (ADVICE_OR_COMPARISON.test(text) || NON_AI_MODEL.test(text)) return false;
  return true;
}

function modelCatalog(engine) {
  try {
    return new Map(
      (engine?.listModels?.() ?? []).map((entry) => [
        entry.key,
        {
          id: entry.key,
          name: entry.spec?.name || entry.key,
          provider: entry.providerId || entry.spec?.provider || null,
        },
      ])
    );
  } catch {
    return new Map();
  }
}

function modelDescription(id, catalog, available) {
  if (typeof id !== "string" || !id) return null;
  const known = catalog.get(id);
  return Object.freeze({
    id,
    name: known?.name || id,
    provider: known?.provider || null,
    available: available.has(id),
  });
}

export function describeModelIdentity(engine, { modelRoute = null, activeModel = null } = {}) {
  const catalog = modelCatalog(engine);
  const availableKeys = (() => {
    try {
      return engine?.availableModelKeys?.() ?? [];
    } catch {
      return [];
    }
  })();
  const available = new Set(availableKeys);
  const configuredDefault = modelDescription(engine?.config?.defaultModel, catalog, available);
  const configuredFallback = modelDescription(engine?.config?.fallbackModel, catalog, available);
  const sessionModel = modelDescription(modelRoute, catalog, available);
  const active = modelDescription(activeModel || modelRoute, catalog, available);
  return Object.freeze({
    configuredDefault,
    active,
    sessionModel,
    configuredFallback,
    routingMode: sessionModel ? "pinned" : "automatic",
  });
}

function label(model) {
  if (!model) return "unavailable";
  return model.name === model.id ? `\`${model.id}\`` : `${model.name} (\`${model.id}\`)`;
}

function availability(model) {
  return model?.available === false ? " It is not callable in this deployment." : "";
}

export function renderModelIdentity(identity) {
  const configured = identity?.configuredDefault;
  const active = identity?.active;
  const fallback = identity?.configuredFallback;
  const lines = [
    `The configured default is ${label(configured)}.${availability(configured)}`,
    identity?.routingMode === "pinned"
      ? `This conversation is pinned to ${label(identity.sessionModel || active)}.`
      : active
        ? `This conversation uses automatic routing; this reply is running on ${label(active)}.`
        : "This conversation uses automatic routing; the active model could not be verified.",
  ];
  if (fallback) {
    lines.push(
      `The configured routing fallback is ${label(fallback)}.${availability(fallback)}`
    );
  }
  return lines.join(" ");
}
