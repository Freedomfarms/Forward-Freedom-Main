// CHIEF context injection — recalled memory becomes model context.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/tools/storage/context.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Preserved upstream semantics:
//   - ContextConfig (enabled, top_k, min_score, max_context_tokens)
//   - token estimate is a whitespace split
//   - quarantined facts are dropped before they can spend context budget
//   - a document with no trust metadata stays recallable; a non-mapping
//     metadata object, an unknown tier, or "untrusted" fails closed
//   - newest facts win the fact budget (caller passes oldest-first); when
//     retrieval results exist, facts get at most half the budget
//   - a single oversized result may displace facts if it fits the total budget
//   - the context message is merged into the first system message, which is
//     placed first; the original message list is not mutated
//   - nothing to inject returns the original messages
// Adaptations:
//   - factPriority "given" keeps the caller's order (best first) instead of
//     reversing it. OpenJarvis ranks documents in the retrieval backend and
//     walks facts newest-first. CHIEF's only store is encrypted facts, so the
//     assembler ranks them with reciprocal rank fusion and passes that order.
//     The default remains newest-first.
//   - No event-bus publish. CHIEF's EventType.MEMORY_RETRIEVE has no consumer
//     on this path; publishing it would be a new side channel.

import { EventType } from "../core/events.js";

export const RECALLABLE_TRUST_TIERS = new Set(["", "auto", "trusted"]);

export function countTokens(text) {
  const value = String(text ?? "").trim();
  if (!value) return 0;
  return value.split(/\s+/).length;
}

export class ContextConfig {
  constructor({ enabled = true, topK = 5, minScore = 0, maxContextTokens = 2048 } = {}) {
    this.enabled = enabled;
    this.topK = topK;
    this.minScore = minScore;
    this.maxContextTokens = maxContextTokens;
  }
}

export function trustedForRecall(fact) {
  const tier = String(fact?.trustTier ?? fact?.trust ?? "")
    .trim()
    .toLowerCase();
  return RECALLABLE_TRUST_TIERS.has(tier);
}

export function resultTrustedForRecall(result) {
  const metadata = result?.metadata;
  if (metadata == null) return true;
  if (typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const tier = String(metadata.trust ?? "")
    .trim()
    .toLowerCase();
  return RECALLABLE_TRUST_TIERS.has(tier);
}

export function formatContext(results) {
  if (!results?.length) return "";
  return results
    .map((result) => {
      const source = result.source ? `[Source: ${result.source}] ` : "";
      return `${source}${result.content}`;
    })
    .join("\n\n");
}

export function buildContextMessage(results, facts = []) {
  const safeFacts = facts.filter(trustedForRecall);
  const safeResults = results.filter(resultTrustedForRecall);
  const sections = [];
  if (safeFacts.length) {
    const factText = safeFacts.map((fact) => `- ${fact.content ?? fact.text}`).join("\n");
    sections.push(
      "The following durable facts were remembered from prior conversations. Use them when relevant to the user's request:\n\n" +
        factText
    );
  }
  if (safeResults.length) {
    sections.push(
      "The following context was retrieved from the knowledge base. Use it to inform your response, citing sources where applicable:\n\n" +
        formatContext(safeResults)
    );
  }
  return {
    role: "system",
    content: sections.join("\n\n"),
    metadata: { memory_context: true },
  };
}

function mergeContextMessage(messages, contextMessage) {
  const systemMessages = messages.filter((message) => message.role === "system");
  if (systemMessages.length === 0) return [contextMessage, ...messages];
  const content = [...systemMessages.map((message) => message.content), contextMessage.content]
    .filter(Boolean)
    .join("\n\n");
  const combined = { ...systemMessages[0], content };
  return [combined, ...messages.filter((message) => message.role !== "system")];
}

export function injectContext(
  query,
  messages,
  backendResults = null,
  { config = new ContextConfig(), facts = [], factPriority = "newest", bus = null } = {}
) {
  const cfg = config ?? new ContextConfig();
  if (!cfg.enabled) return messages;

  let results = Array.isArray(backendResults) ? [...backendResults] : [];
  results = results.filter(resultTrustedForRecall);
  results = results.filter((result) => (result.score ?? 0) >= cfg.minScore);
  if (cfg.topK != null) results = results.slice(0, cfg.topK);

  const trusted = facts.filter(trustedForRecall);
  const ordered = factPriority === "given" ? trusted : [...trusted].reverse();
  let factBudget = cfg.maxContextTokens;
  if (results.length) factBudget = Math.floor(factBudget / 2);

  const selectedFacts = [];
  let totalTokens = 0;
  for (const fact of ordered) {
    const tokens = countTokens(fact.content ?? fact.text);
    if (totalTokens + tokens > factBudget) continue;
    selectedFacts.push(fact);
    totalTokens += tokens;
  }

  const truncated = [];
  for (const result of results) {
    const tokens = countTokens(result.content);
    if (totalTokens + tokens > cfg.maxContextTokens) {
      if (truncated.length === 0 && selectedFacts.length > 0 && tokens <= cfg.maxContextTokens) {
        selectedFacts.length = 0;
        totalTokens = 0;
      } else {
        break;
      }
    }
    if (totalTokens + tokens > cfg.maxContextTokens) break;
    truncated.push(result);
    totalTokens += tokens;
  }

  if (selectedFacts.length === 0 && truncated.length === 0) return messages;

  bus?.publish(EventType.MEMORY_RETRIEVE, {
    context_injection: true,
    query,
    num_results: truncated.length,
    num_facts: selectedFacts.length,
    total_tokens: totalTokens,
  });

  return mergeContextMessage(messages, buildContextMessage(truncated, selectedFacts));
}
