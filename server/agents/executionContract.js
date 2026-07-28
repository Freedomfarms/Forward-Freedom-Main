// ─────────────────────────────────────────────────────────────────────────────
// Agent Execution Contract — shared by CEO Brain and every sub-agent.
//
// Infrastructure (not prompt-only):
//   1) Classify user request (intent ≠ execution)
//   2) Collect execution evidence from this turn / records
//   3) Guard final reply — strip unsupported outcome claims
//
// CEO remains authority for Plans. Sub-agents may reason + execute approved
// tools and return evidence; they cannot invent outcomes.
// ─────────────────────────────────────────────────────────────────────────────

import { isCeoObservabilityEnabled } from "../brain/observability.js";
import {
  groundedOwnershipReply,
  isCreationLikeIntent,
  isModificationIntent,
} from "../brain/worldModelOwnership.js";

export const AGENT_REQUEST_KINDS = Object.freeze({
  INFORMATION_REQUEST: "information_request",
  ACTION_REQUEST: "action_request",
  STATUS_QUESTION: "status_question",
  CLARIFICATION_NEEDED: "clarification_needed",
});

/** Outcome verbs that require execution evidence when claimed as done. */
export const EVIDENCE_GATED_OUTCOMES = Object.freeze([
  "emailed",
  "created",
  "scheduled",
  "completed",
  "submitted",
  "connected",
]);

const STATUS_CUE_RE =
  /\b(did you|have you|has (?:it|that|the)|was (?:it|that|the|there)|were you|did it|has it been|was there)\b/i;

const ACTION_IMPERATIVE_RE =
  /\b(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+)?(?:email|e-?mail|send|run|create|build|schedule|submit|connect|enable|disable|pause|resume|update|delete)\b/i;

