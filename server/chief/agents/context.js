// Turns a workforce picture into the context items the existing reader slot
// already accepts. The model sees labeled lines. It does not receive rows.

const AGENT_LINES = 6;
const EVENT_LINES = 4;

function summary(event) {
  if (event.text) return event.text;
  if (event.outcome) return event.outcome;
  return event.kind;
}

function agentLine(agent) {
  const name = agent.displayName || agent.id;
  const reported =
    agent.identityTrust === "untrusted" && agent.displayName ? " (reported name)" : "";
  const role = agent.role ? `, ${agent.role}` : "";
  const when = agent.lastEventAt || "unknown";
  return `${name}${reported} is ${agent.liveness}${role}. Last event ${when}.`;
}

export function agentContextReader(runtime) {
  if (typeof runtime?.picture !== "function") {
    throw new TypeError("agent context reader requires a runtime picture");
  }
  return async function readAgents(ctx) {
    const picture = await runtime.picture(ctx?.userId, { now: ctx?.now });
    if (!picture?.bound && !picture?.revoked) return [];
    const trust = picture.coverage === "platform" ? "platform" : "untrusted";
    const lines = [
      {
        text: [picture.coverageLine, picture.gaps?.[0]].filter(Boolean).join(" "),
        source: picture.provider,
        sourceType: "live_agent_state",
        trust,
        temporalState: "current",
        occurredAt: picture.asOf,
        sourceId: "workforce-coverage",
      },
    ];
    for (const agent of (picture.agents ?? []).slice(0, AGENT_LINES)) {
      lines.push({
        text: agentLine(agent),
        source: picture.provider,
        sourceType: "live_agent_state",
        trust: agent.identityTrust === "untrusted" ? "untrusted" : trust,
        temporalState: agent.liveness === "active" ? "current" : "recent",
        occurredAt: agent.lastEventAt,
        sourceId: agent.id,
        relatesTo: agent.lastTurnId ? [agent.lastTurnId] : [],
      });
    }
    for (const event of (picture.recent ?? []).slice(0, EVENT_LINES)) {
      lines.push({
        text: `${event.agentId} ${event.kind}: ${summary(event)}`,
        source: picture.provider,
        sourceType: "live_agent_state",
        trust: event.trust || trust,
        temporalState: "recent",
        occurredAt: event.occurredAt,
        sourceId: event.id,
        relatesTo: [event.agentId, event.turnId].filter(Boolean),
      });
    }
    return lines;
  };
}
