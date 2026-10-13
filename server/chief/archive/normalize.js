// Shared shaping for imported transcripts. Parsers produce provider records.
// This module assigns stable fallback ids, a content hash, and the redacted
// search projection. It does not call a model and it does not write facts.

import { createHash } from "node:crypto";

import { redactSensitiveSpans } from "../runtime/recall.js";
import { MAX_BLOCK_CHARS, MAX_TITLE_CHARS, RECALL_DOCUMENT_MAX } from "./limits.js";

const ROLES = new Set(["user", "assistant", "system", "tool", "unknown"]);

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function clipText(value, max = MAX_BLOCK_CHARS) {
  const text = String(value ?? "");
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function sourceInstant(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function providerUrl(provider, externalId) {
  if (typeof externalId !== "string" || externalId.startsWith("derived:")) return null;
  if (!/^[A-Za-z0-9:_-]{8,80}$/.test(externalId)) return null;
  if (provider === "claude") return `https://claude.ai/chat/${externalId}`;
  if (provider === "chatgpt") return `https://chatgpt.com/c/${externalId}`;
  return null;
}

function textOf(blocks) {
  return blocks
    .filter((block) => block.type === "text" || block.type === "code")
    .map((block) => (block.type === "code" ? block.code : block.text))
    .join("\n")
    .trim();
}

function sealBlocks(blocks) {
  const next = [];
  let unsupported = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "thinking") {
      const clipped = clipText(block.text);
      next.push({ type: block.type, text: clipped.text });
      if (clipped.truncated) {
        unsupported = true;
        next.push({
          type: "unsupported",
          kind: "truncated",
          note: "content was truncated at the archive limit",
        });
      }
      continue;
    }
    if (block.type === "code") {
      const clipped = clipText(block.code);
      next.push({
        type: "code",
        language: String(block.language || "unknown").slice(0, 40),
        code: clipped.text,
      });
      if (clipped.truncated) {
        unsupported = true;
        next.push({
          type: "unsupported",
          kind: "truncated",
          note: "content was truncated at the archive limit",
        });
      }
      continue;
    }
    if (block.type === "tool_use") {
      const input = clipText(JSON.stringify(block.input ?? {}));
      next.push({
        type: "tool_use",
        id: String(block.id || "").slice(0, 80),
        name: String(block.name || "").slice(0, 80),
        input: input.truncated ? { truncated: true } : safeJson(input.text),
      });
      if (input.truncated) unsupported = true;
      continue;
    }
    if (block.type === "tool_result") {
      const content = clipText(block.content);
      next.push({
        type: "tool_result",
        toolUseId: String(block.toolUseId || "").slice(0, 80),
        content: content.text,
      });
      if (content.truncated) unsupported = true;
      continue;
    }
    unsupported = true;
    next.push({
      type: "unsupported",
      kind: String(block.kind || "unsupported").slice(0, 80),
      note: String(block.note || "unsupported content was not imported").slice(0, 160),
    });
  }
  return { blocks: next, unsupported };
}

function safeJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const CREDENTIAL_PROSE =
  /\b(?:password|passphrase|secret|token|api[\s_-]*key|credential)s?\b\s+(?:is|was|are|equals)\s+\S+/gi;

// Archive recall only. The shared redactor keeps CHIEF search unchanged.
// Prose such as "password is hunter2" has to be removed first: the shared
// pattern consumes the keyword and the word "is", and would leave the value.
// This is not universal secret detection. Original message blocks are untouched.
function redactArchiveRecall(value) {
  const prepared = String(value ?? "").replace(CREDENTIAL_PROSE, " ");
  return redactSensitiveSpans(prepared);
}

export function derivedConversationId(provider, title, messages) {
  const seed = JSON.stringify({
    provider,
    title,
    messages: messages.map((message) => ({
      role: message.role,
      externalId: message.externalId,
      at: message.sourceCreatedAt,
      text: textOf(message.blocks),
    })),
  });
  return `derived:${sha256(seed).slice(0, 32)}`;
}

function messageKey(message, ordinal) {
  if (message.externalId) return message.externalId;
  return `ordinal:${ordinal}:${sha256(`${message.role}\n${textOf(message.blocks)}`).slice(0, 24)}`;
}

export function finalizeConversation(provider, draft) {
  const warnings = [...(draft.warnings ?? [])];
  const seen = new Set();
  const messages = [];
  let unsupportedCount = draft.unsupportedCount ?? 0;
  draft.messages.forEach((message, index) => {
    const role = ROLES.has(message.role) ? message.role : "unknown";
    const sealed = sealBlocks(message.blocks ?? []);
    if (!sealed.blocks.length) return;
    if (sealed.unsupported) unsupportedCount += 1;
    const providedId =
      typeof message.externalId === "string" && message.externalId.trim()
        ? message.externalId.trim().slice(0, 120)
        : "";
    let externalId = providedId || messageKey({ ...message, role, blocks: sealed.blocks }, index);
    if (seen.has(externalId)) {
      externalId = `${externalId}#${index}`;
      warnings.push("duplicate message id");
    }
    seen.add(externalId);
    messages.push({
      ordinal: messages.length,
      externalId,
      role,
      model: message.model ? String(message.model).slice(0, 120) : null,
      parentExternalId: message.parentExternalId
        ? String(message.parentExternalId).slice(0, 120)
        : null,
      sourceCreatedAt: sourceInstant(message.sourceCreatedAt),
      blocks: sealed.blocks,
      hasUnsupported: sealed.unsupported,
    });
  });

  const title = clipText(draft.title || "Untitled", MAX_TITLE_CHARS).text || "Untitled";
  const externalId =
    typeof draft.externalId === "string" && draft.externalId.trim()
      ? draft.externalId.trim().slice(0, 120)
      : derivedConversationId(provider, title, messages);
  if (!draft.externalId) warnings.push("derived conversation id");

  const canonical = messages.map((message) => ({
    role: message.role,
    externalId: message.externalId,
    at: message.sourceCreatedAt,
    blocks: message.blocks,
  }));
  const recall = redactArchiveRecall(
    [title, ...messages.map((message) => textOf(message.blocks))].filter(Boolean).join("\n")
  ).slice(0, RECALL_DOCUMENT_MAX);

  return {
    provider,
    externalId,
    title,
    sourceUrl: providerUrl(provider, externalId),
    model: draft.model ? String(draft.model).slice(0, 120) : null,
    sourceCreatedAt: sourceInstant(draft.sourceCreatedAt),
    sourceUpdatedAt: sourceInstant(draft.sourceUpdatedAt),
    contentHash: sha256(JSON.stringify(canonical)),
    messageCount: messages.length,
    unsupportedCount,
    omittedBranchCount: draft.omittedBranchCount ?? 0,
    recallDocument: recall || null,
    warnings: [...new Set(warnings)],
    messages,
  };
}
