import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { handleCaptureToken } from "../api/chief/capture-token.js";
import { handleExternalCapture } from "../api/chief/external-capture.js";
import { acceptCapturedConversation } from "../server/chief/archive/capture.js";
import { MemoryCaptureCredential } from "../server/chief/archive/captureStore.js";
import { createCaptureToken } from "../server/chief/archive/captureToken.js";
import { MemoryExternalArchive } from "../server/chief/archive/store.js";
import { searchOwnedHistories } from "../server/chief/runtime/recall.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";
import { extractSnapshot, shouldCapture } from "../extension/src/extract.js";
import {
  applyResult,
  dueItems,
  emptyState,
  enqueue,
  fingerprint,
  retryFailed,
  setOrigin,
  setPaused,
  setProviderEnabled,
  setToken,
  settingsView,
  visibleStatus,
} from "../extension/src/queue.js";
import {
  captureBody,
  interpretResponse,
  normalizeOrigin,
  payloadTooLarge,
} from "../extension/src/transport.js";

const previousKeys = process.env.FFF_ENCRYPTION_KEYS;

function useKeys() {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  delete process.env.FFF_ENCRYPTION_ACTIVE_VERSION;
  resetKeyProviderCache();
}

test.before(() => {
  useKeys();
});

test.after(() => {
  if (previousKeys == null) delete process.env.FFF_ENCRYPTION_KEYS;
  else process.env.FFF_ENCRYPTION_KEYS = previousKeys;
  resetKeyProviderCache();
});

function mockResponse() {
  const state = { statusCode: null, body: null };
  const response = {
    setHeader() {},
    getHeader() {},
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(payload) {
      state.body = payload;
      return response;
    },
  };
  return { response, state };
}

function request({ method = "POST", body = {}, headers = {}, uid = "user-a" } = {}) {
  return {
    method,
    headers,
    body,
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    uid,
  };
}

const allow = async () => true;
const authenticate = async (req) => ({ uid: req.uid });

function snapshot(messages) {
  return {
    provider: "claude",
    externalId: "2222222222222222",
    title: "Bridge",
    messages: messages ?? [
      {
        role: "user",
        externalId: "m-user",
        text: "Where is the lighthouse?",
        sourceCreatedAt: "2026-02-02T00:00:00.000Z",
      },
      {
        role: "assistant",
        externalId: "m-assistant",
        text: "Use the archive.",
        sourceCreatedAt: "2026-02-02T00:01:00.000Z",
      },
    ],
  };
}

function extraMessage() {
  return {
    role: "assistant",
    externalId: "m-added",
    text: "A later note.",
    sourceCreatedAt: "2026-02-02T00:02:00.000Z",
  };
}

async function postToken(credentials, body, uid = "user-a") {
  const { response, state } = mockResponse();
  await handleCaptureToken(request({ body, uid }), response, {
    credentials,
    authenticate,
    enforceRateLimit: allow,
  });
  return state;
}

