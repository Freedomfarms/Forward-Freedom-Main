// CHIEF voice stays outside the turn machine. These tests cover the lifecycle,
// the speech boundary, and the ElevenLabs adapter. They do not call a model.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefVoice } from "../api/chief/voice.js";
import { handleChiefVoiceTrace } from "../api/chief/voice/trace.js";
import { handleChiefVoices } from "../api/chief/voice/voices.js";
import {
  projectElevenVoices,
  publicVoiceConfig,
  sanitizeSpeechRequest,
} from "../server/chief/voice/elevenlabs.js";
import { recordVoiceTrace, sanitizeVoiceTrace } from "../server/chief/voice/trace.js";
import { MemoryTraceStore } from "../server/chief/traces/store.js";
import { createSpeechInput } from "../src/components/chief/voice/speechInput.js";
import {
  isWakePhraseOnly,
  phaseAfterCoreTap,
  recognitionErrorCode,
  spokenText,
  transcriptForTurn,
  VOICE_PHASE,
} from "../src/components/chief/voice/voiceMachine.js";
import { normalizeVoiceSettings } from "../src/components/chief/voice/voiceSettings.js";

function mockResponse() {
  const headers = {};
  const state = { statusCode: null, body: null, raw: null };
  const response = {
    headersSent: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(payload) {
      state.body = payload;
      response.headersSent = true;
      return response;
    },
    end(payload) {
      state.raw = payload;
      response.headersSent = true;
    },
  };
  return { response, headers, state };
}

function request(method, body = {}) {
  return { method, headers: {}, body, socket: { remoteAddress: "127.0.0.1" }, on() {} };
}

test("voice tap and transcript rules stay outside the turn", () => {
  assert.equal(phaseAfterCoreTap(VOICE_PHASE.IDLE), VOICE_PHASE.LISTENING);
  assert.equal(phaseAfterCoreTap(VOICE_PHASE.LISTENING), VOICE_PHASE.IDLE);
  assert.equal(phaseAfterCoreTap(VOICE_PHASE.SPEAKING), VOICE_PHASE.LISTENING);
  assert.equal(phaseAfterCoreTap(VOICE_PHASE.THINKING), VOICE_PHASE.LISTENING);
  assert.equal(phaseAfterCoreTap(VOICE_PHASE.ERROR), VOICE_PHASE.LISTENING);
  assert.equal(transcriptForTurn("  what about vendor x  "), "what about vendor x");
  assert.equal(transcriptForTurn("   "), "");
  assert.equal(transcriptForTurn("Hey Chief."), "");
  assert.equal(isWakePhraseOnly("hey chief"), true);
  assert.equal(
    transcriptForTurn("Hey Chief, what about vendor x?"),
    "Hey Chief, what about vendor x?"
  );
  assert.equal(recognitionErrorCode("not-allowed"), "permission_denied");
  assert.equal(recognitionErrorCode("no-speech"), "");
  assert.equal(spokenText("Hello **world** [docs](https://example.com)."), "Hello world docs.");
});

test("voice settings do not keep a provider secret", () => {
  const settings = normalizeVoiceSettings({
    provider: "browser",
    voiceId: "abc123def456",
    speed: 9,
    fallbackEnabled: true,
    apiKey: "secret",
  });
  assert.equal(settings.provider, "elevenlabs");
  assert.equal(settings.voiceId, "abc123def456");
  assert.equal(settings.speed, 1.2);
  assert.equal(settings.fallbackEnabled, true);
  assert.equal("apiKey" in settings, false);
});

test("speech input emits one final transcript and keeps interim local", () => {
  const created = [];
  function Recognition() {
    created.push(this);
  }
  Recognition.prototype.start = function start() {};
  Recognition.prototype.abort = function abort() {};
  Recognition.prototype.stop = function stop() {};
  const finals = [];
  const interim = [];
  const input = createSpeechInput({
    Recognition,
    onInterim: (text) => interim.push(text),
    onFinal: (text) => finals.push(text),
  });
  assert.equal(input.start(), true);
  created[0].onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "hel" }, isFinal: false, length: 1 }],
  });
  created[0].onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "hello chief" }, isFinal: true, length: 1 }],
  });
  created[0].onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: "hello chief" }, isFinal: true, length: 1 }],
  });
  assert.deepEqual(interim, ["hel"]);
  assert.deepEqual(finals, ["hello chief"]);
});

