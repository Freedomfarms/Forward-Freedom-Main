import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { AgentError } from "../../server/agents/errors.js";
import {
  CEO_AGENT_CONFIG_SAFE_SELECT,
  CEO_PERSONALITY_PRESETS,
  ensureCeoAgentConfig,
  isValidAvatarKey,
  isValidPersonalityPreset,
  respondAgentApiError,
  serializeCeoAgentConfig,
} from "../../server/agents/apiHelpers.js";
import {
  createCeoDocuments,
  isMissingCeoDocumentsError,
  readDocumentInputs,
} from "../../server/agents/documents.js";
import {
  generateOnboardingSummary,
  isMissingOnboardingSummaryColumnError,
  saveOnboardingSummary,
} from "../../server/agents/onboardingSummary.js";
import { applyOps, getProfile, saveProfile } from "../../server/agents/profile.js";

// POST /api/agents/onboarding — one-shot CEO Agent onboarding. Seeds the
// living profile from structured answers (source: "onboarding"), stores
// optional reference documents, generates a short profile summary, sets the
// CEO presentation fields, and stamps onboardingCompletedAt.
//
// Idempotency: a second submission returns 409 (already completed) rather
// than merging — onboarding is a one-time flow; later edits go through
// PUT /api/agents/ceo and PATCH /api/agents/ceo/profile.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

const TEXT_MAX_LENGTH = 1000;
const ADDITIONAL_NOTES_MAX_LENGTH = 2000;
const LIST_MAX_ITEMS = 10;

function invalid(message) {
  return new AgentError(message, "INVALID_AGENT_PAYLOAD", 400);
}

function readTextList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be an array of strings.`);
  if (value.length > LIST_MAX_ITEMS) throw invalid(`${label} may contain at most ${LIST_MAX_ITEMS} items.`);
  return value
    .map((item) => {
      if (typeof item !== "string") throw invalid(`${label} must contain only strings.`);
      return item.trim().slice(0, TEXT_MAX_LENGTH);
    })
    .filter(Boolean);
}

function readText(value, label, { maxLength = TEXT_MAX_LENGTH } = {}) {
  if (value == null) return null;
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  return value.trim().slice(0, maxLength) || null;
}

function parseOnboardingPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("A JSON object body is required.");
  }

  const financialGoals = readTextList(payload.financialGoals, "financialGoals");
  const priorities = Array.isArray(payload.priorities)
    ? readTextList(payload.priorities, "priorities")
    : [readText(payload.priorities, "priorities")].filter(Boolean);
  const lifeContext = readText(payload.lifeContext, "lifeContext");
  const additionalNotes = readText(payload.additionalNotes, "additionalNotes", {
    maxLength: ADDITIONAL_NOTES_MAX_LENGTH,
  });
  const communicationPrefs = readText(payload.communicationPrefs, "communicationPrefs");
  const documents = readDocumentInputs(payload.documents);

  const ceoName = readText(payload.ceoName, "ceoName");
  if (ceoName && ceoName.length > 80) throw invalid("ceoName must be at most 80 characters.");
  const personalityPreset = payload.personalityPreset ?? null;
  if (personalityPreset != null && !isValidPersonalityPreset(personalityPreset)) {
    throw invalid(`personalityPreset must be one of: ${CEO_PERSONALITY_PRESETS.join(", ")}.`);
  }
  const avatarKey = payload.avatarKey ?? null;
  if (avatarKey != null && !isValidAvatarKey(avatarKey)) {
    throw invalid("avatarKey must be a preset avatar key (short slug) or null.");
  }

  return {
    financialGoals,
    priorities,
    lifeContext,
    additionalNotes,
    communicationPrefs,
    documents,
    ceoName,
    personalityPreset,
    avatarKey,
  };
}

function buildProfileOps(parsed) {
  const ops = [];
  for (const goal of parsed.financialGoals) {
    ops.push({ op: "add", category: "financialGoals", text: goal });
  }
  for (const priority of parsed.priorities) {
    ops.push({ op: "add", category: "statedPreferences", text: `Priority: ${priority}` });
  }
  if (parsed.lifeContext) {
    ops.push({ op: "add", category: "lifeContext", text: parsed.lifeContext });
  }
  if (parsed.additionalNotes) {
    ops.push({
      op: "add",
      category: "lifeContext",
      text: `Additional notes: ${parsed.additionalNotes}`,
    });
  }
  if (parsed.communicationPrefs) {
    ops.push({
      op: "add",
      category: "statedPreferences",
      text: `Communication preference: ${parsed.communicationPrefs}`,
    });
  }
  return ops;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "POST") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  // Summary generation falls back to a template when the LLM is unavailable,
  // so onboarding stays on the general limiter (one-shot per account anyway).
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const parsed = parseOnboardingPayload(await readJsonBody(request));

    const ceoConfig = await withUserContext(decodedToken.uid, async (tx) => {
      const config = await ensureCeoAgentConfig(tx, decodedToken.uid);
      if (config.onboardingCompletedAt) {
        throw new AgentError(
          "Onboarding has already been completed for this account.",
          "ONBOARDING_ALREADY_COMPLETED",
          409
        );
      }
      return tx.ceoAgentConfig.update({
        where: { id: config.id },
        data: {
          ...(parsed.ceoName ? { name: parsed.ceoName } : {}),
          ...(parsed.personalityPreset ? { personalityPreset: parsed.personalityPreset } : {}),
          ...(parsed.avatarKey ? { avatarKey: parsed.avatarKey } : {}),
          onboardingCompletedAt: new Date(),
        },
        select: CEO_AGENT_CONFIG_SAFE_SELECT,
      });
    });

    const ops = buildProfileOps(parsed);
    let profile = await getProfile(decodedToken.uid);
    if (ops.length) {
      profile = applyOps(profile, ops, { source: "onboarding" });
      await saveProfile(decodedToken.uid, profile);
    }

    let documents = [];
    if (parsed.documents.length) {
      try {
        documents = await createCeoDocuments(decodedToken.uid, ceoConfig.id, parsed.documents);
      } catch (error) {
        // Table may not exist yet if migrate deploy lagged; don't fail setup.
        if (!isMissingCeoDocumentsError(error)) throw error;
        console.warn(
          "[onboarding] CeoDocument table missing; continuing without document storage until migrate deploy."
        );
      }
    }

    const { summary } = await generateOnboardingSummary({
      profile,
      additionalNotes: parsed.additionalNotes,
      documentNames: documents.map((doc) => doc.filename),
      personalityPreset: ceoConfig.personalityPreset,
    });
    let savedSummary = { summary, generatedAt: new Date() };
    try {
      savedSummary = await saveOnboardingSummary(decodedToken.uid, summary);
    } catch (error) {
      if (!isMissingOnboardingSummaryColumnError(error)) throw error;
      console.warn(
        "[onboarding] onboardingSummary columns missing; summary returned but not cached until migrate deploy."
      );
    }

    return response.status(200).json({
      ceoAgent: serializeCeoAgentConfig(ceoConfig),
      profileEntriesSeeded: ops.length,
      documents,
      onboardingSummary: {
        summary: savedSummary.summary,
        generatedAt: savedSummary.generatedAt,
      },
    });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/onboarding",
      error,
      "Unable to complete CEO Agent onboarding."
    );
  }
}
