// CHIEF taint tracking — information-flow labels for tool chains.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/security/taint.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Preserved: TaintLabel values, SINK_POLICY entries, check_taint,
// auto_detect regexes, union/propagate.
// Adaptations:
//   - Session taint is a list of label strings on the checkpoint, not an
//     in-process lock. A serverless resume must see the same labels.
//   - Arguments are auto-detected and unioned before the sink check. Upstream
//     only consulted an explicit `_taint` object plus session labels, so the
//     first outbound call carrying a secret was not caught.
//   - `mcp_invoke` is a CHIEF outbound sink (PII and SECRET), same rule as
//     upstream `http_request`. `schedule_create` forbids SECRET because the
//     payload is durable and a later tick would replay it.
//   - Upstream tool names stay in the policy so a future tool with that name
//     is covered. CHIEF does not register code-execution tools.

export const TaintLabel = Object.freeze({
  PII: "pii",
  SECRET: "secret",
  USER_PRIVATE: "user_private",
  EXTERNAL: "external",
});

const LABEL_VALUES = new Set(Object.values(TaintLabel));

export const SINK_POLICY = Object.freeze({
  web_search: new Set([TaintLabel.PII, TaintLabel.SECRET]),
  http_request: new Set([TaintLabel.PII, TaintLabel.SECRET]),
  channel_send: new Set([TaintLabel.SECRET]),
  channel_tools: new Set([TaintLabel.SECRET]),
  code_interpreter: new Set([TaintLabel.SECRET]),
  file_write: new Set([TaintLabel.SECRET]),
  mcp_invoke: new Set([TaintLabel.PII, TaintLabel.SECRET]),
  schedule_create: new Set([TaintLabel.SECRET]),
});

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\+?1?\s*\(?[2-9]\d{2}\)?\s*[-.\s]?\d{3}\s*[-.\s]?\d{4}\b/,
];

const SECRET_PATTERNS = [
  /(?:sk|pk|api)[_-][a-zA-Z0-9]{20,}/,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  /(?:bearer|token|password|secret|key)\s*[=:]\s*\S{8,}/i,
];

export function normalizeTaint(labels) {
  const set = new Set();
  for (const label of labels ?? []) {
    if (LABEL_VALUES.has(label)) set.add(label);
  }
  return [...set].sort();
}

export function unionTaint(left, right) {
  return normalizeTaint([...(left ?? []), ...(right ?? [])]);
}

export function autoDetectTaint(text) {
  const labels = [];
  const value = String(text ?? "");
  if (PII_PATTERNS.some((pattern) => pattern.test(value))) labels.push(TaintLabel.PII);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) labels.push(TaintLabel.SECRET);
  return normalizeTaint(labels);
}

export function checkTaint(toolName, labels) {
  const forbidden = SINK_POLICY[toolName];
  if (!forbidden) return null;
  const violations = normalizeTaint(labels).filter((label) => forbidden.has(label));
  if (violations.length === 0) return null;
  return `Data with labels [${violations.join(", ")}] cannot be sent to '${toolName}'.`;
}