test("speech request validation rejects arbitrary urls and empty text", () => {
  const env = { ELEVENLABS_API_KEY: "server-key", ELEVENLABS_MODEL_ID: "eleven_flash_v2_5" };
  assert.equal(sanitizeSpeechRequest({ text: "  " }, env).code, "invalid_request");
  assert.equal(
    sanitizeSpeechRequest({ text: "Hello", voiceId: "https://evil.example/voice" }, env).code,
    "invalid_request"
  );
  const clean = sanitizeSpeechRequest(
    {
      text: "Hello",
      voiceId: "voiceid1234",
      modelId: "not-a-model",
      settings: { speed: 4, stability: -1, extra: "nope" },
    },
    env
  );
  assert.equal(clean.voiceId, "voiceid1234");
  assert.equal(clean.modelId, "eleven_flash_v2_5");
  assert.equal(clean.settings.speed, 1.2);
  assert.equal(clean.settings.stability, 0);
  assert.equal(clean.settings.extra, undefined);
  assert.equal(publicVoiceConfig(env).configured, true);
  assert.equal(JSON.stringify(publicVoiceConfig(env)).includes("server-key"), false);
});

test("voice list projection drops secrets and preview urls", () => {
  const voices = projectElevenVoices({
    voices: [
      {
        voice_id: "voiceid1234",
        name: "Aria",
        preview_url: "https://example.com/secret-preview",
        samples: [{ audio: "raw" }],
        labels: { language: "en", accent: "american", token: "nope-not-a-label-key-wait" },
      },
    ],
    xi_api_key: "nope",
  });
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, "Aria");
  assert.equal(voices[0].language, "en");
  assert.equal(voices[0].preview_url, undefined);
  assert.equal(JSON.stringify(voices).includes("secret"), false);
});

test("elevenlabs synthesis stays on the server and returns audio", async () => {
  const { response, headers, state } = mockResponse();
  const seen = [];
  await handleChiefVoice(
    request("POST", { text: "Hello from chief", voiceId: "voiceid1234" }),
    response,
    {
      limit: async () => true,
      authenticate: async () => ({ uid: "user-1" }),
      env: { ELEVENLABS_API_KEY: "server-key", ELEVENLABS_MODEL_ID: "eleven_multilingual_v2" },
      fetchImpl: async (url, init) => {
        seen.push({ url, authorization: init.headers["xi-api-key"] });
        return {
          ok: true,
          status: 200,
          headers: { get: () => "audio/mpeg" },
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      },
    }
  );
  assert.equal(state.statusCode, 200);
  assert.equal(headers["Content-Type"], "audio/mpeg");
  assert.equal(Buffer.isBuffer(state.raw), true);
  assert.equal(seen[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voiceid1234");
  assert.equal(seen[0].authorization, "server-key");
  assert.equal(JSON.stringify(state.body || {}).includes("server-key"), false);
});

test("missing elevenlabs key does not fall through to the browser from the server", async () => {
  const { response, state } = mockResponse();
  await handleChiefVoice(request("POST", { text: "Hello" }), response, {
    limit: async () => true,
    authenticate: async () => ({ uid: "user-1" }),
    env: {},
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(state.statusCode, 503);
  assert.equal(state.body.code, "not_configured");
});

test("voice list endpoint returns metadata only", async () => {
  const { response, state } = mockResponse();
  await handleChiefVoices(request("GET"), response, {
    limit: async () => true,
    authenticate: async () => ({ uid: "user-1" }),
    env: { ELEVENLABS_API_KEY: "server-key" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        voices: [{ voice_id: "voiceid1234", name: "Aria", labels: { language: "en" } }],
      }),
    }),
  });
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.voices[0].id, "voiceid1234");
  assert.equal(JSON.stringify(state.body).includes("server-key"), false);
});

test("voice traces keep lifecycle metadata and drop transcript text", async () => {
  assert.equal(
    sanitizeVoiceTrace({
      event: "voice.error",
      detail: { stage: "stt", code: "permission_denied", text: "secret words", audio: "raw" },
    }).detail.text,
    undefined
  );
  assert.equal(sanitizeVoiceTrace({ event: "voice.leak", detail: { stage: "stt" } }), null);
  assert.equal(sanitizeVoiceTrace({ event: "voice.error", detail: { stage: "stt" } }), null);
  const store = new MemoryTraceStore();
  const saved = await recordVoiceTrace({
    userId: "user-1",
    event: "voice.listen_started",
    sessionId: "session-1",
    detail: { stage: "stt" },
    status: "ok",
    store,
  });
  assert.equal(saved.steps[0].stepType, "VOICE");
  assert.equal(saved.steps[0].name, "voice.listen_started");
  assert.deepEqual(saved.steps[0].detail, { stage: "stt" });
  assert.equal(JSON.stringify(saved).includes("microphone"), false);

  const { response, state } = mockResponse();
  await handleChiefVoiceTrace(
    request("POST", {
      event: "voice.transcription_completed",
      sessionId: "session-1",
      detail: { stage: "stt", text: "what about vendor x" },
    }),
    response,
    {
      limit: async () => true,
      authenticate: async () => ({ uid: "user-1" }),
      store,
    }
  );
  assert.equal(state.statusCode, 202);
  assert.equal(state.body.saved, true);
  const stored = store.traces[1];
  assert.equal(JSON.stringify(stored).includes("vendor"), false);
  assert.deepEqual(stored.steps[0].detail, { stage: "stt" });
});
