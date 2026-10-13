// Page snapshot for claude.ai and chatgpt.com.
// Selectors are the fixture contract. They were not verified on the live sites.
// An unrecognized page returns no messages and must not be uploaded.

const ID_PATTERN = /^[A-Za-z0-9:_-]{8,80}$/;

export function providerFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "claude.ai") return "claude";
  if (url.hostname === "chatgpt.com") return "chatgpt";
  return null;
}

export function conversationIdFromUrl(provider, href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const id =
    provider === "claude" && parts[0] === "chat"
      ? parts[1]
      : provider === "chatgpt" && parts[0] === "c"
        ? parts[1]
        : "";
  if (!id || id.startsWith("derived:") || !ID_PATTERN.test(id)) return null;
  return id;
}

export function isStreaming(document) {
  if (!document?.querySelector) return false;
  return Boolean(
    document.querySelector("[data-capture-streaming='true']") ||
    document.querySelector("[data-testid='stop-button']")
  );
}

function roleOf(node) {
  const author = node?.getAttribute?.("data-message-author-role");
  if (author === "user" || author === "assistant") return author;
  const testId = node?.getAttribute?.("data-testid");
  if (testId === "user-message") return "user";
  if (testId === "assistant-message") return "assistant";
  return null;
}

function collectNodes(document, provider) {
  if (!document?.querySelectorAll) return null;
  if (provider === "chatgpt") {
    const nodes = [...document.querySelectorAll("[data-message-author-role]")];
    return nodes.length ? nodes : null;
  }
  const preferred = [
    ...document.querySelectorAll("[data-testid='user-message'], [data-testid='assistant-message']"),
  ];
  if (preferred.length) return preferred;
  const fallback = [...document.querySelectorAll("[data-message-author-role]")];
  return fallback.length ? fallback : null;
}

export function extractSnapshot(document, href) {
  const provider = providerFromUrl(href);
  if (!provider) return { recognized: false, reason: "unrecognized", messages: [] };
  const externalId = conversationIdFromUrl(provider, href);
  if (!externalId) {
    return { recognized: false, provider, reason: "missing-id", messages: [] };
  }
  if (isStreaming(document)) {
    return {
      recognized: true,
      provider,
      externalId,
      streaming: true,
      reason: "incomplete",
      messages: [],
    };
  }
  const nodes = collectNodes(document, provider);
  if (!nodes) {
    return { recognized: false, provider, externalId, reason: "unrecognized", messages: [] };
  }
  const messages = [];
  nodes.forEach((node) => {
    const role = roleOf(node);
    const text = typeof node?.textContent === "string" ? node.textContent.trim() : "";
    if (!role || !text) return;
    const id = node.getAttribute?.("data-message-id");
    messages.push({
      role,
      text,
      ...(typeof id === "string" && id.trim() ? { externalId: id.trim() } : {}),
    });
  });
  if (!messages.length) {
    return { recognized: false, provider, externalId, reason: "unrecognized", messages: [] };
  }
  return { recognized: true, provider, externalId, streaming: false, messages, reason: null };
}

export function shouldCapture(snapshot) {
  if (!snapshot?.provider || !snapshot.recognized) {
    return { ok: false, reason: snapshot?.reason || "unrecognized" };
  }
  if (snapshot.streaming) return { ok: false, reason: "incomplete" };
  if (!snapshot.externalId) return { ok: false, reason: "missing-id" };
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  if (messages.length > 200) return { ok: false, reason: "oversized" };
  const hasUser = messages.some((message) => message.role === "user" && message.text);
  const hasAssistant = messages.some((message) => message.role === "assistant" && message.text);
  if (!hasUser || !hasAssistant) return { ok: false, reason: "incomplete" };
  return { ok: true };
}
