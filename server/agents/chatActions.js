import { withUserContext } from "../db/prisma.js";
import { encrypt } from "../security/envelope.js";
import {
  serializeAgentConfig,
  validateAgentUpdatePayload,
} from "./apiHelpers.js";
import { resolveConversationForWrite, touchConversation } from "./conversations.js";
import { applySnippetTitleIfNeeded } from "./conversationTitle.js";
import { deliverAgentRunReport } from "./emailDelivery.js";
import { AgentError } from "./errors.js";
import { runAgent } from "./runner.js";
import { WEEKDAY_NAMES, isValidSchedulePreset, isValidScheduleWeekday } from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task-scoped actions a sub-agent may take on ITSELF via chat.
//
// Safety contract:
//   • Actions only touch the agentConfigId of the chat being used — never
//     another agent, never CEO config, never money moves / third parties.
//   • Config mutations reuse validateAgentUpdatePayload (same allowlist as
//     PATCH /api/agents/:id).
//   • Email still goes only to the user's own verified account address.
// ─────────────────────────────────────────────────────────────────────────────

export const TASK_ACTION_TYPES = Object.freeze(["run_now", "update_config", "email_report"]);

/** JSON-schema fragment for the sub-agent chat structured reply. */
export const TASK_ACTION_JSON_SCHEMA = {
  anyOf: [
    {
      type: "null",
      description: "No task change requested — leave null for ordinary questions.",
    },
    {
      type: "object",
      description:
        "A change to THIS agent's own task settings, or a request to run / email its report. Never use for another agent or for financial actions.",
      properties: {
        type: {
          type: "string",
          enum: [...TASK_ACTION_TYPES],
          description:
            "run_now = trigger a manual run now; update_config = change this agent's own settings; email_report = email the latest (or related) report to the user.",
        },
        name: {
          type: "string",
          description: "New display name for this agent (update_config only).",
        },
        instructions: {
          type: "string",
          description: "New instructions / topic for this agent (update_config only).",
        },
        definitionOfDone: {
          type: "string",
          description: "New definition of done for this agent (update_config only).",
        },
        status: {
          type: "string",
          enum: ["ACTIVE", "PAUSED"],
          description: "Pause or resume this agent (update_config only).",
        },
        schedulePreset: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description: "New schedule cadence (update_config only).",
        },
        scheduleWeekday: {
          type: "string",
          enum: [...WEEKDAY_NAMES],
          description: "Weekday when schedulePreset is weekly (update_config only).",
        },
        clearSchedule: {
          type: "boolean",
          description: "Set true to make this agent on-demand only (update_config only).",
        },
        emailDelivery: {
          type: "boolean",
          description:
            "Enable/disable emailing this agent's reports to the user's verified account address after each run (update_config only).",
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
  ],
};

/**
 * Validates and normalizes a model-emitted taskAction. Returns null when the
 * model emitted nothing usable (ordinary Q&A). Throws AgentError on a
 * clearly malformed action object.
 */
export function sanitizeTaskAction(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentError("taskAction must be an object or null.", "INVALID_TASK_ACTION", 400);
  }
  const type = raw.type;
  if (!TASK_ACTION_TYPES.includes(type)) {
    throw new AgentError(
      `taskAction.type must be one of: ${TASK_ACTION_TYPES.join(", ")}.`,
      "INVALID_TASK_ACTION",
      400
    );
  }

  if (type === "run_now" || type === "email_report") {
    return { type };
  }

  // update_config — only allowlisted fields, via the same validator as PATCH.
  const payload = {};
  if (typeof raw.name === "string") payload.name = raw.name;
  if (typeof raw.instructions === "string") payload.instructions = raw.instructions;
  if (typeof raw.definitionOfDone === "string") payload.definitionOfDone = raw.definitionOfDone;
  if (raw.status === "ACTIVE" || raw.status === "PAUSED") payload.status = raw.status;
  if (raw.clearSchedule === true) {
    payload.schedulePreset = null;
  } else if (typeof raw.schedulePreset === "string") {
    if (!isValidSchedulePreset(raw.schedulePreset)) {
      throw new AgentError(
        'schedulePreset must be "daily", "weekly", or "monthly".',
        "INVALID_TASK_ACTION",
        400
      );
    }
    payload.schedulePreset = raw.schedulePreset;
    if (typeof raw.scheduleWeekday === "string") {
      const weekday = raw.scheduleWeekday.toLowerCase();
      if (!isValidScheduleWeekday(weekday)) {
        throw new AgentError(
          "scheduleWeekday must be a lowercase weekday name.",
          "INVALID_TASK_ACTION",
          400
        );
      }
      payload.scheduleWeekday = weekday;
    }
  }
  if (typeof raw.emailDelivery === "boolean") {
    payload.toolAccess = raw.emailDelivery ? { email: true } : null;
  }

  if (!Object.keys(payload).length) {
    throw new AgentError(
      "update_config taskAction included no updatable fields.",
      "INVALID_TASK_ACTION",
      400
    );
  }

  const data = validateAgentUpdatePayload(payload);
  return { type: "update_config", data, payload };
}

/**
 * Conservative phrasing detector for common self-management asks that should
 * not depend on the LLM (and must not bounce the user to the CEO Agent).
 * Returns a sanitized taskAction or null.
 */
export function matchDeterministicTaskIntent(message) {
  const text = String(message || "").toLowerCase().trim();
  if (!text) return null;

  // Auto-email toggle (settings) — distinct from "email me the report".
  if (
    /\b(enable|turn on)\b.{0,40}\be-?mail/.test(text) ||
    /\be-?mail\b.{0,30}\b(after each run|automatically|auto)\b/.test(text)
  ) {
    return sanitizeTaskAction({ type: "update_config", emailDelivery: true });
  }
  if (/\b(disable|turn off|stop)\b.{0,40}\be-?mail/.test(text)) {
    return sanitizeTaskAction({ type: "update_config", emailDelivery: false });
  }

  // One-off "email me the report" stays on the emailDelivery short-circuit.
  if (/\be-?mail/.test(text)) return null;

  if (
    !/\bunpause|resume\b/.test(text) &&
    (/\bpause\s+(yourself|this agent|the agent)\b/.test(text) ||
      /^(please\s+)?pause\b/.test(text) ||
      /\b(can you|could you|please)\s+pause\b/.test(text))
  ) {
    return sanitizeTaskAction({ type: "update_config", status: "PAUSED" });
  }

  if (
    /\b(resume|unpause)\s+(yourself|this agent|the agent)\b/.test(text) ||
    /^(please\s+)?(resume|unpause)\b/.test(text) ||
    /\b(can you|could you|please)\s+(resume|unpause)\b/.test(text)
  ) {
    return sanitizeTaskAction({ type: "update_config", status: "ACTIVE" });
  }

  if (
    /\b(run|trigger|execute)\b/.test(text) &&
    /\b(now|yourself|a run|another run|again|manually)\b/.test(text)
  ) {
    return sanitizeTaskAction({ type: "run_now" });
  }

  // "make it weekly on thursday", "change schedule to daily", "every week on monday"
  const weeklyMatch = text.match(
    /\b(?:schedule|run|set|make|change|switch|update).{0,40}\bweekly\b(?:\s+on\s+(\w+))?/
  );
  const everyWeekMatch = text.match(/\bevery\s+week(?:\s+on\s+(\w+))?/);
  if (weeklyMatch || everyWeekMatch) {
    const weekdayRaw = weeklyMatch?.[1] || everyWeekMatch?.[1] || null;
    const weekday = weekdayRaw && WEEKDAY_NAMES.includes(weekdayRaw) ? weekdayRaw : undefined;
    return sanitizeTaskAction({
      type: "update_config",
      schedulePreset: "weekly",
      ...(weekday ? { scheduleWeekday: weekday } : {}),
    });
  }
  if (
    /\b(?:schedule|run|set|make|change|switch|update).{0,40}\bdaily\b/.test(text) ||
    /\bevery\s+day\b/.test(text)
  ) {
    return sanitizeTaskAction({ type: "update_config", schedulePreset: "daily" });
  }
  if (
    /\b(?:schedule|run|set|make|change|switch|update).{0,40}\bmonthly\b/.test(text) ||
    /\bevery\s+month\b/.test(text)
  ) {
    return sanitizeTaskAction({ type: "update_config", schedulePreset: "monthly" });
  }
  if (/\b(on[- ]?demand|no schedule|clear schedule|remove schedule|stop scheduling)\b/.test(text)) {
    return sanitizeTaskAction({ type: "update_config", clearSchedule: true });
  }

  return null;
}

function describeConfigUpdate(payload, updated) {
  const parts = [];
  if (payload.name != null) parts.push(`renamed to "${updated.name}"`);
  if (payload.instructions != null) parts.push("updated my instructions");
  if (payload.definitionOfDone != null) parts.push("updated my definition of done");
  if (payload.status === "PAUSED") parts.push("paused myself");
  if (payload.status === "ACTIVE") parts.push("resumed myself");
  if ("schedulePreset" in payload) {
    if (payload.schedulePreset == null) {
      parts.push("cleared my schedule (on-demand only)");
    } else if (payload.schedulePreset === "weekly") {
      const day = payload.scheduleWeekday || updated.schedule?.weekday || "monday";
      parts.push(`set my schedule to weekly (${day})`);
    } else {
      parts.push(`set my schedule to ${payload.schedulePreset}`);
    }
  }
  if ("toolAccess" in payload) {
    parts.push(
      payload.toolAccess?.email
        ? "enabled emailing my reports to your verified account address after each run"
        : "disabled automatic report emails"
    );
  }
  if (!parts.length) return "Updated my settings.";
  return `Done — I've ${parts.join(" and ")}.`;
}

async function persistChatExchange({
  userId,
  agentConfigId,
  conversationId,
  message,
  reply,
  relatedRunId = null,
}) {
  return withUserContext(userId, async (tx) => {
    const agentConfig = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
    });
    if (!agentConfig) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }

    const conversation = await resolveConversationForWrite(tx, {
      userId,
      agentConfigId: agentConfig.id,
      conversationId,
      allowSystem: false,
    });

    await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: conversation.id,
        agentConfigId: agentConfig.id,
        role: "USER",
        contentCiphertext: encrypt(String(message)),
        relatedRunId: relatedRunId || null,
      },
    });
    await touchConversation(tx, conversation.id);
    const conversationTitle = await applySnippetTitleIfNeeded(tx, {
      conversationId: conversation.id,
      messageText: String(message),
    });

    const replyMessage = await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: conversation.id,
        agentConfigId: agentConfig.id,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId: relatedRunId || null,
      },
    });
    await touchConversation(tx, conversation.id);

    return {
      reply,
      messageId: replyMessage.id,
      conversationId: conversation.id,
      conversationTitle,
      agent: serializeAgentConfig(agentConfig),
    };
  });
}

