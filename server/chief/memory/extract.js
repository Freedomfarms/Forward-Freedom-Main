// CHIEF automatic memory — one exchange becomes durable facts.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source files: src/openjarvis/memory/extractor.py (FactExtractor,
//     _DEFAULT_SYSTEM_PROMPT, JSON-array parse, line fallback, dedupe, caps),
//     src/openjarvis/memory/service.py (_process, _scan, _flagged,
//     _blocks_exchange)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Preserved upstream semantics:
//   - the extraction prompt, temperature 0, 512 max tokens, 10 facts, 200
//     characters, JSON array anywhere in the output, then bullet/line fallback
//   - extraction never raises; a model failure degrades to no facts
//   - the exchange is scanned before the model call; only HIGH/CRITICAL
//     findings drop the exchange
//   - a fact whose own text is flagged is stored untrusted (quarantine) and
//     clean facts stay recallable
//   - a scanner failure fails open so capture is not silently disabled
// Adaptations:
//   - the model call is ChiefModelEngine.generate, so the budget cap and the
//     pause flag apply. Caller kind is "event". There is no background thread:
//     a serverless invocation extracts after the turn completes.
//   - storage is the existing fact store (dedupe, cap, encryption). Identity
//     facts are not downgraded. A duplicate that was recallable is downgraded
//     when the new copy is quarantined, matching FactStore.add.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { trustedForRecall } from "../context/inject.js";

export const EXTRACTION_SYSTEM_PROMPT =
  "You extract durable, long-term facts about the user from a single " +
  "conversation exchange. A good fact is stable over time and useful in " +
  "future conversations: preferences, identity, goals, ongoing projects, " +
  "constraints, or relationships. Ignore one-off task details, small talk, " +
  "and anything the assistant said about itself.\n\n" +
  "Respond with ONLY a JSON array of short fact strings (each under 200 " +
  "characters). If there is nothing worth remembering, respond with [].";

const NON_FACTS = new Set(["[]", "none", "n/a", "null"]);

function scanOrNull(text) {
  try {
    return scanInjection(text);
  } catch {
    return null;
  }
}

function blocksExchange(result) {
  return result != null && fencesOutput(result.threatLevel);
}

function flagged(result) {
  return result != null && result.isClean === false;
}

export function parseExtractedFacts(content, { maxFacts = 10, maxFactChars = 200 } = {}) {
  if (!content || !String(content).trim()) return [];
  const raw = coerceToList(String(content));
  const facts = [];
  const seen = new Set();
  for (const item of raw) {
    const fact = cleanFact(item, maxFactChars);
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

function coerceToList(content) {
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      // Fall through to line parsing, as the upstream extractor does.
    }
  }
  const items = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(trimmed.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""));
  }
  return items;
}

function cleanFact(item, maxFactChars) {
  let fact = String(item)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!fact || NON_FACTS.has(fact.toLowerCase())) return "";
  if (fact.length > maxFactChars) fact = fact.slice(0, maxFactChars).trimEnd();
  return fact;
}

export async function extractFacts(engine, { userText, assistantText, userId, sessionId }) {
  const user = String(userText ?? "").trim();
  if (!user) return [];
  let exchange = `User: ${user}`;
  const assistant = String(assistantText ?? "").trim();
  if (assistant) exchange += `\nAssistant: ${assistant}`;
  try {
    const result = await engine.generate(
      [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: exchange },
      ],
      {
        temperature: 0,
        maxTokens: 512,
        userId,
        caller: { kind: "event", id: sessionId ?? null, trigger: "memory_extract" },
      }
    );
    const content = result?.content ?? result?.text ?? "";
    return parseExtractedFacts(content);
  } catch {
    return [];
  }
}

export async function rememberExchange({
  facts,
  engine,
  userId,
  sessionId,
  userText,
  assistantText,
}) {
  try {
    if (blocksExchange(scanOrNull(`${userText ?? ""}\n${assistantText ?? ""}`))) {
      return { stored: 0, skipped: "injection" };
    }
    const extracted = await extractFacts(engine, { userText, assistantText, userId, sessionId });
    let stored = 0;
    for (const fact of extracted) {
      const trustTier = flagged(scanOrNull(fact)) ? "UNTRUSTED" : "AUTO";
      const row = await facts.write({
        userId,
        content: fact,
        trustTier,
        source: "auto",
      });
      if (row?.source === "identity") continue;
      if (trustTier === "UNTRUSTED" && trustedForRecall(row) && facts.setTrust) {
        await facts.setTrust({ userId, id: row.id, trustTier: "UNTRUSTED" });
      }
      stored += 1;
    }
    return { stored, skipped: null };
  } catch {
    return { stored: 0, skipped: "error" };
  }
}
