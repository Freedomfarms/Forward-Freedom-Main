import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { CEO_AGENT_MODEL, generateAgentText, isLlmConfigured } from "./llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { renderProfileForPrompt } from "./profile.js";

// Narrative "here's what I know about you" summary written after onboarding.
// Falls back to a deterministic template when the LLM is unavailable so setup
// never blocks on model access.

function buildTemplateSummary({ profile, additionalNotes, documentNames }) {
  const goals = profile?.categories?.financialGoals?.map((entry) => entry.text) || [];
  const life = profile?.categories?.lifeContext?.map((entry) => entry.text) || [];
  const prefs = profile?.categories?.statedPreferences?.map((entry) => entry.text) || [];
  const lines = ["Here's what I'll keep in mind about you:"];
  if (goals.length) {
    lines.push("", "Goals:", ...goals.map((goal) => `• ${goal}`));
  }
  if (life.length || additionalNotes) {
    lines.push("", "Life context:");
    for (const item of life) lines.push(`• ${item}`);
    if (additionalNotes) lines.push(`• ${additionalNotes}`);
  }
  if (prefs.length) {
    lines.push("", "Preferences & priorities:", ...prefs.map((item) => `• ${item}`));
  }
  if (documentNames?.length) {
    lines.push(
      "",
      "Reference documents I'll use when we talk:",
      ...documentNames.map((name) => `• ${name}`)
    );
  }
  if (lines.length === 1) {
    lines.push("", "You haven't shared much yet — chat with me anytime and I'll learn as we go.");
  } else {
    lines.push("", "You can edit or delete any of this in your profile, and upload more documents later.");
  }
  return lines.join("\n");
}

export async function generateOnboardingSummary({
  profile,
  additionalNotes = null,
  documentNames = [],
  personalityPreset = "DIRECT_EFFICIENT",
} = {}) {
  const fallback = buildTemplateSummary({ profile, additionalNotes, documentNames });
  if (!isLlmConfigured()) {
    return { summary: fallback, model: null, usage: null };
  }

  const tone =
    personalityPreset === "WARM_ENCOURAGING"
      ? "Tone: warm and encouraging."
      : personalityPreset === "FORMAL"
        ? "Tone: formal and professional."
        : "Tone: direct and efficient.";

  try {
    const { text, usage } = await generateAgentText({
      model: CEO_AGENT_MODEL,
      system: [
        "You are the user's CEO Agent inside Freedom OS.",
        "Write a short personal briefing (a short intro paragraph plus a few bullets) summarizing what you now know about the user from onboarding.",
        "This is a profile summary, not financial advice. Never recommend buy/sell/move money.",
        tone,
        "Safety rules:",
        `- ${PROMPT_SAFETY_RULES}`,
      ].join("\n"),
      prompt: [
        "Produce the onboarding profile summary from this data.",
        dataSection("LIVING PROFILE", renderProfileForPrompt(profile)),
        dataSection("ADDITIONAL NOTES FROM USER", additionalNotes || "(none)"),
        dataSection(
          "UPLOADED DOCUMENT FILENAMES",
          documentNames.length ? documentNames.join("\n") : "(none)"
        ),
      ].join("\n\n"),
      maxOutputTokens: 700,
    });
    const summary = String(text || "").trim();
    return { summary: summary || fallback, model: CEO_AGENT_MODEL, usage: usage || null };
  } catch {
    return { summary: fallback, model: null, usage: null };
  }
}

export async function saveOnboardingSummary(userId, summary) {
  const ciphertext = encrypt(String(summary || "").trim());
  const at = new Date();
  await withUserContext(userId, async (tx) => {
    const ceo = await tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!ceo) return;
    await tx.ceoAgentConfig.update({
      where: { id: ceo.id },
      data: {
        onboardingSummaryCiphertext: ciphertext,
        onboardingSummaryAt: at,
      },
    });
  });
  return { summary: String(summary || "").trim(), generatedAt: at };
}

export async function readOnboardingSummary(userId) {
  const row = await withUserContext(userId, (tx) =>
    tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: {
        onboardingSummaryCiphertext: true,
        onboardingSummaryAt: true,
      },
    })
  );
  if (!row?.onboardingSummaryCiphertext) {
    return { summary: null, generatedAt: null };
  }
  try {
    return {
      summary: decrypt(row.onboardingSummaryCiphertext),
      generatedAt: row.onboardingSummaryAt ?? null,
    };
  } catch {
    return { summary: null, generatedAt: null };
  }
}