async function postCapture(ctx, body, token = ctx.token, method = "POST") {
  const { response, state } = mockResponse();
  await handleExternalCapture(
    request({
      method,
      body,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    response,
    {
      credentials: ctx.credentials,
      store: ctx.store,
      audit: ctx.audit,
      enforceRateLimit: allow,
    }
  );
  return state;
}

async function arm(provider = "claude") {
  const credentials = new MemoryCaptureCredential();
  const store = new MemoryExternalArchive();
  const audit = new MemoryAuditLog();
  const issued = await postToken(credentials, { action: "issue" });
  assert.equal(issued.statusCode, 200);
  assert.equal(typeof issued.body.token, "string");
  const enabled = await postToken(credentials, {
    action: "update",
    [`${provider}Enabled`]: true,
  });
  assert.equal(enabled.body[`${provider}Enabled`], true);
  return { credentials, store, audit, token: issued.body.token };
}

function node(attrs, text) {
  return {
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    textContent: text,
  };
}

function fakeDocument({ selectors = {}, lists = {} } = {}) {
  return {
    querySelector(selector) {
      return selectors[selector] ?? null;
    },
    querySelectorAll(selector) {
      return lists[selector] ?? [];
    },
  };
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test("capture token status never returns the token after it is issued", async () => {
  const credentials = new MemoryCaptureCredential();
  const issued = await postToken(credentials, { action: "issue" });
  const { response, state } = mockResponse();
  await handleCaptureToken(request({ method: "GET" }), response, {
    credentials,
    authenticate,
    enforceRateLimit: allow,
  });
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.issued, true);
  assert.equal(Object.hasOwn(state.body, "token"), false);
  assert.equal(JSON.stringify(state.body).includes(issued.body.token), false);
});

test("live capture reuses the archive and does not write durable notes", async () => {
  const ctx = await arm();
  const captureSource = readFileSync(
    new URL("../server/chief/archive/capture.js", import.meta.url),
    "utf8"
  );
  const routeSource = readFileSync(
    new URL("../api/chief/external-capture.js", import.meta.url),
    "utf8"
  );
  assert.equal(captureSource.includes("retainConversationMemories"), false);
  assert.equal(routeSource.includes("retainConversationMemories"), false);

  const stored = await postCapture(ctx, snapshot());
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.body.status, "imported");
  assert.equal(stored.body.messageCount, 2);
  assert.equal(JSON.stringify(stored.body).includes("lighthouse"), false);

  const detail = await ctx.store.get("user-a", [...ctx.store.conversations.keys()][0]);
  assert.equal(detail.provider, "claude");
  assert.equal(detail.messages[0].externalId, "m-user");
  assert.equal(detail.messages[1].role, "assistant");
  assert.equal(detail.sourceUrl, "https://claude.ai/chat/2222222222222222");
  const ciphertext = ctx.store.messages.map((message) => message.contentCiphertext).join("\n");
  assert.equal(ciphertext.includes("lighthouse"), false);
  assert.equal(ctx.audit.entries[0].action, "external_capture");
  assert.equal(ctx.audit.entries[0].summary.includes("lighthouse"), false);
  assert.match(ctx.audit.entries[0].summary, /messages=2/);

  const found = await searchOwnedHistories(
    {
      async searchConversations() {
        return { conversations: [] };
      },
    },
    ctx.store,
    "user-a",
    { query: "lighthouse" }
  );
  assert.equal(found.conversations[0].provider, "claude");
  assert.equal(found.conversations[0].externalId, "2222222222222222");
});

test("duplicate capture is idempotent and an added message updates without copying ids", async () => {
  const ctx = await arm();
  const first = await postCapture(ctx, snapshot());
  const second = await postCapture(ctx, snapshot());
  assert.equal(second.body.status, "duplicate");
  assert.equal(ctx.store.messages.length, 2);

  const updated = await postCapture(ctx, snapshot([...snapshot().messages, extraMessage()]));
  assert.equal(updated.body.status, "updated");
  assert.equal(updated.body.messageCount, 3);
  const detail = await ctx.store.get(
    "user-a",
    first.body.externalId ? [...ctx.store.conversations.keys()][0] : ""
  );
  const ids = detail.messages.map((message) => message.externalId);
  assert.deepEqual(ids, ["m-user", "m-assistant", "m-added"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("a shorter snapshot does not replace a longer archived conversation", async () => {
  const ctx = await arm();
  await postCapture(ctx, snapshot([...snapshot().messages, extraMessage()]));
  let writes = 0;
  const upsert = ctx.store.upsert.bind(ctx.store);
  ctx.store.upsert = async (...args) => {
    writes += 1;
    return upsert(...args);
  };
  const shorter = await postCapture(ctx, snapshot());
  assert.equal(shorter.statusCode, 409);
  assert.equal(shorter.body.code, "PARTIAL");
  assert.equal(writes, 0);
  assert.equal(ctx.store.messages.length, 3);
  assert.equal(JSON.stringify(shorter.body).includes("lighthouse"), false);
  const status = await ctx.credentials.status("user-a");
  assert.equal(status.lastErrorCode, "PARTIAL");
});

test("oversized, rejected, disabled, paused, and bad tokens do not write", async () => {
  const ctx = await arm();
  const oversized = await postCapture(
    ctx,
    snapshot(
      Array.from({ length: 201 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        externalId: `m-${index}-message`,
        text: "note",
      }))
    )
  );
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.body.code, "OVERSIZED");
  assert.equal(ctx.store.conversations.size, 0);

  const rejected = await postCapture(
    ctx,
    snapshot([{ role: "tool", externalId: "m-tool", text: "no" }])
  );
  assert.equal(rejected.body.code, "REJECTED");
  assert.equal(ctx.store.conversations.size, 0);

  const other = await arm("chatgpt");
  const disabled = await postCapture(ctx, { ...snapshot(), provider: "chatgpt" });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, "DISABLED");

  await postToken(ctx.credentials, { action: "update", paused: true });
  const paused = await postCapture(ctx, snapshot());
  assert.equal(paused.statusCode, 403);
  assert.equal(paused.body.code, "PAUSED");
  await postToken(ctx.credentials, { action: "update", paused: false });

  const missing = await postCapture(ctx, snapshot(), "");
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.code, "AUTH");

  const forged = createCaptureToken("user-a");
  const mismatch = await postCapture(ctx, snapshot(), forged);
  assert.equal(mismatch.statusCode, 401);

  await postToken(ctx.credentials, { action: "revoke" });
  const revoked = await postCapture(ctx, snapshot());
  assert.equal(revoked.statusCode, 401);
  assert.equal(ctx.store.conversations.size, 0);
  assert.equal(other.store.conversations.size, 0);
});

test("capture ignores a body user id and leaves another archive untouched", async () => {
  const owner = await arm();
  const stranger = await arm();
  await postCapture(owner, snapshot());
  const crossed = await postCapture(stranger, { ...snapshot(), userId: "user-b" });
  assert.equal(crossed.body.status, "imported");
  const ownerDetail = await owner.store.get("user-a", [...owner.store.conversations.keys()][0]);
  assert.equal(ownerDetail.messages.length, 2);
  assert.equal([...stranger.store.conversations.values()][0].userId, "user-a");
  assert.equal((await stranger.store.list("user-b")).length, 0);

  const shared = new MemoryExternalArchive();
  const credentials = new MemoryCaptureCredential();
  const audit = new MemoryAuditLog();
  const first = await postToken(credentials, { action: "issue" }, "user-a");
  const second = await postToken(credentials, { action: "issue" }, "user-b");
  await postToken(credentials, { action: "update", claudeEnabled: true }, "user-a");
  await postToken(credentials, { action: "update", claudeEnabled: true }, "user-b");
  await postCapture({ credentials, store: shared, audit, token: first.body.token }, snapshot());
  await postCapture(
    { credentials, store: shared, audit, token: second.body.token },
    { ...snapshot(), externalId: "3333333333333333", userId: "user-a" }
  );
  assert.equal((await shared.list("user-a")).length, 1);
  assert.equal((await shared.list("user-b"))[0].externalId, "3333333333333333");
  assert.equal((await shared.list("user-a"))[0].externalId, "2222222222222222");
});

test("disabled account and store failure are not reported as saved", async () => {
  const ctx = await arm();
  ctx.credentials.accounts.set("user-a", { isDisabled: true });
  const disabled = await postCapture(ctx, snapshot());
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, "AUTH");
  assert.equal(ctx.store.conversations.size, 0);

  ctx.credentials.accounts.set("user-a", { isDisabled: false });
  ctx.store.upsert = async () => {
    throw new Error("database unavailable");
  };
  const failed = await postCapture(ctx, snapshot());
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.code, "STORE");
  assert.equal(failed.body.status, undefined);
});

