// CHIEF model providers — descriptors for the AI SDK provider transports.
//
// REUSE DIRECTLY: Vercel AI SDK provider packages (Apache-2.0)
//   `@ai-sdk/xai`       → xAI Grok (CHIEF primary; docs/CHIEF_ARCHITECTURE.md §2)
//   `@ai-sdk/anthropic` → Anthropic (already a platform dependency)
// The OpenJarvis engine zoo (src/openjarvis/engine/*) is deliberately NOT
// ported: the audit (docs/CHIEF_GITHUB_REUSE_AUDIT.md §2.3, "InferenceEngine
// abstraction + engine zoo → REUSE DIRECTLY") found the AI SDK to be the
// equivalent TypeScript implementation. What survives from upstream is the
// *shape*: one registry of engines/providers, each knowing which environment
// variable unlocks it (cf. CloudEngine._init_clients, which enables each
// vendor client only when its API key is present — the same rule this module
// applies through `resolveProviderCredentials`).
//
// A provider descriptor is the CHIEF-side contract every transport must
// satisfy. Adding a provider = one descriptor + `ProviderRegistry` entry +
// catalog rows; nothing in the router or engine changes:
//
//   {
//     id:             ProviderRegistry key; matches ModelSpec.provider
//     displayName:    for health/diagnostics output
//     packageName:    the npm transport (for notices/diagnostics)
//     credentialEnv:  ordered env var names; the first one present wins.
//                     CHIEF_-prefixed names come first so an operator can
//                     give CHIEF its own key without touching platform vars
//     baseUrlEnv:     optional env var overriding the vendor endpoint
//     create(opts):   returns an AI SDK ProviderV4 (must expose
//                     `languageModel(modelId)`)
//   }
//
// Credentials are read only here, only from the injected `env`, and never
// stored on anything that leaves this module except the provider instance
// itself (the AI SDK sends them as request headers). Diagnostics report the
// *name* of the variable that was used, never its value.

import { createXai } from "@ai-sdk/xai";
import { createAnthropic } from "@ai-sdk/anthropic";

import { ProviderRegistry } from "../core/registry.js";

export const XAI_PROVIDER_ID = "xai";
export const ANTHROPIC_PROVIDER_ID = "anthropic";

export const xaiProviderDescriptor = Object.freeze({
  id: XAI_PROVIDER_ID,
  displayName: "xAI (Grok)",
  packageName: "@ai-sdk/xai",
  credentialEnv: Object.freeze(["CHIEF_XAI_API_KEY", "XAI_API_KEY"]),
  baseUrlEnv: "CHIEF_XAI_BASE_URL",
  create({ apiKey, baseURL, fetch }) {
    return createXai({ apiKey, ...(baseURL ? { baseURL } : {}), ...(fetch ? { fetch } : {}) });
  },
});

export const anthropicProviderDescriptor = Object.freeze({
  id: ANTHROPIC_PROVIDER_ID,
  displayName: "Anthropic",
  packageName: "@ai-sdk/anthropic",
  credentialEnv: Object.freeze(["CHIEF_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]),
  baseUrlEnv: "CHIEF_ANTHROPIC_BASE_URL",
  create({ apiKey, baseURL, fetch }) {
    return createAnthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(fetch ? { fetch } : {}),
    });
  },
});

export const BUILTIN_PROVIDERS = Object.freeze([
  xaiProviderDescriptor,
  anthropicProviderDescriptor,
]);

export function validateProviderDescriptor(descriptor) {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new TypeError("provider descriptor must be an object");
  }
  if (typeof descriptor.id !== "string" || descriptor.id.trim() === "") {
    throw new TypeError("provider descriptor id must be a nonempty string");
  }
  if (
    !Array.isArray(descriptor.credentialEnv) ||
    descriptor.credentialEnv.length === 0 ||
    descriptor.credentialEnv.some((name) => typeof name !== "string" || name.trim() === "")
  ) {
    throw new TypeError(`provider '${descriptor.id}' must list at least one credentialEnv name`);
  }
  if (typeof descriptor.create !== "function") {
    throw new TypeError(`provider '${descriptor.id}' must implement create(options)`);
  }
  return descriptor;
}

export function ensureBuiltinProvidersRegistered() {
  for (const descriptor of BUILTIN_PROVIDERS) {
    if (!ProviderRegistry.contains(descriptor.id)) {
      ProviderRegistry.registerValue(descriptor.id, descriptor);
    }
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Resolves which credential (if any) unlocks a provider. Returns the secret
// separately from the diagnostic view so callers cannot accidentally surface
// it: `describeProviderCredentials` is the only thing safe to serialize.
export function resolveProviderCredentials(descriptor, env) {
  validateProviderDescriptor(descriptor);
  for (const name of descriptor.credentialEnv) {
    const apiKey = nonEmpty(env?.[name]);
    if (apiKey) {
      const baseURL = descriptor.baseUrlEnv ? nonEmpty(env?.[descriptor.baseUrlEnv]) : null;
      return { configured: true, credentialSource: name, apiKey, baseURL };
    }
  }
  return { configured: false, credentialSource: null, apiKey: null, baseURL: null };
}

export function describeProviderCredentials(descriptor, env) {
  const { configured, credentialSource } = resolveProviderCredentials(descriptor, env);
  return {
    id: descriptor.id,
    displayName: descriptor.displayName ?? descriptor.id,
    packageName: descriptor.packageName ?? null,
    configured,
    credentialSource,
    credentialEnv: [...descriptor.credentialEnv],
  };
}

// Instantiates every enabled provider that has credentials. Unknown ids fail
// closed (a typo in configuration must not silently disable routing); missing
// credentials are reported, not thrown, so CHIEF degrades to the providers
// that are configured.
export function instantiateProviders({
  env,
  enabledIds,
  registry = ProviderRegistry,
  fetch = undefined,
} = {}) {
  const active = new Map();
  const skipped = [];
  for (const id of enabledIds) {
    if (!registry.contains(id)) {
      throw new Error(
        `CHIEF model provider '${id}' is enabled but not registered (known: ${registry.keys().join(", ") || "none"})`
      );
    }
    const descriptor = validateProviderDescriptor(registry.get(id));
    const credentials = resolveProviderCredentials(descriptor, env);
    if (!credentials.configured) {
      skipped.push({ id, reason: "no credentials", credentialEnv: [...descriptor.credentialEnv] });
      continue;
    }
    const instance = descriptor.create({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseURL ?? undefined,
      fetch,
    });
    if (typeof instance?.languageModel !== "function") {
      throw new TypeError(`provider '${id}' create() must return an AI SDK provider`);
    }
    active.set(id, { descriptor, instance, credentialSource: credentials.credentialSource });
  }
  return { active, skipped };
}
