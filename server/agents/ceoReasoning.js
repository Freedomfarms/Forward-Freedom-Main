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
    if (/\b(who|people|persons?|competitors?|accounts?|targets?|subjects?)\b/.test(lower))
      score += 50;
    if (/\b(platforms?|sources?|where|channels?|x\b|twitter|linkedin|instagram)\b/.test(lower))
      score += 40;
    if (
      /\b(outcome|done|deliver|emails?|reports?|format|frequency|schedule|morning)\b/.test(lower)
    )
      score += 30;
    if (/\b(topic|what updates|signal|metric)\b/.test(lower)) score += 25;
    // Preference / checklist items sink
    if (/\b(personality|tone|voice|style|escalat|boundary|boundaries|permission)\b/.test(lower))
      score -= 40;
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
  if (/^who\b/i.test(text) || /^which\b/i.test(text) || /^what\b/i.test(text)) {
    return text.endsWith("?") ? text : `${text}?`;
  }
  return `What about ${text}?`.replace(/^What about (?=who|which|what)/i, "");
}

/**
 * Lightweight mission sketch for debug + regression expectations.
 * Does not invent agent type/domain; only surfaces obvious known/missing.
 */
export function sketchMissionFromMessage(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const known = [];
  const missing = [];
  const assumptions = [];

  const wantsAgent =
    /\b(agent|build me|create|watch(?:es|ing)?|monitor|report|email me|summary)\b/i.test(text);
  const social =
    /\b(social media|twitter|\bx\b|linkedin|instagram|tiktok|posts?)\b/i.test(lower);
  const competitors = /\bcompetitors?\b/i.test(lower);
  const emailDelivery = /\bemails?\b/i.test(lower);
  const namedPeople = extractProperNames(text);
  const platforms = [];
  if (/\b(twitter|\bx\b)\b/i.test(text)) platforms.push("X");
  if (/\blinkedin\b/i.test(text)) platforms.push("LinkedIn");
  if (/\binstagram\b/i.test(text)) platforms.push("Instagram");

  let mission = null;
  let situation = wantsAgent
    ? "User is requesting a capability or ongoing report from the CEO."
    : "User message in the CEO conversation.";

  if (social && emailDelivery) {
    mission = "Email social media reports about specific people.";
    known.push("Deliver reports by email");
    known.push("Domain: social media reporting");
    if (namedPeople.length) known.push(`People: ${namedPeople.join(", ")}`);
    else missing.push("people to monitor");
    if (platforms.length) known.push(`Platforms: ${platforms.join(", ")}`);
    else missing.push("platforms to monitor");
    if (!/\b(morning|daily|weekly|every)\b/i.test(text)) {
      missing.push("frequency / schedule");
    } else {
      known.push("Schedule mentioned in request");
    }
    assumptions.push({
      text: "Likely a research-style monitoring capability (not finance)",
      confidence: 0.55,
    });
  } else if (competitors) {
    mission = "Watch competitors and report on them.";
    if (namedPeople.length) known.push(`Named entities: ${namedPeople.join(", ")}`);
    else missing.push("which competitors or industry");
    missing.push("what to watch for");
    if (!emailDelivery && !/\breport|summar/i.test(lower)) {
      missing.push("how to deliver updates");
    } else if (emailDelivery) {
      known.push("Deliver by email");
    }
  } else if (wantsAgent) {
    mission = text.slice(0, 200);
    missing.push("desired outcome / definition of done");
  }

  // Complete-ish social request: people + platforms present → drop those gaps
  if (namedPeople.length >= 2 && platforms.length >= 2 && social) {
    // frequency may remain; people/platforms are known
    const filtered = missing.filter(
      (gap) => !/people to monitor|platforms to monitor/i.test(gap)
    );
    missing.length = 0;
    missing.push(...filtered);
    if (!missing.length) {
      // Still allow a soft optional gap only if schedule vague — morning is enough
      if (/\bevery morning\b/i.test(lower)) {
        // executable enough
      }
    }
  }

  const selection = selectHighestValueQuestion(missing, { known });
  const sketch = {
    situation,
    mission,
    known,
    missing,
    assumptions,
    candidateQuestions: selection?.candidateQuestions || [],
    selectedQuestion: selection?.selectedQuestion || null,
    reasonSelected: selection?.reasonSelected || null,
    tentativeAgentType: social || competitors ? "research" : null,
    agentTypeConfidence: social || competitors ? 0.55 : 0,
  };
  return sketch;
}

function extractProperNames(text) {
  // Captures sequences like "Elon Musk" / "Jensen Huang" — not a NER model.
  const matches = String(text || "").match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  return [...new Set(matches)].filter((name) => !/^Every\b/.test(name));
}

export function shouldCommitAgentType(confidence, evidence = []) {
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < AGENT_TYPE_COMMIT_CONFIDENCE) return false;
  return Array.isArray(evidence) ? evidence.length > 0 || conf >= 0.9 : conf >= 0.9;
}

export function isCreatableAgentType(type) {
  return CREATABLE_AGENT_TYPES.includes(String(type || "").trim().toLowerCase());
}