test("audit failure after a stored capture still reports the archive result", async () => {
  const ctx = await arm();
  ctx.audit.write = async () => {
    throw new Error("audit unavailable");
  };
  const stored = await postCapture(ctx, snapshot());
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.body.status, "imported");
  assert.equal(ctx.store.conversations.size, 1);
});

test("direct accept uses the caller id when the body names someone else", async () => {
  const credentials = new MemoryCaptureCredential();
  const store = new MemoryExternalArchive();
  const token = createCaptureToken("user-a");
  await credentials.issue("user-a", token);
  await credentials.updateControls("user-a", { claudeEnabled: true });
  const result = await acceptCapturedConversation(
    "user-a",
    { ...snapshot(), userId: "user-b" },
    { credentials, store, audit: new MemoryAuditLog() }
  );
  assert.equal(result.status, "imported");
  assert.equal([...store.conversations.values()][0].userId, "user-a");
  assert.equal((await store.list("user-b")).length, 0);
});

test("queue retries transient failures, stops on auth, and restores after restart", () => {
  const now = 1_000_000;
  let state = setOrigin(emptyState(), "https://freedom.example");
  state = setToken(state, "ffc.example.secretsecretsecretsecretsecretsecretsecret");
  state = setProviderEnabled(state, "claude", true);
  const body = snapshot();
  state = enqueue(state, body, now);
  assert.equal(dueItems(state, now).length, 1);
  assert.equal(enqueue(state, body, now).items.length, 1);
  assert.equal(fingerprint(body), fingerprint(body));

  const edited = snapshot([...body.messages, extraMessage()]);
  state = enqueue(state, edited, now);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].messages.length, 3);

  let current = state;
  let clock = now;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const due = dueItems(current, clock);
    assert.equal(due.length, 1);
    current = applyResult(current, due[0], { ok: false, retry: true, code: "TRANSIENT" }, clock);
    clock = current.items[0].nextAttemptAt ?? clock + 1;
  }
  assert.equal(current.items[0].stopped, true);
  assert.equal(visibleStatus(current).label, "Failed");
  assert.equal(JSON.stringify(current).includes("Infinity"), false);
  const restored = JSON.parse(JSON.stringify(current));
  assert.equal(restored.items[0].stopped, true);
  assert.equal(retryFailed(restored, clock).items[0].stopped, false);

  const authed = applyResult(state, state.items[0], { ok: false, retry: false, code: "AUTH" }, now);
  assert.equal(authed.authExpired, true);
  assert.equal(dueItems(authed, now + 999_999).length, 0);
  assert.equal(visibleStatus(authed).label, "Signed out");
  const resumed = setToken(authed, authed.token, now + 5);
  assert.equal(resumed.authExpired, false);
  assert.equal(dueItems(resumed, now + 5).length, 1);

  const paused = setPaused(enqueue(resumed, edited, now), true, now);
  assert.equal(dueItems(paused, now).length, 0);
  const view = settingsView({
    ...resumed,
    items: [{ messages: [{ text: "lighthouse" }], token: "secret" }],
  });
  assert.equal(JSON.stringify(view).includes("lighthouse"), false);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("successful queue removal keeps the accepted hash and ignores a repeated snapshot", () => {
  let state = setOrigin(emptyState(), "https://freedom.example");
  state = setToken(state, "ffc.example.secretsecretsecretsecretsecretsecretsecret");
  state = setProviderEnabled(state, "chatgpt", true);
  const body = { ...snapshot(), provider: "chatgpt", externalId: "3333333333333333" };
  state = enqueue(state, body, 50);
  state = applyResult(state, state.items[0], { ok: true, retry: false, code: "imported" }, 50);
  assert.equal(state.items.length, 0);
  assert.equal(visibleStatus(state).label, "Captured");
  assert.equal(enqueue(state, body, 60).items.length, 0);
  assert.equal(setProviderEnabled(emptyState(), "claude", false).providers.claude, false);
});

