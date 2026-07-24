import { withUserContext } from "../db/prisma.js";
import { decrypt, decryptJson, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";
import { CEO_AGENT_MODEL, generateAgentText } from "./llm.js";
import { normalizeAgentModel } from "./models.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { normalizeProfile, renderProfileForPrompt } from "./profile.js";
import {
  loadTeamAgents,
  renderNamedRunSummaries,
  renderTeamRoster,
} from "./teamContext.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Agent digest: a short readable briefing synthesized from the user's
// recent run summaries (already minimized plaintext) plus the living profile,
// cached encrypted on CeoAgentConfig so opening the dashboard never requires
// a fresh LLM call. The CEO chat can also replace this body on request.
// ─────────────────────────────────────────────────────────────────────────────

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_MAX_RUNS = 50;
export const DIGEST_MAX_LENGTH = 4000;

export const DIGEST_ACTION_TYPES = Object.freeze(["set_content", "regenerate"]);

export const NO_ACTIVITY_DIGEST =
  "Nothing to report yet — your agents haven't completed any runs recently. Once they start running, I'll summarize what they find here.";

function noActivityDigestForTeam(agents) {
  if (!agents?.length) return NO_ACTIVITY_DIGEST;
  const names = agents.map((agent) => agent.name).filter(Boolean);
  if (!names.length) return NO_ACTIVITY_DIGEST;
  const teamList =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  return `Nothing to report yet — your team includes ${teamList}, but none have completed runs recently. Once they start running, I'll summarize what they find here.`;
}

// Personality is preset-driven by design: fixed server-side snippets keyed by
// the CeoPersonalityPreset enum — never free text.
const PERSONALITY_TONES = Object.freeze({
  DIRECT_EFFICIENT:
    "Tone: direct and efficient. Lead with what matters, skip pleasantries, keep it tight.",
  WARM_ENCOURAGING:
    "Tone: warm and encouraging. Be supportive and positive while staying factual.",
  FORMAL: "Tone: formal and professional. Use measured, precise language.",
});

/** JSON-schema fragment for CEO-chat digest edits. */
export const DIGEST_ACTION_JSON_SCHEMA = {
  anyOf: [
    {
      type: "null",
      description: "No digest change — leave null for ordinary questions.",
    },
    {
      type: "object",
      description:
        "Change the Daily Digest body shown on the Freedom OS home. Use when the user asks you to rewrite, replace, or regenerate that briefing.",
      properties: {
        type: {
          type: "string",
          enum: [...DIGEST_ACTION_TYPES],
          description:
            "set_content = write the full digest body the user wants; regenerate = rebuild the default briefing from recent agent runs.",
        },
        content: {
          type: "string",
          description:
            "Full Daily Digest body text when type is set_content. Plain text or light markdown; no title/heading for the section itself.",
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
  ],
};

function buildDigestSystemPrompt(personalityPreset) {
  return [
    "You are the CEO Agent inside Freedom OS: the orchestrator that coordinates a user's team of read-only agents and reports to the user.",
    "Write a short, readable Daily Digest briefing (a few sentences to a few short bullets) summarizing what the user's agents found recently, using the run summaries and YOUR SUB-AGENTS roster provided as data.",
    "Refer to agents by the names in YOUR SUB-AGENTS. Never invent teammates that are not listed.",
    "Output ONLY the briefing body. Do not include a title, heading, or label such as \"Status Update\", \"Daily Digest\", or markdown # headings — the UI already labels the section.",
    "You cannot take actions; you only inform. Never give directives such as buy/sell/move money and never make investment recommendations.",
    PERSONALITY_TONES[personalityPreset] || PERSONALITY_TONES.DIRECT_EFFICIENT,
    "Safety rules:",
    `- ${PROMPT_SAFETY_RULES}`,
  ].join("\n");
}

/**
 * Normalizes digest body text: trim, drop a leading chrome heading the model
 * sometimes echoes ("# Status Update"), and enforce a max length.
 */
export function normalizeDigestText(raw, { maxLength = DIGEST_MAX_LENGTH } = {}) {
  let text = String(raw || "")
    .split("\0")
    .join("")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return "";

  // Strip one or more leading ATX headings / bold title lines that only
  // restate the section (the UI already says "Daily digest").
  text = text.replace(
    /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:status\s*update|daily\s*digest|digest|briefing)\s*(?:\*\*|__)?\s*\n+/i,
    ""
  );
  text = text.trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trimEnd();
  }
  return text;
}

export function sanitizeDigestAction(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentError("digestAction must be an object or null.", "INVALID_DIGEST_ACTION", 400);
  }
  const type = raw.type;
  if (!DIGEST_ACTION_TYPES.includes(type)) {
    throw new AgentError(
      `digestAction.type must be one of: ${DIGEST_ACTION_TYPES.join(", ")}.`,
      "INVALID_DIGEST_ACTION",
      400
    );
  }
  if (type === "regenerate") {
    return { type: "regenerate" };
  }
  const content = normalizeDigestText(raw.content);
  if (!content) {
    throw new AgentError(
      "digestAction.content is required when type is set_content.",
      "INVALID_DIGEST_ACTION",
      400
    );
  }
  return { type: "set_content", content };
}

async function persistDigest(userId, ceoConfigId, digest) {
  const generatedAt = new Date();
  await withUserContext(userId, (tx) =>
    tx.ceoAgentConfig.update({
      where: { id: ceoConfigId },
      data: { lastDigestCiphertext: encrypt(digest), lastDigestAt: generatedAt },
      // Avoid RETURNING un-migrated columns (P2022) if schema is lagging.
      select: { id: true },
    })
  );
  return { digest, generatedAt };
}

/** Reads the cached digest body for prompt context (null when empty/missing). */
export async function readCachedDigest(userId) {
  const row = await withUserContext(userId, (tx) =>
    tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { lastDigestCiphertext: true, lastDigestAt: true },
    })
  );
  if (!row?.lastDigestCiphertext) {
    return { digest: null, generatedAt: row?.lastDigestAt ?? null };
  }
  try {
    return {
      digest: decrypt(row.lastDigestCiphertext),
      generatedAt: row.lastDigestAt ?? null,
    };
  } catch {
    return { digest: null, generatedAt: row.lastDigestAt ?? null };
  }
}

