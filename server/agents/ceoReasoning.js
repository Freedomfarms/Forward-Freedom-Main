// ─────────────────────────────────────────────────────────────────────────────
// Shared CEO mission reasoning — ONE brain for information, execution, create,
// update, and workflows. Not a separate "+ New Agent" interview.
//
// Pipeline (prompt-enforced + helpers for ranking / debug / tests):
//   Situation Brief → Mission Model → Knowledge State → Relevance → ONE question
// ─────────────────────────────────────────────────────────────────────────────

import { CREATABLE_AGENT_TYPES } from "./registry.js";

export const AGENT_TYPE_COMMIT_CONFIDENCE = 0.75;

/** Shared system rules for Brain + legacy CEO chat. */
export const CEO_MISSION_REASONING_RULES = [
  "You are the user's single CEO intelligence inside Freedom OS. There is no separate agent-builder mode — creating, updating, and running agents are capabilities you use inside this conversation.",
  "Every turn, reason through: Situation Brief (what is happening / what outcome they want) → Mission Model (create, execute, answer, or modify) → Knowledge State (known vs missing vs assumptions with confidence) → Relevance (rank missing info by execution dependency, mission criticality, information gain) → ask ONE highest-value question OR act if the mission is executable.",
  "Never follow a fixed interview checklist (personality, tone, escalation, boundaries, category). Never ask preference questions before mission-critical execution facts are known.",
  "Never invent agent type, domain, restrictions, permissions, workflow behavior, or personality. If uncertain, ask. Maintain Decision / Confidence / Evidence before committing type, tools, permissions, or workflows.",
  "Stop asking when the mission is executable. Do not collect unnecessary preferences. Successful execution beats a completed questionnaire.",
  "When the user refers to an existing agent/capability (e.g. \"my supplier agent\"), modify that capability — do not create a duplicate.",
  "Assumptions must never be presented as facts. Label them clearly or ask.",
  'Example: user says "email me social media reports on a couple people" → acknowledge the mission, then ask who to track — do NOT invent a Finance Agent or ask about personality.',
].join("\n");

export function isCeoReasoningDebugEnabled() {
  const raw = String(process.env.FREEDOM_OS_DEBUG_CEO || "").trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * Dev-only observability for the reasoning loop.
 * @param {object} state
 */
export function logCeoReasoning(state = {}) {
  if (!isCeoReasoningDebugEnabled()) return;
  const lines = [
    "Situation: " + (state.situation || "(none)"),
    "Mission: " + (state.mission || "(none)"),
    "Known: " + formatList(state.known),
    "Missing: " + formatList(state.missing),
    "Assumptions: " + formatAssumptions(state.assumptions),
    "Candidate questions: " + formatList(state.candidateQuestions),
    "Selected question: " + (state.selectedQuestion || "(none)"),
    "Reason selected: " + (state.reasonSelected || "(none)"),
  ];
  console.info(`[ceo-reasoning]\n${lines.join("\n")}`);
}

function formatList(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items.map((item) => String(item)).join("; ");
}

function formatAssumptions(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const conf =
        item.confidence != null && Number.isFinite(Number(item.confidence))
          ? ` conf=${Number(item.confidence).toFixed(2)}`
          : "";
      return `${item.text || item.fact || "?"}${conf}`;
    })
    .join("; ");
}

/**
 * Rank missing facts for execution. Higher score = ask sooner.
 * Not a personality checklist — execution blockers win.
 */
export function rankMissingByRelevance(missing = [], { known = [] } = {}) {
  const knownText = known.join(" ").toLowerCase();
  const scored = (Array.isArray(missing) ? missing : []).map((item) => {
    const text = String(item || "").trim();
    const lower = text.toLowerCase();
    let score = 10;
    // Execution dependency / criticality boosts
    if (
      /\b(who|people|persons?|competitors?|accounts?|targets?|subjects?|suppliers?|customers?|companies|company|which agent)\b/.test(
        lower
      )
    ) {
      score += 50;
    }
    if (/\b(platforms?|sources?|where|channels?|x\b|twitter|linkedin|instagram)\b/.test(lower)) {
      score += 40;
    }
    if (
      /\b(outcome|done|deliver|emails?|reports?|format|frequency|schedule|morning|earlier|time)\b/.test(
        lower
      )
    ) {
      score += 30;
    }
    if (/\b(topic|what updates|signal|metric|what to watch|risk signals?)\b/.test(lower)) {
      score += 25;
    }
    if (/\b(scope|which|clarify|ambiguous)\b/.test(lower)) score += 45;
    // Preference / checklist items sink
    if (/\b(personality|tone|voice|style|escalat|boundary|boundaries|permission)\b/.test(lower)) {
      score -= 40;
    }
    if (/\b(agent type|category|finance|research)\b/.test(lower) && knownText) score -= 10;
    return { text, score };
  });
  return scored
    .filter((row) => row.text)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.text);
}