test("extractor sends only recognized completed provider conversations", () => {
  const claudeNodes = [
    node(
      { "data-testid": "user-message", "data-message-id": "m-user" },
      "Where is the lighthouse?"
    ),
    node(
      { "data-testid": "assistant-message", "data-message-id": "m-assistant" },
      "Use the archive."
    ),
  ];
  const claude = extractSnapshot(
    fakeDocument({
      lists: {
        "[data-testid='user-message'], [data-testid='assistant-message']": claudeNodes,
      },
    }),
    "https://claude.ai/chat/2222222222222222"
  );
  assert.equal(shouldCapture(claude).ok, true);
  assert.equal(claude.messages[0].externalId, "m-user");

  const streaming = extractSnapshot(
    fakeDocument({
      selectors: { "[data-testid='stop-button']": { id: "stop" } },
      lists: {
        "[data-testid='user-message'], [data-testid='assistant-message']": claudeNodes,
      },
    }),
    "https://claude.ai/chat/2222222222222222"
  );
  assert.equal(shouldCapture(streaming).reason, "incomplete");

  const unrecognized = extractSnapshot(fakeDocument(), "https://claude.ai/new");
  assert.equal(shouldCapture(unrecognized).ok, false);
  assert.equal(unrecognized.messages.length, 0);

  const foreign = extractSnapshot(fakeDocument(), "https://example.com/chat/2222222222222222");
  assert.equal(foreign.reason, "unrecognized");

  const chat = extractSnapshot(
    fakeDocument({
      lists: {
        "[data-message-author-role]": [
          node({ "data-message-author-role": "user", "data-message-id": "u1" }, "Hello archive"),
          node({ "data-message-author-role": "assistant", "data-message-id": "a1" }, "Hello back"),
        ],
      },
    }),
    "https://chatgpt.com/c/3333333333333333"
  );
  assert.equal(shouldCapture(chat).ok, true);
  assert.equal(chat.provider, "chatgpt");
  assert.equal(chat.messages[1].externalId, "a1");
});

