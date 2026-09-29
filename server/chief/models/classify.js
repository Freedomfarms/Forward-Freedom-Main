// CHIEF query classification — broad category used by routing policies.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/learning/routing/_utils.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - the code and math regexes, verbatim (note: deliberately narrower than
//     the complexity analyzer's — upstream keeps them separate)
//   - class order and thresholds: code → math → short (<50) → long (>500)
//     → general
//   - the class labels are the keys of the later LearnedRouterPolicy's
//     per-class model map, so they must not be renamed
// Documented adaptations: none.

const CODE_RE = /```|`[^`]+`|\bdef\s|\bclass\s|\bimport\s|\bfunction\s/i;
const MATH_RE = /\bsolve\b|\bintegral\b|\bequation\b|\bcalculate\b|\bcompute\b/i;

export const QueryClass = Object.freeze({
  CODE: "code",
  MATH: "math",
  SHORT: "short",
  LONG: "long",
  GENERAL: "general",
});

export function classifyQuery(query) {
  if (typeof query !== "string") {
    throw new TypeError("classifyQuery expects a string query");
  }
  if (CODE_RE.test(query)) return QueryClass.CODE;
  if (MATH_RE.test(query)) return QueryClass.MATH;
  if (query.length < 50) return QueryClass.SHORT;
  if (query.length > 500) return QueryClass.LONG;
  return QueryClass.GENERAL;
}
