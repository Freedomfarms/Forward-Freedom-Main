// CHIEF provider descriptor tests — credential resolution boundary, secret
// hygiene, fail-closed configuration, and the real @ai-sdk/xai /
// @ai-sdk/anthropic transports constructing without network access.

import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRegistry } from "../server/chief/core/registry.js";
import {
  ANTHROPIC_PROVIDER_ID,
  BUILTIN_PROVIDERS,
  OPENAI_PROVIDER_ID,
  XAI_PROVIDER_ID,
  anthropicProviderDescriptor,
  openaiProviderDescriptor,
  describeProviderCredentials,
  ensureBuiltinProvidersRegistered,
  instantiateProviders,
  resolveProviderCredentials,
  validateProviderDescriptor,
  xaiProviderDescriptor,
} from "../server/chief/models/providers.js";

const SECRET = "xai-secret-value-do-not-leak";

test("built-in providers register idempotently under their ids", () => {
  ProviderRegistry.clear();
  ensureBuiltinProvidersRegistered();
  ensureBuiltinProvidersRegistered();
  assert.deepEqual(
    new Set(ProviderRegistry.keys()),
    new Set([XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID])
  );
  assert.equal(ProviderRegistry.get(XAI_PROVIDER_ID), xaiProviderDescriptor);
  assert.equal(BUILTIN_PROVIDERS[0].id, XAI_PROVIDER_ID);
});

test("descriptor validation rejects malformed providers", () => {
  assert.throws(() => validateProviderDescriptor(null), TypeError);
  assert.throws(
    () => validateProviderDescriptor({ id: "", credentialEnv: ["X"], create() {} }),
    TypeError
  );
  assert.throws(
    () => validateProviderDescriptor({ id: "p", credentialEnv: [], create() {} }),
    TypeError
  );
  assert.throws(() => validateProviderDescriptor({ id: "p", credentialEnv: ["X"] }), TypeError);
  for (const descriptor of BUILTIN_PROVIDERS) validateProviderDescriptor(descriptor);
});

test("credential resolution honors the CHIEF_-prefixed variable first", () => {
  const platformOnly = resolveProviderCredentials(xaiProviderDescriptor, { XAI_API_KEY: SECRET });
  assert.equal(platformOnly.configured, true);
  assert.equal(platformOnly.credentialSource, "XAI_API_KEY");
  assert.equal(platformOnly.apiKey, SECRET);

  const both = resolveProviderCredentials(xaiProviderDescriptor, {
    XAI_API_KEY: "platform",
    CHIEF_XAI_API_KEY: "chief",
  });
  assert.equal(both.credentialSource, "CHIEF_XAI_API_KEY");
  assert.equal(both.apiKey, "chief");

  const blank = resolveProviderCredentials(xaiProviderDescriptor, { XAI_API_KEY: "   " });
  assert.equal(blank.configured, false);
  assert.equal(blank.apiKey, null);

  const none = resolveProviderCredentials(xaiProviderDescriptor, {});
  assert.equal(none.configured, false);
  assert.equal(none.credentialSource, null);
});

test("base URL override is read only alongside a credential", () => {
  const withBase = resolveProviderCredentials(xaiProviderDescriptor, {
    XAI_API_KEY: SECRET,
    CHIEF_XAI_BASE_URL: "https://proxy.example/v1",
  });
  assert.equal(withBase.baseURL, "https://proxy.example/v1");
  const noKey = resolveProviderCredentials(xaiProviderDescriptor, {
    CHIEF_XAI_BASE_URL: "https://proxy.example/v1",
  });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.baseURL, null);
});

test("describeProviderCredentials never contains the secret", () => {
  const description = describeProviderCredentials(xaiProviderDescriptor, { XAI_API_KEY: SECRET });
  assert.deepEqual(description, {
    id: "xai",
    displayName: "xAI (Grok)",
    packageName: "@ai-sdk/xai",
    configured: true,
    credentialSource: "XAI_API_KEY",
    credentialEnv: ["CHIEF_XAI_API_KEY", "XAI_API_KEY"],
  });
  assert.ok(!JSON.stringify(description).includes(SECRET));
});

