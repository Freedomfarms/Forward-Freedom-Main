// Historical import orchestration. Parsed conversations are untrusted data.
// Nothing here writes ChiefFact, starts a turn, or calls a provider.

import { MemoryAuditLog } from "../security/audit.js";
import { parseExportUpload, previewRecords } from "./parseExport.js";
import { MemoryExternalArchive } from "./store.js";

function summaryText(provider, counts) {
  return [
    `${provider} import`,
    `imported ${counts.imported}`,
    `updated ${counts.updated}`,
    `duplicate ${counts.duplicate}`,
    `failed ${counts.failed}`,
  ].join("; ");
}

export async function previewExport(input) {
  const parsed = await parseExportUpload(input);
  if (!parsed.ok) return { error: parsed.error };
  return { preview: previewRecords(parsed) };
}

export async function importExport(input, { userId, store, audit } = {}) {
  const parsed = await parseExportUpload(input);
  if (!parsed.ok) return { error: parsed.error };
  const archive = store ?? new MemoryExternalArchive();
  const log = audit ?? new MemoryAuditLog();
  const counts = {
    imported: 0,
    updated: 0,
    duplicate: 0,
    failed: parsed.failures.length,
  };
  const failures = parsed.failures.map((failure) => ({ ...failure }));
  const conversations = [];
  for (const conversation of parsed.conversations) {
    if (!conversation.messageCount) {
      counts.failed += 1;
      failures.push({
        index: null,
        externalId: conversation.externalId,
        error: "conversation has no messages",
      });
      continue;
    }
    try {
      const outcome = await archive.upsert(userId, conversation);
      counts[outcome] += 1;
      conversations.push({
        externalId: conversation.externalId,
        title: conversation.title,
        messageCount: conversation.messageCount,
        status: outcome,
      });
    } catch {
      counts.failed += 1;
      failures.push({
        index: null,
        externalId: conversation.externalId,
        error: "conversation could not be stored",
      });
    }
  }
  let auditStatus = "recorded";
  try {
    await log.write({
      userId,
      actor: "user",
      action: "external_import",
      resource: input.provider,
      summary: summaryText(input.provider, counts),
    });
  } catch {
    auditStatus = "unavailable";
  }
  return { counts, failures, conversations, audit: auditStatus };
}

export async function removeImportedConversation(userId, id, { store, audit } = {}) {
  const archive = store ?? new MemoryExternalArchive();
  const log = audit ?? new MemoryAuditLog();
  const deleted = await archive.delete(userId, id);
  if (!deleted) return { deleted: false };
  let auditStatus = "recorded";
  try {
    await log.write({
      userId,
      actor: "user",
      action: "external_delete",
      resource: id,
      summary: "deleted one imported conversation",
    });
  } catch {
    auditStatus = "unavailable";
  }
  return { deleted: true, id, audit: auditStatus };
}
