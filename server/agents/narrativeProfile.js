import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";
import { CEO_AGENT_MODEL, generateAgentText, isLlmConfigured } from "./llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { getProfile, renderProfileForPrompt } from "./profile.js";
import { isCreationStateContent } from "./creationState.js";

// Long-form "Read your Profile" newsletter: derived from living profile facts,
// CEO chat history, and created agents. Cached encrypted on CeoAgentConfig
// (separate from the short onboarding summary).

export const INSUFFICIENT_PROFILE_MESSAGE =
  "I don't have enough information yet to build your profile — chat with me a bit more or create an agent, and I'll be able to write one.";

const CHAT_MESSAGE_FETCH_LIMIT = 400;
const CHAT_PROMPT_CHAR_BUDGET = 48_000;
const MIN_PROFILE_WORDS = 300;
const MAX_PROFILE_WORDS = 2000;
// ~2000 words ≈ 2600–3000 tokens; leave headroom for headings.
const NARRATIVE_MAX_OUTPUT_TOKENS = 3200;

const PERSONALITY_TONES = Object.freeze({
  DIRECT_EFFICIENT:
    "Tone: direct and efficient. Clear sentences, no fluff, still warm enough to read.",
  WARM_ENCOURAGING:
    "Tone: warm and encouraging. Supportive and easy to read, without sounding salesy.",
  FORMAL: "Tone: formal and professional. Measured, precise, and readable.",
});

export function isMissingNarrativeProfileColumnError(error) {
  const message = String(error?.message || "");
  return error?.code === "P2022" && /narrativeProfile/i.test(message);
}