test("capture responses do not keep transcript text and origins stay explicit", () => {
  const result = interpretResponse(500, { error: "lighthouse transcript", code: "STORE" });
  assert.equal(result.retry, true);
  assert.equal(result.code, "TRANSIENT");
  assert.equal(JSON.stringify(result).includes("lighthouse"), false);
  assert.equal(interpretResponse(401, { code: "AUTH" }).retry, false);
  assert.equal(interpretResponse(409, { code: "PARTIAL" }).code, "PARTIAL");
  assert.equal(interpretResponse(200, { status: "duplicate" }).ok, true);
  assert.equal(interpretResponse(200, { status: "saved" }).ok, false);
  assert.equal(normalizeOrigin("https://freedom.example/app"), "https://freedom.example");
  assert.equal(normalizeOrigin("https://claude.ai"), null);
  assert.equal(normalizeOrigin("http://localhost:3001"), "http://localhost:3001");
  assert.equal(normalizeOrigin("http://example.com"), null);
  const huge = snapshot(
    Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      externalId: `message-${index}-id`,
      text: "x".repeat(100_000),
    }))
  );
  let state = setOrigin(
    setToken(
      setProviderEnabled(emptyState(), "claude", true),
      "ffc.example.secretsecretsecretsecretsecretsecretsecret"
    ),
    "https://freedom.example"
  );
  state = enqueue(state, huge, 10);
  assert.equal(payloadTooLarge(state.items[0]), true);
  assert.equal(state.items[0].lastCode, "OVERSIZED");
  assert.equal(dueItems(state, 10).length, 0);
});

test("extracted snapshots queue for the enabled provider and post to capture", async () => {
  const claude = extractSnapshot(
    fakeDocument({
      lists: {
        "[data-testid='user-message'], [data-testid='assistant-message']": [
          node(
            { "data-testid": "user-message", "data-message-id": "m-user" },
            "Where is the lighthouse?"
          ),
          node(
            { "data-testid": "assistant-message", "data-message-id": "m-assistant" },
            "Use the archive."
          ),
        ],
      },
    }),
    "https://claude.ai/chat/2222222222222222"
  );
  const chatgpt = extractSnapshot(
    fakeDocument({
      lists: {
        "[data-message-author-role]": [
          node({ "data-message-author-role": "user", "data-message-id": "u1" }, "Hello archive"),
          node({ "data-message-author-role": "assistant", "data-message-id": "a1" }, "Hello back"),
        ],
      },
    }),
    "https://chatgpt.com/c/3333333333333333"
  );
  assert.equal(claude.provider, "claude");
  assert.deepEqual(
    claude.messages.map((message) => message.role),
    ["user", "assistant"]
  );
  assert.equal(chatgpt.provider, "chatgpt");
  assert.equal(chatgpt.externalId, "3333333333333333");
  assert.equal(chatgpt.messages[1].externalId, "a1");
  assert.equal(shouldCapture(claude).ok, true);
  assert.equal(shouldCapture(chatgpt).ok, true);

  const ctx = await arm("claude");
  let state = setProviderEnabled(
    setToken(setOrigin(emptyState(), "https://freedom.example"), ctx.token),
    "claude",
    true
  );
  state = enqueue(state, { ...claude, title: "Bridge" }, 20);
  state = enqueue(state, { ...chatgpt, title: "Other" }, 20);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].provider, "claude");
  assert.equal(state.items[0].messages.length, 2);

  const sent = await postCapture(ctx, captureBody(state.items[0]));
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.status, "imported");
  assert.equal(ctx.store.messages.length, 2);
  assert.equal(JSON.stringify(sent.body).includes("lighthouse"), false);

  const disabled = await postCapture(ctx, {
    ...captureBody(state.items[0]),
    provider: "chatgpt",
    externalId: chatgpt.externalId,
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.body.code, "DISABLED");

  const failed = applyResult(state, state.items[0], interpretResponse(503, {}), 20);
  assert.equal(failed.items[0].lastCode, "TRANSIENT");
  assert.equal(failed.items[0].stopped, false);
  assert.equal(dueItems(failed, failed.items[0].nextAttemptAt).length, 1);

  await postToken(ctx.credentials, { action: "revoke" });
  const revoked = await postCapture(ctx, captureBody(state.items[0]));
  assert.equal(revoked.statusCode, 401);
  assert.equal(revoked.body.code, "AUTH");
  const stopped = applyResult(failed, failed.items[0], interpretResponse(401, revoked.body), 30);
  assert.equal(stopped.authExpired, true);
  assert.equal(dueItems(stopped, 999_999).length, 0);
  assert.equal(ctx.store.conversations.size, 1);
});

test("extension files do not embed service secrets or provider session calls", () => {
  const root = new URL("../extension/", import.meta.url);
  const files = walk(root.pathname);
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(/sk-[A-Za-z0-9]/.test(text), false);
  assert.equal(text.includes("FFF_ENCRYPTION"), false);
  assert.equal(text.includes("BEGIN PRIVATE"), false);
  assert.equal(text.includes("backend-api"), false);
  assert.equal(text.includes("all_urls"), false);
  assert.equal(text.includes("console.log"), false);
  const manifest = JSON.parse(
    readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
  assert.deepEqual(manifest.host_permissions, ["https://claude.ai/*", "https://chatgpt.com/*"]);
  assert.equal(JSON.stringify(manifest).includes("cookies"), false);
});
