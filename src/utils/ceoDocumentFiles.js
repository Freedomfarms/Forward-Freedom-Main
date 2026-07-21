/** Matches server/agents/documents.js — 500,000 KB per file, no character limit. */
export const MAX_DOC_SIZE_BYTES = 500_000 * 1024;
export const MAX_UPLOAD_DOCS = 10;

const TEXT_EXTENSIONS = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".json"]);

function fileExtension(filename = "") {
  const lower = String(filename).toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isPdfFile(file) {
  return file?.type === "application/pdf" || fileExtension(file?.name) === ".pdf";
}

function isSupportedTextFile(file) {
  const ext = fileExtension(file?.name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const mime = String(file?.type || "").toLowerCase();
  return (
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    mime === "text/csv" ||
    mime === "application/json"
  );
}

async function extractPdfText(file) {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  const pdfWorkerSrc = workerModule.default;
  if (typeof GlobalWorkerOptions !== "undefined" && pdfWorkerSrc) {
    GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => (typeof item?.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (line.trim()) pages.push(line);
  }
  return pages.join("\n\n").trim();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/**
 * Reads browser File objects into CEO document payloads.
 * PDFs are text-extracted client-side; other supported types are read as UTF-8 text.
 */
export async function readCeoDocumentFiles(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(
    files.map(async (file) => {
      if (file.size > MAX_DOC_SIZE_BYTES) {
        throw new Error(`"${file.name}" is too large (max ${MAX_DOC_SIZE_BYTES / 1024} KB).`);
      }

      if (isPdfFile(file)) {
        const content = await extractPdfText(file);
        if (!content) {
          throw new Error(`"${file.name}" has no extractable text.`);
        }
        return {
          filename: file.name,
          mimeType: "text/plain",
          content,
        };
      }

      if (!isSupportedTextFile(file)) {
        throw new Error(
          `"${file.name}" is not a supported type. Use .txt, .md, .csv, .json, or .pdf.`
        );
      }

      const content = await readFileAsText(file);
      return {
        filename: file.name,
        mimeType: file.type || "text/plain",
        content,
      };
    })
  );
}
