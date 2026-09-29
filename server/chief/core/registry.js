// CHIEF core registry — decorator-style component registries.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/core/registry.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - per-registry isolated entry storage (subclass registries never share entries)
//   - register(key) returns a decorator-style wrapper; duplicate keys throw
//     ("already has an entry"), missing keys throw ("does not have an entry")
//   - registerValue(key, value) for non-class entries
//   - create(key, ...args) instantiates a registered constructor and throws
//     TypeError ("not callable") for plain values
//   - items()/keys()/contains()/clear() surface
// Documented adaptations (CHIEF-specific reasons):
//   - Python classmethod-on-metaclass storage becomes a static per-class Map,
//     keyed on the concrete class, giving the same isolation guarantee.
//   - Only the typed registries CHIEF's architecture references are declared
//     (docs/CHIEF_ARCHITECTURE.md §2/§7.1). Upstream's engine/speech/TTS/
//     compression/benchmark/learning/miner registries are hardware/daemon
//     concerns that do not exist in this serverless deployment; adding one
//     later is a two-line subclass, not a redesign.

export class RegistryBase {
  // Mirrors upstream `_entries()`: storage is created lazily per concrete
  // class (upstream: `_registry_entries_{cls.__name__}` class attribute).
  static _entries() {
    if (!Object.prototype.hasOwnProperty.call(this, "_registryEntries")) {
      Object.defineProperty(this, "_registryEntries", {
        value: new Map(),
        writable: false,
        enumerable: false,
      });
    }
    return this._registryEntries;
  }

  static register(key) {
    const entries = this._entries();
    const registryName = this.name;
    if (entries.has(key)) {
      throw new Error(`${registryName} already has an entry for '${key}'`);
    }
    return (value) => {
      // Re-check: the decorator may be applied after other registrations.
      if (entries.has(key)) {
        throw new Error(`${registryName} already has an entry for '${key}'`);
      }
      entries.set(key, value);
      return value;
    };
  }

  static registerValue(key, value) {
    const entries = this._entries();
    if (entries.has(key)) {
      throw new Error(`${this.name} already has an entry for '${key}'`);
    }
    entries.set(key, value);
  }

  static get(key) {
    const entries = this._entries();
    if (!entries.has(key)) {
      throw new Error(`${this.name} does not have an entry for '${key}'`);
    }
    return entries.get(key);
  }

  static create(key, ...args) {
    const entry = this.get(key);
    if (typeof entry !== "function") {
      throw new TypeError(
        `${this.name} entry '${key}' is not callable and cannot be instantiated`,
      );
    }
    return new entry(...args);
  }

  static items() {
    return [...this._entries().entries()];
  }

  static keys() {
    return [...this._entries().keys()];
  }

  static contains(key) {
    return this._entries().has(key);
  }

  static clear() {
    this._entries().clear();
  }
}

// Typed registries used by the CHIEF architecture (docs/CHIEF_ARCHITECTURE.md §2).
export class ModelRegistry extends RegistryBase {}
export class AgentRegistry extends RegistryBase {}
export class ToolRegistry extends RegistryBase {}
export class MemoryRegistry extends RegistryBase {}
export class FactStoreRegistry extends RegistryBase {}
export class RouterPolicyRegistry extends RegistryBase {}
export class ChannelRegistry extends RegistryBase {}
export class ConnectorRegistry extends RegistryBase {}
