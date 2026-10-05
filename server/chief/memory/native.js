// Native memory adapter. chief_fact and ChiefSession recall stay the stores.
//
// This class does not keep rows, embed externally, or own the transcript.
// remember/search/forget call the fact store and the recall-document reader
// CHIEF already uses. A live tool result is refused before any write.

import { trustedForRecall } from "../context/inject.js";
import { fencesOutput, scanInjection } from "../security/injection.js";
import { qualifiesForLongTermMemory, personalSource } from "./qualify.js";
import {
  MEMORY_LAYER,
  planMemoryRetrieval,
  rankEpisodes,
  selectPersonalFacts,
} from "./retrieve.js";
import { semanticSimilarity } from "./semantic.js";
import { buildWorkingMemory, renderWorkingMemory } from "./working.js";

const LIVE_SOURCES = new Set([
  "tool",
  "finance",
  "finance_summary",
  "freedom_financial",
  "calendar",
  "email",
  "web",
  "web_search",
  "code",
  "codebase",
]);

const LIVE_KINDS = new Set(["tool", "live", "financial", "calendar", "email", "web", "code"]);

function scanOrNull(text) {
  try {
    return scanInjection(text);
  } catch {
    return null;
  }
}

function isLiveEvent(event) {
  const source = String(event?.source ?? "").toLowerCase();
  const kind = String(event?.kind ?? "").toLowerCase();
  if (LIVE_KINDS.has(kind)) return true;
  if (LIVE_SOURCES.has(source)) return true;
  return source.endsWith("_tool");
}

function trustTierFor(event) {
  const raw = String(event?.trust ?? "AUTO")
    .trim()
    .toUpperCase();
  if (raw === "UNTRUSTED") return "UNTRUSTED";
  if (raw === "AUTO" || raw === "") return "AUTO";
  return null;
}

function durableSource(event, text) {
  if (String(event?.kind ?? "").toLowerCase() === "explicit") return personalSource(text);
  if (event?.source === "preference") return "preference";
  if (event?.source === "user") return "user";
  return "auto";
}

function layersFor(query, scope) {
  const raw = scope?.layers ?? scope?.layer ?? null;
  if (raw == null) {
    const plan = planMemoryRetrieval(query);
    const layers = [];
    if (plan.working && scope?.transcript) layers.push(MEMORY_LAYER.WORKING);
    if (plan.personal) layers.push(MEMORY_LAYER.PERSONAL);
    if (plan.episodic) layers.push(MEMORY_LAYER.EPISODIC);
    return layers;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) => String(item ?? "").toUpperCase())
    .filter(
      (item) =>
        item === MEMORY_LAYER.WORKING ||
        item === MEMORY_LAYER.PERSONAL ||
        item === MEMORY_LAYER.EPISODIC
    );
}

function finiteScore(value) {
  return Number.isFinite(value) ? value : 0;
}

export class NativeMemoryProvider {
  constructor({ facts = null, episodes = null } = {}) {
    this.name = "native";
    this.facts = facts;
    this.episodes = episodes;
  }

  isAvailable() {
    const facts = this.facts;
    return Boolean(
      facts &&
      typeof facts.read === "function" &&
      typeof facts.write === "function" &&
      typeof facts.forget === "function"
    );
  }

  async remember(event = {}) {
    const userId = event.userId;
    const text = String(event.text ?? "").trim();
    if (!userId) return { stored: false, reason: "missing-user" };
    if (!text) return { stored: false, reason: "not-durable" };
    if (isLiveEvent(event)) return { stored: false, reason: "live-data" };
    const explicit = String(event.kind ?? "").toLowerCase() === "explicit";
    const scan = scanOrNull(text);
    if (scan && fencesOutput(scan.threatLevel)) return { stored: false, reason: "injection" };
    if (!qualifiesForLongTermMemory(text, { explicit })) {
      return { stored: false, reason: "not-durable" };
    }
    let trustTier = trustTierFor(event);
    if (!trustTier) return { stored: false, reason: "trust" };
    if (!explicit && scan && scan.isClean === false) trustTier = "UNTRUSTED";
    const written = await this.facts.write({
      userId,
      content: text,
      trustTier,
      source: durableSource(event, text),
      importance: explicit ? 0.8 : 0.5,
      confidence: explicit ? 0.9 : 0.5,
    });
    return { stored: true, id: written?.id ?? null };
  }

  async search(query, scope = {}) {
    const userId = scope.userId;
    if (!userId) return [];
    const results = [];
    for (const layer of layersFor(query, scope)) {
      try {
        if (layer === MEMORY_LAYER.WORKING) {
          const hit = this._workingHit(query, scope);
          if (hit) results.push(hit);
        } else if (layer === MEMORY_LAYER.PERSONAL) {
          results.push(...(await this._personalHits(query, scope)));
        } else if (layer === MEMORY_LAYER.EPISODIC) {
          results.push(...(await this._episodicHits(query, scope)));
        }
      } catch {
        // This source returned nothing. Other layers still answer.
      }
    }
    return results;
  }

  async forget(selector = {}) {
    if (!selector.userId || typeof this.facts?.forget !== "function") return { deleted: 0 };
    return this.facts.forget({
      userId: selector.userId,
      id: selector.id ?? null,
      content: selector.content ?? selector.text ?? null,
    });
  }

  _workingHit(_query, scope) {
    if (!Array.isArray(scope.transcript) || scope.transcript.length === 0) return null;
    const text = renderWorkingMemory(buildWorkingMemory(scope.transcript, { notes: scope.notes }));
    if (!text) return null;
    return {
      layer: MEMORY_LAYER.WORKING,
      text,
      score: 1,
      sourceId: scope.sessionId ?? null,
    };
  }

  async _personalHits(query, scope) {
    const rows = await this.facts.read({ userId: scope.userId, query: "", limit: 500 });
    const recallable = (rows ?? []).filter(
      (fact) => fact?.source !== "identity" && trustedForRecall(fact)
    );
    const selected = selectPersonalFacts(query, recallable);
    if (selected.length && typeof this.facts.touch === "function") {
      try {
        await this.facts.touch({
          userId: scope.userId,
          ids: selected.map((fact) => fact.id).filter(Boolean),
        });
      } catch {
        // Recall still returns if last-use cannot be recorded.
      }
    }
    return selected.map((fact) => ({
      layer: MEMORY_LAYER.PERSONAL,
      text: fact.content,
      score: finiteScore(semanticSimilarity(query, fact.content)),
      sourceId: fact.id ?? null,
    }));
  }

  async _episodicHits(query, scope) {
    if (typeof this.episodes?.listRecallDocuments !== "function") return [];
    const documents = await this.episodes.listRecallDocuments(scope.userId, {
      limit: 40,
      excludeSessionId: scope.sessionId ?? null,
    });
    return rankEpisodes(query, documents, { userId: scope.userId }).map((hit) => ({
      layer: MEMORY_LAYER.EPISODIC,
      text: String(hit.episode.content ?? ""),
      score: finiteScore(hit.score),
      sourceId: hit.episode.id ?? null,
    }));
  }
}
