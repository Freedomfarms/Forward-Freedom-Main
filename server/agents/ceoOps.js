import { withUserContext } from "../db/prisma.js";
import {
  createAgentConfig,
  serializeAgentConfig,
  serializeAgentRun,
  validateAgentCreatePayload,
  validateAgentUpdatePayload,
} from "./apiHelpers.js";
import { AgentError } from "./errors.js";
import { runAgent } from "./runner.js";
import { notifyCeoDelegatedRunComplete } from "./runCompletion.js";
import {
  WEEKDAY_NAMES,
  isValidScheduleHourUtc,
  isValidSchedulePreset,
  isValidScheduleWeekday,
  normalizeScheduleWeekdays,
} from "./schedule.js";
import { announceAgentCreatedToCeoChat } from "./teamContext.js";
import {
  formatHourLocalLabel,
  isValidIanaTimeZone,
  localScheduleToUtcCron,
  normalizeIanaTimeZone,
} from "./timezone.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO operational actions — the chat interface into the same server functions
// used by REST/UI. No separate business logic.
// ─────────────────────────────────────────────────────────────────────────────

export const CEO_ACTION_TYPES = Object.freeze([
  "create_agent",
  "update_agent",
  "run_agent",
  "delete_agent",
  "set_timezone",
]);

export const CEO_DESTRUCTIVE_ACTION_TYPES = Object.freeze([
  "delete_agent",
  // Future: delete_document, delete_conversation, remove_profile_entry
]);

/** Platform sync budget before a delegated run flips to async (ms). */
export const CEO_RUN_SYNC_BUDGET_MS = Number(process.env.CEO_RUN_SYNC_BUDGET_MS) || 45_000;

export const CEO_ACTIONS_JSON_SCHEMA = {
  anyOf: [
    {
      type: "null",
      description: "No operational change — leave null for ordinary questions.",
    },
    {
      type: "array",
      description:
        "Ordered platform operations to execute this turn. Use the same underlying capabilities as the UI. Prefer one-shot create when the user gave enough detail. For delete_agent, set confirmed=true only after the user explicitly confirms.",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [...CEO_ACTION_TYPES],
          },
          // create_agent / update_agent shared fields
          agentId: {
            type: "string",
            description:
              "Target sub-agent id for update/run/delete. For run_agent after create_agent in the same turn, omit or use \"__last_created__\".",
          },
          agentType: {
            type: "string",
            enum: ["finance", "research", "reminders"],
          },
          name: { type: "string" },
          instructions: { type: "string" },
          definitionOfDone: { type: "string" },
          status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
          schedulePreset: {
            type: "string",
            enum: ["daily", "weekly", "monthly"],
          },
          scheduleWeekday: { type: "string", enum: [...WEEKDAY_NAMES] },
          scheduleWeekdays: {
            type: "array",
            items: { type: "string", enum: [...WEEKDAY_NAMES] },
          },
          scheduleHourLocal: {
            type: "integer",
            minimum: 0,
            maximum: 23,
            description: "Hour in the user's local timezone (0–23). Prefer this over UTC.",
          },
          clearSchedule: { type: "boolean" },
          emailDelivery: { type: "boolean" },
          model: { type: "string" },
          confirmed: {
            type: "boolean",
            description: "Required true for delete_agent after explicit user confirmation.",
          },
          timezone: {
            type: "string",
            description: "IANA timezone for set_timezone (e.g. America/Chicago).",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  ],
};

function invalidAction(message) {
  throw new AgentError(message, "INVALID_CEO_ACTION", 400);
}

export function sanitizeCeoActions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) invalidAction("ceoActions must be an array or null.");
  return raw.map((item, index) => sanitizeCeoAction(item, index));
}

function sanitizeCeoAction(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalidAction(`ceoActions[${index}] must be an object.`);
  }
  const type = raw.type;
  if (!CEO_ACTION_TYPES.includes(type)) {
    invalidAction(`ceoActions[${index}].type must be one of: ${CEO_ACTION_TYPES.join(", ")}.`);
  }

  if (type === "set_timezone") {
    return { type, timezone: normalizeIanaTimeZone(raw.timezone) };
  }

  if (type === "run_agent") {
    return {
      type,
      agentId: typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : "__last_created__",
    };
  }

  if (type === "delete_agent") {
    if (typeof raw.agentId !== "string" || !raw.agentId.trim()) {
      invalidAction("delete_agent requires agentId.");
    }
    return {
      type,
      agentId: raw.agentId.trim(),
      confirmed: raw.confirmed === true,
    };
  }

  if (type === "create_agent") {
    return {
      type,
      agentType: raw.agentType,
      name: raw.name,
      instructions: raw.instructions,
      definitionOfDone: raw.definitionOfDone,
      schedulePreset: raw.schedulePreset,
      scheduleWeekday: raw.scheduleWeekday,
      scheduleWeekdays: raw.scheduleWeekdays,
      scheduleHourLocal: raw.scheduleHourLocal,
      clearSchedule: raw.clearSchedule === true,
      emailDelivery: raw.emailDelivery,
      model: raw.model,
    };
  }

  // update_agent
  if (typeof raw.agentId !== "string" || !raw.agentId.trim()) {
    invalidAction("update_agent requires agentId.");
  }
  return {
    type,
    agentId: raw.agentId.trim(),
    name: raw.name,
    instructions: raw.instructions,
    definitionOfDone: raw.definitionOfDone,
    status: raw.status,
    schedulePreset: raw.schedulePreset,
    scheduleWeekday: raw.scheduleWeekday,
    scheduleWeekdays: raw.scheduleWeekdays,
    scheduleHourLocal: raw.scheduleHourLocal,
    clearSchedule: raw.clearSchedule === true,
    emailDelivery: raw.emailDelivery,
    model: raw.model,
  };
}

