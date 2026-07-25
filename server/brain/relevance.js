import { PROFILE_CATEGORIES, normalizeProfile } from "../agents/profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Relevance Engine — v2 rollout step 1 (docs/FREEDOM_BRAIN_V2.md §2, §0.2).
//
// Decides what deserves the Brain's attention instead of dumping every stored
// memory into the prompt, and annotates every selected item with WHY it was
// included (reason, confidence, source, last-confirmed date) so the Brain can
// weigh provenance instead of blindly trusting context.
//
// Step-1 scope: operates over the EXISTING living-profile store. Confidence
// is derived deterministically from each entry's source and age — the same
// inputs the UserMemory lifecycle formalizes in rollout step 2, which will
// replace only the candidate-loading side of this module.
//
// Everything here is deterministic and cheap (no model calls, no embeddings);
// scoring internals are this module's private concern so upgrades never touch
// the loop, tools, or prompts.
// ─────────────────────────────────────────────────────────────────────────────

/** Max memory items injected per turn once selection kicks in. */
export const MEMORY_BUDGET = 25;
/** Coverage guarantee: top items per non-empty category before global fill. */
const MIN_PER_CATEGORY = 2;
/** Confidence decays with a 180-day half-life since the entry last changed. */
const CONFIDENCE_HALF_LIFE_DAYS = 180;
const CONFIDENCE_FLOOR = 0.3;
const CONFIDENCE_CEILING = 0.99;

const CATEGORY_LABELS = Object.freeze({
  financialGoals: "Financial goals",
  knownAccountsRelationships: "Known accounts & relationships",
  statedPreferences: "Stated preferences",
  recurringConcerns: "Recurring concerns",
  lifeContext: "Life context",
});

// Sources the user personally provided/curated rank above extracted ones.
const USER_CONFIRMED_SOURCES = new Set(["onboarding", "user_edit"]);

const SOURCE_LABELS = Object.freeze({
  onboarding: "user provided (onboarding)",
  user_edit: "user confirmed (profile edit)",
  brain_chat: "extracted from conversation",
  ceo_chat: "extracted from conversation",
});

function sourceLabel(source) {
  const key = String(source || "unknown");
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  return `observed by ${key} capability`;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between",
  "both", "cannot", "could", "does", "doing", "down", "during", "each",
  "from", "have", "having", "here", "into", "just", "like", "make", "more",
  "most", "much", "need", "only", "other", "over", "should", "some", "such",
  "than", "that", "them", "then", "there", "these", "they", "this", "those",
  "under", "until", "very", "want", "wants", "what", "when", "where",
  "which", "while", "will", "with", "would", "your",
]);

/** Lowercased content terms (length ≥ 4, stop words removed). */
export function extractTopicTerms(...texts) {
  const terms = new Set();
  for (const text of texts) {
    const tokens = String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
    for (const token of tokens) terms.add(token);
  }
  return terms;
}

function ageDays(isoDate, now) {
  const then = new Date(isoDate || 0).getTime();
  if (!Number.isFinite(then) || then <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - then) / (24 * 60 * 60 * 1000));
}

/**
 * Derived confidence for a living-profile entry (step-1 stand-in for the
 * UserMemory lifecycle): source prior × recency decay, clamped.
 */
export function deriveConfidence(entry, { now = new Date() } = {}) {
  const prior = USER_CONFIRMED_SOURCES.has(String(entry.source)) ? 0.9 : 0.7;
  const age = ageDays(entry.updatedAt || entry.addedAt, now);
  const decayed = Number.isFinite(age)
    ? prior * Math.pow(2, -age / CONFIDENCE_HALF_LIFE_DAYS)
    : prior * 0.5;
  return Math.min(CONFIDENCE_CEILING, Math.max(CONFIDENCE_FLOOR, decayed));
}

function matchedTerms(entryText, topicTerms) {
  if (!topicTerms.size) return [];
  const entryTerms = extractTopicTerms(entryText);
  const matches = [];
  for (const term of entryTerms) {
    if (topicTerms.has(term)) matches.push(term);
  }
  return matches;
}

/**
 * Attention score for one entry:
 *   score = 0.5·topical relevance + 0.3·recency + 0.2·(user-confirmed boost)
 * Returned with the components so the provenance annotation IS the score's
 * explanation (§0.2 — no separate guess).
 */