export function selectHighestValueQuestion(missing, context = {}) {
  const ranked = rankMissingByRelevance(missing, context);
  if (!ranked.length) return null;
  const top = ranked[0];
  return {
    selectedQuestion: top.endsWith("?") ? top : humanizeGapAsQuestion(top),
    candidateQuestions: ranked.slice(0, 5).map((gap) => humanizeGapAsQuestion(gap)),
    reasonSelected: "Highest execution dependency / mission criticality among missing facts.",
  };
}

function humanizeGapAsQuestion(gap) {
  const text = String(gap || "").trim();
  if (!text) return text;
  if (text.endsWith("?")) return text;
  if (/^(who|which|what|when|how)\b/i.test(text)) {
    return text.endsWith("?") ? text : `${text}?`;
  }
  return `What about ${text}?`;
}

/**
 * Lightweight mission sketch for debug + acceptance / regression expectations.
 * Does not invent agent type/domain as facts; only surfaces obvious known/missing.
 */
export function sketchMissionFromMessage(message, { existingAgents = [] } = {}) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const known = [];
  const missing = [];
  const assumptions = [];

  const existingRef = detectExistingAgentReference(text, existingAgents);
  const modifyIntent =
    Boolean(existingRef) ||
    (/\b(make my|change|update|rename|pause|resume|earlier|later|reschedule|tweak|edit)\b/i.test(
      text
    ) &&
      /\b(agent|report|schedule|digest|reminder|brief)\b/i.test(text));

  const social =
    /\b(social media|twitter|\bx\b|linkedin|instagram|tiktok|posts?)\b/i.test(lower);
  const competitors = /\bcompetitors?\b/i.test(lower);
  const supplier = /\bsuppliers?\b/i.test(lower);
  const investments = /\b(investments?|portfolio|stocks?|holdings?)\b/i.test(lower);
  const customers = /\bcustomers?\b/i.test(lower);
  const companyWatch = /\b(my company|the company|our company)\b/i.test(lower);
  const vagueAsk =
    companyWatch ||
    customers ||
    /\b(help( me)? with|handle my|something for|the usual|keep an eye|look after)\b/i.test(
      text
    );
  const emailDelivery = /\bemails?\b/i.test(lower);
  const hasSchedule = /\b(every|daily|weekly|morning|monday|tuesday|wednesday|thursday|friday|hourly|monthly|weekday)\b/i.test(
    text
  );
  const namedPeople = extractNamedEntities(text);
  const platforms = extractPlatforms(text);
  const sources = extractSources(text);
  const industry = extractIndustry(text);
  const sourcesMentioned = platforms.length > 0 || sources.length > 0;

  const createIntent =
    !modifyIntent &&
    !vagueAsk &&
    /\b(agent|build me|create|set up|stand up|watch(?:es|ing)?|monitor|track|report|email me|summary|need a)\b/i.test(
      text
    );

  let mission = null;
  let missionKind = "answer";
  let situation = "User message in the CEO conversation.";
  let tentativeAgentType = null;
  let agentTypeConfidence = 0;
  let missionExecutable = false;

  // ── Modify existing capability ────────────────────────────────────────────
  if (modifyIntent) {
    missionKind = "modify";
    situation = existingRef
      ? `User wants to change an existing capability (${existingRef}).`
      : "User wants to change an existing agent or report.";
    mission = text.slice(0, 200);
    if (existingRef) {
      known.push(`Existing capability referenced: ${existingRef}`);
    } else {
      missing.push("which existing agent or report to change");
    }

    if (/\b(earlier|later|reschedule|schedule|morning|time|hour|\d{1,2}\s*(am|pm))\b/i.test(text)) {
      known.push("Change involves schedule / timing");
      if (/\bearlier\b/i.test(text) || !/\b(\d{1,2}\s*(am|pm)|:\d{2})\b/i.test(text)) {
        if (!/\b(\d{1,2}\s*(am|pm)|:\d{2})\b/i.test(text)) {
          missing.push("exact new send time");
        } else {
          known.push("New send time stated");
        }
      }
    }
    if (/\b(format|shorter|longer|bullets?|pdf|table|markdown)\b/i.test(text)) {
      known.push("Change involves report format");
      if (/\b(bullets?|pdf|table|markdown|shorter|longer)\b/i.test(text)) {
        known.push("Desired format stated");
      } else {
        missing.push("desired report format");
      }
    }
    if (!existingRef && !missing.includes("which existing agent or report to change")) {
      missing.unshift("which existing agent or report to change");
    }
  }
  // ── Ambiguous / underspecified asks (before create — "watch my company") ─
  else if (vagueAsk && !competitors && !supplier && !investments && !social) {
    missionKind = "clarify";
    situation = "User request is ambiguous; CEO must clarify before acting.";
    mission = text.slice(0, 200);
    if (companyWatch) {
      missing.push("what about the company to watch (news, competitors, ops, finance)");
    } else if (customers) {
      missing.push("what customer outcome is needed (support, churn, feedback, CRM)");
    } else if (/\binbox\b/i.test(text)) {
      missing.push("what inbox outcome is needed (triage, draft replies, digest)");
    } else if (/\bhiring\b/i.test(text)) {
      missing.push("what hiring outcome is needed (pipeline, sourcing, interview notes)");
    } else if (/\bops\b/i.test(text)) {
      missing.push("what ops outcome is needed");
    } else if (/\bbriefing\b/i.test(text)) {
      missing.push("which briefing or what it should cover");
    } else {
      missing.push("desired outcome / definition of done");
    }
  }
  // ── Create / monitor / report missions ────────────────────────────────────
  else if (createIntent || social || competitors || supplier || investments) {
    missionKind = "create";
    situation = "User is requesting a capability or ongoing report from the CEO.";

    if (social) {
      mission = emailDelivery
        ? "Email social media reports about specific people."
        : "Monitor social media and report on specific people.";
      known.push("Domain: social media reporting");
      if (emailDelivery) known.push("Deliver reports by email");
      if (namedPeople.length) known.push(`People: ${namedPeople.join(", ")}`);
      else missing.push("people to monitor");
      if (platforms.length) known.push(`Platforms: ${platforms.join(", ")}`);
      else missing.push("platforms to monitor");
      if (hasSchedule) known.push("Schedule mentioned in request");
      else missing.push("frequency / schedule");
      assumptions.push({
        text: "Likely a research-style monitoring capability (not finance)",
        confidence: 0.55,
      });
      tentativeAgentType = "research";
      agentTypeConfidence = 0.55;
    } else if (competitors) {
      mission = "Watch competitors and report on them.";
      if (namedPeople.length) {
        known.push(`Competitors / entities: ${namedPeople.join(", ")}`);
      } else if (industry) {
        known.push(`Industry scope: ${industry}`);
        missing.push("which competitor companies in that industry");
      } else {
        missing.push("which competitors or industry");
      }
      if (/\b(pricing|price|hiring|product|funding|digest)\b/i.test(text)) {
        known.push("Signal focus mentioned");
      } else {
        missing.push("what to watch for");
      }
      if (emailDelivery) known.push("Deliver by email");
      else if (!/\breport|summar|digest/i.test(lower)) missing.push("how to deliver updates");
      else known.push("Report / summary deliverable requested");
      if (hasSchedule) known.push("Schedule mentioned in request");
      if (sources.length) known.push(`Sources: ${sources.join(", ")}`);
      assumptions.push({
        text: "Likely a research-style competitive monitoring capability",
        confidence: 0.5,
      });
      tentativeAgentType = "research";
      agentTypeConfidence = 0.5;
    } else if (supplier) {
      mission = "Produce supplier risk reporting.";
      known.push("Domain: supplier risk");
      if (/\bweekly\b/i.test(text) || /\bfriday\b/i.test(text)) known.push("Cadence: weekly");
      else if (!hasSchedule) missing.push("frequency / schedule");
      if (emailDelivery) known.push("Deliver by email");
      if (namedPeople.length) {
        known.push(`Suppliers: ${namedPeople.join(", ")}`);
      } else {
        missing.push("which suppliers or supplier list");
      }
      if (!/\b(risk|delay|financial|compliance|geopolit)/i.test(lower)) {
        missing.push("which risk signals matter");
      } else {
        known.push("Risk focus mentioned");
      }
      assumptions.push({
        text: "Likely a research-style supplier monitoring capability",
        confidence: 0.5,
      });
      tentativeAgentType = "research";
      agentTypeConfidence = 0.5;
    } else if (investments) {
      mission = "Monitor investments / portfolio and report.";
      known.push("Domain: investments / portfolio");
      missing.push("which accounts, tickers, or portfolio scope");
      if (!emailDelivery && !/\breport|summar|alert|ping/i.test(lower)) {
        missing.push("how to deliver updates");
      } else if (emailDelivery) {
        known.push("Deliver by email");
      }
      if (!hasSchedule && !/\balert|when|moves?\b/i.test(lower)) {
        missing.push("frequency / schedule or alert triggers");
      }
      assumptions.push({
        text: "May map to a finance capability once scope is confirmed",
        confidence: 0.45,
      });
      tentativeAgentType = "finance";
      agentTypeConfidence = 0.45;
    } else {
      mission = text.slice(0, 200);
      missing.push("desired outcome / definition of done");
    }
  }

  // Complete social: named people + platforms → drop those gaps
  if (namedPeople.length >= 1 && platforms.length >= 1 && social) {
    const filtered = missing.filter(
      (gap) => !/people to monitor|platforms to monitor/i.test(gap)
    );
    missing.length = 0;
    missing.push(...filtered);
  }

  // Complete mission heuristic: schedule + delivery + subject/sources enough to act
  const completeEnough =
    missionKind === "create" &&
    hasSchedule &&
    (emailDelivery || /\breport|summar|digest/i.test(lower)) &&
    (namedPeople.length > 0 || (sourcesMentioned && industry) || (sourcesMentioned && competitors)) &&
    !missing.some((gap) =>
      /people to monitor|platforms to monitor|which competitors|which competitor companies|which suppliers|which accounts/i.test(
        gap
      )
    );

  if (completeEnough) {
    // Soft gaps (signals) drop when digest/report + entities + sources exist
    const hard = missing.filter((gap) =>
      /people to monitor|platforms to monitor|which competitors|which competitor companies|which suppliers|which accounts|ticker|how to deliver/i.test(
        gap
      )
    );
    missing.length = 0;
    missing.push(...hard);
    if (!missing.length) {
      missionExecutable = true;
      missionKind = "execute";
      situation = "Mission is sufficiently defined to execute or create.";
    }
  }

  // Modify with concrete instruction can be executable enough to act
  if (missionKind === "modify" && existingRef && !missing.length) {
    missionExecutable = true;
  }

  // Never invent preference gaps
  for (const banned of ["personality", "tone", "escalation", "boundaries"]) {
    if (missing.some((gap) => gap.toLowerCase().includes(banned))) {
      // strip checklist leftovers if any slipped in
    }
  }
  const cleanedMissing = missing.filter(
    (gap) => !/personality|tone|escalat|boundar/i.test(gap)
  );
  missing.length = 0;
  missing.push(...cleanedMissing);

  const selection = missionExecutable
    ? null
    : selectHighestValueQuestion(missing, { known });

  return {
    situation,
    mission,
    missionKind,
    known,
    missing,
    assumptions,
    candidateQuestions: selection?.candidateQuestions || [],
    selectedQuestion: selection?.selectedQuestion || null,
    reasonSelected: selection?.reasonSelected || null,
    tentativeAgentType,
    agentTypeConfidence,
    missionExecutable,
    createsNewCapability: missionKind === "create" || missionKind === "execute",
    modifiesExisting: missionKind === "modify",
    existingAgentReferenced: existingRef,
  };
}