const OUTCOME_CLAIM_PATTERNS = Object.freeze({
  emailed: [
    /\b(?:i(?:'ve| have)?\s+)?e-?mailed\b/i,
    /\b(?:i(?:'ve| have)?\s+)?sent\s+(?:that|the|this|your|an?\s+)?(?:report\s+)?e-?mail\b/i,
    /\be-?mail(?:ed)?\s+(?:that|the|this|your)\s+report\b/i,
    /\be-?mail\s+(?:has been|was)\s+sent\b/i,
    /\bsent\s+(?:it|that|the report)\s+to\s+your\b/i,
  ],
  created: [
    /\b(?:i(?:'ve| have)?\s+)?created\s+(?:the|your|a|an)\b/i,
    /\b(?:agent|monitor|watcher)\s+(?:is|was)\s+(?:created|set up)\b/i,
  ],
  scheduled: [
    /\b(?:i(?:'ve| have)?\s+)?scheduled\b/i,
    /\bschedule\s+(?:is|was)\s+set\b/i,
  ],
  completed: [
    /\b(?:successfully\s+)?completed\b/i,
    /\ball\s+set\b/i,
    /\byou(?:'re| are)\s+all\s+set\b/i,
  ],
  submitted: [/\b(?:i(?:'ve| have)?\s+)?submitted\b/i],
  connected: [
    /\b(?:i(?:'ve| have)?\s+)?connected\b/i,
    /\b(?:is|are)\s+now\s+connected\b/i,
  ],
});

/**
 * Classify a user message for the execution contract.
 * Status questions are never treated as action requests.
 */
export function classifyAgentRequest(message) {
  const text = String(message || "").trim();
  if (!text) return AGENT_REQUEST_KINDS.CLARIFICATION_NEEDED;

  const lower = text.toLowerCase();

  // "Did you email…?" / "Have you sent…?" — status, not a send request.
  if (STATUS_CUE_RE.test(text) && /\b(e-?mail|send|sent|run|ran|create|created|schedule|scheduled|complete|completed|submit|submitted|connect|connected)\b/i.test(text)) {
    return AGENT_REQUEST_KINDS.STATUS_QUESTION;
  }

  // Trailing status alternatives: "…or did you just run it?"
  if (/\bor\s+did\s+you\b/i.test(text) && /\b(run|email|send|create)\b/i.test(text)) {
    return AGENT_REQUEST_KINDS.STATUS_QUESTION;
  }

  // Information questions before action detection — "what did the last run find?"
  // contains the noun "run" but is not an imperative.
  if (/\b(what|which|who|when|where|why|how)\b/i.test(lower)) {
    // Exception: clear agent-directed imperatives inside a question.
    if (!/\b(please|can you|could you|would you|go ahead and)\b/i.test(lower)) {
      return AGENT_REQUEST_KINDS.INFORMATION_REQUEST;
    }
  }

  if (ACTION_IMPERATIVE_RE.test(text)) {
    return AGENT_REQUEST_KINDS.ACTION_REQUEST;
  }

  if (/\b(yes|no|ok|okay|sure|confirm|go ahead)\b/i.test(lower) && text.length < 40) {
    return AGENT_REQUEST_KINDS.CLARIFICATION_NEEDED;
  }

  return AGENT_REQUEST_KINDS.INFORMATION_REQUEST;
}

/**
 * Mutating task/tool actions are blocked for status / pure information asks.
 */
export function isMutatingActionAllowed(requestKind, actionType = null) {
  if (
    requestKind === AGENT_REQUEST_KINDS.STATUS_QUESTION ||
    requestKind === AGENT_REQUEST_KINDS.INFORMATION_REQUEST
  ) {
    return false;
  }
  if (requestKind === AGENT_REQUEST_KINDS.CLARIFICATION_NEEDED && !actionType) {
    return false;
  }
  return true;
}

/**
 * Build evidence bag from this-turn outcomes + known execution records.
 * Historical run summaries may answer status questions; they do NOT authorize
 * first-person "I just emailed" claims unless thisTurn.emailSent is true.
 */
export function buildExecutionEvidence({
  actionResult = null,
  taskActionType = null,
  turnState = null,
  relatedRun = null,
  recentRuns = [],
  emailDeliveryEnabled = false,
} = {}) {
  const thisTurn = {
    emailSent: false,
    emailFailed: false,
    emailStatus: null,
    runTriggered: false,
    runSucceeded: false,
    runFailed: false,
    runSummary: null,
    agentCreated: false,
    agentUpdated: false,
    scheduleChanged: false,
    confirmations: [],
  };

  if (actionResult) {
    if (taskActionType === "email_report") {
      if (actionResult.sent === true) {
        thisTurn.emailSent = true;
        thisTurn.emailStatus = actionResult.emailStatus || "email sent";
      } else if (actionResult.sent === false) {
        thisTurn.emailFailed = true;
        thisTurn.emailStatus = actionResult.emailStatus || actionResult.reply || "email failed";
      } else if (/i(?:'ve| have)? emailed/i.test(actionResult.reply || "")) {
        thisTurn.emailSent = true;
        thisTurn.emailStatus = "email sent";
      } else if (/couldn'?t email|email skipped|unverified/i.test(actionResult.reply || "")) {
        thisTurn.emailFailed = true;
        thisTurn.emailStatus = actionResult.reply;
      }
    }
    if (taskActionType === "run_now" && actionResult.run) {
      thisTurn.runTriggered = true;
      thisTurn.runSucceeded = actionResult.run.status === "SUCCEEDED";
      thisTurn.runFailed = actionResult.run.status === "FAILED";
      thisTurn.runSummary = actionResult.run.summary || null;
      const summary = String(actionResult.run.summary || "");
      if (/\(email sent/i.test(summary)) {
        thisTurn.emailSent = true;
        thisTurn.emailStatus = summary;
      } else if (/\(email skipped|email delivery/i.test(summary)) {
        thisTurn.emailFailed = true;
        thisTurn.emailStatus = summary;
      }
    }
    if (taskActionType === "update_config") {
      thisTurn.agentUpdated = true;
      if (/schedule/i.test(actionResult.reply || "")) thisTurn.scheduleChanged = true;
    }
  }

  if (turnState) {
    if (turnState.run?.id) {
      thisTurn.runTriggered = true;
      thisTurn.runSucceeded = !turnState.run.status || turnState.run.status === "SUCCEEDED";
      thisTurn.runFailed = turnState.run.status === "FAILED";
      thisTurn.runSummary = turnState.run.summary || null;
    }
    if (turnState.agent?.id) thisTurn.agentCreated = true;
    if (Array.isArray(turnState.confirmations)) {
      thisTurn.confirmations = turnState.confirmations.map(String);
      for (const line of thisTurn.confirmations) {
        if (/e-?mail(?:ed)?|email delivery enabled/i.test(line) && /sent|enabled/i.test(line)) {
          // Config enable ≠ send; only treat as emailSent when wording claims send.
          if (/\bsent\b/i.test(line) || /i(?:'ve| have)? emailed/i.test(line)) {
            thisTurn.emailSent = true;
            thisTurn.emailStatus = line;
          }
        }
        if (/\bschedule\b/i.test(line)) thisTurn.scheduleChanged = true;
      }
    }
  }

  const historical = {
    relatedRunEmailSent: runSummaryShowsEmailSent(relatedRun?.summary),
    relatedRunEmailSkipped: runSummaryShowsEmailSkipped(relatedRun?.summary),
    relatedRunStatus: relatedRun?.status || null,
    relatedRunSummary: relatedRun?.summary || null,
    latestRunEmailSent: false,
    latestRunSummary: null,
  };

  const latest = Array.isArray(recentRuns) && recentRuns.length ? recentRuns[0] : null;
  if (latest) {
    historical.latestRunSummary = latest.summary || null;
    historical.latestRunEmailSent = runSummaryShowsEmailSent(latest.summary);
  }

  return {
    thisTurn,
    historical,
    emailDeliveryEnabled: emailDeliveryEnabled === true,
    // Flags for claim checks
    canClaimEmailed: thisTurn.emailSent === true,
    canClaimCreated: thisTurn.agentCreated === true,
    canClaimScheduled: thisTurn.scheduleChanged === true,
    canClaimCompleted:
      thisTurn.emailSent ||
      thisTurn.runSucceeded ||
      thisTurn.agentCreated ||
      thisTurn.scheduleChanged ||
      thisTurn.confirmations.length > 0,
    canClaimConnected: false, // never from chat alone without registry evidence
  };
}

function runSummaryShowsEmailSent(summary) {
  return /\(email sent/i.test(String(summary || ""));
}

function runSummaryShowsEmailSkipped(summary) {
  return /\(email skipped|email delivery/i.test(String(summary || ""));
}

export function detectOutcomeClaims(reply) {
  const text = String(reply || "");
  const claimed = [];
  for (const outcome of EVIDENCE_GATED_OUTCOMES) {
    const patterns = OUTCOME_CLAIM_PATTERNS[outcome] || [];
    if (patterns.some((re) => re.test(text))) claimed.push(outcome);
  }
  // Bare "Done —" with email-ish context
  if (/\bdone\b/i.test(text) && /\be-?mail/i.test(text) && !claimed.includes("emailed")) {
    claimed.push("emailed");
  }
  if (/\bdone\b/i.test(text) && !claimed.includes("completed")) {
    // Only gate bare Done when paired with an outcome verb, not ordinary prose.
    if (/\b(created|scheduled|submitted|connected|ran|emailed|sent)\b/i.test(text)) {
      claimed.push("completed");
    }
  }
  return claimed;
}

/**
 * Validate reply against evidence. Returns { ok, failures, claimed }.
 */
export function validateExecutionClaims(reply, evidence, { requestKind = null } = {}) {
  const claimed = detectOutcomeClaims(reply);
  const failures = [];

  for (const outcome of claimed) {
    if (outcome === "emailed" && !evidence?.canClaimEmailed) {
      // Status answers may cite historical evidence without this-turn send.
      if (
        requestKind === AGENT_REQUEST_KINDS.STATUS_QUESTION &&
        (evidence?.historical?.relatedRunEmailSent || evidence?.historical?.latestRunEmailSent)
      ) {
        continue;
      }
      failures.push("unsupported_claim:emailed");
    }
    if (outcome === "created" && !evidence?.canClaimCreated) {
      failures.push("unsupported_claim:created");
    }
    if (outcome === "scheduled" && !evidence?.canClaimScheduled) {
      failures.push("unsupported_claim:scheduled");
    }
    if (outcome === "completed" && !evidence?.canClaimCompleted) {
      failures.push("unsupported_claim:completed");
    }
    if (outcome === "submitted" && !evidence?.thisTurn?.confirmations?.length) {
      failures.push("unsupported_claim:submitted");
    }
    if (outcome === "connected" && !evidence?.canClaimConnected) {
      failures.push("unsupported_claim:connected");
    }
  }

  // Status question answered as if an action just happened ("Done — I've emailed")
  if (
    requestKind === AGENT_REQUEST_KINDS.STATUS_QUESTION &&
    /\bdone\b/i.test(reply || "") &&
    /\be-?mail/i.test(reply || "") &&
    !evidence?.canClaimEmailed
  ) {
    if (!failures.includes("unsupported_claim:emailed")) {
      failures.push("unsupported_claim:emailed");
    }
  }

  return { ok: failures.length === 0, failures, claimed };
}

/**
 * Rewrite unsupported claims into a truthful status response.
 *
 * Ownership invariant: create/update intents must never be answered from
 * generic recentRuns. Historical runs are status/context only.
 */
export function groundedExecutionReply(
  evidence,
  {
    requestKind = null,
    failures = [],
    intent = null,
    userMessage = "",
    worldModelFacts = null,
    capabilityAssessment = null,
    draftReply = "",
  } = {}
) {
  const bits = [];
  const tt = evidence?.thisTurn || {};
  const hist = evidence?.historical || {};
  const creationLike = isCreationLikeIntent(intent, userMessage);
  const modificationLike = isModificationIntent(intent);

  // Create / update: Registry ownership path — never "completed run on record".
  if ((creationLike || modificationLike) && !tt.agentCreated) {
    return groundedOwnershipReply({
      facts: worldModelFacts,
      userMessage,
      failures: ["creation_answered_with_run_history"],
      capabilityAssessment,
      draftReply,
    });
  }

  if (tt.runTriggered) {
    if (tt.runFailed) {
      bits.push(`I ran, but the run failed${tt.runSummary ? `: ${tt.runSummary}` : "."}`);
    } else if (tt.runSucceeded) {
      bits.push("I ran the report.");
    } else {
      bits.push("A run was triggered.");
    }
  } else if (
    requestKind === AGENT_REQUEST_KINDS.STATUS_QUESTION &&
    (hist.relatedRunStatus === "SUCCEEDED" || hist.latestRunSummary)
  ) {
    // Status questions may cite Run History. Action/create intents must not.
    bits.push("I have a completed run on record.");
  }

  if (failures.includes("unsupported_claim:emailed") || requestKind === AGENT_REQUEST_KINDS.STATUS_QUESTION) {
    if (tt.emailSent) {
      bits.push(
        `Email delivery completed${tt.emailStatus ? ` (${tt.emailStatus})` : "."}`
      );
    } else if (hist.relatedRunEmailSent || hist.latestRunEmailSent) {
      bits.push("The run summary shows an email was sent for that report.");
    } else if (tt.emailFailed) {
      bits.push(
        `I do not have evidence of a successful email send (${tt.emailStatus || "failed or skipped"}).`
      );
    } else {
      bits.push("I do not have evidence that an email was sent.");
    }
  }

  if (failures.includes("unsupported_claim:created") && !tt.agentCreated) {
    bits.push("I do not have evidence that a new agent was created in this turn.");
  }
  if (failures.includes("unsupported_claim:scheduled") && !tt.scheduleChanged) {
    bits.push("I do not have evidence that a schedule change was applied.");
  }
  if (failures.includes("unsupported_claim:connected")) {
    bits.push("I cannot claim a connector is connected without validated system state.");
  }

  if (!bits.length) {
    return "I can only confirm outcomes that are backed by execution records or tool results. I do not have evidence for that claim.";
  }
  return bits.join(" ");
}

/**
 * Guard a final agent reply. Pure function — call before persist.
 */
export function guardAgentReply({
  reply,
  userMessage,
  evidence = null,
  requestKind = null,
  intent = null,
  worldModelFacts = null,
  capabilityAssessment = null,
} = {}) {
  const kind = requestKind || classifyAgentRequest(userMessage);
  const bag = evidence || buildExecutionEvidence({});
  const check = validateExecutionClaims(reply, bag, { requestKind: kind });

  if (check.ok) {
    return {
      ok: true,
      rewritten: false,
      reply: String(reply || "").trim(),
      requestKind: kind,
      failures: [],
      claimed: check.claimed,
    };
  }

  const rewritten = groundedExecutionReply(bag, {
    requestKind: kind,
    failures: check.failures,
    intent,
    userMessage,
    worldModelFacts,
    capabilityAssessment,
    draftReply: reply,
  });

  logExecutionGuard({
    event: "reply_guard_rewrote",
    requestKind: kind,
    failures: check.failures,
    claimed: check.claimed,
    intent: intent || null,
  });

  return {
    ok: false,
    rewritten: true,
    reply: rewritten,
    requestKind: kind,
    failures: check.failures,
    claimed: check.claimed,
  };
}

/**
 * Data section lines for prompts — structured context, not soft instructions.
 */
export function renderRequestClassificationSection(requestKind) {
  const kind = requestKind || AGENT_REQUEST_KINDS.INFORMATION_REQUEST;
  const lines = [
    `kind: ${kind}`,
    "intent_is_not_execution: true",
  ];
  if (kind === AGENT_REQUEST_KINDS.STATUS_QUESTION) {
    lines.push(
      "rule: Answer from existing execution records only. Do not perform new actions. Do not claim emailed/created/scheduled/completed without evidence."
    );
  } else if (kind === AGENT_REQUEST_KINDS.INFORMATION_REQUEST) {
    lines.push("rule: Answer the question. Do not create side effects unless the user clearly asks for an action.");
  } else if (kind === AGENT_REQUEST_KINDS.ACTION_REQUEST) {
    lines.push("rule: Perform only allowlisted tools/taskActions. Claim outcomes only from tool/execution results.");
  } else {
    lines.push("rule: Clarify before mutating state.");
  }
  return lines.join("\n");
}

export function renderSubAgentAuthoritySection() {
  return [
    "ceo_is_authority: true",
    "can_perform_domain_reasoning: yes",
    "can_execute_approved_tools: yes",
    "can_return_evidence: yes",
    "can_create_plans: no",
    "can_invent_capabilities: no",
    "can_override_unavailable_capabilities: no",
    "can_claim_outcomes_without_proof: no",
  ].join("\n");
}

export function logExecutionGuard(event = {}) {
  if (!isCeoObservabilityEnabled()) return;
  console.info(
    `[agent-execution-contract] ${JSON.stringify({
      phase: "execution_contract",
      event: event.event || "guard",
      requestKind: event.requestKind || null,
      failures: event.failures || [],
      claimed: event.claimed || [],
      actionBlocked: event.actionBlocked === true,
    })}`
  );
}