async function loadUserTimezone(userId) {
  const user = await withUserContext(userId, (tx) =>
    tx.user.findUnique({ where: { id: userId }, select: { timezone: true } })
  );
  return user?.timezone && isValidIanaTimeZone(user.timezone) ? user.timezone : null;
}

function buildScheduleFields(action, timeZone) {
  if (action.clearSchedule === true) {
    return { schedulePreset: null };
  }
  if (action.schedulePreset == null && action.scheduleHourLocal == null) {
    return {};
  }
  if (action.schedulePreset != null && !isValidSchedulePreset(action.schedulePreset)) {
    invalidAction('schedulePreset must be "daily", "weekly", or "monthly".');
  }

  const payload = {};
  if (action.schedulePreset != null) payload.schedulePreset = action.schedulePreset;

  if (typeof action.scheduleWeekday === "string") {
    const weekday = action.scheduleWeekday.toLowerCase();
    if (!isValidScheduleWeekday(weekday)) invalidAction("Invalid scheduleWeekday.");
    payload.scheduleWeekday = weekday;
  }
  if (Array.isArray(action.scheduleWeekdays)) {
    const weekdays = normalizeScheduleWeekdays(null, action.scheduleWeekdays);
    if (!weekdays) invalidAction("Invalid scheduleWeekdays.");
    payload.scheduleWeekdays = weekdays;
  }

  if (action.scheduleHourLocal != null) {
    if (!timeZone) {
      throw new AgentError(
        "I need your timezone before I can schedule a local time. Set it in Settings or tell me your IANA timezone (e.g. America/New_York).",
        "TIMEZONE_REQUIRED",
        400
      );
    }
    const hourLocal = Number(action.scheduleHourLocal);
    const resolved = localScheduleToUtcCron({
      preset: payload.schedulePreset || "weekly",
      weekday: payload.scheduleWeekday,
      weekdays: payload.scheduleWeekdays,
      hourLocal,
      timeZone,
    });
    payload.scheduleHourUtc = resolved.hourUtc;
    if (payload.schedulePreset === "weekly" && resolved.weekdaysUtc?.length) {
      payload.scheduleWeekdays = resolved.weekdaysUtc;
    }
    payload._localLabel = formatHourLocalLabel(hourLocal, timeZone);
  }

  return payload;
}

async function applyCreateAgent(userId, ceoAgentConfigId, action, timeZone) {
  const scheduleFields = buildScheduleFields(action, timeZone);
  const localLabel = scheduleFields._localLabel;
  delete scheduleFields._localLabel;

  const toolAccess =
    action.emailDelivery === true ? { email: true } : action.emailDelivery === false ? null : undefined;

  const validated = validateAgentCreatePayload({
    agentType: action.agentType,
    name: action.name,
    instructions: action.instructions ?? "",
    definitionOfDone:
      action.definitionOfDone ||
      action.instructions ||
      `Complete the ${action.agentType || "research"} task and summarize findings.`,
    schedulePreset: scheduleFields.schedulePreset,
    scheduleWeekday: scheduleFields.scheduleWeekday,
    scheduleWeekdays: scheduleFields.scheduleWeekdays,
    scheduleHourUtc: scheduleFields.scheduleHourUtc,
    ...(toolAccess !== undefined ? { toolAccess } : {}),
    ...(typeof action.model === "string" ? { model: action.model } : {}),
  });

  const agent = await withUserContext(userId, async (tx) => {
    const created = await createAgentConfig(tx, userId, validated);
    await announceAgentCreatedToCeoChat(tx, {
      userId,
      ceoAgentConfigId,
      agent: created,
    });
    return created;
  });

  const scheduleNote = localLabel
    ? ` Scheduled for ${localLabel}.`
    : scheduleFields.schedulePreset
      ? " Schedule configured."
      : "";
  const emailNote =
    action.emailDelivery === true
      ? " Email delivery enabled."
      : "";

  return {
    reply: `Created "${agent.name}" (${agent.agentType}).${scheduleNote}${emailNote}`,
    agent: serializeAgentConfig(agent),
  };
}

