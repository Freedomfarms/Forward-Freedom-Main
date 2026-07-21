import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";

// Encrypted reference documents for the CEO Agent. Content is stored as
// ciphertext plaintext (text/csv/md/json only) — no binary uploads.

export function isMissingCeoDocumentsError(error) {
  const message = String(error?.message || "");
  return (
    (error?.code === "P2021" || error?.code === "P2022") &&
    /CeoDocument/i.test(message)
  );
}

export const MAX_DOCUMENTS_PER_USER = 10;
export const MAX_DOCUMENT_CONTENT_CHARS = 40_000;
export const MAX_DOCUMENTS_PER_UPLOAD = 3;
export const MAX_FILENAME_LENGTH = 120;

const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/x-markdown",
]);

function invalid(message) {
  return new AgentError(message, "INVALID_AGENT_PAYLOAD", 400);
}

export function normalizeMimeType(mimeType, filename = "") {
  const raw = String(mimeType || "").trim().toLowerCase();
  if (ALLOWED_MIME_TYPES.has(raw)) {
    return raw === "text/x-markdown" ? "text/markdown" : raw;
  }
  const lowerName = String(filename || "").toLowerCase();
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "text/markdown";
  if (lowerName.endsWith(".csv")) return "text/csv";
  if (lowerName.endsWith(".json")) return "application/json";
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".text")) return "text/plain";
  return null;
}

export function serializeCeoDocument(doc) {
  return {
    id: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt,
  };
}

/** Validates one document payload; returns normalized fields (not yet encrypted). */
export function readDocumentInput(raw, index = 0) {
  const label = `documents[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(`${label} must be an object.`);
  }
  const filename = typeof raw.filename === "string" ? raw.filename.trim() : "";
  if (!filename || filename.length > MAX_FILENAME_LENGTH) {
    throw invalid(`${label}.filename must be 1–${MAX_FILENAME_LENGTH} characters.`);
  }
  if (/[/\\]/.test(filename) || filename.includes("..")) {
    throw invalid(`${label}.filename is invalid.`);
  }
  const mimeType = normalizeMimeType(raw.mimeType, filename);
  if (!mimeType) {
    throw invalid(
      `${label} must be a text document (.txt, .md, .csv, or .json).`
    );
  }
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content.trim()) throw invalid(`${label}.content is required.`);
  if (content.length > MAX_DOCUMENT_CONTENT_CHARS) {
    throw invalid(
      `${label}.content must be at most ${MAX_DOCUMENT_CONTENT_CHARS} characters.`
    );
  }
  return {
    filename,
    mimeType,
    content,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

export function readDocumentInputs(value, { max = MAX_DOCUMENTS_PER_UPLOAD } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid("documents must be an array.");
  if (value.length > max) {
    throw invalid(`At most ${max} documents can be uploaded at once.`);
  }
  return value.map((item, index) => readDocumentInput(item, index));
}

export async function listCeoDocuments(userId) {
  try {
    const rows = await withUserContext(userId, (tx) =>
      tx.ceoDocument.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      })
    );
    return rows.map(serializeCeoDocument);
  } catch (error) {
    if (isMissingCeoDocumentsError(error)) return [];
    throw error;
  }
}

export async function createCeoDocuments(userId, ceoAgentConfigId, documents) {
  if (!documents.length) return [];
  try {
    return await withUserContext(userId, async (tx) => {
      const existing = await tx.ceoDocument.count({ where: { userId } });
      if (existing + documents.length > MAX_DOCUMENTS_PER_USER) {
        throw new AgentError(
          `You can store at most ${MAX_DOCUMENTS_PER_USER} documents for your CEO Agent.`,
          "DOCUMENT_LIMIT_REACHED",
          400
        );
      }
      const created = [];
      for (const doc of documents) {
        const row = await tx.ceoDocument.create({
          data: {
            userId,
            ceoAgentConfigId,
            filename: doc.filename,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            contentCiphertext: encrypt(doc.content),
          },
          select: {
            id: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
        });
        created.push(serializeCeoDocument(row));
      }
      return created;
    });
  } catch (error) {
    if (isMissingCeoDocumentsError(error)) {
      throw new AgentError(
        "Document storage is not available yet (database migration pending). Try again shortly.",
        "DOCUMENTS_SCHEMA_UNMIGRATED",
        503
      );
    }
    throw error;
  }
}

export async function deleteCeoDocument(userId, documentId) {
  try {
    return await withUserContext(userId, async (tx) => {
      const existing = await tx.ceoDocument.findFirst({
        where: { id: documentId, userId },
        select: { id: true },
      });
      if (!existing) {
        throw new AgentError("Document not found.", "DOCUMENT_NOT_FOUND", 404);
      }
      await tx.ceoDocument.delete({ where: { id: existing.id } });
      return { deleted: true, id: existing.id };
    });
  } catch (error) {
    if (isMissingCeoDocumentsError(error)) {
      throw new AgentError(
        "Document storage is not available yet (database migration pending). Try again shortly.",
        "DOCUMENTS_SCHEMA_UNMIGRATED",
        503
      );
    }
    throw error;
  }
}

/**
 * Loads decrypted document text for CEO prompts (filename + truncated body).
 * Fail-closed per row: undecryptable documents are skipped.
 */
export async function loadDocumentsForPrompt(userId, { limit = 8, maxCharsPerDoc = 6000 } = {}) {
  let rows;
  try {
    rows = await withUserContext(userId, (tx) =>
      tx.ceoDocument.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { filename: true, contentCiphertext: true },
      })
    );
  } catch (error) {
    if (isMissingCeoDocumentsError(error)) {
      return "(no reference documents uploaded)";
    }
    throw error;
  }
  const blocks = [];
  for (const row of rows) {
    let content;
    try {
      content = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    const trimmed = String(content || "").trim();
    if (!trimmed) continue;
    const body =
      trimmed.length > maxCharsPerDoc
        ? `${trimmed.slice(0, maxCharsPerDoc)}\n…(truncated)`
        : trimmed;
    blocks.push(`### ${row.filename}\n${body}`);
  }
  return blocks.length ? blocks.join("\n\n") : "(no reference documents uploaded)";
}
