// ─────────────────────────────────────────────────────────────────────────────
// CEO Brain efficiency metrics — measure how quickly ambiguity becomes execution.
// Tracks questions-until-execution, unnecessary/re-ask rates, and completion.
// Kept separate from ceoReasoning.js to avoid circular imports.
// ─────────────────────────────────────────────────────────────────────────────

const PREFERENCE_RE = /personality|tone|voice|style|escalat|boundar|permission/i;
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "or",
  "and",
  "for",
  "in",
  "on",
  "is",
  "are",
  "what",
  "which",
  "who",
  "how",
  "about",
  "me",
  "my",
  "your",
]);

/** Acceptance ceilings by mission complexity. */
export const EFFICIENCY_TARGETS = {
  simple: { maxQuestions: 2, requireBlockingOnly: false },
  medium: { maxQuestions: 5, requireBlockingOnly: false },
  /** Complex: no arbitrary question cap; every question must resolve a blocker. */
  complex: { maxQuestions: null, requireBlockingOnly: true },
};

/** Blank per-mission efficiency log (persisted on mission state). */
export function emptyEfficiencyLog() {
  return {
    missionStartedAt: null,
    missionExecutableAt: null,
    questionsAsked: [],
    blockingGapsResolved: [],
    deferredPreferences: [],
    reaskedFields: [],
  };
}

export function cloneEfficiencyLog(log = null) {
  const src = log && typeof log === "object" ? log : emptyEfficiencyLog();
  return {
    missionStartedAt: src.missionStartedAt ?? null,
    missionExecutableAt: src.missionExecutableAt ?? null,
    questionsAsked: Array.isArray(src.questionsAsked)
      ? src.questionsAsked.map((row) => ({ ...row, reasons: [...(row.reasons || [])] }))
      : [],
    blockingGapsResolved: [...(src.blockingGapsResolved || [])],
    deferredPreferences: [...(src.deferredPreferences || [])],
    reaskedFields: [...(src.reaskedFields || [])],
  };
}

/**
 * Classify whether a clarification question is unnecessary.
 * Unnecessary if: already known, does not block execution, or deferrable preference.
 */
export function classifyQuestionNecessity(question, state = {}) {
  const q = String(question || "").trim();
  const reasons = [];
  if (!q) return { unnecessary: false, reasons };

  if (state.missionExecutable) {
    reasons.push("does_not_block_execution");
  }

  if (informationAlreadyKnown(q, state)) {
    reasons.push("information_already_known");
  }

  if (PREFERENCE_RE.test(q)) {
    reasons.push("deferrable_preference");
  }

  if (!state.missionExecutable && !questionBlocksExecution(q, state)) {
    reasons.push("does_not_block_execution");
  }

  return { unnecessary: reasons.length > 0, reasons: uniqueStrings(reasons) };
}

/** True when the question asks for a fact already in known / changedFacts. */
export function informationAlreadyKnown(question, state = {}) {
  const facts = [...(state.known || []), ...(state.changedFacts || [])];
  if (!facts.length) return false;
  return facts.some((fact) => factAnswersQuestion(question, fact));
}

/**
 * A question blocks execution when it targets a remaining missing gap
 * (especially a top-ranked dependency).
 */
export function questionBlocksExecution(question, state = {}) {
  const missing = Array.isArray(state.missing) ? state.missing : [];
  if (!missing.length) return false;
  return missing.some((gap) => questionOverlapsFact(question, gap));
}

/** Detect re-asking a field already captured (or already asked). */
export function detectReaskField(question, state = {}, priorQuestions = []) {
  if (informationAlreadyKnown(question, state)) {
    return fieldKeyFromQuestion(question);
  }
  const qNorm = normalizeText(question);
  for (const prior of priorQuestions || []) {
    const priorQ = typeof prior === "string" ? prior : prior?.question;
    if (!priorQ) continue;
    if (normalizeText(priorQ) === qNorm || questionOverlapsFact(question, priorQ)) {
      return fieldKeyFromQuestion(question);
    }
  }
  return null;
}

/**
 * Fold one mission-state transition into the efficiency log.
 * @param {object} log
 * @param {{ prior?: object, next: object, now?: string|(() => string) }} args
 */
