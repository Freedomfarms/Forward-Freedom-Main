import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefVoices } from "../api/chief/voice/voices.js";
import { discoverCapabilities } from "../server/chief/capabilities/discover.js";
import { projectConnectedSystems } from "../server/chief/capabilities/systems.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { baselineCapabilities } from "../server/chief/control/plane.js";
import {
  CHIEF_PREFERENCES_KEY,
  normalizeChiefPreferences,
  readChiefPreferences,
  shouldSpeakReply,
  writeChiefPreferences,
} from "../src/utils/chiefPreferences.js";
import {
  VOICE_CONNECTION_LABEL,
  voiceConnectionLabel,
  voiceConnectionState,
} from "../src/utils/chiefVoiceStatus.js";

function policy() {
  const next = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of baselineCapabilities()) next.grant("_default", capability);
  next.grant("_default", Capability.WEB_SEARCH);
  return next;
}

function memoryStorage(seed = {}) {
  const bin = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return bin.has(key) ? bin.get(key) : null;
    },
    setItem(key, value) {
      bin.set(key, value);
    },
  };
}

test("voice connection words come from the server result and hide the key", () => {
  assert.equal(voiceConnectionState({ configured: true }), "connected");
  assert.equal(voiceConnectionState({ configured: false }), "not_configured");
  assert.equal(
    voiceConnectionState({ configured: true, code: "authentication_failed" }),
    "authentication_failed"
  );
  assert.equal(voiceConnectionState({ code: "provider_error" }), "unavailable");
  assert.equal(voiceConnectionLabel("connected"), "Connected");
  assert.equal(voiceConnectionLabel("not_configured"), "Not configured");
  assert.equal(voiceConnectionLabel("authentication_failed"), "Authentication failed");
  assert.equal(voiceConnectionLabel("unavailable"), "Unable to load voices");
  assert.equal(JSON.stringify(VOICE_CONNECTION_LABEL).includes("ELEVEN"), false);
});

test("elevenlabs authentication failure is reported without the key", async () => {
  const state = { statusCode: null, body: null };
  const response = {
    setHeader() {},
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(body) {
      state.body = body;
      return response;
    },
  };
  await handleChiefVoices(
    { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    response,
    {
      limit: async () => true,
      authenticate: async () => ({ uid: "user-1" }),
      env: { ELEVENLABS_API_KEY: "server-key" },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }
  );
  assert.equal(state.statusCode, 502);
  assert.equal(state.body.code, "authentication_failed");
  assert.equal(JSON.stringify(state.body).includes("server-key"), false);
});

test("connected systems follow the control plane and do not invent a link", () => {
  const off = projectConnectedSystems(
    discoverCapabilities({
      policy: policy(),
      freedomFinancialRead: false,
      webCredentialPresent: false,
      codeEnabled: false,
    })
  );
  const finance = off.find((row) => row.id === "freedom-financial");
  const email = off.find((row) => row.id === "email");
  const web = off.find((row) => row.id === "web-search");
  const grokbot = off.find((row) => row.id === "grokbot");
  assert.equal(finance.access, "not_connected");
  assert.equal(finance.status, "Off");
  assert.match(finance.detail, /Module 02/);
  assert.equal(email.access, "not_connected");
  assert.equal(email.status, "Not connected");
  assert.equal(web.access, "not_connected");
  assert.equal(grokbot.access, "read");
  assert.equal(grokbot.status, "Read only");
  assert.match(grokbot.detail, /Read-only observation/);

  const on = projectConnectedSystems(
    discoverCapabilities({
      policy: policy(),
      freedomFinancialRead: true,
      webCredentialPresent: true,
      codeEnabled: true,
    })
  );
  assert.equal(on.find((row) => row.id === "freedom-financial").access, "read");
  assert.equal(on.find((row) => row.id === "freedom-financial").status, "Connected");
  assert.equal(on.find((row) => row.id === "web-search").access, "read");
  assert.equal(on.find((row) => row.id === "codebase").access, "read");
  assert.equal(on.find((row) => row.id === "email").access, "not_connected");
  assert.equal(JSON.stringify(on).includes("xi-api-key"), false);
});

test("interface preferences persist without credentials", () => {
  const storage = memoryStorage();
  const saved = writeChiefPreferences(
    {
      conversation: { autoSpeak: true, enterToSend: false, apiKey: "secret" },
      appearance: { animationIntensity: "off", reducedMotion: "reduce" },
      elevenLabsKey: "secret",
    },
    storage
  );
  assert.equal(saved.conversation.autoSpeak, true);
  assert.equal(saved.conversation.enterToSend, false);
  assert.equal(saved.conversation.voiceResponses, true);
  assert.equal(saved.appearance.animationIntensity, "off");
  assert.equal(saved.appearance.reducedMotion, "reduce");
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.deepEqual(readChiefPreferences(storage), saved);
  assert.equal(shouldSpeakReply({ source: "voice", preferences: saved }), true);
  assert.equal(shouldSpeakReply({ source: "text", preferences: saved }), true);
  assert.equal(shouldSpeakReply({ source: "text" }), true);
  assert.equal(normalizeChiefPreferences(null).conversation.autoSpeak, true);
  assert.equal(
    shouldSpeakReply({
      source: "voice",
      preferences: normalizeChiefPreferences({ conversation: { voiceResponses: false } }),
    }),
    false
  );
  assert.equal(
    shouldSpeakReply({
      source: "text",
      preferences: normalizeChiefPreferences({
        conversation: { autoSpeak: false, speechChoice: true },
      }),
    }),
    false
  );

  const legacy = memoryStorage({
    [CHIEF_PREFERENCES_KEY]: JSON.stringify({
      conversation: { autoSpeak: false, voiceResponses: true },
    }),
  });
  const upgraded = readChiefPreferences(legacy);
  assert.equal(upgraded.conversation.autoSpeak, true);
  assert.equal(upgraded.conversation.speechChoice, true);
  assert.equal(shouldSpeakReply({ source: "text", preferences: upgraded }), true);
  assert.equal(readChiefPreferences(legacy).conversation.autoSpeak, true);
});

test("CHIEF settings stays inside the room and drops the CEO settings detour", () => {
  const page = readFileSync(
    new URL("../src/components/chief/ChiefPage.jsx", import.meta.url),
    "utf8"
  );
  const dashboard = readFileSync(
    new URL("../src/ForwardFreedomDashboard.jsx", import.meta.url),
    "utf8"
  );
  const settings = readFileSync(
    new URL("../src/components/chief/ChiefSettings.jsx", import.meta.url),
    "utf8"
  );
  assert.match(page, /setSettingsOpen\(true\)/);
  assert.match(page, /<ChiefSettings/);
  assert.doesNotMatch(page, /onOpenSettings/);
  assert.doesNotMatch(dashboard, /chiefFace === "settings"/);
  assert.doesNotMatch(dashboard, /initialView=\{chiefFace === "settings"/);
  assert.match(settings, /fetchChiefVoiceCatalog/);
  assert.doesNotMatch(settings, /ELEVENLABS_API_KEY|xi-api-key/);
  assert.doesNotMatch(page, /ELEVENLABS_API_KEY|xi-api-key/);
});
