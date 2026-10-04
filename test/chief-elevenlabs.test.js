// ElevenLabs stays server-side. Voice ids come from the live list. Typed and
// spoken turns still enter CHIEF through /api/chief/chat.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleChiefSpeak } from "../api/chief/speak.js";
import { handleChiefVoices } from "../api/chief/voices.js";
import {
  ELEVENLABS_SPEECH_URL,
  ELEVENLABS_VOICES_URL,
  isVoiceId,
  listElevenLabsVoices,
  openElevenLabsSpeech,
  plainSpeechText,
  publicVoices,
  readElevenLabsApiKey,
  upstreamDetail,
} from "../server/chief/voice/elevenlabs.js";
import { takePcmSamples, transcriptFromSpeechEvent } from "../src/utils/chiefSpeech.js";

const SECRET = "xi-test-key-should-not-leak";
const VOICE = "21m00Tcm4TlvDq8ikWAM";

const silentLogger = { error() {}, log() {}, warn() {} };

function read(relativePath) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function mockResponse() {
  const headers = {};
  const chunks = [];
  const state = { statusCode: null, body: null, ended: false };
  const response = {
    headersSent: false,
    writableEnded: false,
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
      response.writableEnded = true;
      return response;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      response.headersSent = true;
    },
    end() {
      state.ended = true;
      response.writableEnded = true;
    },
    flushHeaders() {},
  };
  return { response, headers, chunks, state };
}

function request({ method = "GET", body = {}, uid = "user-1" } = {}) {
  return {
    method,
    headers: {},
    body,
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    on() {},
    uid,
  };
}

const auth = (uid) => async (req) => ({ uid: req.uid ?? uid });

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("voice list keeps voice_id and name and drops samples", () => {
  const voices = publicVoices({
    voices: [
      {
        voice_id: VOICE,
        name: "Aria",
        category: "premade",
        samples: [{ file_name: "secret.wav" }],
        preview_url: "https://example.test/preview",
      },
      { voice_id: "short", name: "Nope" },
      { voice_id: VOICE, name: "Aria duplicate" },
    ],
  });
  assert.deepEqual(voices, [{ voice_id: VOICE, name: "Aria", category: "premade" }]);
  assert.equal(JSON.stringify(voices).includes("secret.wav"), false);
  assert.equal(JSON.stringify(voices).includes("preview"), false);
});

test("upstream errors keep the status detail and drop the api key", () => {
  const detail = upstreamDetail(
    JSON.stringify({
      detail: { status: "invalid_api_key", message: `Invalid ${SECRET}` },
    }),
    SECRET
  );
  assert.match(detail, /Invalid \[redacted\]/);
  assert.equal(detail.includes(SECRET), false);
});

test("a missing key does not call ElevenLabs", async () => {
  let called = false;
  const result = await listElevenLabsVoices({
    apiKey: "",
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { voices: [] });
    },
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.message, "ElevenLabs is not configured.");
  assert.equal(readElevenLabsApiKey({}), "");
});