export function updateEfficiencyLog(log, { prior = null, next, now } = {}) {
  const out = cloneEfficiencyLog(log);
  const ts = resolveNow(now);

  if (!out.missionStartedAt && next?.mission) {
    out.missionStartedAt = ts;
  }

  // Gaps cleared this turn
  for (const gap of prior?.missing || []) {
    const stillOpen = (next?.missing || []).some((g) => normalizeText(g) === normalizeText(gap));
    if (stillOpen) continue;
    if (!out.blockingGapsResolved.some((g) => normalizeText(g) === normalizeText(gap))) {
      out.blockingGapsResolved.push(gap);
    }
  }

  // Standing / captured preferences that were not asked as the blocker
  for (const pref of next?.preferences || []) {
    if (!pref) continue;
    if (questionOverlapsFact(next?.selectedQuestion, pref)) continue;
    if (!out.deferredPreferences.some((p) => normalizeText(p) === normalizeText(pref))) {
      out.deferredPreferences.push(pref);
    }
  }

  // Preference-style gaps dropped from missing without being selected
  for (const gap of prior?.missing || []) {
    if (!PREFERENCE_RE.test(gap)) continue;
    const stillOpen = (next?.missing || []).some((g) => normalizeText(g) === normalizeText(gap));
    if (stillOpen) continue;
    if (!out.deferredPreferences.some((p) => normalizeText(p) === normalizeText(gap))) {
      out.deferredPreferences.push(gap);
    }
  }

  if (next?.selectedQuestion && !next.missionExecutable) {
    const classification = classifyQuestionNecessity(next.selectedQuestion, {
      known: next.known || [],
      changedFacts: next.changedFacts || [],
      missing: next.missing || [],
      missionExecutable: next.missionExecutable,
    });
    const reaskField = detectReaskField(
      next.selectedQuestion,
      { known: next.known || [], changedFacts: next.changedFacts || [] },
      out.questionsAsked
    );
    const reasons = [...classification.reasons];
    if (reaskField) reasons.push("reask");

    out.questionsAsked.push({
      question: next.selectedQuestion,
      at: ts,
      unnecessary: classification.unnecessary || Boolean(reaskField),
      reasons: uniqueStrings(reasons),
    });

    if (reaskField && !out.reaskedFields.some((f) => normalizeText(f) === normalizeText(reaskField))) {
      out.reaskedFields.push(reaskField);
    }
  }

  if (!out.missionExecutableAt && next?.missionExecutable) {
    out.missionExecutableAt = ts;
  }

  return out;
}

/**
 * Derived rates for one mission conversation.
 * questionsUntilExecution = clarification questions before missionExecutable=true.
 */
export function computeEfficiencyMetrics(log = emptyEfficiencyLog()) {
  const questions = Array.isArray(log.questionsAsked) ? log.questionsAsked : [];
  const completed = Boolean(log.missionExecutableAt);
  // When completed, all recorded questions precede executable (we stop asking).
  const questionsUntilExecution = completed ? questions.length : null;
  const unnecessaryCount = questions.filter((q) => q.unnecessary).length;
  const reaskCount = Array.isArray(log.reaskedFields) ? log.reaskedFields.length : 0;
  const asked = questions.length;

  return {
    questionsUntilExecution,
    unnecessaryQuestionCount: unnecessaryCount,
    unnecessaryQuestionRate: asked ? unnecessaryCount / asked : 0,
    reaskCount,
    reaskRate: asked ? reaskCount / asked : 0,
    missionCompleted: completed,
    /** Single-mission completion (0 or 1); aggregate via summarizeMissionCompletion. */
    missionCompletionRate: completed ? 1 : 0,
    questionsAsked: asked,
    blockingGapsResolved: (log.blockingGapsResolved || []).length,
    deferredPreferences: (log.deferredPreferences || []).length,
    reaskedFields: [...(log.reaskedFields || [])],
    missionStartedAt: log.missionStartedAt ?? null,
    missionExecutableAt: log.missionExecutableAt ?? null,
  };
}

/** Percentage of conversations that reached an executable mission state. */
export function summarizeMissionCompletion(logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  const total = list.length;
  const completed = list.filter((log) => Boolean(log?.missionExecutableAt)).length;
  return {
    missions: total,
    completed,
    missionCompletionRate: total ? completed / total : 0,
  };
}

/**
 * Evaluate acceptance targets for simple / medium / complex missions.
 * @param {"simple"|"medium"|"complex"} complexity
 */
export function evaluateEfficiencyTarget(complexity, metrics, log = null) {
  const target = EFFICIENCY_TARGETS[complexity];
  if (!target) {
    return { ok: false, failures: [`unknown complexity: ${complexity}`], target: null };
  }
  const failures = [];
  const questions =
    metrics?.questionsUntilExecution != null
      ? metrics.questionsUntilExecution
      : metrics?.questionsAsked ?? 0;

  if (target.maxQuestions != null) {
    if (!metrics?.missionCompleted) {
      failures.push(
        `mission not executable (target ${complexity}: <= ${target.maxQuestions} questions to execution)`
      );
    } else if (questions > target.maxQuestions) {
      failures.push(
        `questionsUntilExecution=${questions} exceeds ${complexity} max of ${target.maxQuestions}`
      );
    }
  }

  if (target.requireBlockingOnly) {
    const rate = Number(metrics?.unnecessaryQuestionRate || 0);
    if (rate > 0) {
      failures.push(
        `complex mission has unnecessaryQuestionRate=${rate}; every question must resolve a blocking dependency`
      );
    }
    if ((metrics?.reaskCount || 0) > 0 || (log?.reaskedFields || []).length > 0) {
      failures.push("complex mission re-asked already captured fields");
    }
  }

  return { ok: failures.length === 0, failures, target };
}

export function isCeoEfficiencyDebugEnabled() {
  const raw = String(process.env.FREEDOM_OS_DEBUG_CEO || "").trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  return process.env.NODE_ENV !== "production";
}