async function applyUpdateAgent(userId, action, timeZone) {
  const scheduleFields = buildScheduleFields(action, timeZone);
  const localLabel = scheduleFields._localLabel;
  delete scheduleFields._localLabel;

  const payload = {};
  if (typeof action.name === "string") payload.name = action.name;
  if (typeof action.instructions === "string") payload.instructions = action.instructions;
  if (typeof action.definitionOfDone === "string") {
    payload.definitionOfDone = action.definitionOfDone;
  }
  if (action.status === "ACTIVE" || action.status === "PAUSED") payload.status = action.status;
  if (typeof action.model === "string") payload.model = action.model;
  if (action.emailDelivery === true) payload.toolAccess = { email: true };
  if (action.emailDelivery === false) payload.toolAccess = null;
  Object.assign(payload, scheduleFields);

  if (!Object.keys(payload).length) invalidAction("update_agent included no updatable fields.");

  const data = validateAgentUpdatePayload(payload);
  const updated = await withUserContext(userId, async (tx) => {
    const existing = await tx.agentConfig.findFirst({
      where: { id: action.agentId, userId },
    });
    if (!existing) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }
    return tx.agentConfig.update({ where: { id: existing.id }, data });
  });

  let reply = `Updated "${updated.name}".`;
  if (payload.status === "PAUSED") reply = `Paused "${updated.name}".`;
  if (payload.status === "ACTIVE") reply = `Resumed "${updated.name}".`;
  if (localLabel) reply += ` Schedule set for ${localLabel}.`;
  if (action.emailDelivery === true) reply += " Email delivery enabled.";
  if (action.emailDelivery === false) reply += " Email delivery disabled.";

  return { reply, agent: serializeAgentConfig(updated) };
}

async function applyDeleteAgent(userId, action) {
  if (!action.confirmed) {
    const agent = await withUserContext(userId, (tx) =>
      tx.agentConfig.findFirst({
        where: { id: action.agentId, userId },
        select: { id: true, name: true },
      })
    );
    if (!agent) throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    return {
      reply: `Confirm you want to permanently delete "${agent.name}"? Say yes and I'll remove it.`,
      needsConfirmation: true,
      agent: { id: agent.id, name: agent.name },
    };
  }

  const deleted = await withUserContext(userId, async (tx) => {
    const agent = await tx.agentConfig.findFirst({
      where: { id: action.agentId, userId },
      select: { id: true, name: true },
    });
    if (!agent) throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    await tx.agentConfig.delete({ where: { id: agent.id } });
    return agent;
  });

  return { reply: `Deleted "${deleted.name}".`, deleted: true };
}

async function applySetTimezone(userId, action) {
  if (!action.timezone) invalidAction("set_timezone requires a valid IANA timezone.");
  await withUserContext(userId, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: { timezone: action.timezone },
    })
  );
  return { reply: `Timezone set to ${action.timezone}.`, timezone: action.timezone };
}

/**
 * Runs a sub-agent on behalf of the CEO conversation with lineage + hybrid
 * sync/async handoff.
 */
export async function runAgentForCeo({
  userId,
  agentConfigId,
  conversationId,
  ceoAgentConfigId,
  parentRunId = null,
  syncBudgetMs = CEO_RUN_SYNC_BUDGET_MS,
}) {
  const agent = await withUserContext(userId, (tx) =>
    tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
      select: { id: true, name: true, agentType: true, status: true },
    })
  );
  if (!agent) throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);

  let startedRunId = null;
  const runPromise = runAgent({
    userId,
    agentConfigId,
    trigger: "ceo_delegate",
    triggeredByConversationId: conversationId,
    parentRunId,
    onStarted: (run) => {
      startedRunId = run.id;
    },
  });

  const winner = await Promise.race([
    runPromise.then((run) => ({ mode: "sync", run })),
    new Promise((resolve) => {
      setTimeout(() => resolve({ mode: "async" }), Math.max(1_000, syncBudgetMs));
    }),
  ]);

  if (winner.mode === "sync") {
    const run = winner.run;
    const serialized = serializeAgentRun(run, { includeOutput: true });
    let reply;
    if (run.status === "SUCCEEDED") {
      reply = [
        `Working on it… done.`,
        `"${agent.name}" finished.`,
        run.summary || null,
        serialized.output ? String(serialized.output).slice(0, 1800) : null,
      ]
        .filter(Boolean)
        .join("\n\n");
    } else if (run.status === "SKIPPED") {
      reply = `"${agent.name}" did not run (${run.error || "skipped"}).`;
    } else {
      reply = `"${agent.name}" failed${run.error ? `: ${run.error}` : "."}`;
    }
    return { reply, run: serialized, mode: "sync", agent };
  }

  // Async path: keep the work going; notify when complete.
  void runPromise
    .then(async (run) => {
      await notifyCeoDelegatedRunComplete({
        userId,
        ceoAgentConfigId,
        conversationId,
        agentName: agent.name,
        run,
      });
    })
    .catch(async (error) => {
      console.warn("[ceoOps] async delegated run failed:", error?.message || error);
      if (startedRunId) {
        const run = await withUserContext(userId, (tx) =>
          tx.agentRun.findFirst({ where: { id: startedRunId, userId } })
        );
        if (run) {
          await notifyCeoDelegatedRunComplete({
            userId,
            ceoAgentConfigId,
            conversationId,
            agentName: agent.name,
            run,
          });
        }
      }
    });

  return {
    reply: `I've started "${agent.name}". I'll notify you here when it's complete.`,
    run: startedRunId ? { id: startedRunId, status: "RUNNING", agentConfigId } : null,
    mode: "async",
    agent,
  };
}

