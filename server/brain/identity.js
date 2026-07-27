import { dataSection } from "../agents/prompts.js";
import { PROFILE_CATEGORIES } from "../agents/profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Identity namespaces for Freedom Brain.
//
// The assistant entity is CEO_AGENT (type + id). The configurable display name
// (e.g. whatever the user typed in settings) is only a label — never the
// identity key for memory, reasoning, permissions, or capabilities.
//
// Model framing: "I am the CEO Agent named <displayName>."
// Not: "I am <displayName>."
// ─────────────────────────────────────────────────────────────────────────────

/** Stable entity type for the Freedom Brain CEO orchestrator. */
export const CEO_AGENT_ENTITY_TYPE = "CEO_AGENT";

export const MEMORY_OWNERS = Object.freeze(["assistant", "user", "workspace"]);

/** Capabilities are entity-typed — independent of display name. */
export const CEO_AGENT_CAPABILITIES =
  "Create, update, run, and coordinate specialist agents; maintain the Daily Digest; recall user-owned memories with provenance.";

export const CEO_AGENT_ROLE = "Freedom Brain — CEO Agent (assistant entity type CEO_AGENT)";

const NAME_CLAIM_RE =
  /\b(?:(?:my|the user'?s|user'?s|his|her|their)\s+name\s+is|name\s*[:=]|i(?:'?m| am)|call(?:ed)?\s+me)\s+/i;

/**
 * Build the three identity namespaces from authoritative config/user rows.
 * Never derive assistant entity identity from the living profile blob.
 * Display name is read from CeoAgentConfig.name as a user preference only.
 */
export function buildIdentityNamespaces({
  ceoConfig = {},
  user = null,
  teamAgents = [],
  profile = null,
} = {}) {
  const displayName = cleanPersonName(ceoConfig?.name) || "CEO Agent";
  const entityId = ceoConfig?.id ? String(ceoConfig.id) : null;
  const userName =
    cleanPersonName(user?.displayName) ||
    inferUserNameFromProfile(profile, displayName) ||
    null;

  const preferences = collectOwnedTexts(profile, "statedPreferences", displayName);
  const personalFacts = collectOwnedTexts(profile, "lifeContext", displayName);

  return {
    assistantIdentity: {
      entityType: CEO_AGENT_ENTITY_TYPE,
      id: entityId,
      /** User-configurable label only — not used as a memory/permission key. */
      displayName,
      role: CEO_AGENT_ROLE,
      capabilities: CEO_AGENT_CAPABILITIES,
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

/** Display name accessor — never treat this as the entity identity. */
export function getAssistantDisplayName(identities) {
  return (
    cleanPersonName(identities?.assistantIdentity?.displayName) ||
    cleanPersonName(identities?.assistantIdentity?.name) ||
    null
  );
}

/** Convert a selected relevance memory into an owned fact. */
export function toOwnedMemory(item, { assistantDisplayName = null } = {}) {
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
    leak:
      owner === "user" && isAssistantIdentityAttributedToUser(text, assistantDisplayName),
  };
}

/**
 * Keep only user-owned, non-leaking memories for the RELEVANT MEMORIES section.
 * Assistant display names never enter this list as generic user memories.
 */
export function selectOwnedUserMemories(
  selected = [],
  { assistantDisplayName = null, assistantName = null } = {}
) {
  // assistantName kept as a soft alias for older call sites.
  const displayName = assistantDisplayName || assistantName;
  const out = [];
  for (const item of selected || []) {
    const owned = toOwnedMemory(item, { assistantDisplayName: displayName });
    if (!owned.value) continue;
    if (owned.owner !== "user") continue;
    if (owned.leak) continue;
    out.push(owned);
  }
  return out;
}

/** True when a profile/memory text claims the assistant display name is the user's. */
export function isAssistantIdentityAttributedToUser(text, assistantDisplayName) {
  const name = cleanPersonName(assistantDisplayName);
  if (!name || !text) return false;
  const body = String(text);
  const nameRe = personNameRegex(name);
  if (!nameRe.test(body)) return false;

  if (
    /\b(user'?s name|my name is|name is|call(?:ed)? me|i am|i'm)\b/i.test(body) &&
    nameRe.test(body)
  ) {
    // Allow facts about the assistant entity / its display label.
    if (/\b(assistant|ceo|agent|brain|display\s*name)\b/i.test(body)) return false;
    return true;
  }

  // Bare "Name: <displayName>" life-context rows when that label is the CEO's.
  if (/^\s*name\s*[:=]\s*/i.test(body) && nameRe.test(body)) return true;
  return false;
}

/**
 * Drop profile ops that would store the CEO display name as a user fact.
 * Used by memory extraction before applyOps/saveProfile.
 */
export function filterAssistantIdentityOps(ops, assistantDisplayName) {
  return (Array.isArray(ops) ? ops : []).filter((op) => {
    if (!op || typeof op !== "object") return false;
    if (op.op === "remove") return true;
    const text = String(op.text || "").trim();
    if (!text) return op.op === "remove";
    return !isAssistantIdentityAttributedToUser(text, assistantDisplayName);
  });
}

/**
 * Situation Brief identity block — separate sections, never merged.
 * Assistant identity is entity-typed; displayName is an explicit label field.
 */
export function renderIdentitySituationBrief({
  identities,
  activeMission = null,
  relevantMemories = [],
} = {}) {
  const assistant = identities?.assistantIdentity || {};
  const user = identities?.userIdentity || {};
  const workspace = identities?.workspaceIdentity || {};
  const displayName = assistant.displayName || assistant.name || "CEO Agent";
  const entityType = assistant.entityType || CEO_AGENT_ENTITY_TYPE;

  const sections = [
    dataSection(
      "ASSISTANT IDENTITY",
      [
        `owner: assistant`,
        `entityType: ${entityType}`,
        `id: ${assistant.id || "(unknown)"}`,
        `displayName: ${displayName}`,
        `displayNameNote: user-configurable label only — not the entity identity; renaming does not change type, id, memory ownership, permissions, or capabilities`,
        `selfDescription: I am the CEO Agent named ${displayName}.`,
        `role: ${assistant.role || CEO_AGENT_ROLE}`,
        `capabilities: ${assistant.capabilities || CEO_AGENT_CAPABILITIES}`,
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
 * Uses the configured displayName only as a label collision check — entity
 * type/id never change when the label changes.
 */
export function validateIdentityConsistency(reply, identities = {}, { userMessage = "" } = {}) {
  const failures = [];
  const text = String(reply || "").trim();
  if (!text) return { ok: true, failures };

  const displayName = getAssistantDisplayName(identities);
  const userName = cleanPersonName(identities?.userIdentity?.name);
  const msg = String(userMessage || "");

  if (displayName) {
    const displayRe = personNameRegex(displayName);

    // Greeting the user with the CEO display name.
    if (
      new RegExp(`\\b(hey|hi|hello|dear)\\s+${escapeRegex(displayName)}\\b`, "i").test(text) &&
      !new RegExp(
        `\\b(i(?:'?m| am)|my name is|ceo agent named)\\s+${escapeRegex(displayName)}\\b`,
        "i"
      ).test(text)
    ) {
      failures.push("addressed_user_as_assistant");
    }

    // Claims the CEO display name belongs to the user / is in the user profile.
    const correctingSelf =
      /\b(my name|i made a mistake|not yours|mistakenly|incorrectly|i(?:'?m| am) (?:the )?(?:assistant|ceo|brain)|ceo agent named)\b/i.test(
        text
      );
    if (!correctingSelf) {
      const attributed =
        new RegExp(
          `\\b(your name is|call you|calling you)\\s+${escapeRegex(displayName)}\\b`,
          "i"
        ).test(text) ||
        new RegExp(
          `\\b${escapeRegex(displayName)}\\b.{0,48}\\b(in your profile|listed in your profile|your profile)\\b`,
          "i"
        ).test(text) ||
        new RegExp(
          `\\b(in your profile|listed in your profile|your profile).{0,48}\\b${escapeRegex(displayName)}\\b`,
          "i"
        ).test(text);
      if (attributed) failures.push("assistant_name_attributed_to_user");
    }

    // User challenges a mis-name using the current display label.
    const challengeRe = new RegExp(
      `\\b(why .* call me|why .* ${escapeRegex(displayName)}|${escapeRegex(displayName)} is your name|what you mean)\\b`,
      "i"
    );
    if (
      challengeRe.test(msg) &&
      displayRe.test(text) &&
      /\b(your profile|your name|listed)\b/i.test(text) &&
      !/\b(my name|i made a mistake|not yours|assistant|ceo agent)\b/i.test(text)
    ) {
      failures.push("failed_identity_correction");
    }
  }

  // User asks "what is my name?" — must not answer with the CEO display name.
  if (
    /\bwhat(?:'s| is) my name\b/i.test(msg) &&
    displayName &&
    personNameRegex(displayName).test(text) &&
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

  // Reject attempts to overwrite CEO entity identity with the user's name.
  if (
    /\bremember (?:that )?your name is\b/i.test(msg) &&
    userName &&
    new RegExp(`\\bmy name is\\s+${escapeRegex(userName)}\\b`, "i").test(text) &&
    !/\bceo agent\b/i.test(text)
  ) {
    failures.push("accepted_user_name_as_assistant_identity");
  }

  if (
    userName &&
    displayName &&
    new RegExp(`\\byour name is\\s+${escapeRegex(displayName)}\\b`, "i").test(text)
  ) {
    if (!failures.includes("assistant_name_attributed_to_user")) {
      failures.push("assistant_name_attributed_to_user");
    }
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

/**
 * Structured retry hint — re-injects entity namespaces (data), not name patches.
 */
export function renderIdentityValidationRetry(identities, failures = []) {
  const assistant = identities?.assistantIdentity || {};
  const user = identities?.userIdentity || {};
  const displayName = getAssistantDisplayName(identities) || "CEO Agent";
  return dataSection(
    "IDENTITY NAMESPACE CORRECTION",
    [
      `validation_failed: ${failures.join(", ") || "identity_inconsistency"}`,
      `assistant.entityType: ${assistant.entityType || CEO_AGENT_ENTITY_TYPE}`,
      `assistant.id: ${assistant.id || "(unknown)"}`,
      `assistant.displayName (label only): ${displayName}`,
      `selfDescription: I am the CEO Agent named ${displayName}.`,
      `user.name (owner=user): ${user.name || "(not set — do not invent)"}`,
      "Regenerate using entityType CEO_AGENT + displayName label. Do not assign the CEO displayName to the user.",
    ].join("\n")
  );
}

function collectOwnedTexts(profile, category, assistantDisplayName) {
  const entries = profile?.categories?.[category];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => String(entry?.text || "").trim())
    .filter(Boolean)
    .filter((text) => !isAssistantIdentityAttributedToUser(text, assistantDisplayName))
    .slice(0, 8);
}

function inferUserNameFromProfile(profile, assistantDisplayName) {
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
      if (
        assistantDisplayName &&
        candidate.toLowerCase() === assistantDisplayName.toLowerCase()
      ) {
        continue;
      }
      if (isAssistantIdentityAttributedToUser(text, assistantDisplayName)) continue;
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
