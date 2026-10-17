// Public, read-only model identity derived from the running model engine.
// This intentionally exposes catalog labels and model keys only. Provider
// credentials, environment variable names, and provider-private metadata do
// not enter this description.

const MODEL_IDENTITY_QUESTION =
  /\b(?:what|which)\s+(?:ai\s+)?model\b|\bdefault model\b|\bmodel (?:are|is|do) (?:you|chief)\b|\b(?:active|fallback|configured) model\b/i;

export function isModelIdentityQuestion(query) {
  return MODEL_IDENTITY_QUESTION.test(String(query ?? ""));
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
