/**
 * Light chat emphasis the agent UI renders:
 *   **bold**      → bold
 *   __underline__ → underline
 *
 * Pure string parse (no HTML). Callers map segments to React nodes.
 */
export function parseChatEmphasis(text) {
  const raw = String(text ?? "");
  if (!raw) return [{ type: "text", value: "" }];

  const token = /(\*\*[^*]+\*\*|__[^_]+__)/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = token.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: raw.slice(lastIndex, match.index) });
    }
    const tokenText = match[0];
    if (tokenText.startsWith("**")) {
      segments.push({ type: "bold", value: tokenText.slice(2, -2) });
    } else {
      segments.push({ type: "underline", value: tokenText.slice(2, -2) });
    }
    lastIndex = match.index + tokenText.length;
  }

  if (lastIndex < raw.length) {
    segments.push({ type: "text", value: raw.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: "text", value: raw }];
}
