import { withUserContext } from "../../db/prisma.js";
import { AgentError } from "../errors.js";
import { generateAgentText, getWebSearchTools } from "../llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "../prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Research agent: read-only topic research via Anthropic's provider-executed
// web search tool. It reads NO user financial data at all — the topic comes
// from the agent's instructions/definitionOfDone, plus the agent's own
// previous run summary for a "since our last brief" comparison. Web search is
// the only tool.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_WEB_SEARCHES = 5;
// Legacy marker from the previous prompt format — still parsed as a fallback
// so older stored outputs and non-compliant model output keep working.
const LEGACY_SUMMARY_MARKER = "SUMMARY:";

export const RESEARCH_SYSTEM_PROMPT = [
  "You are the Research agent inside Freedom OS, a personal-finance workspace. You are a read-only researcher.",
  "You research the topic described in the user's agent configuration using web search, then write a factual report of the key findings. Cite the sources (title and URL) you relied on.",
  "You must not give financial directives (buy/sell/move money) or personalized investment recommendations; report findings, not orders.",
  'Write the report as a polished executive brief in Markdown. Do not include any preamble, meta-commentary, or narration of your research process (no "I\'ll research…", no "Let me look into…"). Start directly with the first heading.',
  "Use ## for section headings and **bold** for emphasis where useful.",
  'End with a "## Summary" section containing 2-4 sentences.',
  'If a previous run summary is provided, include a brief "Since our last brief" comparison note (what changed since then) just before the summary section.',
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

/**
 * Extracts the short summary that feeds run.summary and the email callout.
 * Preferred format: a "## Summary" section (kept in the report so it renders
 * like any other section). Falls back to the legacy "SUMMARY:" marker, then
 * to the report's first 240 characters.
 */
export function splitReportAndSummary(text) {
  const raw = String(text || "").trim();

  const headingMatch = raw.match(/^#{1,6}\s*Summary\b.*$/im);
  if (headingMatch) {
    const rest = raw.slice(headingMatch.index + headingMatch[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const summary = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
    if (summary) return { report: raw, summary };
  }

  const markerIndex = raw.lastIndexOf(LEGACY_SUMMARY_MARKER);
  if (markerIndex >= 0) {
    const report = raw.slice(0, markerIndex).trim();
    const summary = raw.slice(markerIndex + LEGACY_SUMMARY_MARKER.length).trim();
    if (summary) return { report: report || summary, summary };
  }

  return { report: raw, summary: raw.slice(0, 240) };
}

/**
 * Best-effort lookup of this agent's previous successful run, so the report
 * can open with a "Since our last brief" comparison. Reads only the agent's
 * own prior summary — never user financial data.
 */
async function getPreviousRunContext(userId, agentConfigId) {
  try {
    const previous = await withUserContext(userId, (tx) =>
      tx.agentRun.findFirst({
        where: { userId, agentConfigId, agentType: "research", status: "SUCCEEDED" },
        orderBy: { startedAt: "desc" },
        select: { summary: true, startedAt: true },
      })
    );
    if (!previous?.summary) return null;
    // The stored summary may carry a delivery-status suffix appended by the
    // runner ("... (email sent to ...)"); strip it from the prompt context.
    const summary = previous.summary.replace(/\s*\(email (sent|skipped|delivery)[^]*$/, "").trim();
    if (!summary) return null;
    const when = previous.startedAt ? new Date(previous.startedAt).toUTCString() : "unknown time";
    return `Previous run completed ${when}. Its summary was:\n${summary}`;
  } catch {
    return null;
  }
}

export async function runResearchAgent({ userId, config }) {
  const hasTopic =
    String(config.instructions || "").trim() || String(config.definitionOfDone || "").trim();
  if (!hasTopic) {
    throw new AgentError(
      "The research agent has no topic: set instructions or a definition of done.",
      "RESEARCH_TOPIC_MISSING",
      400
    );
  }

  const previousRunContext = await getPreviousRunContext(userId, config.id);

  const { text, usage } = await generateAgentText({
    model: config.model,
    system: RESEARCH_SYSTEM_PROMPT,
    prompt: [
      "Research the topic described in the configuration below and write your report.",
      dataSection("AGENT INSTRUCTIONS (user-configured)", config.instructions),
      dataSection("DEFINITION OF DONE (user-configured)", config.definitionOfDone),
      dataSection("PREVIOUS RUN SUMMARY (for the since-our-last-brief comparison)", previousRunContext),
    ].join("\n\n"),
    tools: getWebSearchTools({ maxUses: MAX_WEB_SEARCHES }),
    maxOutputTokens: 2000,
  });

  const { report, summary } = splitReportAndSummary(text);
  return {
    summary,
    output: report,
    usage,
    model: config.model,
    dataAccessed: {
      description:
        "No user financial data was read. Topic text came from the agent configuration, the agent's own previous run summary was provided for comparison, and web search was used read-only.",
      webSearch: { maxUses: MAX_WEB_SEARCHES },
    },
  };
}
