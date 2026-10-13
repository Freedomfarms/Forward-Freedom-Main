// Claude export parser.
//
// Adapted from OpenChat (Apache-2.0), https://github.com/P0u4a/openchat
// packages/extension/src/lib/parsers/claude.ts — parseClaudeConversation.
// Copyright remains with the OpenChat authors. See
// licenses/OpenChat-Apache-2.0.txt and THIRD_PARTY_NOTICES.md.
//
// Freedom OS changes: official export arrays, stable ids, attachment markers,
// and no random message ids. Thinking and tool blocks are kept. This parser
// does not call Anthropic.

import { finalizeConversation } from "../normalize.js";
import { MAX_MESSAGES_PER_CONVERSATION } from "../limits.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function blocksFromMessage(message) {
  const blocks = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    const record = asObject(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      if (record.text.trim()) blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (record.type === "thinking") {
      const text = typeof record.thinking === "string" ? record.thinking : record.text;
      if (typeof text === "string" && text.trim()) blocks.push({ type: "thinking", text });
      continue;
    }
    if (record.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: record.id,
        name: record.name,
        input: asObject(record.input) ?? {},
      });
      continue;
    }
    if (record.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        toolUseId: record.tool_use_id || record.toolUseId,
        content: toolResultText(record.content),
      });
      continue;
    }
    blocks.push({
      type: "unsupported",
      kind: typeof record.type === "string" ? record.type : "block",
      note: "unsupported Claude content block",
    });
  }
  if (!blocks.length && typeof message.text === "string" && message.text.trim()) {
    blocks.push({ type: "text", text: message.text });
  }
  const attachmentCount = [message.attachments, message.files, message.files_v2].reduce(
    (count, value) => count + (Array.isArray(value) ? value.length : 0),
    0
  );
  if (attachmentCount > 0) {
    blocks.push({
      type: "unsupported",
      kind: "attachment",
      note: `${attachmentCount} attachment(s) were not imported`,
    });
  }
  return blocks;
}

function roleOf(sender) {
  if (sender === "human" || sender === "user") return "user";
  if (sender === "assistant") return "assistant";
  if (sender === "system") return "system";
  if (sender === "tool") return "tool";
  return "unknown";
}

export function isClaudeExportRecord(value) {
  const record = asObject(value);
  return Boolean(record && (Array.isArray(record.chat_messages) || record.sender));
}

export function parseClaudeConversation(raw) {
  const record = asObject(raw);
  if (!record || !Array.isArray(record.chat_messages)) {
    return { error: "not a Claude conversation" };
  }
  if (record.chat_messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    return { error: "conversation exceeds the message limit" };
  }
  const ordered = record.chat_messages
    .map((message, index) => ({ message: asObject(message), index }))
    .filter((entry) => entry.message)
    .sort((left, right) => {
      const leftIndex = Number.isFinite(left.message.index) ? left.message.index : left.index;
      const rightIndex = Number.isFinite(right.message.index) ? right.message.index : right.index;
      return leftIndex - rightIndex;
    });
  const known = new Set(
    ordered.map((entry) => (typeof entry.message.uuid === "string" ? entry.message.uuid : ""))
  );
  const messages = [];
  for (const entry of ordered) {
    const message = entry.message;
    const blocks = blocksFromMessage(message);
    if (!blocks.length) continue;
    const parent =
      typeof message.parent_message_uuid === "string" && known.has(message.parent_message_uuid)
        ? message.parent_message_uuid
        : null;
    messages.push({
      externalId: typeof message.uuid === "string" ? message.uuid : null,
      role: roleOf(message.sender),
      sourceCreatedAt: message.created_at || message.updated_at || null,
      parentExternalId: parent,
      blocks,
    });
  }
  if (!messages.length) return { error: "conversation has no messages" };
  return {
    conversation: finalizeConversation("claude", {
      externalId: typeof record.uuid === "string" ? record.uuid : null,
      title: typeof record.name === "string" && record.name.trim() ? record.name : "Untitled",
      model: typeof record.model === "string" ? record.model : null,
      sourceCreatedAt: record.created_at || null,
      sourceUpdatedAt: record.updated_at || null,
      messages,
    }),
  };
}

export function parseClaudeExport(raw) {
  const records = Array.isArray(raw) ? raw : [raw];
  const conversations = [];
  const failures = [];
  records.forEach((record, index) => {
    const parsed = parseClaudeConversation(record);
    if (parsed.error) {
      failures.push({
        index,
        externalId: asObject(record)?.uuid ?? null,
        error: parsed.error,
      });
      return;
    }
    conversations.push(parsed.conversation);
  });
  return { conversations, failures };
}
