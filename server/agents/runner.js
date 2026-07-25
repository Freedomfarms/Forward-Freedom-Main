import { withUserContext } from "../db/prisma.js";
import { encrypt } from "../security/envelope.js";
import { AgentError, describeAgentError } from "./errors.js";
import { getRunnableAgentHandler } from "./registry.js";
import { addCosts, addUsage, estimateCost } from "./costs.js";
import {
  buildRunEmailContent,
  isEmailDeliveryEnabled,
  sendAgentReportEmail,
} from "./emailDelivery.js";
import { extractFromRun } from "./profile.js";

// Trust is staged (see prisma/schema.prisma): the runtime only honors these
// two levels in this phase. ACTION_REQUIRED_APPROVAL and AUTONOMOUS exist in
// the schema but are rejected here until later phases unlock them.
const ALLOWED_PERMISSION_LEVELS = Object.freeze(["READ_ONLY", "DRAFT_ONLY"]);

const SUMMARY_MAX_LENGTH = 600;

function clampSummary(summary) {
  const text = String(summary || "").trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : text;
}

// Every check that must pass before an agent is allowed to execute. Any error
// raised while checking (including registry lookups) blocks the run — the
// gate can only fail closed.
function evaluateRunGate(config) {
  try {
    if (config.status === "PAUSED") {
      return { allowed: false, reason: "AGENT_PAUSED: Agent is paused; the run was skipped." };
    }
    if (!ALLOWED_PERMISSION_LEVELS.includes(config.permissionLevel)) {
      return {
        allowed: false,
        reason: `PERMISSION_LEVEL_NOT_ALLOWED: Permission level "${config.permissionLevel}" is not enabled in this phase; only READ_ONLY and DRAFT_ONLY agents may run.`,
      };
    }
    return { allowed: true, handler: getRunnableAgentHandler(config.agentType) };
  } catch (error) {
    return { allowed: false, reason: describeAgentError(error) };
  }
}

/**
 * Executes one agent run end-to-end:
 *   load config → fail-closed gate → AgentRun(RUNNING) → registry handler →
 *   persist results (encrypted output, minimized summary, usage accounting) →
 *   best-effort living-profile extraction (never fails the run).
 *
 * Returns the final AgentRun row. Database access runs in several short
 * withUserContext transactions (RLS-scoped) rather than one long transaction,
 * so no transaction is held open across an LLM call.
 */
export async function runAgent({
  userId,
  agentConfigId,
  trigger = "manual",
  triggeredByConversationId = null,
  parentRunId = null,
  onStarted = null,
}) {
  if (!userId || !agentConfigId) {
    throw new AgentError("runAgent requires userId and agentConfigId.", "INVALID_ARGUMENT", 400);
  }

  const config = await withUserContext(userId, (tx) =>
    tx.agentConfig.findFirst({ where: { id: agentConfigId, userId } })
  );
  if (!config) {
    throw new AgentError("Agent configuration not found.", "AGENT_NOT_FOUND", 404);
  }

  const lineage = {
    trigger: typeof trigger === "string" && trigger.trim() ? trigger.trim() : "manual",
    triggeredByConversationId: triggeredByConversationId || null,
    parentRunId: parentRunId || null,
  };

  const gate = evaluateRunGate(config);
  if (!gate.allowed) {
    // Policy blocks are recorded as SKIPPED runs so the audit trail shows the
    // attempt and exactly why nothing happened.
    const skipped = await withUserContext(userId, (tx) =>
      tx.agentRun.create({
        data: {
          userId,
          agentConfigId: config.id,
          agentType: config.agentType,
          status: "SKIPPED",
          error: gate.reason,
          completedAt: new Date(),
          ...lineage,
        },
      })
    );
    if (typeof onStarted === "function") {
      try {
        onStarted(skipped);
      } catch {
        // Caller callback must never fail the run path.
      }
    }
    return skipped;
  }

  const run = await withUserContext(userId, (tx) =>
    tx.agentRun.create({
      data: {
        userId,
        agentConfigId: config.id,
        agentType: config.agentType,
        status: "RUNNING",
        ...lineage,
      },
    })
  );
  if (typeof onStarted === "function") {
    try {
      onStarted(run);
    } catch {
      // Caller callback must never fail the run path.
    }
  }

  try {
    const result = await gate.handler({ userId, config, trigger });

    // Opt-in email delivery of the run's report to the user's own VERIFIED
    // account address. Reminders handles delivery inside its own handler (the
    // email IS the reminder); every other type is emailed here, after the
    // handler produced its report. Best-effort: never fails the run.
    let summary = result.summary;
    if (config.agentType !== "reminders" && isEmailDeliveryEnabled(config.toolAccess)) {
      const { subject, body, html } = buildRunEmailContent({
        agentName: config.name,
        agentType: config.agentType,
        run: { summary: result.summary, startedAt: run.startedAt },
        output: result.output != null ? String(result.output) : null,
      });
      const emailResult = await sendAgentReportEmail({ userId, subject, body, html });
      summary = summary ? `${summary} (${emailResult.status})` : `(${emailResult.status})`;
    }

    const usage = result.usage || null;
    const model = result.model ?? (usage ? config.model : null);
    const cost = estimateCost(model, usage);
    let updated = await withUserContext(userId, (tx) =>
      tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          summary: clampSummary(summary),
          dataAccessed: result.dataAccessed ?? undefined,
          outputCiphertext: result.output != null ? encrypt(String(result.output)) : null,
          model,
          tokensInput: usage?.inputTokens ?? null,
          tokensOutput: usage?.outputTokens ?? null,
          estimatedCostUsd: cost,
          completedAt: new Date(),
        },
      })
    );

    // Living-profile extraction: its tokens/cost are charged to this run row,
    // and any failure here must never fail the (already successful) run.
    try {
      const extraction = await extractFromRun({
        userId,
        run: { agentType: config.agentType, summary: result.summary, output: result.output },
      });
      if (extraction?.usage) {
        const combinedUsage = addUsage(usage, extraction.usage);
        updated = await withUserContext(userId, (tx) =>
          tx.agentRun.update({
            where: { id: run.id },
            data: {
              tokensInput: combinedUsage?.inputTokens ?? null,
              tokensOutput: combinedUsage?.outputTokens ?? null,
              estimatedCostUsd: addCosts(cost, estimateCost(extraction.model, extraction.usage)),
            },
          })
        );
      }
    } catch {
      // Profile extraction is best-effort by contract.
    }

    return updated;
  } catch (error) {
    try {
      return await withUserContext(userId, (tx) =>
        tx.agentRun.update({
          where: { id: run.id },
          data: { status: "FAILED", error: describeAgentError(error), completedAt: new Date() },
        })
      );
    } catch {
      // Recording the failure failed (e.g. DB outage) — surface the original
      // handler error, which is the actionable one.
      throw error;
    }
  }
}
