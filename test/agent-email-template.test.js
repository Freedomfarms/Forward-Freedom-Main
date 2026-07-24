import test from "node:test";
import assert from "node:assert/strict";

import {
  agentTypeLabel,
  buildEmailHtml,
  escapeHtml,
  formatRunDate,
  markdownToPlainText,
  renderInlineMarkdownToEmailHtml,
  renderMarkdownToEmailHtml,
} from "../server/agents/emailTemplate.js";
import { splitReportAndSummary } from "../server/agents/types/research.js";

test("renderMarkdownToEmailHtml renders and inline-styles markdown", () => {
  const html = renderMarkdownToEmailHtml(
    "## Market Pulse\n\nBTC held **steady** this week.\n\n- point one\n- point two\n\n| Asset | Price |\n| --- | --- |\n| BTC | $65,053 |"
  );
  assert.match(html, /<h2 style="[^"]+">Market Pulse<\/h2>/);
  assert.match(html, /<strong style="[^"]+">steady<\/strong>/);
  assert.match(html, /<ul style="[^"]+">/);
  assert.match(html, /<table style="[^"]+">/);
  assert.match(html, /<td style="[^"]+">\$65,053<\/td>/);
});

test("renderMarkdownToEmailHtml strips dangerous content and attributes", () => {
  const html = renderMarkdownToEmailHtml(
    '<script>alert(1)</script><p onclick="evil()" style="color:red">hi</p>' +
      '<a href="javascript:alert(1)">bad</a> <a href="https://ok.com">ok</a>'
  );
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /onclick/);
  assert.doesNotMatch(html, /color:red/); // model-authored styles replaced with ours
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/ok\.com"/);
});

test("renderMarkdownToEmailHtml demotes h1 to h2", () => {
  const html = renderMarkdownToEmailHtml("# Top Title");
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /<h2 style="[^"]+">Top Title<\/h2>/);
});

test("renderInlineMarkdownToEmailHtml keeps emphasis only", () => {
  const html = renderInlineMarkdownToEmailHtml("BTC slipped **-1.2%** since [Tuesday](https://x.com).");
  assert.match(html, /<strong style="[^"]+">-1\.2%<\/strong>/);
  assert.match(html, /href="https:\/\/x\.com"/);
  assert.doesNotMatch(html, /<p/);
});

test("markdownToPlainText strips markdown syntax for the text fallback", () => {
  const text = markdownToPlainText(
    "## Heading\n\nSome **bold** and *italic* text with `code` and a [link](https://example.com).\n\n---\n\n> quoted"
  );
  assert.doesNotMatch(text, /[#`]|\*\*/);
  assert.match(text, /^Heading/);
  assert.match(text, /Some bold and italic text with code and a link \(https:\/\/example\.com\)\./);
  assert.match(text, /quoted/);
});

test("formatRunDate formats like 'Friday, July 24'", () => {
  assert.equal(formatRunDate(new Date("2026-07-24T13:00:00Z")), "Friday, July 24");
});

test("agentTypeLabel maps known types and defaults", () => {
  assert.equal(agentTypeLabel("research"), "Research Brief");
  assert.equal(agentTypeLabel("finance"), "Finance Report");
  assert.equal(agentTypeLabel("reminders"), "Reminder");
  assert.equal(agentTypeLabel("unknown"), "Agent Report");
});

test("buildEmailHtml assembles header, callout, body, and footer with escaping", () => {
  const html = buildEmailHtml({
    agentType: "research",
    title: "Fed <Watch>",
    runDate: "Friday, July 24",
    bodyHtml: "<p>body content</p>",
    summaryHtml: "summary content",
    comparisonNote: "Since our last brief: <changed>",
  });
  assert.match(html, /Freedom OS/);
  assert.match(html, /Fed &lt;Watch&gt;/); // title escaped
  assert.match(html, /Research Brief/);
  assert.match(html, /Friday, July 24/);
  assert.match(html, /summary content/);
  assert.match(html, /body content/);
  assert.match(html, /Since our last brief: &lt;changed&gt;/); // note escaped
  assert.match(html, /only email you, never anyone else/i);
  // Inline-styled, table-based layout (no <style> blocks for Gmail).
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /<table role="presentation"/);
});

test("buildEmailHtml omits callout and note when absent", () => {
  const html = buildEmailHtml({
    agentType: "reminders",
    title: "Reminder",
    bodyHtml: "<p>pay the bill</p>",
  });
  assert.doesNotMatch(html, /Summary<\/div>/);
  assert.match(html, /pay the bill/);
});

test("escapeHtml escapes all HTML-significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("splitReportAndSummary extracts a ## Summary section and keeps it in the report", () => {
  const text =
    "## Findings\n\nDetails here.\n\n## Summary\n\nRates held steady. Futures price a hike by October.";
  const { report, summary } = splitReportAndSummary(text);
  assert.equal(summary, "Rates held steady. Futures price a hike by October.");
  assert.equal(report, text); // section stays in the report body
});

test("splitReportAndSummary stops the summary at the next heading", () => {
  const { summary } = splitReportAndSummary(
    "## Summary\n\nShort version.\n\n## Sources\n\n- one"
  );
  assert.equal(summary, "Short version.");
});

test("splitReportAndSummary falls back to the legacy SUMMARY: marker", () => {
  const { report, summary } = splitReportAndSummary("Report body.\n\nSUMMARY: Old style summary.");
  assert.equal(summary, "Old style summary.");
  assert.equal(report, "Report body.");
});

test("splitReportAndSummary falls back to a 240-char excerpt", () => {
  const { report, summary } = splitReportAndSummary("Just a short report with no summary section.");
  assert.equal(report, "Just a short report with no summary section.");
  assert.equal(summary, "Just a short report with no summary section.");
});
