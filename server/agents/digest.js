import { withUserContext } from "../db/prisma.js";
import { decryptJson, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";
import { CEO_AGENT_MODEL, generateAgentText } from "./llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { normalizeProfile, renderProfileForPrompt } from "./profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Agent digest: one short readable status update synthesized from the
// user's recent run summaries (already minimized plaintext) plus the living
// profile, cached encrypted on CeoAgentConfig so opening the dashboard never
// requires a fresh LLM call.
// ─────────────────────────────────────────────────────────────────────────────

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_MAX_RUNS = 50;

export const NO_ACTIVITY_DIGEST =
  "Nothing to report yet — your agents haven't completed any runs recently. Once they start running, I'll summarize what they find here.";

// Personality is preset-driven by design: fixed server-side snippets keyed by
// the CeoPersonalityPreset enum — never free text.
const PERSONALITY_TONES = Object.freeze({
  DIRECT_EFFICIENT:
    "Tone: direct and efficient. Lead with what matters, skip pleasantries, keep it tight.",
  WARM_ENCOURAGING:
    "Tone: warm and encouraging. Be supportive and positive while staying factual.",
  FORMAL: "Tone: formal and professional. Use measured, precise language.",
});

function buildDigestSystemPrompt(personalityPreset) {
  return [
    "You are the CEO Agent inside Freedom OS: the orchestrator that coordinates a user's team of read-only agents and reports to the user.",
    "Write a short, readable status update (a few sentences to a few short bullets) summarizing what the user's agents found recently, using the run summaries provided as data.",
    "You cannot take actions; you only inform. Never give directives such as buy/sell/move money and never make investment recommendations.",
    PERSONALITY_TONES[personalityPreset] || PERSONALITY_TONES.DIRECT_EFFICIENT,
    "Safety rules:",
    `- ${PROMPT_SAFETY_RULES}`,
  ].join("\n");
}

function renderRunSummaries(runs) {
  return runs
    .map((run) => {
      const day = new Date(run.startedAt).toISOString().slice(0, 10);
      return `[${day}] (${run.agentType}) ${run.summary}`;
    })
    .join("\n");
}

/**
 * Collects the last ~7 days of run summaries across all the user's agents
 * (inside their RLS context), makes one model call, and caches the result
 * encrypted on CeoAgentConfig.lastDigestCiphertext/lastDigestAt.
 * With no recent runs it returns a friendly message without an LLM call.
 */
export async function generateDigest(userId) {
  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { ceoConfig, runs } = await withUserContext(userId, async (tx) => {
    const ceoConfigRow = await tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { id: true, personalityPreset: true, profileCiphertext: true },
    });
    if (!ceoConfigRow) return { ceoConfig: null, runs: [] };
    const runRows = await tx.agentRun.findMany({
      where: { userId, status: "SUCCEEDED", startedAt: { gte: since }, summary: { not: null } },
      orderBy: { startedAt: "desc" },
      take: DIGEST_MAX_RUNS,
      select: { agentType: true, summary: true, startedAt: true },
    });
    return { ceoConfig: ceoConfigRow, runs: runRows };
  });

  if (!ceoConfig) {
    throw new AgentError("CEO Agent is not set up for this user.", "CEO_AGENT_NOT_FOUND", 404);
  }

  if (!runs.length) {
    return { digest: NO_ACTIVITY_DIGEST, generatedAt: new Date(), model: null, usage: null };
  }

  const profile = normalizeProfile(
    ceoConfig.profileCiphertext ? decryptJson(ceoConfig.profileCiphertext) : null
  );

  const { text, usage } = await generateAgentText({
    model: CEO_AGENT_MODEL,
    system: buildDigestSystemPrompt(ceoConfig.personalityPreset),
    prompt: [
      "Write the status update for the user based on the recent agent activity below.",
      dataSection("RECENT AGENT RUN SUMMARIES", renderRunSummaries(runs)),
      dataSection("USER PROFILE (long-term memory)", renderProfileForPrompt(profile)),
    ].join("\n\n"),
    maxOutputTokens: 700,
  });

  const digest = String(text || "").trim();
  const generatedAt = new Date();
  await withUserContext(userId, (tx) =>
    tx.ceoAgentConfig.update({
      where: { id: ceoConfig.id },
      data: { lastDigestCiphertext: encrypt(digest), lastDigestAt: generatedAt },
    })
  );

  return { digest, generatedAt, model: CEO_AGENT_MODEL, usage };
}
