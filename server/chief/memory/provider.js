// One memory provider for a CHIEF turn. Today that provider is native.
//
// A later phase may construct a different class here. It must replace this
// one. It must not run beside it. The adapter does not own sessions, tools,
// or the prompt. Callers that need a turn to survive a memory failure use
// openMemoryAccess, which returns an empty result instead of a made-up one.

import { NativeMemoryProvider } from "./native.js";

const PROVIDER_METHODS = ["isAvailable", "remember", "search", "forget"];

export function isMemoryProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
  if (Array.isArray(provider.providers) || Array.isArray(provider.backends)) return false;
  return PROVIDER_METHODS.every((method) => typeof provider[method] === "function");
}

export function openMemoryAccess(provider) {
  if (!isMemoryProvider(provider)) {
    throw new TypeError("MemoryProvider requires isAvailable, remember, search, and forget");
  }
  return {
    provider,
    isAvailable() {
      try {
        return provider.isAvailable() === true;
      } catch {
        return false;
      }
    },
    async remember(event) {
      try {
        if (provider.isAvailable() !== true) return { stored: false, reason: "unavailable" };
        return await provider.remember(event);
      } catch {
        return { stored: false, reason: "unavailable" };
      }
    },
    async search(query, scope) {
      try {
        if (provider.isAvailable() !== true) return [];
        const rows = await provider.search(query, scope);
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    },
    async forget(selector) {
      try {
        if (provider.isAvailable() !== true) return { deleted: 0 };
        const result = await provider.forget(selector);
        return result ?? { deleted: 0 };
      } catch {
        return { deleted: 0 };
      }
    },
  };
}

export function createMemoryAccess({
  facts = null,
  episodes = null,
  checkpointStore = null,
  provider = "native",
  providers = null,
  backends = null,
} = {}) {
  if (provider !== "native" || providers != null || backends != null) {
    throw new TypeError("only one memory provider may be active");
  }
  return openMemoryAccess(
    new NativeMemoryProvider({
      facts,
      episodes: episodes ?? checkpointStore,
    })
  );
}
