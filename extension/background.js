// Service worker. Posts recognized snapshots to the user's Freedom OS origin.
// It does not read provider cookies and does not log transcript text.

import { shouldCapture } from "./src/extract.js";
import {
  applyResult,
  dueItems,
  emptyState,
  enqueue,
  retryFailed,
  setOrigin,
  setPaused,
  setProviderEnabled,
  setToken,
  settingsView,
  visibleStatus,
} from "./src/queue.js";
import { captureBody, interpretResponse, normalizeOrigin } from "./src/transport.js";

const STORAGE_KEY = "freedomCapture";

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...emptyState(), ...(stored?.[STORAGE_KEY] ?? {}) };
}

async function save(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function postItem(state, item) {
  const origin = String(state.origin).replace(/\/$/, "");
  const response = await fetch(`${origin}/api/chief/external-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(captureBody(item)),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return interpretResponse(response.status, { code: body?.code, status: body?.status });
}

async function flush() {
  let state = await load();
  const due = dueItems(state, Date.now());
  for (const item of due) {
    let result;
    try {
      result = await postItem(state, item);
    } catch {
      result = interpretResponse(0, {});
    }
    state = applyResult(state, item, result, Date.now());
    await save(state);
    if (state.authExpired || state.paused) break;
  }
}

let chain = Promise.resolve();

function scheduleFlush() {
  chain = chain.then(flush).catch(() => {});
  return chain;
}

function fromExtensionPage(sender) {
  const url = typeof sender?.url === "string" ? sender.url : "";
  return url.startsWith(chrome.runtime.getURL(""));
}

function fromProviderPage(sender) {
  const url = typeof sender?.url === "string" ? sender.url : "";
  return url.startsWith("https://claude.ai/") || url.startsWith("https://chatgpt.com/");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "page") {
    if (!fromProviderPage(sender)) {
      sendResponse({ accepted: false, reason: "unrecognized" });
      return;
    }
    const decision = shouldCapture(message.snapshot);
    if (!decision.ok) {
      if (decision.reason !== "oversized") {
        sendResponse({ accepted: false, reason: decision.reason });
        return;
      }
      load()
        .then(async (state) => {
          state.lastErrorAt = new Date().toISOString();
          state.lastErrorCode = "OVERSIZED";
          await save(state);
          sendResponse({ accepted: false, reason: "oversized" });
        })
        .catch(() => sendResponse({ accepted: false, reason: "oversized" }));
      return true;
    }
    load()
      .then(async (state) => {
        const next = enqueue(state, message.snapshot);
        await save(next);
        await scheduleFlush();
        sendResponse({ accepted: true });
      })
      .catch(() => sendResponse({ accepted: false, reason: "failed" }));
    return true;
  }
  if (!fromExtensionPage(sender)) {
    sendResponse({ ok: false });
    return;
  }
  if (message.type === "status") {
    load()
      .then((state) =>
        sendResponse({ ok: true, status: visibleStatus(state), settings: settingsView(state) })
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "settings") {
    const origin = normalizeOrigin(message.origin);
    if (!origin) {
      sendResponse({ ok: false, error: "Enter the https origin of your Freedom OS site." });
      return;
    }
    load()
      .then(async (state) => {
        let next = setOrigin(state, origin);
        if (typeof message.token === "string" && message.token.trim()) {
          next = setToken(next, message.token);
        }
        next = setProviderEnabled(next, "claude", message.claude === true);
        next = setProviderEnabled(next, "chatgpt", message.chatgpt === true);
        next = setPaused(next, message.paused === true);
        await save(next);
        await scheduleFlush();
        sendResponse({ ok: true, status: visibleStatus(next) });
      })
      .catch(() => sendResponse({ ok: false, error: "Capture settings could not be saved." }));
    return true;
  }
  if (message.type === "retry") {
    load()
      .then(async (state) => {
        const next = retryFailed(state);
        await save(next);
        await scheduleFlush();
        sendResponse({ ok: true, status: visibleStatus(next) });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("freedom-capture-flush", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  scheduleFlush();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === "freedom-capture-flush") scheduleFlush();
});