test("no provider secret is read from process.env implicitly", () => {
  // The env object is injected; an empty one means "unconfigured" even if
  // the host process happens to carry a key.
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = SECRET;
  try {
    assert.equal(resolveProviderCredentials(xaiProviderDescriptor, {}).configured, false);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("instantiateProviders builds the OpenAI transport from CHIEF_OPENAI_API_KEY", () => {
  ProviderRegistry.clear();
  ensureBuiltinProvidersRegistered();
  const { active, skipped } = instantiateProviders({
    env: { CHIEF_OPENAI_API_KEY: "openai-secret", OPENAI_API_KEY: "platform-openai" },
    enabledIds: ["openai"],
  });
  assert.deepEqual(skipped, []);
  assert.equal(active.get("openai").credentialSource, "CHIEF_OPENAI_API_KEY");
  const gpt = active.get("openai").instance.languageModel("gpt-4.1");
  assert.equal(gpt.modelId, "gpt-4.1");
  assert.match(gpt.provider, /^openai/);
  assert.equal(typeof gpt.doStream, "function");
  assert.equal(openaiProviderDescriptor.credentialEnv[0], "CHIEF_OPENAI_API_KEY");
});

test("instantiateProviders builds real AI SDK providers for xAI and Anthropic", () => {
  ProviderRegistry.clear();
  ensureBuiltinProvidersRegistered();
  const { active, skipped } = instantiateProviders({
    env: { XAI_API_KEY: SECRET, ANTHROPIC_API_KEY: "anthropic-secret" },
    enabledIds: ["xai", "anthropic"],
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual([...active.keys()], ["xai", "anthropic"]);

  const grok = active.get("xai").instance.languageModel("grok-4.7");
  assert.equal(grok.modelId, "grok-4.7");
  assert.match(grok.provider, /^xai/);
  assert.equal(typeof grok.doGenerate, "function");
  assert.equal(typeof grok.doStream, "function");

  const claude = active.get("anthropic").instance.languageModel("claude-haiku-4-5");
  assert.equal(claude.modelId, "claude-haiku-4-5");
  assert.match(claude.provider, /^anthropic/);
  assert.equal(active.get("xai").credentialSource, "XAI_API_KEY");
});

test("instantiateProviders skips (not throws) providers without credentials", () => {
  ProviderRegistry.clear();
  ensureBuiltinProvidersRegistered();
  const { active, skipped } = instantiateProviders({
    env: { XAI_API_KEY: SECRET },
    enabledIds: ["xai", "anthropic"],
  });
  assert.deepEqual([...active.keys()], ["xai"]);
  assert.deepEqual(skipped, [
    {
      id: "anthropic",
      reason: "no credentials",
      credentialEnv: ["CHIEF_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    },
  ]);
});

test("instantiateProviders fails closed on an unregistered provider id", () => {
  ProviderRegistry.clear();
  ensureBuiltinProvidersRegistered();
  assert.throws(
    () => instantiateProviders({ env: { XAI_API_KEY: SECRET }, enabledIds: ["xai", "typo"] }),
    /'typo' is enabled but not registered/
  );
});

test("a provider whose create() does not return an AI SDK provider is rejected", () => {
  ProviderRegistry.clear();
  ProviderRegistry.registerValue("broken", {
    id: "broken",
    credentialEnv: ["BROKEN_KEY"],
    create: () => ({}),
  });
  assert.throws(
    () => instantiateProviders({ env: { BROKEN_KEY: "k" }, enabledIds: ["broken"] }),
    /must return an AI SDK provider/
  );
});

test("the xAI descriptor forwards apiKey/baseURL/fetch to @ai-sdk/xai", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({ error: "offline test" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  const provider = xaiProviderDescriptor.create({
    apiKey: SECRET,
    baseURL: "https://xai.test/v1",
    fetch: fakeFetch,
  });
  const model = provider.languageModel("grok-4.7");
  await assert.rejects(
    model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://xai.test/v1/"), calls[0].url);
  const auth = Object.entries(calls[0].headers).find(([k]) => k.toLowerCase() === "authorization");
  assert.equal(auth?.[1], `Bearer ${SECRET}`);
});

test("the Anthropic descriptor is shaped identically (extensibility check)", () => {
  assert.deepEqual(
    Object.keys(anthropicProviderDescriptor).sort(),
    Object.keys(xaiProviderDescriptor).sort()
  );
});
