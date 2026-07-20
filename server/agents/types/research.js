import { AgentError } from "../errors.js";
import { generateAgentText, getWebSearchTools } from "../llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "../prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Research agent: read-only topic research via Anthropic's provider-executed
// web search tool. It reads NO user financial data at all — the topic comes
// from the agent's instructions/definitionOfDone. Web search is the only tool.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_WEB_SEARCHES = 5;
const SUMMARY_MARKER = "SUMMARY:";

export const RESEARCH_SYSTEM_PROMPT = [
  "You are the Research agent inside Freedom OS, a personal-finance workspace. You are a read-only researcher.",
  "You research the topic described in the user's agent configuration using web search, then write a concise, factual report with the key findings. Cite the sources (title and URL) you relied on.",
  "You must not give financial directives (buy/sell/move money) or personalized investment recommendations; report findings, not orders.",
  `End your report with a final line that starts with "${SUMMARY_MARKER}" followed by a 1-2 sentence summary of the findings.`,
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

export function splitReportAndSummary(text) {
  const raw = String(text || "").trim();
  const markerIndex = raw.lastIndexOf(SUMMARY_MARKER);
  if (markerIndex >= 0) {
    const report = raw.slice(0, markerIndex).trim();
    const summary = raw.slice(markerIndex + SUMMARY_MARKER.length).trim();
    if (summary) return { report: report || summary, summary };
  }
  // Fallback: first sentence-ish chunk as the summary.
  return { report: raw, summary: raw.slice(0, 240) };
}

export async function runResearchAgent({ userId, config }) {
  void userId; // reads no user data — topic comes from the agent configuration
  const hasTopic =
    String(config.instructions || "").trim() || String(config.definitionOfDone || "").trim();
  if (!hasTopic) {
    throw new AgentError(
      "The research agent has no topic: set instructions or a definition of done.",
      "RESEARCH_TOPIC_MISSING",
      400
    );
  }

  const { text, usage } = await generateAgentText({
    model: config.model,
    system: RESEARCH_SYSTEM_PROMPT,
    prompt: [
      "Research the topic described in the configuration below and write your report.",
      dataSection("AGENT INSTRUCTIONS (user-configured)", config.instructions),
      dataSection("DEFINITION OF DONE (user-configured)", config.definitionOfDone),
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
        "No user financial data was read. Topic text came from the agent configuration; web search was used read-only.",
      webSearch: { maxUses: MAX_WEB_SEARCHES },
    },
  };
}
