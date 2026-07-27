import { dataSection } from "../agents/prompts.js";
import { PROFILE_CATEGORIES } from "../agents/profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Identity namespaces for Freedom Brain.
//
// Assistant, user, and workspace identity are separate structured contexts.
// Memories/facts always carry ownership metadata so the LLM never receives
// unattributed identity claims. This module is the architectural fix for
// assistant↔user name confusion (e.g. calling the user by the CEO's name).
// ─────────────────────────────────────────────────────────────────────────────

export const MEMORY_OWNERS = Object.freeze(["assistant", "user", "workspace"]);

const NAME_CLAIM_RE =
  /\b(?:(?:my|the user'?s|user'?s|his|her|their)\s+name\s+is|name\s*[:=]|i(?:'?m| am)|call(?:ed)?\s+me)\s+/i;

/**
 * Build the three identity namespaces from authoritative config/user rows.
 * Never derive assistant identity from the living profile blob.
 */
export function buildIdentityNamespaces({
  ceoConfig = {},
  user = null,
  teamAgents = [],
  profile = null,
} = {}) {
  const assistantName = String(ceoConfig?.name || "CEO Agent").trim() || "CEO Agent";
  const userName =
    cleanPersonName(user?.displayName) ||
    inferUserNameFromProfile(profile, assistantName) ||
    null;

  const preferences = collectOwnedTexts(profile, "statedPreferences", assistantName);
  const personalFacts = collectOwnedTexts(profile, "lifeContext", assistantName);

  return {
    assistantIdentity: {
      name: assistantName,
      role: "Freedom Brain — CEO Agent (assistant)",
      capabilities:
        "Create, update, run, and coordinate specialist agents; maintain the Daily Digest; recall user-owned memories with provenance.",
    },
    userIdentity: {
      name: userName,
      preferences,
      personalFacts,
    },
    workspaceIdentity: {
      product: "Freedom OS",
      organization: null,
      timezone: user?.timezone || null,
      specialistCount: Array.isArray(teamAgents) ? teamAgents.length : 0,
    },
  };
}

/** Convert a selected relevance memory into an owned fact. */
export function toOwnedMemory(item, { assistantName = null } = {}) {
  const entry = item?.entry || item || {};
  const text = String(entry.text || item?.value || "").trim();
  const owner = normalizeOwner(entry.owner || item?.owner || "user");
  return {
    owner,
    type: inferMemoryType(item?.category || entry.category, text),
    key: inferMemoryKey(item?.category || entry.category, text),
    value: text,
    id: entry.id || item?.id || null,
    category: item?.category || entry.category || null,
    source: entry.source || item?.source || null,
    annotation: item?.annotation || null,
    // Surface leaks so callers can drop them before prompt injection.
    leak: owner === "user" && isAssistantIdentityAttributedToUser(text, assistantName),
  };
}

/**
 * Keep only user-owned, non-leaking memories for the RELEVANT MEMORIES section.
 * Assistant identity never enters this list as a generic memory.
 */
export function selectOwnedUserMemories(selected = [], { assistantName = null } = {}) {
  const out = [];
  for (const item of selected || []) {
    const owned = toOwnedMemory(item, { assistantName });
    if (!owned.value) continue;
    if (owned.owner !== "user") continue;
    if (owned.leak) continue;
    out.push(owned);
  }
  return out;
}

/** True when a profile/memory text claims the assistant's name is the user's. */
export function isAssistantIdentityAttributedToUser(text, assistantName) {
  const name = cleanPersonName(assistantName);
  if (!name || !text) return false;
  const body = String(text);
  const nameRe = personNameRegex(name);
  if (!nameRe.test(body)) return false;

  // Explicit user-name claims mentioning the assistant name.
  if (
    /\b(user'?s name|my name is|name is|call(?:ed)? me|i am|i'm)\b/i.test(body) &&
    nameRe.test(body)
  ) {
    // Allow "My assistant is named Harry" / "CEO agent Harry"
    if (/\b(assistant|ceo|agent|brain)\b/i.test(body)) return false;
    return true;
  }

  // Bare "Name: Harry" style life-context rows when Harry is the assistant.
  if (/^\s*name\s*[:=]\s*/i.test(body) && nameRe.test(body)) return true;
  return false;
}

/**
 * Drop profile ops that would store assistant identity as a user fact.
 * Used by memory extraction before applyOps/saveProfile.
 */
export function filterAssistantIdentityOps(ops, assistantName) {
  return (Array.isArray(ops) ? ops : []).filter((op) => {
    if (!op || typeof op !== "object") return false;
    if (op.op === "remove") return true;
    const text = String(op.text || "").trim();
    if (!text) return op.op === "remove";
    return !isAssistantIdentityAttributedToUser(text, assistantName);
  });
}

/**
 * Situation Brief identity block — separate sections, never merged.
 * Active mission + relevant memories are optional trailing sections.
 */
export function renderIdentitySituationBrief({
  identities,
  activeMission = null,
  relevantMemories = [],
} = {}) {
  const assistant = identities?.assistantIdentity || {};
  const user = identities?.userIdentity || {};
  const workspace = identities?.workspaceIdentity || {};

  const sections = [
    dataSection(
      "ASSISTANT IDENTITY",
      [
        `owner: assistant`,
        `name: ${assistant.name || "CEO Agent"}`,
        `role: ${assistant.role || "Freedom Brain — CEO Agent (assistant)"}`,
        `capabilities: ${assistant.capabilities || "(see YOUR CAPABILITIES)"}`,
      ].join("\n")
    ),
    dataSection(
      "USER IDENTITY",
      [
        `owner: user`,
        `name: ${user.name || "(not set — do not invent a user name)"}`,
        `preferences: ${formatList(user.preferences)}`,
        `personal facts: ${formatList(user.personalFacts)}`,
      ].join("\n")
    ),
    dataSection(
      "WORKSPACE",
      [
        `owner: workspace`,
        `product: ${workspace.product || "Freedom OS"}`,
        workspace.organization ? `organization: ${workspace.organization}` : null,
        `timezone: ${workspace.timezone || "(unknown)"}`,
        `specialist agents: ${workspace.specialistCount ?? 0}`,
      ]
        .filter(Boolean)
        .join("\n")
    ),
  ];

  sections.push(
    dataSection(
      "ACTIVE MISSION",
      activeMission
        ? [
            `mission: ${activeMission.mission || "(none)"}`,
            `kind: ${activeMission.missionKind || "(none)"}`,
            `executable: ${activeMission.missionExecutable ? "yes" : "no"}`,
            `known: ${formatList(activeMission.known)}`,
            `missing: ${formatList(activeMission.missing)}`,
          ].join("\n")
        : "(no active mission sketch)"
    )
  );

  sections.push(dataSection("RELEVANT MEMORIES", renderOwnedMemories(relevantMemories)));
  return sections;
}

/** Render owned memories; every line carries owner metadata. */
export function renderOwnedMemories(memories = []) {
  if (!Array.isArray(memories) || !memories.length) {
    return "(no user-owned memories selected for this turn)";
  }
  const lines = [];
  for (const memory of memories) {
    const id = memory.id ? `[${memory.id}] ` : "";
    const type = memory.type || "fact";
    const key = memory.key || "general";
    lines.push(
      `- owner: ${memory.owner || "user"}; type: ${type}; key: ${key}; value: ${id}${memory.value}`
    );
    if (memory.annotation) {
      lines.push(
        `  (why: ${memory.annotation.reason}; confidence ${memory.annotation.confidence}; source: ${memory.annotation.source}; last confirmed ${memory.annotation.lastConfirmed})`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic self-consistency check before the reply is persisted.
 * Catches assistant↔user identity swaps without relying on prompt rules.
 */
export function validateIdentityConsistency(reply, identities = {}, { userMessage = "" } = {}) {
  const failures = [];
  const text = String(reply || "").trim();
  if (!text) return { ok: true, failures };

  const assistantName = cleanPersonName(identities?.assistantIdentity?.name);
  const userName = cleanPersonName(identities?.userIdentity?.name);
  const msg = String(userMessage || "");

  if (assistantName) {
    const assistantRe = personNameRegex(assistantName);

    // "Hey Harry" / "Hi Harry," as a greeting → addressing the user as the assistant.
    if (
      new RegExp(`\\b(hey|hi|hello|dear)\\s+${escapeRegex(assistantName)}\\b`, "i").test(text) &&
      !new RegExp(
        `\\b(i(?:'?m| am)|my name is)\\s+${escapeRegex(assistantName)}\\b`,
        "i"
      ).test(text)
    ) {
      failures.push("addressed_user_as_assistant");
    }

    // Claims assistant name belongs to the user / is in the user profile.
    // Allow corrections that clearly reclaim the name as the assistant's.
    const correctingSelf =
      /\b(my name|i made a mistake|not yours|mistakenly|incorrectly|i(?:'?m| am) (?:the )?(?:assistant|ceo|brain))\b/i.test(
        text
      );
    if (!correctingSelf) {
      const attributed =
        new RegExp(
          `\\b(your name is|call you|calling you)\\s+${escapeRegex(assistantName)}\\b`,
          "i"
        ).test(text) ||
        new RegExp(
          `\\b${escapeRegex(assistantName)}\\b.{0,48}\\b(in your profile|listed in your profile|your profile)\\b`,
          "i"
        ).test(text) ||
        new RegExp(
          `\\b(in your profile|listed in your profile|your profile).{0,48}\\b${escapeRegex(assistantName)}\\b`,
          "i"
        ).test(text);
      if (attributed) failures.push("assistant_name_attributed_to_user");
    }

    // User challenges the mis-name and the reply still asserts Harry is the user's name.
    if (
      /\b(why .* call me|why .* harry|harry is your name|what you mean)\b/i.test(msg) &&
      assistantRe.test(text) &&
      /\b(your profile|your name|listed)\b/i.test(text) &&
      !/\b(my name|i made a mistake|not yours|assistant)\b/i.test(text)
    ) {
      failures.push("failed_identity_correction");
    }
  }

  // User asks "what is my name?" — must not answer with the assistant name.
  if (
    /\bwhat(?:'s| is) my name\b/i.test(msg) &&
    assistantName &&
    personNameRegex(assistantName).test(text) &&
    !/\b(i don'?t|not (?:sure|set|known)|do not have|haven'?t)\b/i.test(text)
  ) {
    if (!userName || !personNameRegex(userName).test(text)) {
      failures.push("answered_user_name_with_assistant_name");
    }
  }

  // User asks "what is your name?" / "who are you?" — must not claim to be the user.
  if (/\b(what(?:'s| is) your name|who are you)\b/i.test(msg) && userName) {
    if (
      new RegExp(`\\b(i(?:'?m| am)|my name is)\\s+${escapeRegex(userName)}\\b`, "i").test(text)
    ) {
      failures.push("claimed_user_name_as_assistant");
    }
  }

  // Reject attempts to overwrite assistant identity with the user's name via "remember".
  if (
    /\bremember (?:that )?your name is\b/i.test(msg) &&
    userName &&
    new RegExp(`\\bmy name is\\s+${escapeRegex(userName)}\\b`, "i").test(text)
  ) {
    failures.push("accepted_user_name_as_assistant_identity");
  }

  // Known user name contradicted by assigning a different name as "your name is X"
  // when X is the assistant name (already covered) or inventing identity flip.
  if (
    userName &&
    assistantName &&
    new RegExp(`\\byour name is\\s+${escapeRegex(assistantName)}\\b`, "i").test(text)
  ) {
    if (!failures.includes("assistant_name_attributed_to_user")) {
      failures.push("assistant_name_attributed_to_user");
    }
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

/**
 * Structured retry hint — re-injects namespaces (data), not behavioral rules.
 */
export function renderIdentityValidationRetry(identities, failures = []) {
  const assistant = identities?.assistantIdentity || {};
  const user = identities?.userIdentity || {};
  return dataSection(
    "IDENTITY NAMESPACE CORRECTION",
    [
      `validation_failed: ${failures.join(", ") || "identity_inconsistency"}`,
      `assistant.name (owner=assistant): ${assistant.name || "CEO Agent"}`,
      `user.name (owner=user): ${user.name || "(not set — do not invent)"}`,
      "Regenerate the reply using ASSISTANT IDENTITY / USER IDENTITY ownership. Do not assign assistant.name to the user.",
    ].join("\n")
  );
}

function collectOwnedTexts(profile, category, assistantName) {
  const entries = profile?.categories?.[category];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => String(entry?.text || "").trim())
    .filter(Boolean)
    .filter((text) => !isAssistantIdentityAttributedToUser(text, assistantName))
    .slice(0, 8);
}

function inferUserNameFromProfile(profile, assistantName) {
  if (!profile?.categories) return null;
  for (const category of PROFILE_CATEGORIES) {
    for (const entry of profile.categories[category] || []) {
      const text = String(entry?.text || "");
      const match = text.match(
        /\b(?:user'?s name is|my name is|name is|name\s*[:=])\s*([A-Z][a-zA-Z'-]{1,40})\b/
      );
      if (!match) continue;
      const candidate = cleanPersonName(match[1]);
      if (!candidate) continue;
      if (assistantName && candidate.toLowerCase() === assistantName.toLowerCase()) continue;
      if (isAssistantIdentityAttributedToUser(text, assistantName)) continue;
      return candidate;
    }
  }
  return null;
}

function inferMemoryType(category, text) {
  if (NAME_CLAIM_RE.test(text || "")) return "identity";
  if (category === "statedPreferences") return "preference";
  if (category === "financialGoals") return "goal";
  if (category === "recurringConcerns") return "concern";
  if (category === "knownAccountsRelationships") return "relationship";
  return "fact";
}

function inferMemoryKey(category, text) {
  if (NAME_CLAIM_RE.test(text || "")) return "name";
  if (category === "statedPreferences") return "preference";
  if (category === "financialGoals") return "goal";
  if (category === "lifeContext") return "life_context";
  if (category === "recurringConcerns") return "concern";
  if (category === "knownAccountsRelationships") return "relationship";
  return "general";
}

function normalizeOwner(owner) {
  const value = String(owner || "user").toLowerCase();
  return MEMORY_OWNERS.includes(value) ? value : "user";
}

function cleanPersonName(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  // Reject emails / multi-sentence blobs.
  if (/@/.test(text) || text.length > 60) return null;
  return text.replace(/\s+/g, " ");
}

function formatList(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items.map((item) => String(item)).join("; ");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function personNameRegex(name) {
  return new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
}
