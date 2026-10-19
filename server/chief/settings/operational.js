// Public operational settings for settings_read.
// Timezone stays on the profile service. Model, voice, and integration
// fields come from the running engine, the public voice config, and the
// existing capability inventory. No credential, profile column, or browser
// store is read or returned.

import { discoverCapabilities } from "../capabilities/discover.js";
import { defaultConnectors } from "../connectors/registry.js";
import { describeModelIdentity } from "../models/identity.js";
import { loadModelConfig } from "../models/config.js";
import {
  listElevenLabsVoices,
  publicVoiceConfig,
  readElevenLabsApiKey,
} from "../voice/elevenlabs.js";

const SECRET_KEY = /api[_-]?key|token|secret|password|credential|authorization|email/i;

function copyModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: typeof model.id === "string" ? model.id : null,
    name: typeof model.name === "string" ? model.name : null,
    provider: typeof model.provider === "string" ? model.provider : null,
    available: model.available === true ? true : model.available === false ? false : null,
  };
}

function configOf(engine, env) {
  if (engine?.config && typeof engine.config === "object") return engine.config;
  try {
    return loadModelConfig(env);
  } catch {
    return null;
  }
}

export function projectModelSettings({
  engine = null,
  env = process.env,
  modelRoute = null,
  activeModel = null,
} = {}) {
  const config = configOf(engine, env);
  if (!config) return { readable: false };
  const identity = engine
    ? describeModelIdentity(engine, { modelRoute, activeModel })
    : {
        routingMode: modelRoute ? "pinned" : "automatic",
        configuredDefault: {
          id: config.defaultModel,
          name: config.defaultModel,
          provider: null,
          available: null,
        },
        active: activeModel
          ? { id: activeModel, name: activeModel, provider: null, available: null }
          : modelRoute
            ? { id: modelRoute, name: modelRoute, provider: null, available: null }
            : null,
        sessionModel: modelRoute
          ? { id: modelRoute, name: modelRoute, provider: null, available: null }
          : null,
        configuredFallback: config.fallbackModel
          ? {
              id: config.fallbackModel,
              name: config.fallbackModel,
              provider: null,
              available: null,
            }
          : null,
      };
  return {
    readable: true,
    modelsEnabled: config.modelsEnabled !== false,
    routingMode: identity.routingMode === "pinned" ? "pinned" : "automatic",
    routerPolicy: typeof config.routerPolicy === "string" ? config.routerPolicy : null,
    temperature: Number.isFinite(config.temperature) ? config.temperature : null,
    maxTokens: Number.isFinite(config.maxTokens) ? config.maxTokens : null,
    enabledProviders: Array.isArray(config.enabledProviders) ? [...config.enabledProviders] : [],
    configuredDefault: copyModel(identity.configuredDefault),
    active: copyModel(identity.active),
    sessionModel: copyModel(identity.sessionModel),
    configuredFallback: copyModel(identity.configuredFallback),
  };
}

function voiceBase(env, apiKey) {
  const config = publicVoiceConfig(env);
  return {
    provider: "elevenlabs",
    integration: "native",
    configured: Boolean(apiKey),
    defaultVoiceId: config.defaultVoiceId || null,
    defaultSpeechModelId: config.defaultModelId || null,
    fallbackAvailable: config.fallbackAvailable === true,
    browserVoiceSelection: "not_readable",
  };
}

export async function readElevenLabsOperationalStatus({
  env = process.env,
  fetchImpl = fetch,
  listVoices = listElevenLabsVoices,
} = {}) {
  const apiKey = readElevenLabsApiKey(env);
  const base = voiceBase(env, apiKey);
  if (!apiKey) return { ...base, status: "not_configured", authenticated: false };
  try {
    const listed = await listVoices({ fetchImpl, apiKey, pageLimit: 1 });
    if (listed?.ok) return { ...base, status: "connected", authenticated: true };
    const rejected = listed?.status === 401 || listed?.status === 403;
    return {
      ...base,
      status: rejected ? "authentication_failed" : "unavailable",
      authenticated: false,
    };
  } catch {
    return { ...base, status: "unavailable", authenticated: false };
  }
}

function nativeRow(row) {
  return {
    id: row.id,
    kind: "native",
    granted: row.granted === true,
    availability: row.availability,
    reason: row.reason || null,
  };
}

export function projectIntegrations({
  policy = null,
  connectors = null,
  voice = null,
  freedomFinancialRead = false,
  freedomFinancialReadable = true,
  webCredentialPresent = null,
  codeEnabled = null,
} = {}) {
  const snapshot = discoverCapabilities({
    policy,
    connectors: connectors ?? defaultConnectors(),
    freedomFinancialRead,
    freedomFinancialReadable,
    webCredentialPresent,
    codeEnabled,
  });
  const byId = new Map((snapshot.capabilities ?? []).map((row) => [row.id, row]));
  const native = [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      kind: "native",
      role: "voice",
      connected: voice?.status === "connected",
      status: voice?.status || "unavailable",
      note: "Native Freedom OS voice integration. It is not an external connector.",
    },
  ];
  for (const id of ["code:read", "web:read"]) {
    const row = byId.get(id);
    if (row) native.push(nativeRow(row));
  }
  return {
    native,
    externalConnectors: (snapshot.connectors ?? []).map((connector) => ({
      id: connector.id,
      label: connector.label,
      kind: "external_connector",
      connected: connector.connected === true,
      reason: connector.connected === true ? null : connector.reason || null,
    })),
  };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitize(item);
  }
  return out;
}

export async function buildOperationalSettings({
  engine = null,
  env = process.env,
  modelRoute = null,
  activeModel = null,
  policy = null,
  connectors = null,
  freedomFinancialRead = false,
  freedomFinancialReadable = true,
  readVoiceStatus = readElevenLabsOperationalStatus,
} = {}) {
  let voice;
  try {
    voice = await readVoiceStatus({ env });
  } catch {
    voice = { ...voiceBase(env, ""), status: "unavailable", authenticated: false };
  }
  return sanitize({
    model: projectModelSettings({ engine, env, modelRoute, activeModel }),
    voice,
    integrations: projectIntegrations({
      policy,
      connectors,
      voice,
      freedomFinancialRead,
      freedomFinancialReadable,
    }),
  });
}
