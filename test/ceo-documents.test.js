import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_DOCUMENTS_PER_UPLOAD,
  readDocumentInput,
  readDocumentInputs,
} from "../server/agents/documents.js";

describe("CEO document upload limits", () => {
  it("allows at least 10 documents per upload with no character cap", () => {
    assert.equal(MAX_DOCUMENTS_PER_UPLOAD, 10);
    const docs = Array.from({ length: 10 }, (_, index) => ({
      filename: `notes-${index}.txt`,
      mimeType: "text/plain",
      content: "x".repeat(50_000),
    }));
    const parsed = readDocumentInputs(docs);
    assert.equal(parsed.length, 10);
    assert.ok(parsed[0].content.length > 40_000);
  });

  it("rejects more than 10 documents in one upload", () => {
    const docs = Array.from({ length: 11 }, (_, index) => ({
      filename: `notes-${index}.txt`,
      mimeType: "text/plain",
      content: "hello",
    }));
    assert.throws(() => readDocumentInputs(docs), /At most 10 documents/);
  });

  it("accepts content well above the old 40k character cap", () => {
    assert.equal(MAX_DOCUMENT_SIZE_BYTES, 500_000 * 1024);
    const ok = readDocumentInput({
      filename: "big.txt",
      mimeType: "text/plain",
      content: "y".repeat(100_000),
    });
    assert.equal(ok.filename, "big.txt");
    assert.equal(ok.sizeBytes, 100_000);
  });

  it("rejects empty document content", () => {
    assert.throws(
      () =>
        readDocumentInput({
          filename: "empty.txt",
          mimeType: "text/plain",
          content: "   ",
        }),
      /content is required/
    );
  });
});
