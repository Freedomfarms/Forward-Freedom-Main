// Reciprocal rank fusion for CHIEF fact recall.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/tools/storage/hybrid.py (reciprocal_rank_fusion)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Preserved: RRF_score(d) = sum(weight_i / (k + rank_i(d))), k = 60, equal
// weights, fused score descending, identity is the document content.
// Not ported: HybridMemory. It stores every document in a sparse backend and
// a dense backend. CHIEF facts are encrypted, so Postgres cannot rank them,
// and there is no embedding index. rankFacts points this function at a
// keyword ranking and a recency ranking of the same fact list.

export function reciprocalRankFusion(rankedLists, { k = 60, weights = null } = {}) {
  const lists = rankedLists ?? [];
  const listWeights = weights ?? lists.map(() => 1);
  const scores = new Map();
  const best = new Map();
  lists.forEach((results, listIndex) => {
    const weight = listWeights[listIndex] ?? 1;
    results.forEach((result, rank) => {
      const key = result.content;
      scores.set(key, (scores.get(key) ?? 0) + weight / (k + rank + 1));
      if (!best.has(key)) best.set(key, result);
    });
  });
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, score]) => {
      const original = best.get(key);
      return {
        content: original.content,
        score,
        source: original.source ?? "",
        metadata: original.metadata ?? {},
      };
    });
}

function factContent(fact) {
  return String(fact?.content ?? fact?.text ?? "");
}

function asResult(fact) {
  return {
    content: factContent(fact),
    score: 0,
    source: fact.source ?? "",
    metadata: { trust: String(fact.trustTier ?? fact.trust ?? "").toLowerCase(), fact },
  };
}

export function keywordRank(query, facts) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);
  return facts
    .map((fact) => {
      const haystack = factContent(fact).toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { fact, score };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((row) => row.fact);
}

export function recencyRank(facts) {
  return [...facts].sort(
    (left, right) => new Date(right.createdAt ?? 0) - new Date(left.createdAt ?? 0)
  );
}

export function rankFacts(query, facts, { k = 60 } = {}) {
  const fused = reciprocalRankFusion(
    [keywordRank(query, facts).map(asResult), recencyRank(facts).map(asResult)],
    { k }
  );
  return fused.map((result) => result.metadata.fact);
}