/**
 * Applies sanitized CEO actions in order. Returns combined reply + artifacts.
 */
export async function applyCeoActions({
  userId,
  ceoAgentConfigId,
  conversationId,
  actions,
  syncBudgetMs = CEO_RUN_SYNC_BUDGET_MS,
}) {
  const list = sanitizeCeoActions(actions);
  if (!list.length) return null;

  let timeZone = await loadUserTimezone(userId);
  const replies = [];
  let lastCreatedId = null;
  let lastAgent = null;
  let lastRun = null;
  let mode = null;

  for (const action of list) {
    if (action.type === "set_timezone") {
      const result = await applySetTimezone(userId, action);
      timeZone = result.timezone;
      replies.push(result.reply);
      continue;
    }
    if (action.type === "create_agent") {
      const result = await applyCreateAgent(userId, ceoAgentConfigId, action, timeZone);
      lastCreatedId = result.agent.id;
      lastAgent = result.agent;
      replies.push(result.reply);
      continue;
    }
    if (action.type === "update_agent") {
      const result = await applyUpdateAgent(userId, action, timeZone);
      lastAgent = result.agent;
      replies.push(result.reply);
      continue;
    }
    if (action.type === "delete_agent") {
      const result = await applyDeleteAgent(userId, action);
      replies.push(result.reply);
      continue;
    }
    if (action.type === "run_agent") {
      const agentId =
        !action.agentId || action.agentId === "__last_created__"
          ? lastCreatedId
          : action.agentId;
      if (!agentId) {
        throw new AgentError(
          "run_agent needs an agentId (or a create_agent earlier in this turn).",
          "INVALID_CEO_ACTION",
          400
        );
      }
      const result = await runAgentForCeo({
        userId,
        agentConfigId: agentId,
        conversationId,
        ceoAgentConfigId,
        syncBudgetMs,
      });
      lastRun = result.run;
      if (result.agent?.id && !lastAgent) {
        lastAgent = await withUserContext(userId, async (tx) => {
          const row = await tx.agentConfig.findFirst({
            where: { id: result.agent.id, userId },
          });
          return row ? serializeAgentConfig(row) : null;
        });
      }
      mode = result.mode;
      replies.push(result.reply);
    }
  }

  return {
    reply: replies.join("\n\n"),
    agent: lastAgent,
    run: lastRun,
    mode,
  };
}

/** Exported for schedule unit tests / API helpers. */
export function resolveLocalScheduleForApi(payload, timeZone) {
  if (payload?.scheduleHourLocal == null) return payload;
  if (!isValidScheduleHourUtc(Number(payload.scheduleHourLocal)) &&
      !(Number.isInteger(payload.scheduleHourLocal) && payload.scheduleHourLocal >= 0 && payload.scheduleHourLocal <= 23)) {
    // hour local uses same 0-23 range
  }
  const hourLocal = Number(payload.scheduleHourLocal);
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) {
    throw new AgentError(
      "scheduleHourLocal must be an integer from 0 to 23.",
      "INVALID_SCHEDULE_HOUR",
      400
    );
  }
  const resolved = localScheduleToUtcCron({
    preset: payload.schedulePreset || "daily",
    weekday: payload.scheduleWeekday,
    weekdays: payload.scheduleWeekdays,
    hourLocal,
    timeZone,
  });
  return {
    ...payload,
    scheduleHourUtc: resolved.hourUtc,
    ...(payload.schedulePreset === "weekly" && resolved.weekdaysUtc
      ? { scheduleWeekdays: resolved.weekdaysUtc }
      : {}),
  };
}