export function scoreMemoryEntry(entry, { topicTerms, now = new Date() } = {}) {
  const matches = matchedTerms(entry.text, topicTerms || new Set());
  const topical = Math.min(1, matches.length / 2);
  const recency = Math.pow(
    2,
    -ageDays(entry.updatedAt || entry.addedAt, now) / CONFIDENCE_HALF_LIFE_DAYS
  );
  const confirmed = USER_CONFIRMED_SOURCES.has(String(entry.source)) ? 1 : 0;
  return {
    score: 0.5 * topical + 0.3 * recency + 0.2 * confirmed,
    matches,
    confidence: deriveConfidence(entry, { now }),
    userConfirmed: confirmed === 1,
  };
}

function buildReason(matches, userConfirmed, recencyFresh) {
  if (matches.length) {
    return `matches current topic "${matches.slice(0, 3).join(", ")}"`;
  }
  if (userConfirmed) return "core user-confirmed context";
  if (recencyFresh) return "recently updated";
  return "background context";
}

function lastConfirmedLabel(entry) {
  const iso = entry.updatedAt || entry.addedAt;
  const date = new Date(iso || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "unknown";
  return date.toISOString().slice(0, 10);
}

/**
 * Selects the memories that deserve attention for this turn.
 *
 * Small stores are passed through whole (parity with v1 behavior — selection
 * only kicks in when the store outgrows the budget). Large stores get: the
 * top MIN_PER_CATEGORY per non-empty category (coverage), then the best
 * remaining items globally until the budget is filled.
 *
 * Returns [{ category, categoryLabel, entry, annotation }] in stable
 * category order.
 */
export function selectRelevantMemories(
  profile,
  { message = "", recentUserMessages = [], now = new Date(), budget = MEMORY_BUDGET } = {}
) {
  const normalized = normalizeProfile(profile);
  const topicTerms = extractTopicTerms(message, ...recentUserMessages);

  const scored = [];
  for (const category of PROFILE_CATEGORIES) {
    for (const entry of normalized.categories[category]) {
      const { score, matches, confidence, userConfirmed } = scoreMemoryEntry(entry, {
        topicTerms,
        now,
      });
      const recencyFresh = ageDays(entry.updatedAt || entry.addedAt, now) <= 30;
      scored.push({
        category,
        categoryLabel: CATEGORY_LABELS[category],
        entry,
        score,
        annotation: {
          reason: buildReason(matches, userConfirmed, recencyFresh),
          confidence: Number(confidence.toFixed(2)),
          source: sourceLabel(entry.source),
          lastConfirmed: lastConfirmedLabel(entry),
        },
      });
    }
  }

  let selected;
  if (scored.length <= budget) {
    selected = scored;
  } else {
    const chosen = new Set();
    // Coverage first: best MIN_PER_CATEGORY from each non-empty category.
    for (const category of PROFILE_CATEGORIES) {
      scored
        .filter((item) => item.category === category)
        .sort((a, b) => b.score - a.score)
        .slice(0, MIN_PER_CATEGORY)
        .forEach((item) => chosen.add(item));
    }
    // Then the best remaining items globally until the budget is filled.
    for (const item of [...scored].sort((a, b) => b.score - a.score)) {
      if (chosen.size >= budget) break;
      chosen.add(item);
    }
    selected = scored.filter((item) => chosen.has(item)).slice(0, budget);
  }

  // Stable category order (matches the legacy profile rendering).
  const categoryRank = new Map(PROFILE_CATEGORIES.map((category, index) => [category, index]));
  return selected.sort(
    (a, b) =>
      categoryRank.get(a.category) - categoryRank.get(b.category) || b.score - a.score
  );
}

/**
 * Renders selected memories with their provenance annotations (§0.2):
 *
 *   Financial goals:
 *   - Wants aggressive debt payoff
 *     (why: matches current topic "debt"; confidence 0.9;
 *      source: user confirmed (profile edit); last confirmed 2026-07-01)
 */
export function renderMemoriesWithProvenance(selected) {
  if (!selected.length) return "(no profile information recorded yet)";
  const lines = [];
  let currentCategory = null;
  for (const item of selected) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      lines.push(`${item.categoryLabel}:`);
    }
    lines.push(`- [${item.entry.id}] ${item.entry.text}`);
    lines.push(
      `  (why: ${item.annotation.reason}; confidence ${item.annotation.confidence}; source: ${item.annotation.source}; last confirmed ${item.annotation.lastConfirmed})`
    );
  }
  return lines.join("\n");
}
