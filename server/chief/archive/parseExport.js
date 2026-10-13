// Turns an uploaded JSON or ZIP export into normalized conversations.
// Account files such as users.json are never read. A ZIP is expanded only
// up to the uncompressed cap.

import JSZip from "jszip";

import {
  MAX_CONVERSATIONS,
  MAX_UNCOMPRESSED_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_ZIP_ENTRIES_READ,
} from "./limits.js";
import { isClaudeExportRecord, parseClaudeExport } from "./parsers/claude.js";
import { isChatGptExportRecord, parseChatGptExport } from "./parsers/chatgpt.js";

const PROVIDERS = new Set(["claude", "chatgpt"]);

function fail(error) {
  return { ok: false, error, conversations: [], failures: [] };
}

export function decodeUpload(dataBase64) {
  if (typeof dataBase64 !== "string" || !dataBase64.trim()) {
    return { error: "export file is required" };
  }
  const normalized = dataBase64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return { error: "export file is not valid base64" };
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length) return { error: "export file is empty" };
  if (bytes.length > MAX_UPLOAD_BYTES) return { error: "export file is larger than 3 MB" };
  return { bytes };
}

function isZip(filename, bytes) {
  if (typeof filename === "string" && filename.toLowerCase().endsWith(".zip")) return true;
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function conversationName(name) {
  const base = String(name || "")
    .split("/")
    .pop();
  if (!base || base.includes("..")) return false;
  return /^conversations(?:-\d+)?\.json$/i.test(base);
}

function asRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.conversations)) {
    return parsed.conversations;
  }
  return [parsed];
}

function detect(records) {
  const first = records.find((record) => record && typeof record === "object");
  if (!first) return "empty";
  if (isChatGptExportRecord(first)) return "chatgpt";
  if (isClaudeExportRecord(first)) return "claude";
  return "unknown";
}

async function conversationTexts(filename, bytes) {
  if (!isZip(filename, bytes)) {
    if (typeof filename === "string" && !/\.json$/i.test(filename)) {
      return { error: "upload a .json or .zip export" };
    }
    return { texts: [bytes.toString("utf8")] };
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { error: "zip archive could not be read" };
  }
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && conversationName(entry.name)
  );
  if (!entries.length) return { error: "zip does not contain conversations.json" };
  if (entries.length > MAX_ZIP_ENTRIES_READ)
    return { error: "zip contains too many conversation files" };
  const texts = [];
  let total = 0;
  for (const entry of entries) {
    const text = await entry.async("string");
    total += Buffer.byteLength(text);
    if (total > MAX_UNCOMPRESSED_BYTES) return { error: "zip expands past the archive limit" };
    texts.push(text);
  }
  return { texts };
}

export async function parseExportUpload({ provider, filename, dataBase64 }) {
  if (!PROVIDERS.has(provider)) return fail("provider must be claude or chatgpt");
  const decoded = decodeUpload(dataBase64);
  if (decoded.error) return fail(decoded.error);
  const extracted = await conversationTexts(filename, decoded.bytes);
  if (extracted.error) return fail(extracted.error);

  const conversations = [];
  const failures = [];
  for (const text of extracted.texts) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("export JSON could not be parsed");
    }
    const records = asRecords(parsed);
    const detected = detect(records);
    if (detected === "empty") {
      failures.push({ index: null, externalId: null, error: "export file has no conversations" });
      continue;
    }
    if (detected === "unknown") {
      return fail("export file is not a Claude or ChatGPT conversation export");
    }
    if (detected !== provider) {
      return fail(`this file is a ${detected} export`);
    }
    const result = provider === "claude" ? parseClaudeExport(records) : parseChatGptExport(records);
    conversations.push(...result.conversations);
    failures.push(...result.failures);
  }

  if (conversations.length + failures.length > MAX_CONVERSATIONS) {
    return fail(`export has more than ${MAX_CONVERSATIONS} conversations`);
  }
  return { ok: true, provider, conversations, failures };
}

export function previewRecords(parsed) {
  return {
    provider: parsed.provider,
    conversations: parsed.conversations.map((conversation) => ({
      externalId: conversation.externalId,
      title: conversation.title,
      messageCount: conversation.messageCount,
      sourceCreatedAt: conversation.sourceCreatedAt,
      sourceUpdatedAt: conversation.sourceUpdatedAt,
      unsupportedCount: conversation.unsupportedCount,
      omittedBranchCount: conversation.omittedBranchCount,
      warnings: conversation.warnings,
    })),
    failures: parsed.failures,
    counts: {
      parsed: parsed.conversations.length,
      failed: parsed.failures.length,
    },
  };
}