/**
 * Replaces the Daily Digest body with user/CEO-authored content (no LLM).
 */
export async function setDigestContent(userId, content) {
  const digest = normalizeDigestText(content);
  if (!digest) {
    throw new AgentError("Digest content cannot be empty.", "INVALID_DIGEST_CONTENT", 400);
  }
  const ceoConfig = await withUserContext(userId, (tx) =>
    tx.ceoAgentConfig.findFirst({ where: { userId }, select: { id: true } })
  );
  if (!ceoConfig) {
    throw new AgentError("CEO Agent is not set up for this user.", "CEO_AGENT_NOT_FOUND", 404);
  }
  return persistDigest(userId, ceoConfig.id, digest);
}

/**
 * Applies a sanitized CEO digestAction. Returns { digest, generatedAt, reply }.
 */
export async function applyCeoDigestAction(userId, action) {
  if (!action) {
    throw new AgentError("A digestAction is required.", "INVALID_DIGEST_ACTION", 400);
  }
  if (action.type === "regenerate") {
    const result = await generateDigest(userId);
    return {
      digest: result.digest,
      generatedAt: result.generatedAt,
      reply: "Done — I regenerated your Daily Digest from recent agent activity.",
    };
  }
  if (action.type === "set_content") {
    const result = await setDigestContent(userId, action.content);
    return {
      digest: result.digest,
      generatedAt: result.generatedAt,
      reply: "Done — I updated your Daily Digest with that content.",
    };
  }
  throw new AgentError("Unsupported digestAction type.", "INVALID_DIGEST_ACTION", 400);
}

/**
 * Collects the last ~7 days of run summaries across all the user's agents
 * (inside their RLS context), makes one model call, and caches the result
 * encrypted on CeoAgentConfig.lastDigestCiphertext/lastDigestAt.
 * With no recent runs it returns a friendly message without an LLM call.
 */
export async function generateDigest(userId) {
  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const { ceoConfig, runs, teamAgents } = await withUserContext(userId, async (tx) => {
    const ceoConfigRow = await tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { id: true, personalityPreset: true, profileCiphertext: true, model: true },
    });
    if (!ceoConfigRow) return { ceoConfig: null, runs: [], teamAgents: [] };
    const agents = await loadTeamAgents(tx, userId);
    const runRows = await tx.agentRun.findMany({
      where: { userId, status: "SUCCEEDED", startedAt: { gte: since }, summary: { not: null } },
      orderBy: { startedAt: "desc" },
      take: DIGEST_MAX_RUNS,
      select: { agentConfigId: true, agentType: true, summary: true, startedAt: true },
    });
    return { ceoConfig: ceoConfigRow, runs: runRows, teamAgents: agents };
  });

  if (!ceoConfig) {
    throw new AgentError("CEO Agent is not set up for this user.", "CEO_AGENT_NOT_FOUND", 404);
  }

  if (!runs.length) {
    const digest = normalizeDigestText(noActivityDigestForTeam(teamAgents));
    const saved = await persistDigest(userId, ceoConfig.id, digest);
    return { ...saved, model: null, usage: null };
  }

  const profile = normalizeProfile(
    ceoConfig.profileCiphertext ? decryptJson(ceoConfig.profileCiphertext) : null
  );

  const model = normalizeAgentModel(ceoConfig.model, CEO_AGENT_MODEL);
  const { text, usage } = await generateAgentText({
    model,
    system: buildDigestSystemPrompt(ceoConfig.personalityPreset),
    prompt: [
      "Write the Daily Digest briefing for the user based on the recent agent activity below.",
      "Remember: body only — no title or heading.",
      dataSection("YOUR SUB-AGENTS (current team)", renderTeamRoster(teamAgents)),
      dataSection("RECENT AGENT RUN SUMMARIES", renderNamedRunSummaries(runs, teamAgents)),
      dataSection("USER PROFILE (long-term memory)", renderProfileForPrompt(profile)),
    ].join("\n\n"),
    maxOutputTokens: 700,
  });

  const digest = normalizeDigestText(text) || NO_ACTIVITY_DIGEST;
  const saved = await persistDigest(userId, ceoConfig.id, digest);
  return { ...saved, model, usage };
}