async function applyUpdateConfigAction({ userId, agentConfigId, action }) {
  const updated = await withUserContext(userId, async (tx) => {
    const agent = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
    });
    if (!agent) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }
    return tx.agentConfig.update({
      where: { id: agent.id },
      data: action.data,
    });
  });
  return {
    reply: describeConfigUpdate(action.payload, serializeAgentConfig(updated)),
    agent: serializeAgentConfig(updated),
  };
}

async function applyRunNowAction({ userId, agentConfigId }) {
  const run = await runAgent({ userId, agentConfigId, trigger: "manual" });
  if (run.status === "SKIPPED") {
    return {
      reply: `I couldn't run just now: ${run.error || "the run was skipped"}.`,
      run,
    };
  }
  if (run.status === "FAILED") {
    return {
      reply: `I ran, but the run failed: ${run.error || "unknown error"}.`,
      run,
    };
  }
  const summaryBit = run.summary ? ` Summary: ${run.summary}` : "";
  return {
    reply: `Done — I just ran.${summaryBit}`,
    run,
  };
}

/**
 * Applies a sanitized taskAction for a sub-agent chat. For deterministic
 * intents (API short-circuit), also persists the user/agent chat rows.
 * For the LLM path, pass { persist: false } — respondToChat already wrote
 * the user message and will write the agent reply.
 */
export async function applySubAgentTaskAction({
  userId,
  agentConfigId,
  conversationId = null,
  message,
  action,
  relatedRunId = null,
  persist = true,
}) {
  if (!action) {
    throw new AgentError("A taskAction is required.", "INVALID_TASK_ACTION", 400);
  }

  let outcome;
  if (action.type === "email_report") {
    outcome = await deliverAgentRunReport({ userId, agentConfigId, relatedRunId });
  } else if (action.type === "update_config") {
    outcome = await applyUpdateConfigAction({ userId, agentConfigId, action });
  } else if (action.type === "run_now") {
    outcome = await applyRunNowAction({ userId, agentConfigId });
  } else {
    throw new AgentError("Unsupported taskAction type.", "INVALID_TASK_ACTION", 400);
  }

  if (!persist) {
    return outcome;
  }

  const persisted = await persistChatExchange({
    userId,
    agentConfigId,
    conversationId,
    message,
    reply: outcome.reply,
    relatedRunId: outcome.run?.id || relatedRunId,
  });
  return { ...persisted, agent: outcome.agent ?? persisted.agent, run: outcome.run };
}