test("voice list uses v2 and xi-api-key, and pages", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const page = String(url).includes("next_page_token") ? 2 : 1;
    if (page === 1) {
      return jsonResponse(200, {
        voices: [{ voice_id: VOICE, name: "Aria", category: "premade", samples: [{ secret: 1 }] }],
        has_more: true,
        next_page_token: "page-2",
      });
    }
    return jsonResponse(200, {
      voices: [{ voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", category: "premade" }],
      has_more: false,
      next_page_token: null,
    });
  };
  const result = await listElevenLabsVoices({ fetchImpl, apiKey: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.voices.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.startsWith(ELEVENLABS_VOICES_URL), true);
  assert.equal(calls[0].init.headers["xi-api-key"], SECRET);
  assert.equal(JSON.stringify(result.voices).includes(SECRET), false);
  assert.equal(JSON.stringify(result.voices).includes("secret"), false);
});

test("voice list failure reports the upstream status", async () => {
  const logs = [];
  const http = mockResponse();
  await handleChiefVoices(request(), http.response, {
    authenticate: auth("user-1"),
    env: { ELEVENLABS_API_KEY: SECRET },
    logger: { error(_message, fields) { logs.push(fields); } },
    fetchImpl: async () =>
      jsonResponse(401, { detail: { status: "invalid_api_key", message: `bad ${SECRET}` } }),
  });
  assert.equal(http.state.statusCode, 502);
  assert.equal(http.state.body.status, 401);
  assert.match(http.state.body.error, /ElevenLabs rejected the API key \(401\)/);
  assert.match(http.state.body.error, /bad \[redacted\]/);
  assert.equal(JSON.stringify(http.state.body).includes(SECRET), false);
  assert.equal(http.state.body.provider, "ElevenLabs");
  assert.equal(logs[0].status, 401);
  assert.equal(JSON.stringify(logs).includes(SECRET), false);
});

test("speech streams pcm for the selected voice_id and strips markdown", async () => {
  const calls = [];
  const payload = new Uint8Array([1, 2, 3, 4]);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: { ...init, body: JSON.parse(init.body) } });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  const http = mockResponse();
  await handleChiefSpeak(
    request({
      method: "POST",
      body: { text: "What is **happening** with my vendors?", voice_id: VOICE },
    }),
    http.response,
    {
      authenticate: auth("user-1"),
      env: { ELEVENLABS_API_KEY: SECRET },
      logger: silentLogger,
      fetchImpl,
    }
  );
  assert.equal(http.state.statusCode, 200);
  assert.equal(http.headers["X-Chief-Audio-Format"], "pcm_24000");
  assert.deepEqual(Buffer.concat(http.chunks), Buffer.from(payload));
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${ELEVENLABS_SPEECH_URL}/${VOICE}/stream?output_format=pcm_24000`
  );
  assert.equal(calls[0].init.headers["xi-api-key"], SECRET);
  assert.equal(calls[0].init.body.model_id, "eleven_flash_v2_5");
  assert.equal(calls[0].init.body.text, "What is happening with my vendors?");
  assert.equal(calls[0].init.body.text.includes("**"), false);
  assert.equal(JSON.stringify(http.state.body || {}).includes(SECRET), false);
  assert.equal(Buffer.concat(http.chunks).includes(Buffer.from(SECRET)), false);
});

test("a rejected voice id never reaches ElevenLabs", async () => {
  let called = false;
  const http = mockResponse();
  await handleChiefSpeak(
    request({ method: "POST", body: { text: "Hello", voice_id: "../etc" } }),
    http.response,
    {
      authenticate: auth("user-1"),
      env: { ELEVENLABS_API_KEY: SECRET },
      logger: silentLogger,
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    }
  );
  assert.equal(called, false);
  assert.equal(http.state.statusCode, 400);
  assert.match(http.state.body.error, /Choose an ElevenLabs voice/);
  assert.equal(isVoiceId(VOICE), true);
  assert.equal(isVoiceId("bad id"), false);
});

test("flash model rejection falls back to a second stream", async () => {
  const models = [];
  const opened = await openElevenLabsSpeech({
    apiKey: SECRET,
    voiceId: VOICE,
    text: "**Hello** there",
    logger: silentLogger,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      models.push(body.model_id);
      if (body.model_id === "eleven_flash_v2_5") {
        return jsonResponse(400, { detail: { message: "model does not support tts" } });
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([9]));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  });
  assert.deepEqual(models, ["eleven_flash_v2_5", "eleven_multilingual_v2"]);
  assert.equal(opened.ok, true);
  assert.equal(opened.format, "mp3_44100_128");
  assert.equal(plainSpeechText("**bold** and [vendors](https://example.test)"), "bold and vendors");
});

test("an upstream 401 is not retried", async () => {
  let calls = 0;
  const opened = await openElevenLabsSpeech({
    apiKey: SECRET,
    voiceId: VOICE,
    text: "Hello",
    logger: silentLogger,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(401, { detail: { message: "Invalid API key" } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(opened.ok, false);
  assert.equal(opened.status, 401);
  assert.match(opened.message, /Invalid API key/);
});

test("speech capture and pcm framing stay shared helpers", () => {
  const parsed = transcriptFromSpeechEvent({
    results: [
      { 0: { transcript: "What is happening " }, isFinal: false },
      { 0: { transcript: "with my vendors?" }, isFinal: true },
    ],
  });
  assert.equal(parsed.finalText, "with my vendors?");
  assert.equal(parsed.interim, "What is happening");

  const first = takePcmSamples(new Uint8Array(), new Uint8Array([0x01, 0x00, 0x02]));
  assert.equal(first.samples.length, 1);
  assert.equal(first.samples[0], 1);
  assert.deepEqual(Array.from(first.pending), [0x02]);
  const second = takePcmSamples(first.pending, new Uint8Array([0x01]));
  assert.equal(second.samples[0], 258);
});

test("the browser never receives the ElevenLabs key or a second chat path", () => {
  const clientFiles = [
    "src/utils/chiefApi.js",
    "src/utils/chiefSpeech.js",
    "src/utils/chiefVoicePreference.js",
    "src/components/chief/ChiefPage.jsx",
    "src/components/chief/ChiefComposer.jsx",
    "src/components/chief/ChiefVoiceDock.jsx",
    "src/components/chief/useChiefVoice.js",
  ];
  for (const file of clientFiles) {
    const source = read(file);
    assert.equal(source.includes("ELEVENLABS_API_KEY"), false, file);
    assert.equal(source.includes("xi-api-key"), false, file);
    assert.equal(source.includes("Voices could not be loaded"), false, file);
  }
  const api = read("src/utils/chiefApi.js");
  assert.match(api, /\/api\/chief\/chat/);
  assert.match(api, /\/api\/chief\/voices/);
  assert.match(api, /\/api\/chief\/speak/);
  assert.match(api, /voice_id: voiceId/);
  const page = read("src/components/chief/ChiefPage.jsx");
  assert.match(page, /onTranscript: \(text\) => sendRef\.current\(text\)/);
  assert.match(page, /streamChiefChat/);
  assert.doesNotMatch(page, /\/api\/chief\/speak/);
  assert.match(read("server/index.js"), /\/api\/chief\/voices/);
  assert.match(read("server/index.js"), /\/api\/chief\/speak/);
  assert.match(read("src/components/chief/ChiefComposer.jsx"), /Ask CHIEF anything/);
  assert.match(read("src/components/chief/ChiefComposer.jsx"), /event\.shiftKey/);
  assert.match(read("src/components/chief/ChiefVoiceDock.jsx"), /Provider: ElevenLabs/);
  assert.match(read("src/components/chief/ChiefVoiceDock.jsx"), /ChiefMarkdown|ChiefTranscript/);
});
