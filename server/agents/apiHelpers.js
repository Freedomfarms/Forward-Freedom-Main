import { AuthError } from "../auth/verifyAuth.js";
import { decrypt } from "../security/envelope.js";
import { respondInternalError } from "../http/errorHelpers.js";
import { AgentError, isAgentError } from "./errors.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";
import {
  cronToSchedulePreset,
  isValidSchedulePreset,
  isValidScheduleWeekday,
  schedulePresetToCron,
} from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for the agent-platform API handlers (api/agents/*,
// api/notifications*, api/cron/*): CEO-config bootstrapping, safe
// serialization (no ciphertext ever leaves the server), and validation.
//
// Safety contract enforced here (mirror of the Phase 4 runtime contract):
//   • personality is preset-only — CEO_PERSONALITY_PRESETS is the full set,
//     free-text prompts/personality overrides are structurally impossible;
//   • agent creation always pins permissionLevel READ_ONLY / status ACTIVE;
//   • schedules only exist as presets in the API — raw cron never crosses
//     the API boundary in either direction.
// ─────────────────────────────────────────────────────────────────────────────

export const CEO_PERSONALITY_PRESETS = Object.freeze([
  "DIRECT_EFFICIENT",
  "WARM_ENCOURAGING",
  "FORMAL",
]);

// Types a user may CREATE. "email" is storable by design (schema-ready) but
// its runtime fails closed — the runner records a SKIPPED run for it.
export { CREATABLE_AGENT_TYPES };

// The only tool key any agent may be granted in this phase (reminders email
// delivery to the user's own address). Unknown keys are dropped, not stored.
const ALLOWED_TOOL_KEYS = Object.freeze(["email"]);

const NAME_MAX_LENGTH = 80;
const INSTRUCTIONS_MAX_LENGTH = 2000;
const DEFINITION_OF_DONE_MAX_LENGTH = 500;
const AVATAR_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function invalid(message) {
  return new AgentError(message, "INVALID_AGENT_PAYLOAD", 400);
}

export function isValidPersonalityPreset(value) {
  return CEO_PERSONALITY_PRESETS.includes(value);
}

// avatarKey identifies a preset avatar asset — a short slug, never a URL.
export function isValidAvatarKey(value) {
  return typeof value === "string" && AVATAR_KEY_PATTERN.test(value);
}

/**
 * Gets or creates the user's CeoAgentConfig (exactly one per user). Called by
 * every CEO-facing endpoint so the first visit works without a setup step.
 */
export async function ensureCeoAgentConfig(tx, userId) {
  const existing = await tx.ceoAgentConfig.findFirst({ where: { userId } });
  if (existing) return existing;
  try {
    return await tx.ceoAgentConfig.create({
      data: { userId, name: "CEO Agent", personalityPreset: "DIRECT_EFFICIENT" },
    });
  } catch (error) {
    // Unique(userId) race with a concurrent first request.
    if (error?.code === "P2002") {
      const raced = await tx.ceoAgentConfig.findFirst({ where: { userId } });
      if (raced) return raced;
    }
    throw error;
  }
}

/** Client-safe CEO config shape — never includes ciphertext columns. */
export function serializeCeoAgentConfig(config) {
  return {
    id: config.id,
    name: config.name,
    personalityPreset: config.personalityPreset,
    avatarKey: config.avatarKey ?? null,
    onboardingCompletedAt: config.onboardingCompletedAt ?? null,
    profileUpdatedAt: config.profileUpdatedAt ?? null,
    lastDigestAt: config.lastDigestAt ?? null,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/**
 * Client-safe AgentConfig shape. The stored cron string is translated back to
 * its preset view ({ preset, weekday? } or null for on-demand agents).
 */
export function serializeAgentConfig(config, { latestRun } = {}) {
  const serialized = {
    id: config.id,
    agentType: config.agentType,
    name: config.name,
    instructions: config.instructions ?? null,
    definitionOfDone: config.definitionOfDone ?? null,
    permissionLevel: config.permissionLevel,
    status: config.status,
    toolAccess: config.toolAccess ?? null,
    schedule: cronToSchedulePreset(config.schedule),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
  if (latestRun !== undefined) {
    serialized.latestRun = latestRun ? serializeAgentRun(latestRun) : null;
  }
  return serialized;
}

/**
 * Client-safe AgentRun shape. The encrypted full output is omitted unless the
 * dedicated single-run detail endpoint asks for it with includeOutput.
 */
export function serializeAgentRun(run, { includeOutput = false } = {}) {
  const serialized = {
    id: run.id,
    agentConfigId: run.agentConfigId ?? null,
    agentType: run.agentType,
    status: run.status,
    summary: run.summary ?? null,
    error: run.error ?? null,
    dataAccessed: run.dataAccessed ?? null,
    model: run.model ?? null,
    tokensInput: run.tokensInput ?? null,
    tokensOutput: run.tokensOutput ?? null,
    estimatedCostUsd: run.estimatedCostUsd != null ? Number(run.estimatedCostUsd) : null,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
  };
  if (includeOutput) {
    let output = null;
    if (run.outputCiphertext) {
      try {
        output = decrypt(run.outputCiphertext);
      } catch {
        output = null;
      }
    }
    serialized.output = output;
  }
  return serialized;
}

/** Client-safe Notification shape. */
export function serializeNotification(notification) {
  return {
    id: notification.id,
    agentConfigId: notification.agentConfigId ?? null,
    title: notification.title,
    body: notification.body,
    channel: notification.channel,
    readAt: notification.readAt ?? null,
    createdAt: notification.createdAt,
  };
}

function readTrimmedString(value, label, { maxLength, required = false } = {}) {
  if (value == null) {
    if (required) throw invalid(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw invalid(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw invalid(`${label} is required.`);
    return null;
  }
  if (maxLength && trimmed.length > maxLength) {
    throw invalid(`${label} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

/**
 * Normalizes a toolAccess payload to the stored object shape, dropping every
 * key outside the allowlist. Accepts ["email"] or { email: true }; anything
 * else valid collapses to null (no tools).
 */
export function sanitizeToolAccess(value) {
  if (value == null) return null;
  let enabledKeys;
  if (Array.isArray(value)) {
    enabledKeys = value.filter((key) => ALLOWED_TOOL_KEYS.includes(key));
  } else if (typeof value === "object") {
    enabledKeys = ALLOWED_TOOL_KEYS.filter((key) => value[key] === true);
  } else {
    throw invalid("toolAccess must be an object or an array of tool names.");
  }
  if (!enabledKeys.length) return null;
  return Object.fromEntries(enabledKeys.map((key) => [key, true]));
}

// Translates the API's { schedulePreset, scheduleWeekday? } pair to the cron
// string stored on AgentConfig.schedule. Null preset = on-demand only.
function readSchedule(payload) {
  const preset = payload.schedulePreset ?? null;
  if (preset == null) return null;
  if (!isValidSchedulePreset(preset)) {
    throw invalid(
      `schedulePreset must be one of: ${["daily", "weekly", "monthly"].join(", ")} (or null for on-demand).`
    );
  }
  const weekday = payload.scheduleWeekday ?? null;
  if (weekday != null && !isValidScheduleWeekday(weekday)) {
    throw invalid("scheduleWeekday must be a lowercase weekday name (e.g. \"monday\").");
  }
  const cron = schedulePresetToCron(preset, weekday);
  if (!cron) throw invalid("The requested schedule could not be resolved.");
  return cron;
}

/**
 * Validates a sub-agent creation payload. Throws a 400 AgentError on any
 * problem; returns the exact column values to persist. permissionLevel and
 * status are NOT read from the payload — creation always pins READ_ONLY /
 * ACTIVE (requests trying to set them are rejected, fail closed).
 */
export function validateAgentCreatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("A JSON object body is required.");
  }
  if ("permissionLevel" in payload) {
    throw invalid("permissionLevel cannot be set via the API; agents are created READ_ONLY.");
  }
  const agentType = payload.agentType;
  if (!CREATABLE_AGENT_TYPES.includes(agentType)) {
    throw invalid(`agentType must be one of: ${CREATABLE_AGENT_TYPES.join(", ")}.`);
  }
  return {
    agentType,
    name: readTrimmedString(payload.name, "name", { maxLength: NAME_MAX_LENGTH, required: true }),
    instructions: readTrimmedString(payload.instructions, "instructions", {
      maxLength: INSTRUCTIONS_MAX_LENGTH,
    }),
    definitionOfDone: readTrimmedString(payload.definitionOfDone, "definitionOfDone", {
      maxLength: DEFINITION_OF_DONE_MAX_LENGTH,
      required: true,
    }),
    schedule: readSchedule(payload),
    toolAccess: sanitizeToolAccess(payload.toolAccess),
  };
}

/**
 * Validates a sub-agent update payload and returns only the columns that were
 * provided. permissionLevel and agentType are immutable via the API in v1
 * (trust staging is UI-only for now) — attempts are rejected, fail closed.
 */
export function validateAgentUpdatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("A JSON object body is required.");
  }
  if ("permissionLevel" in payload) {
    throw invalid("permissionLevel cannot be changed via the API in this phase.");
  }
  if ("agentType" in payload) {
    throw invalid("agentType cannot be changed after creation.");
  }

  const data = {};
  if ("name" in payload) {
    data.name = readTrimmedString(payload.name, "name", {
      maxLength: NAME_MAX_LENGTH,
      required: true,
    });
  }
  if ("instructions" in payload) {
    data.instructions = readTrimmedString(payload.instructions, "instructions", {
      maxLength: INSTRUCTIONS_MAX_LENGTH,
    });
  }
  if ("definitionOfDone" in payload) {
    data.definitionOfDone = readTrimmedString(payload.definitionOfDone, "definitionOfDone", {
      maxLength: DEFINITION_OF_DONE_MAX_LENGTH,
    });
  }
  if ("status" in payload) {
    if (!["ACTIVE", "PAUSED"].includes(payload.status)) {
      throw invalid('status must be "ACTIVE" or "PAUSED".');
    }
    data.status = payload.status;
  }
  if ("toolAccess" in payload) {
    data.toolAccess = sanitizeToolAccess(payload.toolAccess);
  }
  if ("schedulePreset" in payload || "scheduleWeekday" in payload) {
    data.schedule = readSchedule(payload);
  }

  if (!Object.keys(data).length) {
    throw invalid("No updatable fields were provided.");
  }
  return data;
}

/**
 * Creates a sub-agent inside the caller's user-context transaction, linked to
 * the user's CeoAgentConfig (auto-created if missing). `validated` must come
 * from validateAgentCreatePayload — this is the single creation path shared
 * by POST /api/agents and the CEO-chat creation flow, so the READ_ONLY /
 * ACTIVE pin can never be bypassed.
 */
export async function createAgentConfig(tx, userId, validated) {
  const ceoConfig = await ensureCeoAgentConfig(tx, userId);
  return tx.agentConfig.create({
    data: {
      userId,
      ceoAgentConfigId: ceoConfig.id,
      agentType: validated.agentType,
      name: validated.name,
      instructions: validated.instructions,
      definitionOfDone: validated.definitionOfDone,
      schedule: validated.schedule,
      toolAccess: validated.toolAccess,
      permissionLevel: "READ_ONLY",
      status: "ACTIVE",
    },
  });
}

/**
 * Uniform error responder for agent API handlers: AuthError and AgentError
 * carry their own status; other 4xx/503-tagged errors surface as-is; anything
 * else becomes a redacted 500 via respondInternalError.
 */
export function respondAgentApiError(response, context, error, fallbackMessage) {
  if (error instanceof AuthError) {
    return response.status(error.status).json({ error: true, message: error.message });
  }
  if (isAgentError(error)) {
    return response
      .status(error.status || 400)
      .json({ error: true, code: error.code, message: error.message });
  }
  const status = Number(error?.status);
  if ([400, 403, 404, 409, 503].includes(status)) {
    return response.status(status).json({ error: true, message: error.message });
  }
  return respondInternalError(response, context, error, fallbackMessage);
}