function countProfileFacts(profile) {
  const categories = profile?.categories || {};
  return Object.values(categories).reduce(
    (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
    0
  );
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function renderAgentsForPrompt(agents) {
  if (!agents.length) return "(no agents created yet)";
  return agents
    .map((agent, index) => {
      const instructions = String(agent.instructions || "").trim() || "(none)";
      const dod = String(agent.definitionOfDone || "").trim() || "(none)";
      return [
        `${index + 1}. ${agent.name} [${agent.agentType}] status=${agent.status}`,
        `   Instructions: ${instructions}`,
        `   Definition of done: ${dod}`,
      ].join("\n");
    })
    .join("\n");
}

function renderChatForPrompt(messages) {
  if (!messages.length) return "(no CEO chat history yet)";
  const lines = [];
  let used = 0;
  for (const message of messages) {
    const day = message.createdAt
      ? new Date(message.createdAt).toISOString().slice(0, 10)
      : "unknown-date";
    const role = message.role === "user" ? "USER" : "CEO";
    const line = `[${day}] ${role}: ${message.text}`;
    if (used + line.length + 1 > CHAT_PROMPT_CHAR_BUDGET) {
      lines.push(
        `…(${messages.length - lines.length} older messages omitted to fit context)`
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

function buildNarrativeSystemPrompt(personalityPreset) {
  return [
    "You are the user's CEO Agent inside Freedom OS.",
    "Write a long-form personal profile newsletter about the user, based only on the data sections provided.",
    "This is a profile article, not financial advice. Never recommend buy/sell/move money.",
    "Audience: the user reading about themselves. Use plain, easy language — not jargon, not stiff corporate speak.",
    PERSONALITY_TONES[personalityPreset] || PERSONALITY_TONES.DIRECT_EFFICIENT,
    "Format requirements:",
    "- Organized newsletter with clear markdown headings.",
    "- Preferred sections (skip any with nothing real to say): Who You Are · What You're Building · How You Work · Your Agents · What's Next.",
    `- When you DO have enough substance, write at least ${MIN_PROFILE_WORDS} words and at most ${MAX_PROFILE_WORDS} words.`,
    "- Prefer depth and concrete detail drawn from the data. Do not pad with empty filler.",
    "Enough-information rule:",
    "- You need meaningful material from at least one of: several profile facts, real CEO chat (not just a couple of throwaway hellos), or one or more created agents.",
    `- If there is not enough meaningful information, reply with EXACTLY this sentence and nothing else: ${INSUFFICIENT_PROFILE_MESSAGE}`,
    "Safety rules:",
    `- ${PROMPT_SAFETY_RULES}`,
  ].join("\n");
}

/**
 * Soft pre-check before spending an LLM call. Anything beyond total emptiness
 * goes to the model, which decides whether chat is "meaningful" enough.
 */
export function hasAnyNarrativeSourceMaterial({ profileFactCount, agentCount, chatMessageCount }) {
  return profileFactCount > 0 || agentCount > 0 || chatMessageCount > 0;
}

async function loadNarrativeContext(userId) {
  const profile = await getProfile(userId);

  const { ceoConfig, agents, chatRows, documentNames } = await withUserContext(
    userId,
    async (tx) => {
      const ceoConfigRow = await tx.ceoAgentConfig.findFirst({
        where: { userId },
        select: { id: true, personalityPreset: true, name: true },
      });
      if (!ceoConfigRow) {
        return { ceoConfig: null, agents: [], chatRows: [], documentNames: [] };
      }

      const agentRows = await tx.agentConfig.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          name: true,
          agentType: true,
          instructions: true,
          definitionOfDone: true,
          status: true,
        },
      });

      const systemConversations = await tx.agentConversation.findMany({
        where: { userId, ceoAgentConfigId: ceoConfigRow.id, isSystem: true },
        select: { id: true },
      });
      const systemIds = new Set(systemConversations.map((row) => row.id));

      const rawChat = await tx.agentChatMessage.findMany({
        where: { userId, ceoAgentConfigId: ceoConfigRow.id },
        orderBy: { createdAt: "desc" },
        take: CHAT_MESSAGE_FETCH_LIMIT,
        select: {
          role: true,
          contentCiphertext: true,
          createdAt: true,
          conversationId: true,
        },
      });

      const docs = await tx.ceoDocument.findMany({
        where: { userId, ceoAgentConfigId: ceoConfigRow.id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { filename: true },
      });

      return {
        ceoConfig: ceoConfigRow,
        agents: agentRows,
        chatRows: rawChat.filter(
          (row) => !row.conversationId || !systemIds.has(row.conversationId)
        ),
        documentNames: docs.map((doc) => doc.filename).filter(Boolean),
      };
    }
  );

  if (!ceoConfig) {
    throw new AgentError("CEO Agent is not set up for this user.", "CEO_AGENT_NOT_FOUND", 404);
  }

  const chatMessages = [];
  for (const row of chatRows) {
    let text;
    try {
      text = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    if (!text?.trim() || isCreationStateContent(text)) continue;
    chatMessages.push({
      role: row.role === "USER" ? "user" : "agent",
      text: text.trim(),
      createdAt: row.createdAt,
    });
  }
  // Oldest → newest for the prompt (we fetched newest-first).
  chatMessages.reverse();

  return {
    ceoConfig,
    profile,
    profileFactCount: countProfileFacts(profile),
    agents,
    chatMessages,
    documentNames,
  };
}

export async function readNarrativeProfile(userId) {
  let row;
  try {
    row = await withUserContext(userId, (tx) =>
      tx.ceoAgentConfig.findFirst({
        where: { userId },
        select: {
          narrativeProfileCiphertext: true,
          narrativeProfileAt: true,
        },
      })
    );
  } catch (error) {
    if (isMissingNarrativeProfileColumnError(error)) {
      return { profile: null, generatedAt: null, insufficient: false };
    }
    throw error;
  }
  if (!row?.narrativeProfileCiphertext) {
    return { profile: null, generatedAt: null, insufficient: false };
  }
  try {
    const profile = decrypt(row.narrativeProfileCiphertext);
    return {
      profile,
      generatedAt: row.narrativeProfileAt ?? null,
      insufficient: profile.trim() === INSUFFICIENT_PROFILE_MESSAGE,
    };
  } catch {
    return { profile: null, generatedAt: null, insufficient: false };
  }
}

export async function saveNarrativeProfile(userId, profileText) {
  const text = String(profileText || "").trim();
  const ciphertext = encrypt(text);
  const at = new Date();
  try {
    await withUserContext(userId, async (tx) => {
      const ceo = await tx.ceoAgentConfig.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (!ceo) return;
      await tx.ceoAgentConfig.update({
        where: { id: ceo.id },
        data: {
          narrativeProfileCiphertext: ciphertext,
          narrativeProfileAt: at,
        },
        select: { id: true },
      });
    });
  } catch (error) {
    if (isMissingNarrativeProfileColumnError(error)) {
      // Still return the generated text so the UI can show it this session.
      return {
        profile: text,
        generatedAt: at,
        insufficient: text === INSUFFICIENT_PROFILE_MESSAGE,
        persisted: false,
      };
    }
    throw error;
  }
  return {
    profile: text,
    generatedAt: at,
    insufficient: text === INSUFFICIENT_PROFILE_MESSAGE,
    persisted: true,
  };
}

/**
 * Generates (or refuses for insufficient data) the long-form newsletter profile
 * and caches it on CeoAgentConfig.
 */
export async function generateNarrativeProfile(userId) {
  const context = await loadNarrativeContext(userId);

  if (
    !hasAnyNarrativeSourceMaterial({
      profileFactCount: context.profileFactCount,
      agentCount: context.agents.length,
      chatMessageCount: context.chatMessages.length,
    })
  ) {
    return saveNarrativeProfile(userId, INSUFFICIENT_PROFILE_MESSAGE);
  }

  if (!isLlmConfigured()) {
    throw new AgentError(
      "The AI service is not configured (missing ANTHROPIC_API_KEY).",
      "LLM_NOT_CONFIGURED",
      503
    );
  }

  const { text, usage } = await generateAgentText({
    model: CEO_AGENT_MODEL,
    system: buildNarrativeSystemPrompt(context.ceoConfig.personalityPreset),
    prompt: [
      "Write the user's long-form profile newsletter from the data below.",
      `CEO Agent name: ${context.ceoConfig.name || "CEO Agent"}`,
      dataSection("LIVING PROFILE FACTS", renderProfileForPrompt(context.profile)),
      dataSection("AGENTS THE USER CREATED", renderAgentsForPrompt(context.agents)),
      dataSection("CEO CHAT HISTORY (full available history)", renderChatForPrompt(context.chatMessages)),
      dataSection(
        "REFERENCE DOCUMENT FILENAMES (optional mention only — do not invent content)",
        context.documentNames.length ? context.documentNames.join("\n") : "(none)"
      ),
      [
        "Reminders:",
        `- If meaningful material is present, produce ${MIN_PROFILE_WORDS}–${MAX_PROFILE_WORDS} words with the section headings.`,
        `- If not, reply with EXACTLY: ${INSUFFICIENT_PROFILE_MESSAGE}`,
      ].join("\n"),
    ].join("\n\n"),
    maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
  });

  let profile = String(text || "").trim();
  if (!profile) {
    profile = INSUFFICIENT_PROFILE_MESSAGE;
  }

  // Soft enforce: if the model wrote a short "almost enough" piece that isn't
  // the insufficient sentence, keep it only when it's clearly the refusal;
  // otherwise accept whatever readable newsletter came back (model owns length).
  const words = countWords(profile);
  const looksLikeRefusal =
    /not have enough information|more information is needed|enough information yet/i.test(profile) &&
    words < MIN_PROFILE_WORDS;
  if (looksLikeRefusal) {
    profile = INSUFFICIENT_PROFILE_MESSAGE;
  }

  const saved = await saveNarrativeProfile(userId, profile);
  return { ...saved, model: CEO_AGENT_MODEL, usage: usage || null, wordCount: countWords(profile) };
}
