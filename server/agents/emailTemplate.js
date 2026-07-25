// ─────────────────────────────────────────────────────────────────────────────
// Executive HTML email template for agent report delivery.
//
// Email-client constraints drive the design: all CSS is inline (Gmail strips
// <style> blocks in many contexts) and the layout is table-based. Colors come
// from the Freedom OS dashboard theme (#041121 navy, #0077ff primary blue,
// #8feaff accent cyan).
//
// Agent output is LLM-generated markdown, so it is ALWAYS sanitized
// (sanitize-html) after rendering (marked) — the transformTags step below both
// applies the inline styles and discards any attributes the model produced.
//
// IMPORTANT — guarded dependencies: this module sits on the import path of
// EVERY agent API function (apiHelpers → registry → reminders → emailDelivery
// → here). A static `import` of marked/sanitize-html that fails in the
// serverless runtime (engine mismatch, bundler miss) crashes every one of
// those functions at module load (FUNCTION_INVOCATION_FAILED) and takes the
// whole Freedom OS home down. So both packages are loaded lazily inside a
// try/catch, and rendering falls back to escaped plain text when unavailable
// — degraded email styling, never a platform outage.
// ─────────────────────────────────────────────────────────────────────────────

let markdownRenderer = null; // Marked instance when available
let sanitizeHtmlFn = null;

async function loadRenderers() {
  try {
    const [{ Marked }, sanitizeModule] = await Promise.all([
      import("marked"),
      import("sanitize-html"),
    ]);
    // Isolated instance so option changes never leak into other marked consumers.
    markdownRenderer = new Marked({ gfm: true, breaks: true });
    sanitizeHtmlFn = sanitizeModule.default;
  } catch (error) {
    console.warn(
      "[emailTemplate] markdown/sanitize renderers unavailable; falling back to plain text emails:",
      error?.message || error
    );
    markdownRenderer = null;
    sanitizeHtmlFn = null;
  }
}

// Top-level await keeps the exported render functions synchronous for callers;
// a failed load resolves (never rejects), so importing this module can't throw.
await loadRenderers();

const BRAND_NAME = "Freedom OS";
const COLOR_HEADER_BG = "#041121";
const COLOR_ACCENT = "#0077ff";
const COLOR_ACCENT_LIGHT = "#8feaff";
const COLOR_TEXT = "#243447";
const COLOR_HEADING = "#0b1f33";
const COLOR_MUTED = "#5b6b7f";
const COLOR_BORDER = "#e3eaf2";
const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const AGENT_TYPE_LABELS = Object.freeze({
  finance: "Finance Report",
  research: "Research Brief",
  reminders: "Reminder",
});

export function agentTypeLabel(agentType) {
  return AGENT_TYPE_LABELS[agentType] || "Agent Report";
}

