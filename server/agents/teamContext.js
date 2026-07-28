import { encrypt } from "../security/envelope.js";
import { ensureDefaultConversation, touchConversation } from "./conversations.js";
import { cronToSchedulePreset, formatHourUtcLabel } from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared CEO "team" context: the live AgentConfig roster plus helpers so chat
// and digest can name sub-agents even when they have zero runs yet.
// ─────────────────────────────────────────────────────────────────────────────

export const TEAM_AGENT_SELECT = Object.freeze({
  id: true,
  name: true,
  agentType: true,
  status: true,
  schedule: true,
  definitionOfDone: true,
  instructions: true,
  createdAt: true,
});

export async function loadTeamAgents(tx, userId) {
  return tx.agentConfig.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: TEAM_AGENT_SELECT,
  });
}

export function scheduleLabelForAgent(agent) {
  const schedule = cronToSchedulePreset(agent?.schedule);
  let scheduleLabel = "on-demand (no schedule)";
  const hourLabel = formatHourUtcLabel(schedule?.hourUtc);
  if (schedule?.preset === "weekly") {
    const days = schedule.weekdays?.length
      ? schedule.weekdays.join(", ")
      : schedule.weekday || "monday";
    scheduleLabel = hourLabel ? `weekly (${days}) at ${hourLabel}` : `weekly (${days})`;
  } else if (schedule?.preset) {
    scheduleLabel = hourLabel ? `${schedule.preset} at ${hourLabel}` : schedule.preset;
  }
  return scheduleLabel;
}

/** One-line roster for CEO prompts. Never invent agents outside this list. */
export function renderTeamRoster(agents) {
  if (!agents?.length) {
    return "(no sub-agents yet — the user has not created any workers)";
  }
  return agents
    .map((agent) => {
      const dod = String(agent.definitionOfDone || "").trim();
      const dodSnippet = dod
        ? dod.length > 160
          ? `${dod.slice(0, 157)}...`
          : dod
        : "(no definition of done)";
      return [
        `- ${agent.name} (id=${agent.id}, type=${agent.agentType}, status=${agent.status || "ACTIVE"}, schedule=${scheduleLabelForAgent(agent)})`,
        `  Outcome: ${dodSnippet}`,
      ].join("\n");
    })
    .join("\n");
}

export function agentNameById(agents) {
  const map = new Map();
  for (const agent of agents || []) {
    if (agent?.id) map.set(agent.id, agent.name);
  }
  return map;
}

/** Run summaries labeled with agent name when known (falls back to agentType). */
export function renderNamedRunSummaries(runs, agents = [], { emptyLabel = "(no completed runs yet)" } = {}) {
  if (!runs?.length) return emptyLabel;
  const names = agentNameById(agents);
  const rosterIds = new Set((agents || []).map((agent) => agent?.id).filter(Boolean));
  return runs
    .map((run) => {
      const day = new Date(run.startedAt).toISOString().slice(0, 10);
      const name = run.agentConfigId ? names.get(run.agentConfigId) : null;
      const orphaned = !run.agentConfigId || !rosterIds.has(run.agentConfigId);
      const label = name
        ? `${name}, ${run.agentType}`
        : orphaned
          ? `${run.agentType}, orphaned_run`
          : run.agentType;
      const runIdPart = run.id ? `, run ${run.id}` : "";
      const orphanNote = orphaned ? " [not an active agent — history only]" : "";
      return `[${day}] (${label}${runIdPart})${orphanNote} ${run.summary || "(no summary)"}`;
    })
    .join("\n");
}

/**
 * Posts a short AGENT note into the user's main (non-system) CEO conversation
 * so Harry's next chat turn can see that a sub-agent was just created.
 * Creation interviews live on a hidden isSystem thread otherwise.
 */
export async function announceAgentCreatedToCeoChat(
  tx,
  { userId, ceoAgentConfigId, agent }
) {
  if (!userId || !ceoAgentConfigId || !agent?.id) return null;

  const conversation = await ensureDefaultConversation(tx, {
    userId,
    ceoAgentConfigId,
  });

  const note = [
    `Team update: I created "${agent.name}" (${agent.agentType}).`,
    `It is ${String(agent.status || "ACTIVE").toLowerCase()}, read-only, and scheduled as ${scheduleLabelForAgent(agent)}.`,
    agent.definitionOfDone
      ? `Outcome: ${String(agent.definitionOfDone).trim()}`
      : null,
    "It has no completed runs yet — open its chat to refine it or trigger a run.",
  ]
    .filter(Boolean)
    .join(" ");

  const message = await tx.agentChatMessage.create({
    data: {
      userId,
      conversationId: conversation.id,
      ceoAgentConfigId,
      agentConfigId: null,
      role: "AGENT",
      contentCiphertext: encrypt(note),
    },
  });
  await touchConversation(tx, conversation.id);
  return { conversationId: conversation.id, messageId: message.id, note };
}
