import { jsonSchema, tool } from "ai";

import { applyCeoDigestAction, DIGEST_ACTION_TYPES, sanitizeDigestAction } from "../agents/digest.js";
import { applyCeoActions } from "../agents/ceoOps.js";
import { AgentError } from "../agents/errors.js";
import { getWebSearchTools } from "../agents/llm.js";
import { WEEKDAY_NAMES } from "../agents/schedule.js";
import { createPlan, getPlan, updatePlan } from "./plans.js";

// ─────────────────────────────────────────────────────────────────────────────
// Freedom Brain tool belt — Determine Required Tools / Execute / Reflect.
//
// Every platform operation the legacy chat parsed out of a JSON envelope
// (ceoActions, digestAction) becomes a real AI-SDK tool that EXECUTES during
// the turn. The model reads each tool's authoritative result before composing
// its reply — no more speculative action JSON applied after generation.
//
// All executes delegate to the same allowlisted server functions the REST API
// uses (server/agents/ceoOps.js, server/agents/digest.js). No new business
// logic lives here. Tool errors are returned as { ok: false, error } results
// so the model can report the failure honestly instead of the whole turn
// failing.
// ─────────────────────────────────────────────────────────────────────────────

/** Max read-only web searches per Brain turn (matches legacy CEO chat). */
export const BRAIN_WEB_SEARCH_MAX_USES = 5;

const SCHEDULE_FIELDS = {
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
};

function toolResultFromError(error) {
  if (error instanceof AgentError) {
    return { ok: false, error: error.message, code: error.code };
  }
  return { ok: false, error: "The operation failed unexpectedly. Try again." };
}

/**
 * Builds the Brain's per-turn tool set. `turnState` accumulates side-effect
 * artifacts (created/updated agent, delegated run, refreshed digest) across
 * tool calls within ONE turn so brainTurn can surface them in the API
 * response, and tracks the last created agent id so run_agent can chain onto
 * a create_agent from the same turn.
 */