/** "Friday, July 24" — used in subject lines and the email header. */
export function formatRunDate(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(value);
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Per-tag inline styles injected into the rendered markdown. Every rendered
// tag is transformed, so attributes authored by the model never survive.
const BODY_TAG_STYLES = Object.freeze({
  h2: `margin:26px 0 10px;font-family:${FONT_STACK};font-size:19px;line-height:1.35;font-weight:800;color:${COLOR_HEADING};`,
  h3: `margin:20px 0 8px;font-family:${FONT_STACK};font-size:16px;line-height:1.4;font-weight:700;color:${COLOR_HEADING};`,
  h4: `margin:16px 0 6px;font-family:${FONT_STACK};font-size:14px;line-height:1.4;font-weight:700;color:${COLOR_HEADING};`,
  p: `margin:0 0 14px;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${COLOR_TEXT};`,
  ul: `margin:0 0 14px;padding-left:22px;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${COLOR_TEXT};`,
  ol: `margin:0 0 14px;padding-left:22px;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${COLOR_TEXT};`,
  li: `margin:0 0 6px;`,
  a: `color:${COLOR_ACCENT};text-decoration:underline;`,
  strong: `font-weight:700;color:${COLOR_HEADING};`,
  em: `font-style:italic;`,
  blockquote: `margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid ${COLOR_ACCENT};color:${COLOR_MUTED};`,
  code: `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f1f5f9;border-radius:4px;padding:1px 5px;`,
  pre: `margin:0 0 14px;padding:12px 14px;background:#f1f5f9;border-radius:8px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;color:${COLOR_TEXT};`,
  hr: `border:none;border-top:1px solid ${COLOR_BORDER};margin:22px 0;`,
  table: `border-collapse:collapse;margin:0 0 16px;width:100%;font-family:${FONT_STACK};font-size:14px;color:${COLOR_TEXT};`,
  thead: ``,
  tbody: ``,
  tr: ``,
  th: `border:1px solid ${COLOR_BORDER};background:#f0f5fb;padding:8px 10px;text-align:left;font-weight:700;color:${COLOR_HEADING};`,
  td: `border:1px solid ${COLOR_BORDER};padding:8px 10px;text-align:left;vertical-align:top;`,
  br: ``,
});

function styledTagTransform(tagName) {
  return (tag, attribs) => {
    const next = {};
    if (tagName === "a" && attribs.href) next.href = attribs.href;
    const style = BODY_TAG_STYLES[tagName];
    if (style) next.style = style;
    return { tagName, attribs: next };
  };
}

function buildTransformTags() {
  const transforms = {};
  for (const tag of Object.keys(BODY_TAG_STYLES)) {
    transforms[tag] = styledTagTransform(tag);
  }
  // Emails read best with one visual title (the template header), so demote
  // any model-authored top-level heading to a section heading.
  transforms.h1 = styledTagTransform("h2");
  return transforms;
}

const SANITIZE_OPTIONS = Object.freeze({
  allowedTags: [...Object.keys(BODY_TAG_STYLES), "h1"],
  allowedAttributes: {
    a: ["href", "style"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: buildTransformTags(),
});

const INLINE_SANITIZE_OPTIONS = Object.freeze({
  allowedTags: ["strong", "em", "a", "code", "br"],
  allowedAttributes: {
    a: ["href", "style"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    strong: styledTagTransform("strong"),
    em: styledTagTransform("em"),
    a: styledTagTransform("a"),
    code: styledTagTransform("code"),
  },
});

/** Escaped plain-text fallback rendering when marked/sanitize-html are unavailable. */
function fallbackBlockHtml(markdownText) {
  const text = markdownToPlainText(markdownText);
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="${BODY_TAG_STYLES.p}">${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`
    )
    .join("");
}

function fallbackInlineHtml(markdownText) {
  return escapeHtml(markdownToPlainText(markdownText)).replaceAll("\n", "<br />");
}

/** Renders agent-produced markdown into sanitized, inline-styled email HTML. */
export function renderMarkdownToEmailHtml(markdownText) {
  if (!markdownRenderer || !sanitizeHtmlFn) return fallbackBlockHtml(markdownText);
  const html = markdownRenderer.parse(String(markdownText ?? ""), { async: false });
  return sanitizeHtmlFn(html, SANITIZE_OPTIONS).trim();
}

/** Inline variant (no block tags) for the summary callout. */
export function renderInlineMarkdownToEmailHtml(markdownText) {
  if (!markdownRenderer || !sanitizeHtmlFn) return fallbackInlineHtml(markdownText);
  const html = markdownRenderer.parseInline(String(markdownText ?? ""), { async: false });
  return sanitizeHtmlFn(html, INLINE_SANITIZE_OPTIONS).trim();
}

/**
 * Plain-text fallback: strips common markdown syntax so text-only clients see
 * clean copy instead of raw `#`/`**` markers. Best-effort by design.
 */
export function markdownToPlainText(markdownText) {
  let text = String(markdownText ?? "");
  text = text.replace(/```[^\n]*\n?/g, ""); // code fences
  text = text.replace(/^#{1,6}\s+/gm, ""); // heading markers
  text = text.replace(/^\s*>\s?/gm, ""); // blockquote markers
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ""); // horizontal rules
  text = text.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1"); // images → alt text
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"); // links → text (url)
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2"); // bold
  text = text.replace(/(^|\s)(\*|_)(?=\S)([^*_\n]*\S)\2(?=\s|$|[.,;:!?])/gm, "$1$3"); // italic
  text = text.replace(/`([^`\n]+)`/g, "$1"); // inline code
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function renderComparisonNote(comparisonNote) {
  if (!comparisonNote) return "";
  return `
            <p style="margin:0 0 18px;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${COLOR_TEXT};font-style:italic;">${escapeHtml(comparisonNote)}</p>`;
}

function renderSummaryCallout(summaryHtml) {
  if (!summaryHtml) return "";
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
              <tr>
                <td style="background:#eef4ff;border-left:4px solid ${COLOR_ACCENT};border-radius:0 8px 8px 0;padding:16px 18px;">
                  <div style="font-family:${FONT_STACK};font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${COLOR_ACCENT};margin-bottom:7px;">Summary</div>
                  <div style="font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${COLOR_HEADING};">${summaryHtml}</div>
                </td>
              </tr>
            </table>`;
}

/**
 * Assembles the full email document. `bodyHtml` / `summaryHtml` must already
 * be sanitized (use the render helpers above); `title`, `runDate`, and
 * `comparisonNote` are treated as plain text and escaped here.
 */
export function buildEmailHtml({
  agentType,
  title,
  bodyHtml,
  summaryHtml = null,
  runDate = null,
  comparisonNote = null,
}) {
  const safeTitle = escapeHtml(title || "Agent Report");
  const metaLine = [agentTypeLabel(agentType), runDate ? escapeHtml(runDate) : null]
    .filter(Boolean)
    .join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f3f5f9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${COLOR_BORDER};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:${COLOR_HEADER_BG};padding:30px 36px;text-align:center;">
                <div style="font-family:${FONT_STACK};font-size:12px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:${COLOR_ACCENT_LIGHT};">${escapeHtml(BRAND_NAME)}</div>
                <div style="font-family:${FONT_STACK};font-size:25px;line-height:1.3;font-weight:800;color:#ffffff;margin-top:10px;">${safeTitle}</div>
                <div style="font-family:${FONT_STACK};font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:#9fb0c9;margin-top:8px;">${metaLine}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 36px 6px;">${renderComparisonNote(comparisonNote)}${renderSummaryCallout(summaryHtml)}
                <div>${bodyHtml || ""}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 36px 30px;">
                <hr style="border:none;border-top:1px solid ${COLOR_BORDER};margin:0 0 16px;" />
                <p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${COLOR_MUTED};">Sent by ${escapeHtml(BRAND_NAME)} to your verified account email at your request. Agents can only email you, never anyone else.</p>
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${COLOR_MUTED};">Manage or turn off email delivery anytime from this agent's settings in ${escapeHtml(BRAND_NAME)}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