function detectExistingAgentReference(text, existingAgents = []) {
  const lower = String(text || "").toLowerCase();
  // Explicit "my X agent"
  const myAgent = lower.match(/\bmy\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3})\s+agent\b/);
  if (myAgent) return myAgent[0];

  for (const agent of existingAgents) {
    const name = String(agent?.name || "").trim();
    if (name && lower.includes(name.toLowerCase())) return name;
  }

  // Common shorthand: "the supplier agent", "that research agent"
  const theAgent = lower.match(
    /\b(?:the|that)\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3})\s+agent\b/
  );
  if (theAgent) return theAgent[0];
  return null;
}

function extractPlatforms(text) {
  const platforms = [];
  if (/\b(twitter|\bx\b)\b/i.test(text)) platforms.push("X");
  if (/\blinkedin\b/i.test(text)) platforms.push("LinkedIn");
  if (/\binstagram\b/i.test(text)) platforms.push("Instagram");
  if (/\btiktok\b/i.test(text)) platforms.push("TikTok");
  return platforms;
}

function extractSources(text) {
  const sources = [];
  const lower = String(text || "").toLowerCase();
  if (/\breuters\b/i.test(text)) sources.push("Reuters");
  if (/\bbloomberg\b/i.test(text)) sources.push("Bloomberg");
  if (/\bsec\b|\bedgar\b|\bfilings?\b/i.test(lower)) sources.push("SEC filings");
  if (/\bpublic web\b|\bweb\b/i.test(lower) && /\b(using|from|via|sources?)\b/i.test(lower)) {
    sources.push("public web");
  }
  if (/\bcompany blogs?\b/i.test(lower)) sources.push("company blogs");
  if (/\brss\b/i.test(lower)) sources.push("RSS");
  return sources;
}

