// Live capture writes the existing external archive.
// It does not create durable notes.

import { finalizeConversation } from "./normalize.js";

export const MAX_CAPTURE_MESSAGES = 200;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]{8,80}$/;
const PROVIDERS = new Set(["claude", "chatgpt"]);
const ROLES = new Set(["user", "assistant"]);

export class CaptureRejected extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function reject(code, status) {
  return new CaptureRejected(code, status);
}

function messageText(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.blocks)) return "";
  return message.blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function gateError(code) {
  if (code === "AUTH") return reject("AUTH", 401);
  if (code === "PAUSED") return reject("PAUSED", 403);
  if (code === "DISABLED") return reject("DISABLED", 403);
  return reject("REJECTED", 400);
}

export async function acceptCapturedConversation(userId, body, deps) {
  const payload = body && typeof body === "object" ? { ...body } : {};
  delete payload.userId;
  delete payload.recallDocument;
  delete payload.sourceUrl;

  const provider = payload.provider;
  if (!PROVIDERS.has(provider)) throw reject("REJECTED", 400);
  const externalId = typeof payload.externalId === "string" ? payload.externalId.trim() : "";
  if (!EXTERNAL_ID.test(externalId) || externalId.startsWith("derived:")) {
    throw reject("REJECTED", 400);
  }
  if (!Array.isArray(payload.messages)) throw reject("REJECTED", 400);
  if (payload.messages.length > MAX_CAPTURE_MESSAGES) throw reject("OVERSIZED", 400);

  const gate = await deps.credentials.gate(userId, provider);
  if (!gate.ok) throw gateError(gate.code);

  const messages = [];
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") throw reject("REJECTED", 400);
    if (!ROLES.has(message.role)) throw reject("REJECTED", 400);
    const text = messageText(message);
    if (!text.trim()) continue;
    const providedId =
      typeof message.externalId === "string" && message.externalId.trim()
        ? message.externalId.trim()
        : undefined;
    messages.push({
      role: message.role,
      externalId: providedId,
      sourceCreatedAt: message.sourceCreatedAt ?? null,
      blocks: [{ type: "text", text }],
    });
  }

  const finalized = finalizeConversation(provider, {
    externalId,
    title: typeof payload.title === "string" ? payload.title : "Untitled",
    sourceCreatedAt: payload.sourceCreatedAt ?? null,
    sourceUpdatedAt: payload.sourceUpdatedAt ?? null,
    model: typeof payload.model === "string" ? payload.model : null,
    messages,
  });
  if (!finalized.messages.length || finalized.externalId !== externalId) {
    throw reject("REJECTED", 400);
  }

  let existing;
  try {
    existing = await deps.store.findByExternalId(userId, provider, externalId);
  } catch {
    throw reject("STORE", 500);
  }
  if (existing && finalized.messageCount < existing.messageCount) {
    throw reject("PARTIAL", 409);
  }

  let status;
  try {
    status = await deps.store.upsert(userId, finalized);
  } catch {
    throw reject("STORE", 500);
  }

  const now = deps.now ?? new Date();
  try {
    await deps.credentials.recordSuccess(userId, provider, now);
  } catch {
    // The archive write already succeeded.
  }
  try {
    await deps.audit?.write?.({
      userId,
      actor: "capture",
      action: "external_capture",
      resource: provider,
      summary: `captured ${provider} ${status} messages=${finalized.messageCount}`,
    });
  } catch {
    // The archive write already succeeded.
  }

  return {
    status,
    externalId: finalized.externalId,
    messageCount: finalized.messageCount,
  };
}
