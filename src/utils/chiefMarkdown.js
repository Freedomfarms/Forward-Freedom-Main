// CHIEF transcript markdown. The model text is rendered here. The stream and
// the stored transcript both pass through this parser. Backslash escapes such
// as \*\* are unescaped outside code, because that is how the raw string was
// reaching the screen.

const ESCAPE = /(`[^`\n]*`)|\\([\\`*_{}[\]()#+\-.!|])/g;

export function unescapeChiefMarkdown(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const fence = fenceAt(source, index);
    if (fence) {
      const end = source.indexOf(`\n${fence.mark}`, fence.bodyStart);
      if (end === -1) {
        out += source.slice(index);
        break;
      }
      const close = end + 1 + fence.mark.length;
      out += source.slice(index, close);
      index = close;
      continue;
    }
    const next = nextFence(source, index);
    const chunk = source.slice(index, next === -1 ? source.length : next);
    out += chunk.replace(ESCAPE, (match, code, escaped) => (escaped ? escaped : code || match));
    if (next === -1) break;
    index = next;
  }
  return out;
}

function fenceAt(source, index) {
  if (index > 0 && source[index - 1] !== "\n") return null;
  const mark = source.startsWith("```", index)
    ? "```"
    : source.startsWith("~~~", index)
      ? "~~~"
      : "";
  if (!mark) return null;
  const lineEnd = source.indexOf("\n", index);
  return { mark, bodyStart: lineEnd === -1 ? source.length : lineEnd + 1 };
}

function nextFence(source, index) {
  const tick = source.indexOf("\n```", index);
  const wave = source.indexOf("\n~~~", index);
  if (tick === -1) return wave === -1 ? -1 : wave + 1;
  if (wave === -1) return tick + 1;
  return Math.min(tick, wave) + 1;
}

function safeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("//")) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol === "http:" ||
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:"
  ) {
    return raw;
  }
  return null;
}

function parseInlines(text) {
  const source = String(text ?? "");
  const pattern =
    /(`[^`\n]+`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  const nodes = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) nodes.push({ type: "text", value: source.slice(last, match.index) });
    if (match[1]) nodes.push({ type: "code", value: match[1].slice(1, -1) });
    else if (match[2]) {
      const href = safeUrl(match[3]);
      nodes.push(
        href ? { type: "link", value: match[2], href } : { type: "text", value: match[0] }
      );
    } else if (match[4]) nodes.push({ type: "strong", value: match[4] });
    else if (match[5]) nodes.push({ type: "strong", value: match[5] });
    else if (match[6]) nodes.push({ type: "em", value: match[6] });
    else if (match[7]) nodes.push({ type: "em", value: match[7] });
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push({ type: "text", value: source.slice(last) });
  return nodes.length ? nodes : [{ type: "text", value: source }];
}

function isTableStart(lines, index) {
  if (!/^\s*\|.+\|\s*$/.test(lines[index] || "")) return false;
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1] || "");
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => parseInlines(cell.trim()));
}

function isBlockStart(line) {
  return (
    line.startsWith("```") ||
    line.startsWith("~~~") ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*\|.+\|\s*$/.test(line)
  );
}

function parseBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```") || line.startsWith("~~~")) {
      const mark = line.startsWith("~~~") ? "~~~" : "```";
      const language = line.slice(mark.length).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(mark)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, value: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inlines: parseInlines(heading[2]),
      });
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = cells(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index])) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(parseInlines(lines[index].replace(/^\s*[-*]\s+/, "")));
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(parseInlines(lines[index].replace(/^\s*\d+\.\s+/, "")));
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", inlines: parseInlines(paragraph.join(" ")) });
  }
  return blocks;
}

export function parseChiefMarkdown(text) {
  return parseBlocks(unescapeChiefMarkdown(text));
}
