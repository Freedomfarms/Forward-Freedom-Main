// CHIEF registry tests — translated from OpenJarvis tests/core/test_registry.py
// (commit 5e5f5ef) so the ported semantics stay verifiably faithful.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RegistryBase,
  ModelRegistry,
  AgentRegistry,
  ToolRegistry,
  RouterPolicyRegistry,
} from "../server/chief/core/registry.js";

function clearAll() {
  for (const registry of [ModelRegistry, AgentRegistry, ToolRegistry, RouterPolicyRegistry]) {
    registry.clear();
  }
}

test("register decorator stores and get returns the same class", () => {
  clearAll();
  class Dummy {}
  ModelRegistry.register("test-model")(Dummy);
  assert.equal(ModelRegistry.get("test-model"), Dummy);
});

test("registerValue stores plain values", () => {
  clearAll();
  ModelRegistry.registerValue("val", 42);
  assert.equal(ModelRegistry.get("val"), 42);
});

test("duplicate registration throws 'already has an entry'", () => {
  clearAll();
  ModelRegistry.registerValue("dup", 1);
  assert.throws(() => ModelRegistry.registerValue("dup", 2), /already has an entry/);
  assert.throws(() => ModelRegistry.register("dup"), /already has an entry/);
});

test("get for a missing key throws 'does not have an entry'", () => {
  clearAll();
  assert.throws(() => ModelRegistry.get("nonexistent"), /does not have an entry/);
});

test("create instantiates a registered constructor with arguments", () => {
  clearAll();
  class Cls {
    constructor(x) {
      this.x = x;
    }
  }
  ModelRegistry.register("factory")(Cls);
  const obj = ModelRegistry.create("factory", 7);
  assert.equal(obj.x, 7);
});

test("create on a non-callable entry throws TypeError 'not callable'", () => {
  clearAll();
  ModelRegistry.registerValue("plain", "hello");
  assert.throws(() => ModelRegistry.create("plain"), {
    name: "TypeError",
    message: /not callable/,
  });
});

test("items, keys, contains, clear", () => {
  clearAll();
  ModelRegistry.registerValue("a", 1);
  ModelRegistry.registerValue("b", 2);
  assert.deepEqual(Object.fromEntries(ModelRegistry.items()), { a: 1, b: 2 });
  assert.deepEqual(new Set(ModelRegistry.keys()), new Set(["a", "b"]));
  assert.equal(ModelRegistry.contains("a"), true);
  assert.equal(ModelRegistry.contains("absent"), false);
  ModelRegistry.clear();
  assert.deepEqual(ModelRegistry.keys(), []);
});

test("entries in one registry must not leak into another", () => {
  clearAll();
  ModelRegistry.registerValue("shared-key", "model");
  assert.throws(() => AgentRegistry.get("shared-key"), /does not have an entry/);
  assert.equal(ToolRegistry.contains("shared-key"), false);
  // The base class itself is isolated from subclasses too.
  assert.equal(RegistryBase.contains("shared-key"), false);
});

test("RouterPolicyRegistry behaves like every other typed registry", () => {
  clearAll();
  RouterPolicyRegistry.registerValue("test-policy", "dummy");
  assert.equal(RouterPolicyRegistry.get("test-policy"), "dummy");
  assert.throws(
    () => RouterPolicyRegistry.registerValue("test-policy", 2),
    /already has an entry/,
  );
});
