// ChatGPT export parser.
//
// Adapted from Engram (MIT), https://github.com/Sufian-Abu/engram
// packages/core/src/parsers/chatgpt.ts — parseChatGPTExport.
// Copyright (c) 2026 Sufian Abu. See licenses/Engram-MIT.txt.
//
// The visible thread is the walk from current_node to the root. Sibling
// regenerated branches are counted and omitted, not merged into the transcript.
// Freedom OS adds stable ids, role mapping, and unsupported content markers.
// This parser does not call OpenAI.

import { finalizeConversation } from "../normalize.js";
import { MAX_MESSAGES_PER_CONVERSATION } from "../limits.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function isChatGptExportRecord(value) {
  const record = asObject(value);
  return Boolean(record && asObject(record.mapping));
}

function lineageIds(mapping, currentNode) {
  const ids = [];
  let cursor = typeof currentNode === "string" ? currentNode : null;
  const seen = new Set();
  if (cursor && mapping[cursor]) {
    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      ids.push(cursor);
      cursor = typeof mapping[cursor].parent === "string" ? mapping[cursor].parent : null;
    }
    return ids.reverse();
  }
  return Object.entries(mapping)
    .filter(([, node]) => asObject(node?.message))
    .sort((left, right) => {
      const leftTime = Number(left[1]?.message?.create_time ?? 0);
      const rightTime = Number(right[1]?.message?.create_time ?? 0);
      return leftTime - rightTime;
    })
    .map(([id]) => id);
}

function omittedBranchCount(mapping, visibleIds) {
  const visible = new Set(visibleIds);
  let count = 0;
  for (const [id, node] of Object.entries(mapping)) {
    if (visible.has(id)) continue;
    const role = node?.message?.author?.role;
    if (role === "user" || role === "assistant") count += 1;
  }
  return count;
}

function blocksFromContent(content) {
  const blocks = [];
  if (typeof content === "string") {
    if (content.trim()) blocks.push({ type: "text", text: content });
    return blocks;
  }
  const record = asObject(content);
  if (!record) return blocks;
  const parts = Array.isArray(record.parts) ? record.parts : [];
  if (record.content_type === "code") {
    const code = parts.filter((part) => typeof part === "string" && part.trim()).join("\n");
    if (code) {
      blocks.push({
        type: "code",
        language: typeof record.language === "string" ? record.language : "unknown",
        code,
      });
    }
  } else {
    for (const part of parts) {
      if (typeof part === "string") {
        if (part.trim()) blocks.push({ type: "text", text: part });
        continue;
      }
      if (part && typeof part === "object") {
        blocks.push({
          type: "unsupported",
          kind: typeof part.content_type === "string" ? part.content_type : "attachment",
          note: "multimodal or attachment content was not imported",
        });
      }
    }
  }
  if (!blocks.length && typeof record.text === "string" && record.text.trim()) {
    blocks.push({ type: "text", text: record.text });
  }
  return blocks;
}

function roleOf(role) {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "unknown";
}

function visible(message) {
  if (message?.metadata?.is_visually_hidden_from_conversation === true) return false;
  const role = message?.author?.role;
  if (role === "assistant") {
    const channel = message.channel;
    if (typeof channel === "string" && channel && channel !== "final") return false;
    const recipient = message.recipient;
    if (typeof recipient === "string" && recipient && recipient !== "all" && recipient !== "user") {
      return false;
    }
  }
  return true;
}

export function parseChatGptConversation(raw) {
  const record = asObject(raw);
  const mapping = asObject(record?.mapping);
  if (!record || !mapping) return { error: "not a ChatGPT conversation" };
  const visibleIds = lineageIds(mapping, record.current_node);
  if (visibleIds.length > MAX_MESSAGES_PER_CONVERSATION) {
    return { error: "conversation exceeds the message limit" };
  }
  const messages = [];
  let previousId = null;
  for (const id of visibleIds) {
    const message = asObject(mapping[id]?.message);
    if (!message || !visible(message)) continue;
    const blocks = blocksFromContent(message.content);
    if (!blocks.length) continue;
    const externalId = typeof message.id === "string" ? message.id : id;
    messages.push({
      externalId,
      role: roleOf(message.author?.role),
      model:
        typeof message.metadata?.resolved_model_slug === "string"
          ? message.metadata.resolved_model_slug
          : typeof message.metadata?.model_slug === "string"
            ? message.metadata.model_slug
            : null,
      sourceCreatedAt: message.create_time ?? message.update_time ?? null,
      parentExternalId: previousId,
      blocks,
    });
    previousId = externalId;
  }
  if (!messages.length) return { error: "conversation has no messages" };
  const externalId =
    typeof record.conversation_id === "string"
      ? record.conversation_id
      : typeof record.id === "string"
        ? record.id
        : null;
  return {
    conversation: finalizeConversation("chatgpt", {
      externalId,
      title: typeof record.title === "string" && record.title.trim() ? record.title : "Untitled",
      model: typeof record.default_model_slug === "string" ? record.default_model_slug : null,
      sourceCreatedAt: record.create_time ?? null,
      sourceUpdatedAt: record.update_time ?? null,
      omittedBranchCount: omittedBranchCount(mapping, visibleIds),
      messages,
    }),
  };
}

export function parseChatGptExport(raw) {
  const records = Array.isArray(raw) ? raw : [raw];
  const conversations = [];
  const failures = [];
  records.forEach((record, index) => {
    const parsed = parseChatGptConversation(record);
    if (parsed.error) {
      failures.push({
        index,
        externalId: asObject(record)?.conversation_id ?? asObject(record)?.id ?? null,
        error: parsed.error,
      });
      return;
    }
    conversations.push(parsed.conversation);
  });
  return { conversations, failures };
}
