import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { AgentError } from "../../server/agents/errors.js";
import {
  CEO_PERSONALITY_PRESETS,
  ensureCeoAgentConfig,
  isValidAvatarKey,
  isValidPersonalityPreset,
  respondAgentApiError,
  serializeCeoAgentConfig,
} from "../../server/agents/apiHelpers.js";
import { applyOps, getProfile, saveProfile } from "../../server/agents/profile.js";

// POST /api/agents/onboarding — one-shot CEO Agent onboarding. Seeds the
// living profile from structured answers (source: "onboarding"), sets the CEO
// presentation fields, and stamps onboardingCompletedAt.
//
// Idempotency: a second submission returns 409 (already completed) rather
// than merging — onboarding is a one-time flow; later edits go through
// PUT /api/agents/ceo and PATCH /api/agents/ceo/profile.

const TEXT_MAX_LENGTH = 1000;
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

function readText(value, label) {
  if (value == null) return null;
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  return value.trim().slice(0, TEXT_MAX_LENGTH) || null;
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
  const communicationPrefs = readText(payload.communicationPrefs, "communicationPrefs");

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
    communicationPrefs,
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
      });
    });

    const ops = buildProfileOps(parsed);
    if (ops.length) {
      const profile = await getProfile(decodedToken.uid);
      await saveProfile(decodedToken.uid, applyOps(profile, ops, { source: "onboarding" }));
    }

    return response.status(200).json({
      ceoAgent: serializeCeoAgentConfig(ceoConfig),
      profileEntriesSeeded: ops.length,
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
