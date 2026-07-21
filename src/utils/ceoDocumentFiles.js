/** Matches server/agents/documents.js — 500,000 KB per file, no character limit. */
export const MAX_DOC_SIZE_BYTES = 500_000 * 1024;
export const MAX_UPLOAD_DOCS = 10;

export const CEO_DOCUMENT_ACCEPT =
  ".txt,.md,.markdown,.csv,.json,.pdf,.docx,.xlsx,.pptx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation";

const TEXT_EXTENSIONS = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".json"]);

const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function fileExtension(filename = "") {
  const lower = String(filename).toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isPdfFile(file) {
  return file?.type === "application/pdf" || fileExtension(file?.name) === ".pdf";
}

function isDocxFile(file) {
  const mime = String(file?.type || "").toLowerCase();
  return mime === OFFICE_MIME.docx || fileExtension(file?.name) === ".docx";
}

function isXlsxFile(file) {
  const mime = String(file?.type || "").toLowerCase();
  return mime === OFFICE_MIME.xlsx || fileExtension(file?.name) === ".xlsx";
}

function isPptxFile(file) {
  const mime = String(file?.type || "").toLowerCase();
  return mime === OFFICE_MIME.pptx || fileExtension(file?.name) === ".pptx";
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

async function extractDocxText(file) {
  const mammoth = await import("mammoth");
  const extractRawText = mammoth.extractRawText || mammoth.default?.extractRawText;
  if (typeof extractRawText !== "function") {
    throw new Error("Word document parser is unavailable.");
  }
  const result = await extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return String(result?.value || "").trim();
}

async function extractXlsxText(file) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheets = workbook.SheetNames || [];
  const sections = [];
  for (const name of sheets) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (!csv) continue;
    sections.push(sheets.length > 1 ? `### Sheet: ${name}\n${csv}` : csv);
  }
  return sections.join("\n\n").trim();
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function textFromSlideXml(xml) {
  const matches = String(xml || "").match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || [];
  const parts = matches
    .map((tag) => {
      const inner = tag.replace(/^<a:t[^>]*>/, "").replace(/<\/a:t>$/, "");
      return decodeXmlEntities(inner).trim();
    })
    .filter(Boolean);
  return parts.join(" ").trim();
}

async function extractPptxText(file) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => {
      const numA = Number(a.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      const numB = Number(b.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      return numA - numB;
    });

  const slides = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async("string");
    const text = textFromSlideXml(xml);
    if (text) slides.push(text);
  }
  return slides.join("\n\n").trim();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

async function extractOfficeOrPdfText(file) {
  if (isPdfFile(file)) return extractPdfText(file);
  if (isDocxFile(file)) return extractDocxText(file);
  if (isXlsxFile(file)) return extractXlsxText(file);
  if (isPptxFile(file)) return extractPptxText(file);
  return null;
}

/**
 * Reads browser File objects into CEO document payloads.
 * PDFs and Office files are text-extracted client-side; other supported types are read as UTF-8 text.
 */
export async function readCeoDocumentFiles(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(
    files.map(async (file) => {
      if (file.size > MAX_DOC_SIZE_BYTES) {
        throw new Error(`"${file.name}" is too large (max ${MAX_DOC_SIZE_BYTES / 1024} KB).`);
      }

      const extracted = await extractOfficeOrPdfText(file);
      if (extracted !== null) {
        if (!extracted) {
          throw new Error(`"${file.name}" has no extractable text.`);
        }
        return {
          filename: file.name,
          mimeType: "text/plain",
          content: extracted,
        };
      }

      if (!isSupportedTextFile(file)) {
        throw new Error(
          `"${file.name}" is not a supported type. Use .txt, .md, .csv, .json, .pdf, .docx, .xlsx, or .pptx.`
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