function extractIndustry(text) {
  const lower = String(text || "").toLowerCase();
  if (/\bev charging\b/i.test(lower)) return "EV charging";
  if (/\bev\b/i.test(lower)) return "EV";
  if (/\bai chips?\b|\bsemiconductors?\b/i.test(lower)) return "AI chips / semiconductors";
  if (/\bcattle\b/i.test(lower)) return "cattle";
  return null;
}

function extractProperNames(text) {
  // Captures sequences like "Elon Musk" / "Jensen Huang" — not a NER model.
  const matches = String(text || "").match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  return [...new Set(matches)].filter((name) => !STOP_ENTITY_WORDS.has(name.split(/\s+/)[0]));
}

/** People + company-style entities from lists ("Tesla, Rivian, and Lucid"). */
function extractNamedEntities(text) {
  const entities = [...extractProperNames(text)];
  const listChunk = String(text || "").match(
    /\b(?:for|including|covering|tracking|on)\s+([^.?!]+)$/i
  ) || String(text || "").match(/\b(?:for|including|covering|tracking)\s+([^.?!]+)/i);
  if (listChunk) {
    const parts = listChunk[1]
      .split(/\s*(?:,|\band\b|&)\s*/i)
      .map((part) => part.replace(/\b(posts?|from|using|via)\b.*$/i, "").trim())
      .filter(Boolean);
    for (const part of parts) {
      // Drop trailing source clauses: "Lucid using Reuters…"
      const cleaned = part.replace(/\busing\b.*$/i, "").trim();
      if (!cleaned) continue;
      if (STOP_ENTITY_WORDS.has(cleaned.split(/\s+/)[0])) continue;
      if (!/^[A-Z][A-Za-z0-9.&-]*/.test(cleaned)) continue;
      if (cleaned.length > 40) continue;
      entities.push(cleaned);
    }
  }
  // Single capitalized tokens that look like tickers/brands when alongside "competitor"
  if (/\bcompetitors?\b/i.test(text)) {
    const singles = String(text || "").match(/\b[A-Z][a-zA-Z0-9.&-]{1,20}\b/g) || [];
    for (const token of singles) {
      if (STOP_ENTITY_WORDS.has(token)) continue;
      if (/^(X|AI|EV|SEC|RSS)$/i.test(token)) continue;
      entities.push(token);
    }
  }
  return [...new Set(entities)];
}

