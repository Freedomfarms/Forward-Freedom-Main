import crypto from "crypto";
import { jsonSchema } from "ai";

import { withUserContext } from "../db/prisma.js";
import { decryptJson, encryptJson } from "../security/envelope.js";
import { generateAgentObject, isLlmConfigured, PROFILE_EXTRACTION_MODEL } from "./llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// The "living profile": long-term shared memory that all agents read and feed,
// stored encrypted on CeoAgentConfig.profileCiphertext.
//
// Decrypted shape:
//   {
//     categories: {
//       financialGoals | knownAccountsRelationships | statedPreferences |
//       recurringConcerns | lifeContext: [
//         { id, text, source, addedAt, updatedAt }
//       ]
//     },
//     tombstones: [<removed entry ids>]
//   }
//
// Tombstones make deletion durable: automatic merging never re-adds an entry
// the user removed. `source` is "onboarding", "user_edit" (later phase), or
// the agent type that surfaced the fact.
// ─────────────────────────────────────────────────────────────────────────────

export const PROFILE_CATEGORIES = Object.freeze([
  "financialGoals",
  "knownAccountsRelationships",
  "statedPreferences",
  "recurringConcerns",
  "lifeContext",
]);

const CATEGORY_LABELS = Object.freeze({
  financialGoals: "Financial goals",
  knownAccountsRelationships: "Known accounts & relationships",
  statedPreferences: "Stated preferences",
  recurringConcerns: "Recurring concerns",
  lifeContext: "Life context",
});

export const MAX_ENTRIES_PER_CATEGORY = 15;

export function createEmptyProfile() {
  return {
    categories: Object.fromEntries(PROFILE_CATEGORIES.map((category) => [category, []])),
    tombstones: [],
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const text = String(entry.text || "").trim();
  if (!text) return null;
  const now = new Date().toISOString();
  const ownerRaw = String(entry.owner || "user").toLowerCase();
  const owner =
    ownerRaw === "assistant" || ownerRaw === "workspace" || ownerRaw === "user"
      ? ownerRaw
      : "user";
  return {
    id: String(entry.id || crypto.randomUUID()),
    text,
    // Living-profile entries are user-owned by default. Assistant identity
    // must never be stored here as a generic unattributed fact.
    owner,
    source: String(entry.source || "unknown"),
    addedAt: entry.addedAt || now,
    updatedAt: entry.updatedAt || entry.addedAt || now,
  };
}

// Tolerates null/legacy/partial payloads and always returns the full shape.
export function normalizeProfile(raw) {
  const profile = createEmptyProfile();
  if (!raw || typeof raw !== "object") return profile;
  for (const category of PROFILE_CATEGORIES) {
    const entries = Array.isArray(raw.categories?.[category]) ? raw.categories[category] : [];
    profile.categories[category] = entries.map(normalizeEntry).filter(Boolean);
  }
  profile.tombstones = Array.isArray(raw.tombstones)
    ? raw.tombstones.filter((id) => id != null && String(id).trim()).map((id) => String(id))
    : [];
  return profile;
}

/** Loads and decrypts the user's living profile (empty profile if none yet). */
export async function getProfile(userId) {
  const ciphertext = await withUserContext(userId, async (tx) => {
    const ceoConfig = await tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { profileCiphertext: true },
    });
    return ceoConfig?.profileCiphertext ?? null;
  });
  if (!ciphertext) return createEmptyProfile();
  try {
    return normalizeProfile(decryptJson(ciphertext));
  } catch (error) {
    // Corrupted/unreadable ciphertext must not blank the profile UI — fail
    // open to an empty profile so the user can keep editing/re-seeding.
    console.error(
      "[profile.getProfile] decrypt failed; returning empty profile",
      error?.name || "Error"
    );
    return createEmptyProfile();
  }
}

/** Encrypts and persists the profile onto the user's CeoAgentConfig. */
export async function saveProfile(userId, profile) {
  const ciphertext = encryptJson(normalizeProfile(profile));
  await withUserContext(userId, async (tx) => {
    const ceoConfig = await tx.ceoAgentConfig.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!ceoConfig) return;
    await tx.ceoAgentConfig.update({
      where: { id: ceoConfig.id },
      data: { profileCiphertext: ciphertext, profileUpdatedAt: new Date() },
      // Avoid RETURNING un-migrated columns (P2022) if schema is lagging.
      select: { id: true },
    });
  });
}

