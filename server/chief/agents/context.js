// Turns a workforce picture into the context items the existing reader slot
// already accepts. Each line names the provider and what was, and was not, observed.

const AGENT_LINES = 6;

function eventsFor(agent, events) {
  return (events ?? []).filter((event) => event.agentId === agent.id);
}

function observedStatus(events) {
  const work = events.filter((event) => event.kind === "freedom.report.work");
  const latest = work[0];
  const earlier = work.find((event) => event.outcome && event.outcome !== latest?.outcome);
  const parts = [];
  if (latest?.outcome) {
    const detail = latest.text ? `: ${latest.text}` : "";
    parts.push(`Observed status ${latest.outcome}${detail}.`);
  }
  if (earlier?.outcome) {
    parts.push(`Earlier status ${earlier.outcome} is historical, not current.`);
  }
  const completed = work.some((event) =>
    /^(?:completed|finished|done)$/i.test(event.outcome || "")
  );
  if (!completed) parts.push("No completion observed.");
  const failed = events.some((event) =>
    /fail|error|blocked|stuck/i.test(`${event.outcome || ""} ${event.text || ""}`)
  );
  if (failed) parts.push("Observed failure.");
  else parts.push("No failure observed.");
  const finding = events.find((event) => event.kind === "freedom.report.finding");
  if (finding) parts.push(`Observed finding: ${finding.text || finding.outcome}.`);
  else parts.push("No finding observed.");
  const attention = events.find((event) => event.kind === "freedom.report.attention");
  if (attention) parts.push(`Observed attention: ${attention.text || attention.outcome}.`);
  else parts.push("No attention request observed.");
  return parts.join(" ");
}

function agentLine(agent, events, { revoked }) {
  const name = agent.displayName || agent.id;
  const reported =
    agent.identityTrust === "untrusted" && agent.displayName ? " (reported name, untrusted)" : "";
  const role = agent.role ? ` Role ${agent.role}.` : "";
  const when = agent.lastEventAt || "unknown";
  if (revoked) {
    return `${name}${reported}.${role} Binding revoked. Not currently active. Historical observation only. Last event ${when}. ${observedStatus(events)}`;
  }
  const current =
    agent.liveness === "stale"
      ? "Not current activity."
      : "Liveness is inferred from the last event, not from a task status.";
  return `${name}${reported}.${role} Liveness ${agent.liveness}. ${current} Last event ${when}. ${observedStatus(events)}`;
}

export function agentContextReader(runtime) {
  if (typeof runtime?.picture !== "function") {
    throw new TypeError("agent context reader requires a runtime picture");
  }
  return async function readAgents(ctx) {
    const picture = await runtime.picture(ctx?.userId, { now: ctx?.now });
    if (!picture?.bound && !picture?.revoked) return [];
    const trust = picture.coverage === "platform" ? "platform" : "untrusted";
    const provenance =
      picture.coverage === "platform"
        ? "Platform telemetry is the authority for actions it delivered."
        : "These are self-reported observations, not platform telemetry.";
    const lines = [
      {
        text: `Provider ${picture.provider}. ${picture.coverageLine} ${provenance} Absence of an observation is unknown, not success. ${(picture.gaps ?? []).slice(0, 2).join(" ")}`.trim(),
        source: picture.provider,
        sourceType: "live_agent_state",
        trust,
        temporalState: "current",
        occurredAt: picture.asOf,
        sourceId: "workforce-coverage",
      },
    ];
    for (const agent of (picture.agents ?? []).slice(0, AGENT_LINES)) {
      const events = eventsFor(agent, picture.recent);
      lines.push({
        text: agentLine(agent, events, { revoked: picture.revoked === true }),
        source: picture.provider,
        sourceType: "live_agent_state",
        trust: agent.identityTrust === "untrusted" ? "untrusted" : trust,
        temporalState: picture.revoked || agent.liveness !== "active" ? "recent" : "current",
        occurredAt: agent.lastEventAt,
        sourceId: agent.id,
        relatesTo: agent.lastTurnId ? [agent.lastTurnId] : [],
      });
    }
    return lines;
  };
}