const STOP_ENTITY_WORDS = new Set([
  "Every",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "Daily",
  "Weekly",
  "Each",
  "Using",
  "From",
  "LinkedIn",
  "Instagram",
  "TikTok",
  "Twitter",
  "Reuters",
  "Bloomberg",
  "Build",
  "Create",
  "Watch",
  "Monitor",
  "Track",
  "Help",
  "Change",
  "Update",
  "Make",
  "Pause",
  "Rename",
  "Have",
  "Set",
  "Stand",
  "I",
  "My",
  "The",
  "A",
  "An",
  "What",
  "Who",
  "Which",
  "When",
  "How",
  "Can",
  "Do",
  "Keep",
]);

export function shouldCommitAgentType(confidence, evidence = []) {
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < AGENT_TYPE_COMMIT_CONFIDENCE) return false;
  return Array.isArray(evidence) ? evidence.length > 0 || conf >= 0.9 : conf >= 0.9;
}

export function isCreatableAgentType(type) {
  return CREATABLE_AGENT_TYPES.includes(String(type || "").trim().toLowerCase());
}

/** True when selected question is among the top-ranked gaps (acceptance helper). */
export function isHighestValueQuestion(selectedQuestion, missing, context = {}) {
  if (!selectedQuestion) return !(missing && missing.length);
  const ranked = rankMissingByRelevance(missing, context);
  if (!ranked.length) return true;
  const top = humanizeGapAsQuestion(ranked[0]).toLowerCase();
  const selected = String(selectedQuestion).toLowerCase();
  return selected.includes(ranked[0].toLowerCase()) || top.includes(selected.replace(/\?$/, ""));
}