export function buildBrainToolBelt({ userId, ceoAgentConfigId, conversationId, turnState }) {
  async function applySingleCeoAction(action) {
    const result = await applyCeoActions({
      userId,
      ceoAgentConfigId,
      conversationId,
      actions: [action],
    });
    if (result?.agent) turnState.agent = result.agent;
    if (result?.run) turnState.run = result.run;
    if (result?.mode) turnState.runMode = result.mode;
    // Authoritative server confirmations: brainTurn uses these as the guard
    // against retrying a turn whose side effects already happened, and as a
    // reply fallback if the model returns empty text after acting.
    if (result?.reply) turnState.confirmations.push(result.reply);
    return result;
  }

  const createAgent = tool({
    description:
      "Create a new specialist agent for the user when required PLATFORM CAPABILITIES are available. If capabilities are unavailable, returns a planned agent definition without registering a live agent. Prefer one-shot creation when the user gave enough detail. Schedules use the user's local timezone via scheduleHourLocal.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        agentType: { type: "string", enum: ["finance", "research", "reminders"] },
        name: { type: "string" },
        instructions: { type: "string" },
        definitionOfDone: { type: "string" },
        emailDelivery: {
          type: "boolean",
          description: "Email the user each report after a run.",
        },
        model: { type: "string" },
        ...SCHEDULE_FIELDS,
      },
      required: ["agentType", "name"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await applySingleCeoAction({ type: "create_agent", ...input });
        turnState.lastCreatedAgentId = result?.agent?.id ?? turnState.lastCreatedAgentId;
        if (result?.plannedAgent) turnState.plannedAgent = result.plannedAgent;
        if (result?.agentDefinition) turnState.agentDefinition = result.agentDefinition;
        if (result?.capabilityAssessment) {
          turnState.capabilityAssessment = result.capabilityAssessment;
        }
        const created = Boolean(result?.agent?.id);
        return {
          ok: true,
          created,
          result: result?.reply,
          agent: result?.agent ?? null,
          agentDefinition: result?.agentDefinition ?? result?.plannedAgent ?? null,
          capabilityAssessment: result?.capabilityAssessment ?? null,
          blockers: result?.capabilityAssessment?.blockers ?? [],
        };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const updateAgent = tool({
    description:
      "Update one of the user's specialist agents: rename, pause/resume (status), change schedule, instructions, definition of done, email delivery, or model.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        agentId: { type: "string" },
        name: { type: "string" },
        instructions: { type: "string" },
        definitionOfDone: { type: "string" },
        status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
        emailDelivery: { type: "boolean" },
        model: { type: "string" },
        ...SCHEDULE_FIELDS,
      },
      required: ["agentId"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await applySingleCeoAction({ type: "update_agent", ...input });
        return { ok: true, result: result?.reply, agent: result?.agent ?? null };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const runAgentTool = tool({
    description:
      "Delegate work to a specialist agent now. Short jobs return their result here; longer jobs continue in the background and post back to this conversation. Omit agentId to run the agent created earlier in this turn.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Target agent id. Omit to run the agent created this turn.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const agentId =
          typeof input?.agentId === "string" && input.agentId.trim()
            ? input.agentId.trim()
            : turnState.lastCreatedAgentId;
        if (!agentId) {
          return {
            ok: false,
            error: "run_agent needs an agentId (or a create_agent earlier in this turn).",
          };
        }
        const result = await applySingleCeoAction({ type: "run_agent", agentId });
        return {
          ok: true,
          result: result?.reply,
          mode: result?.mode ?? null,
          run: result?.run
            ? { id: result.run.id, status: result.run.status ?? null }
            : null,
        };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const deleteAgent = tool({
    description:
      "Permanently delete one of the user's specialist agents. DESTRUCTIVE: pass confirmed=true ONLY after the user explicitly confirmed in this conversation; without it the tool returns a confirmation prompt to relay.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        agentId: { type: "string" },
        confirmed: {
          type: "boolean",
          description: "True only after explicit user confirmation this conversation.",
        },
      },
      required: ["agentId"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await applySingleCeoAction({
          type: "delete_agent",
          agentId: input.agentId,
          confirmed: input.confirmed === true,
        });
        return { ok: true, result: result?.reply };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const setTimezone = tool({
    description:
      "Save the user's IANA timezone (e.g. America/Chicago) so local-time schedules work.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone identifier." },
      },
      required: ["timezone"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await applySingleCeoAction({
          type: "set_timezone",
          timezone: input.timezone,
        });
        return { ok: true, result: result?.reply };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const updateDigest = tool({
    description:
      'Change the Daily Digest shown on the Freedom OS home. type "set_content" writes the provided body; type "regenerate" rebuilds the default briefing from recent agent activity.',
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        type: { type: "string", enum: [...DIGEST_ACTION_TYPES] },
        content: {
          type: "string",
          description:
            "Full digest body when type is set_content (plain text or light markdown; no heading).",
        },
      },
      required: ["type"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const action = sanitizeDigestAction(input);
        const result = await applyCeoDigestAction(userId, action);
        turnState.digest = {
          digest: result.digest,
          generatedAt: result.generatedAt,
          refreshed: true,
        };
        if (result.reply) turnState.confirmations.push(result.reply);
        return { ok: true, result: result.reply };
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const createPlanTool = tool({
    description:
      "Create a durable CEO Plan (executive memory) when the user expresses lasting intent. Plans store objective/situation/decisions/open items/planned actions only — never workflow scripts, tool permissions, or execution proof. Do not create Plans for ordinary one-off questions. Server dedupes similar ACTIVE Plans in the same mission scope.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "What the user is trying to accomplish (durable intent).",
        },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        missionScope: {
          type: "string",
          description:
            "Scope key for independent concurrent plans. Omit for the primary/default mission.",
        },
        independent: {
          type: "boolean",
          description:
            "True only when this objective is clearly independent of an existing ACTIVE Plan.",
        },
        horizon: { type: "string", enum: ["weeks", "months", "quarters"] },
        reason: {
          type: "string",
          description: "Why this Plan is being created (durable intent signal).",
        },
      },
      required: ["objective"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await createPlan({
          userId,
          objective: input.objective,
          confidence: input.confidence,
          title: input.title,
          missionScope: input.missionScope,
          independent: input.independent === true,
          horizon: input.horizon,
          sourceConversationId: conversationId,
          reason: input.reason || "durable_intent",
        });
        if (result?.plan) turnState.plan = result.plan;
        return result;
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const updatePlanTool = tool({
    description:
      "Apply structured ops to the durable CEO Plan. Requires a reason. Allowed: objective, situation facts, decisions, open items, preferences, planned actions. Completing/failing an action REQUIRES execution evidence (tool_result | execution_record | system_state). Blocked: permissions, capabilities, workflow/next-question ops, claiming completion without evidence. Do not rewrite the whole Plan every turn — only meaningful changes.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        planId: {
          type: "string",
          description: "Plan id. Omit to update the primary ACTIVE Plan.",
        },
        reason: {
          type: "string",
          description: "Why this update is meaningful (required; anti-thrash).",
        },
        ops: {
          type: "array",
          description: "List of structured Plan ops.",
          items: {
            type: "object",
            properties: {
              op: { type: "string" },
              text: { type: "string" },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              status: {
                type: "string",
                enum: ["ACTIVE", "WAITING", "COMPLETED", "ABANDONED"],
              },
              horizon: { type: "string", enum: ["weeks", "months", "quarters"] },
              field: {
                type: "string",
                enum: ["known", "assumptions", "constraints", "relevantContext", "preferences"],
              },
              by: { type: "string", enum: ["user", "ceo"] },
              rationale: { type: "string" },
              kind: { type: "string", enum: ["question", "blocker", "dependency"] },
              id: { type: "string" },
              owner: { type: "string", enum: ["user", "ceo", "agent"] },
              summary: { type: "string" },
              reason: { type: "string" },
              evidence: {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: ["tool_result", "execution_record", "system_state"],
                  },
                  summary: { type: "string" },
                  ref: { type: "string" },
                },
                required: ["kind", "summary"],
                additionalProperties: false,
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      required: ["reason", "ops"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await updatePlan({
          userId,
          planId: input.planId,
          ops: input.ops,
          reason: input.reason,
        });
        if (result?.plan) turnState.plan = result.plan;
        return result;
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  const getPlanTool = tool({
    description:
      "Load the durable CEO Plan body (objective, situation, decisions, open items, actions, recent changeLog). Omit planId for the primary ACTIVE Plan. Plan is memory — not execution proof.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        planId: { type: "string" },
      },
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const result = await getPlan({ userId, planId: input?.planId || null });
        if (result?.plan) turnState.plan = result.plan;
        return result;
      } catch (error) {
        return toolResultFromError(error);
      }
    },
  });

  return {
    ...getWebSearchTools({ maxUses: BRAIN_WEB_SEARCH_MAX_USES }),
    create_agent: createAgent,
    update_agent: updateAgent,
    run_agent: runAgentTool,
    delete_agent: deleteAgent,
    set_timezone: setTimezone,
    update_digest: updateDigest,
    create_plan: createPlanTool,
    update_plan: updatePlanTool,
    get_plan: getPlanTool,
  };
}