/** Dev-only `[ceo-efficiency]` log of tracking fields + derived rates. */
export function logCeoEfficiency(logOrState = {}) {
  if (!isCeoEfficiencyDebugEnabled()) return;
  const log = logOrState.efficiency || logOrState;
  const metrics = computeEfficiencyMetrics(log);
  const lines = [
    "missionStartedAt: " + (log.missionStartedAt || "(none)"),
    "missionExecutableAt: " + (log.missionExecutableAt || "(none)"),
    "questionsAsked: " + formatQuestions(log.questionsAsked),
    "blockingGapsResolved: " + formatList(log.blockingGapsResolved),
    "deferredPreferences: " + formatList(log.deferredPreferences),
    "reaskedFields: " + formatList(log.reaskedFields),
    "questionsUntilExecution: " + String(metrics.questionsUntilExecution ?? "(n/a)"),
    "unnecessaryQuestionRate: " + metrics.unnecessaryQuestionRate.toFixed(2),
    "reaskRate: " + metrics.reaskRate.toFixed(2),
    "missionCompletionRate: " + metrics.missionCompletionRate.toFixed(2),
  ];
  console.info(`[ceo-efficiency]\n${lines.join("\n")}`);
}

function formatList(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items.map((item) => String(item)).join("; ");
}

function formatQuestions(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items
    .map((row) => {
      if (!row || typeof row !== "object") return String(row);
      const flags = row.unnecessary ? " unnecessary" : "";
      return `${row.question || "?"}${flags}`;
    })
    .join("; ");
}

function resolveNow(now) {
  if (typeof now === "function") return now();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item || "").trim();
    if (!key) continue;
    const norm = key.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(key);
  }
  return out;
}

function fieldKeyFromQuestion(question) {
  const q = normalizeText(question);
  if (/supplier/.test(q)) return "suppliers";
  if (/competitor|industry/.test(q)) return "competitors";
  if (/people|who to monitor|whom/.test(q)) return "people";
  if (/platform/.test(q)) return "platforms";
  if (/account|ticker|portfolio/.test(q)) return "portfolio_scope";
  if (/deliver|email|channel|teams|slack/.test(q)) return "delivery";
  if (/frequenc|schedule|cadence/.test(q)) return "schedule";
  if (/outcome|definition of done/.test(q)) return "outcome";
  if (/risk signal/.test(q)) return "risk_signals";
  if (/what to watch/.test(q)) return "watch_signals";
  return q.slice(0, 48) || "unknown";
}

/** Loose overlap — used for gap↔question matching (blocking). */
function questionOverlapsFact(question, fact) {
  const q = normalizeText(question);
  const f = normalizeText(fact);
  if (!q || !f) return false;
  const qCore = q.replace(/^what about\s+/, "").replace(/\?$/, "").trim();
  if (q.includes(f) || f.includes(qCore) || qCore.includes(f)) return true;
  const qTokens = significantTokens(q);
  const fTokens = significantTokens(f);
  if (!qTokens.length || !fTokens.length) return false;
  const overlap = qTokens.filter((t) => fTokens.includes(t));
  return overlap.length >= 2;
}

/**
 * Stricter: known facts only count as answering a question when they capture
 * the requested field (entity lists, delivery, cadence) — not mere domain labels.
 */
function factAnswersQuestion(question, fact) {
  const rawFact = String(fact || "").trim();
  const q = normalizeText(question);
  const f = normalizeText(rawFact);
  if (!q || !f) return false;
  // "Domain: supplier risk" does not answer "which suppliers?"
  if (/^domain\b/i.test(rawFact) || /^domain\b/.test(f)) return false;
  if (/^risk focus mentioned$|^signal focus mentioned$|^schedule mentioned/.test(f)) {
    return false;
  }

  // Structured captures use "Field: value" in mission known[] (colon checked on raw).
  if (/^(suppliers?|people|competitors?|platforms?|accounts?|tickers?)\s*:/i.test(rawFact)) {
    if (/\bsuppliers?\b/.test(q) && /\bsuppliers?\b/i.test(rawFact)) return true;
    if (/\bpeople\b/.test(q) && /\bpeople\b/i.test(rawFact)) return true;
    if (/\bplatforms?\b/.test(q) && /\bplatforms?\b/i.test(rawFact)) return true;
    if (/\bcompetitors?\b/.test(q) && /\bcompetitors?\b/i.test(rawFact)) return true;
    if (/\b(accounts?|tickers?|portfolio)\b/.test(q) && /\b(accounts?|tickers?)\b/i.test(rawFact)) {
      return true;
    }
  }

  if (
    /\b(deliver by email|deliver via|deliver reports)\b/i.test(rawFact) &&
    /\b(deliver|email|channel|teams|slack)\b/.test(q)
  ) {
    return true;
  }
  if (/^cadence:/i.test(rawFact) && /\b(frequenc|schedule|cadence)\b/.test(q)) return true;

  // Exact / near-exact restatement of a known gap answer
  const qCore = q.replace(/^what about\s+/, "").replace(/\?$/, "").trim();
  if (f === qCore || (f.includes(qCore) && qCore.length >= 12)) return true;

  return false;
}

function significantTokens(text) {
  return normalizeText(text)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}