/** Compact plaintext rendering injected (as a data section) into prompts. */
export function renderProfileForPrompt(profile) {
  const normalized = normalizeProfile(profile);
  const lines = [];
  for (const category of PROFILE_CATEGORIES) {
    const entries = normalized.categories[category];
    if (!entries.length) continue;
    lines.push(`${CATEGORY_LABELS[category]}:`);
    for (const entry of entries) {
      lines.push(`- [${entry.id}] ${entry.text}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no profile information recorded yet)";
}

function findEntry(profile, id) {
  for (const category of PROFILE_CATEGORIES) {
    const index = profile.categories[category].findIndex((entry) => entry.id === id);
    if (index >= 0) return { category, index };
  }
  return null;
}

/**
 * Applies structured ops to a profile (pure — returns a new profile).
 * Ops: { op: "add", category, text } | { op: "update", id, text } |
 *      { op: "remove", id }.
 * Rules: removes append the id to tombstones; tombstoned ids are never
 * re-added or updated; each category is capped at MAX_ENTRIES_PER_CATEGORY,
 * pruning the oldest-updated (superseded) entries first.
 */
export function applyOps(profile, ops, { source = "unknown", now = new Date() } = {}) {
  const next = normalizeProfile(profile);
  const timestamp = now.toISOString();
  const tombstoned = new Set(next.tombstones);

  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== "object") continue;

    if (op.op === "add") {
      if (!PROFILE_CATEGORIES.includes(op.category)) continue;
      const text = String(op.text || "").trim();
      if (!text) continue;
      // Never resurrect a tombstoned entry, even if the op echoes its id.
      if (op.id && tombstoned.has(String(op.id))) continue;
      const entries = next.categories[op.category];
      // Same fact already present → refresh instead of duplicating.
      const existing = entries.find((entry) => entry.text.toLowerCase() === text.toLowerCase());
      if (existing) {
        existing.updatedAt = timestamp;
        existing.source = source;
        continue;
      }
      entries.push({
        id: op.id ? String(op.id) : crypto.randomUUID(),
        text,
        owner: "user",
        source,
        addedAt: timestamp,
        updatedAt: timestamp,
      });
      continue;
    }

    if (op.op === "update") {
      const id = String(op.id || "");
      const text = String(op.text || "").trim();
      if (!id || !text || tombstoned.has(id)) continue;
      const located = findEntry(next, id);
      if (!located) continue;
      const entry = next.categories[located.category][located.index];
      entry.text = text;
      entry.source = source;
      entry.updatedAt = timestamp;
      continue;
    }

    if (op.op === "remove") {
      const id = String(op.id || "");
      if (!id) continue;
      const located = findEntry(next, id);
      if (located) {
        next.categories[located.category].splice(located.index, 1);
      }
      if (!tombstoned.has(id)) {
        tombstoned.add(id);
        next.tombstones.push(id);
      }
    }
  }

  // Cap each category, pruning the oldest superseded entries first. Pruning
  // is not a user deletion, so pruned ids are NOT tombstoned.
  for (const category of PROFILE_CATEGORIES) {
    const entries = next.categories[category];
    if (entries.length > MAX_ENTRIES_PER_CATEGORY) {
      entries.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
      entries.splice(0, entries.length - MAX_ENTRIES_PER_CATEGORY);
    }
  }

  return next;
}

export const PROFILE_OPS_JSON_SCHEMA = {
  type: "array",
  description:
    "Profile memory operations. Return an empty array when nothing durable about the user was revealed.",
  items: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["add", "update", "remove"] },
      category: { type: "string", enum: [...PROFILE_CATEGORIES] },
      id: { type: "string", description: "Target entry id (update/remove)." },
      text: { type: "string", description: "The durable fact, phrased briefly (add/update)." },
    },
    required: ["op"],
    additionalProperties: false,
  },
};

const EXTRACTION_SCHEMA = jsonSchema({
  type: "object",
  properties: { ops: PROFILE_OPS_JSON_SCHEMA },
  required: ["ops"],
  additionalProperties: false,
});

// Drops malformed ops from model output before they reach applyOps.
export function sanitizeProfileOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.filter((op) => {
    if (!op || typeof op !== "object") return false;
    if (op.op === "add") return PROFILE_CATEGORIES.includes(op.category) && String(op.text || "").trim();
    if (op.op === "update") return String(op.id || "").trim() && String(op.text || "").trim();
    if (op.op === "remove") return String(op.id || "").trim();
    return false;
  });
}

const EXTRACTION_SYSTEM_PROMPT = [
  "You maintain the long-term memory profile of a Freedom OS user, based on what their agents observe.",
  "You are given the current profile and the summary/output of one completed agent run. Decide whether the run revealed anything DURABLE about the user — goals, preferences, recurring concerns, life context, or relationships between their finances.",
  "Return profile operations only for genuinely durable facts. Most runs reveal nothing durable: return an empty ops array in that case.",
  "Facts must be short, plain statements. Never store merchant names, account names or numbers, or institution names.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

/**
 * One cheap-tier structured call over a completed run's summary/output that
 * asks whether anything durable about the user was revealed. Applies and
 * saves any resulting ops (source = the run's agent type). Returns
 * { ops, usage, model } or null when there was nothing to do. Callers treat
 * this as best-effort — the runner never fails a run because of it.
 */
export async function extractFromRun({ userId, run }) {
  const summary = String(run?.summary || "").trim();
  const output = String(run?.output || "").trim();
  if (!summary && !output) return null;
  if (!isLlmConfigured()) return null;

  const profile = await getProfile(userId);
  const { object, usage } = await generateAgentObject({
    model: PROFILE_EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: [
      "Review this completed agent run and return profile ops for any durable facts (or an empty array).",
      dataSection("CURRENT PROFILE", renderProfileForPrompt(profile)),
      dataSection("RUN SUMMARY", summary),
      dataSection("RUN OUTPUT", output),
    ].join("\n\n"),
    schema: EXTRACTION_SCHEMA,
    maxOutputTokens: 800,
  });

  const ops = sanitizeProfileOps(object?.ops);
  if (ops.length) {
    await saveProfile(userId, applyOps(profile, ops, { source: run?.agentType || "unknown" }));
  }
  return { ops, usage, model: PROFILE_EXTRACTION_MODEL };
}

/**
 * The chat engine requests optional profile ops directly in its structured
 * reply (no second model call). This validates, applies and saves them.
 * Best-effort: callers must not fail the chat if this throws.
 */
export async function extractFromChatReply({ userId, profileOps, source = "unknown" }) {
  const ops = sanitizeProfileOps(profileOps);
  if (!ops.length) return { ops: [] };
  const profile = await getProfile(userId);
  await saveProfile(userId, applyOps(profile, ops, { source }));
  return { ops };
}
