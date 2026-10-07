// How CHIEF talks. One contract for every model provider.
//
// This does not route tools, store memory, or start a turn. The context
// orchestrator still chooses sources. TurnMachine still calls the model.
// The contract tells that model to answer like one assistant. conversationMove
// only labels the latest utterance so a follow-up stays on the open thread
// and a reaction does not become a new task.

import { messageText } from "../runtime/compaction.js";
import { buildWorkingMemory, isAnaphoric } from "../memory/working.js";
import {
  answerFromWorkforce,
  correctWorkforceSentence,
  parseWorkforceFact,
} from "./workforceAnswer.js";
import { settleDelegation } from "./delegation.js";

export const MOVE = Object.freeze({
  ACKNOWLEDGE: "acknowledge",
  CONFIRM: "confirm",
  CONTINUE: "continue",
  DIRECT: "direct",
});

export const CHIEF_RESPONSE_CONTRACT = [
  "Response contract. This is how you behave on every model. GPT, Claude, and Grok are the same assistant.",
  "Understand the intent, resolve it, that, this, them, there, and what about from the working conversation, then do only the work the answer needs.",
  "Answer first. The user hears the result, not the plan. Do not narrate a search, a tool, a calculation, or your reasoning.",
  "A simple question is one to three spoken lines. A normal question is a few lines. A complicated question can use a short structure, still led by the answer.",
  "Do not restate the question, add a summary, or end with Would you like me to. Offer a next step only when the user is weighing a choice, such as what a different public estimate would do.",
  "A reaction such as thanks, great, that's crazy, or that's not bad gets a short human reply and nothing else. Match the tone. Do not force a joke, a catchphrase, or sir.",
  "Sound natural when read aloud. Say about $321K, not a labeled report line. Use the user's name only when it fits.",
  "Call the minimum tools. A holding needs the finance read. What that holding is worth also needs the current price. Equity needs the mortgage and the current home value. A past decision needs memory, not a live balance. Weather or other public facts need the web only when no closer tool exists. A reaction needs no tool.",
  "Memory is what was said or decided. Live readings are what is true now. For a current question, live data wins. If a live source is missing, say it is unavailable. Do not invent the figure.",
  "Workforce lines are observations from the named provider. Answer the question from those observations, and name the state that fits: current, completed, failed, attention, idle, stale, revoked, or unknown. A start is not a completion. Silence is not success. Stale or revoked is not current activity. A missing observation is unknown. Do not invent a tool, a code change, or a result. A bare denial does not replace an observed fact.",
  'If the work requires a repository change, a test-and-fix, or a deploy, report one line: DELEGATION {"effect":"change"|"deploy","objective":"what should be true","outcome":"what a later observation would show"}. Do not call a tool for that work. Explain, summarize, inspect, and other reads stay with you. A DELEGATION line is an intention, not execution. Do not say the work started, and do not hand an email or other send you can already perform to the workforce.',
  "Never say Certainly, Of course, Based on my records, According to the available information, or I'd be happy to. Do not mention the model, the orchestrator, or the prompt.",
].join(" ");

const REACTION =
  /^(?:thanks|thank you|ty|great|nice|cool|awesome|perfect|wow|damn|fuck|shit|hell yeah|not bad|that's not bad|that's crazy|that's good|that's great|got it|makes sense|sounds good|alright|all good|nice one|crazy|lol|lmao|haha|yeah that's (?:crazy|wild|a lot|huge|big)|never mind|nevermind|nvm|forget it|👍)[.!\s]*$/i;

const AGREEMENT =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|please do|check it|yeah check(?: it)?|pull it|do that|go for it)[.!\s]*$/i;

const EXPLICIT_CHECK = /\b(?:check it|look it up|pull it|go ahead and|do that|do it)\b/i;

const OFFER =
  /\b(?:want me to|should i|i can (?:pull|check|look|grab|get|search)|if needed|if you want)\b/i;

const PUBLIC_SOURCE = /\b(?:zillow|redfin|listing|estimate|look up|search the web|web)\b/i;

const ELLIPSIS =
  /^(?:what about|how about|and |what if|how much\b|why\b|what changed|what happened|the other one|is that|and the)\b/i;

const THREAD_FOLLOW =
  /^(?:should i be concerned|what(?:'s| is) changed(?: since)?|what changed since|anything new|is anything(?: currently)? stuck|which one needs(?: me)?|who needs(?: me)?|what don'?t we know|what do we not know)\b/i;

function spoken(text) {
  return String(text ?? "")
    .trim()
    .replace(/[!?.,]+$/g, "")
    .replace(/[,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastIndex(transcript, role) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === role) return index;
  }
  return -1;
}

function assistantBefore(transcript, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (transcript[cursor]?.role !== "assistant") continue;
    return messageText(transcript[cursor]).trim();
  }
  return "";
}

function priorUserTexts(transcript, latestIndex) {
  const texts = [];
  for (let index = latestIndex - 1; index >= 0 && texts.length < 6; index -= 1) {
    if (transcript[index]?.role !== "user") continue;
    const text = messageText(transcript[index]).trim();
    if (text) texts.push(text);
  }
  return texts;
}

export function conversationMove(transcript, query = null) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const latestIndex = lastIndex(messages, "user");
  const latest =
    query != null && String(query).trim()
      ? String(query).trim()
      : latestIndex >= 0
        ? messageText(messages[latestIndex]).trim()
        : "";
  const offered = latestIndex >= 0 ? assistantBefore(messages, latestIndex) : "";
  const memory = buildWorkingMemory(messages);
  const compact = spoken(latest);
  const agreement = AGREEMENT.test(compact);
  const offeredWork = OFFER.test(offered);
  const prior = priorUserTexts(messages, latestIndex);
  const explicitCheck = EXPLICIT_CHECK.test(compact);
  let kind = MOVE.DIRECT;
  if ((agreement && offeredWork) || explicitCheck) kind = MOVE.CONFIRM;
  else if (agreement || REACTION.test(compact)) kind = MOVE.ACKNOWLEDGE;
  else if (
    isAnaphoric(latest) ||
    ELLIPSIS.test(latest) ||
    (THREAD_FOLLOW.test(compact) && prior.length > 0)
  ) {
    kind = MOVE.CONTINUE;
  }
  const thread = [offered, ...prior].join("\n");
  return {
    kind,
    referent: memory.referent ?? null,
    priorUserTexts: prior,
    pullsPublicSource: kind === MOVE.CONFIRM && PUBLIC_SOURCE.test(thread),
  };
}

export function renderConversationMove(transcript, query = null) {
  const move = conversationMove(transcript, query);
  if (move.kind === MOVE.ACKNOWLEDGE) {
    return "The latest message is a reaction, not a new task. Answer in a few words, in the same tone. Do not call a tool. Do not offer more work.";
  }
  if (move.kind === MOVE.CONFIRM) {
    return "The user is confirming the check you just offered. Do that work with the necessary tool, then give the result. Do not describe the plan.";
  }
  if (move.kind === MOVE.CONTINUE) {
    const referent = move.referent ? ` ${move.referent} is the active referent.` : "";
    return `This continues the same conversation.${referent} Resolve it, that, this, them, there, and what about from the working context before you answer.`;
  }
  return "";
}

const OFFER_LINE =
  /\b(?:would you like me to|do you want me to|want me to|i can also|let me know if you(?:'d| would) like|if you(?:'d| would) like|i(?:'d| would) be happy to)\b/i;

const REPORT_OPENING =
  /^(?:certainly|of course|absolutely)[!,.]?\s+|^(?:based on (?:my |the )?(?:analysis|records|information)|here(?:'s| is) (?:a |an )?(?:comprehensive |detailed |brief )?(?:analysis|summary|overview)|i can provide (?:an |a )?(?:analysis|summary|overview))\b[^.]{0,160}[.!]?\s*/i;

const STRUCTURED_ASK =
  /\b(?:review|analy[sz]e|analysis|explain|compare|break down|walk me through|what needs|full picture)\b/i;

const MACHINERY =
  /\b(?:working memory|context orchestrat\w*|provenance|system prompt|provider routing|tool preparation|memory layer|turn machine)\b/i;

const ARCHITECTURE_ASK =
  /\b(?:how (?:do you|does chief) work|your architecture|system prompt|how (?:are|were) you built|orchestrat\w*)\b/i;

const RESTATEMENT =
  /^(?:you asked|your question|to answer your question|regarding your (?:question|request))\b/i;

const CURRENT_FIGURE =
  /(?:\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:xrp|btc|eth|k|grand)\b|\b(?:own|owns|worth|balance|equity|valued)\b[^.]{0,40}\d)/i;

const UNAVAILABLE_ANSWER = "I can't verify that from a current reading.";

function latestUserText(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const index = lastIndex(messages, "user");
  return index >= 0 ? messageText(messages[index]).trim() : "";
}

function sentenceList(text) {
  return String(text ?? "")
    .replace(/^#{1,3}\s+.*$/gm, "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function exploring(transcript) {
  return /^what if\b/i.test(latestUserText(transcript));
}

function askedForStructure(transcript) {
  return STRUCTURED_ASK.test(latestUserText(transcript));
}

function askedArchitecture(transcript) {
  return ARCHITECTURE_ASK.test(latestUserText(transcript));
}

function shortReaction(userText) {
  const compact = spoken(userText).toLowerCase();
  if (/^(?:thanks|thank you|ty)$/.test(compact)) return "Anytime.";
  if (/not bad/.test(compact)) return "Not bad at all.";
  if (/^(?:crazy|damn|wow|fuck|shit|hell yeah|that's crazy)$/.test(compact)) return "Yeah.";
  return "Yep.";
}

function reactionIsAlreadyShort(text) {
  const clean = String(text ?? "").trim();
  if (!clean || clean.length > 80) return false;
  if (OFFER_LINE.test(clean) || MACHINERY.test(clean) || /^#{1,3}\s/m.test(clean)) return false;
  return sentenceList(clean).length <= 2;
}

function withoutDroppedSentences(text, drop) {
  const lines = String(text ?? "").split("\n");
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      kept.push(line);
      continue;
    }
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((sentence) => !drop(sentence.trim()));
    if (sentences.length) kept.push(sentences.join(" "));
  }
  return kept.join("\n").trim();
}

function stripOffers(text, transcript) {
  if (exploring(transcript)) return String(text ?? "").trim();
  return withoutDroppedSentences(text, (sentence) => {
    if (/\d/.test(sentence)) return false;
    return OFFER_LINE.test(sentence);
  });
}

function stripMachinery(text, transcript) {
  if (askedArchitecture(transcript)) return String(text ?? "").trim();
  return withoutDroppedSentences(
    text,
    (sentence) => MACHINERY.test(sentence) || RESTATEMENT.test(sentence)
  );
}

function openWithAnswer(text, transcript) {
  const original = String(text ?? "").trim();
  if (!original || askedForStructure(transcript)) return original;
  const report = REPORT_OPENING.test(original) || /^#{1,3}\s+\S/m.test(original);
  if (!report) return original;
  let body = original.replace(REPORT_OPENING, "").trim();
  body = body.replace(REPORT_OPENING, "").trim();
  const kept = sentenceList(body).filter((sentence) => {
    if (/\d/.test(sentence)) return true;
    if (OFFER_LINE.test(sentence)) return false;
    return !/\b(?:based on|i can provide|let me provide|according to (?:my |the )?(?:records|information|analysis))\b/i.test(
      sentence
    );
  });
  const lead = kept.slice(0, 3).join(" ").trim();
  return lead || original;
}

function numbersIn(text) {
  return [...String(text ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) =>
    match[0].replace(/,/g, "")
  );
}

function priorTranscriptText(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  return messages.map((message) => messageText(message)).join("\n");
}

function toolResultAfterLatestUser(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const start = lastIndex(messages, "user");
  for (let index = start + 1; index < messages.length; index += 1) {
    if (messages[index]?.role !== "tool") continue;
    const raw = messageText(messages[index]);
    if (numbersIn(raw).some((value) => value.length > 1)) return true;
    if (raw.trim() && !/unavailable|not connected|disabled|error|failed/i.test(raw)) return true;
  }
  return false;
}

function liveReadingReady(pack) {
  return (pack?.authority ?? []).some(
    (item) => item?.origin === "live" && item.available !== false
  );
}

function deniesClaim(sentence, pattern) {
  const match = String(sentence).match(pattern);
  if (!match || match.index == null) return false;
  const before = sentence
    .slice(Math.max(0, match.index - 32), match.index)
    .replace(/\bnever\s*mind\b/gi, "");
  return /\b(no|not|never|unknown|without|missing|wasn't|weren't|didn't|cannot|can't|don't|dont|nothing|nobody|no one)\b/i.test(
    before
  );
}

function affirms(sentence, pattern) {
  return pattern.test(sentence) && !deniesClaim(sentence, pattern);
}

function workforceItems(pack) {
  return (pack?.items ?? []).filter(
    (item) =>
      item?.origin === "live" &&
      item.available !== false &&
      item.sourceType === "live_agent_state" &&
      item.sourceId !== "workforce-coverage"
  );
}

function mentionedWorkforce(sentence, items) {
  const lower = sentence.toLowerCase();
  const hits = items.filter((item) => {
    const name = String(item.text ?? "")
      .split(" (")[0]
      .trim()
      .toLowerCase();
    if (name && lower.includes(name)) return true;
    const role = String(item.text ?? "").match(/Role ([^.]+)/)?.[1];
    return Boolean(role && lower.includes(role.trim().toLowerCase()));
  });
  if (/\b(everyone|every agent|all agents|all of them)\b/i.test(sentence)) return items;
  return hits.length ? hits : items;
}

const WORKFORCE_CLAIMS = [
  {
    claim: /\b(completed|finished|accomplished)\b/i,
    support: /\bObserved status (?:completed|finished|done)\b/i,
    unknown: "No completion was observed.",
  },
  {
    claim: /\b(failed|failure|stuck|error)\b/i,
    support: /\bObserved (?:status failed|status blocked|status error|failure)\b/i,
    unknown: "No failure was observed.",
  },
  {
    claim: /\b(needs? (?:my |your )?attention|attention request)\b/i,
    support: /\bObserved attention\b/i,
    unknown: "No attention request was observed.",
  },
  {
    claim: /\b(found|finding)\b/i,
    support: /\bObserved finding\b/i,
    unknown: "No finding was observed.",
  },
  {
    claim: /\b(changed (?:the )?code|committed|edited (?:a |the )?files?)\b/i,
    support: /\bObserved code change\b/i,
    unknown: "No code change was observed.",
  },
  {
    claim: /\b(ran (?:the )?tests|used (?:a |the )?(?:shell|terminal)|npm test)\b/i,
    support: /\bObserved tool use\b/i,
    unknown: "No tool use was observed.",
  },
  {
    claim: /\b(deploy(?:ing|ed)?)\b/i,
    support: /\bObserved deploy\b/i,
    unknown: "No deploy was observed.",
  },
];

function referentItems(sentence, items, transcript) {
  const users = (Array.isArray(transcript) ? transcript : [])
    .filter((message) => message?.role === "user")
    .map((message) => messageText(message));
  const hint = users.slice(-3).join(" ").toLowerCase();
  const hits = items.filter((item) => {
    const name = String(item.text ?? "")
      .split(" (")[0]
      .trim()
      .toLowerCase();
    const role = String(item.text ?? "").match(/Role ([^.]+)/)?.[1] ?? "";
    return (name && hint.includes(name)) || (role && hint.includes(role.trim().toLowerCase()));
  });
  return hits.length ? hits : mentionedWorkforce(sentence, items);
}

function scopeItems(sentence, items, transcript) {
  if (/\b(it|that|they)\b/i.test(sentence)) return referentItems(sentence, items, transcript);
  return mentionedWorkforce(sentence, items);
}

function unsupportedClaim(sentence, items, transcript) {
  const scope = scopeItems(sentence, items, transcript);
  const text = scope.map((item) => item.text).join("\n");
  const all = items.map((item) => item.text).join("\n");
  if (
    /\b(nothing failed|no failures|nobody failed|no agent failed)\b/i.test(sentence) &&
    /\bObserved failure\b/i.test(all)
  ) {
    return "A failure was observed.";
  }
  if (/\b(everyone|every agent|all agents|all of them)\b/i.test(sentence)) {
    for (const rule of WORKFORCE_CLAIMS) {
      if (!affirms(sentence, rule.claim)) continue;
      if (!scope.every((item) => rule.support.test(item.text))) return rule.unknown;
    }
  }
  for (const rule of WORKFORCE_CLAIMS) {
    if (affirms(sentence, rule.claim) && !rule.support.test(text)) return rule.unknown;
  }
  if (affirms(sentence, /\b(currently active|is active)\b/i) && !/Liveness active/i.test(text)) {
    return "That agent is not currently active.";
  }
  if (affirms(sentence, /\b(working on|working right now|still working)\b/i)) {
    if (/\bObserved status completed\b/i.test(text) && !/\bObserved status working\b/i.test(text)) {
      return "The live observation says that work completed. The older working status is not current.";
    }
    if (
      /\bObserved (?:status failed|failure)\b/i.test(text) &&
      !/\bObserved status working\b/i.test(text)
    ) {
      return "The live observation is a failure, not work in progress.";
    }
  }
  return null;
}

function affirmsWorkforceStatus(text) {
  return affirms(
    text,
    /\b(working|completed|finished|failed|idle|stuck|active|attention|finding)\b/i
  );
}

export function guardWorkforceReply(text, pack, transcript = []) {
  const answer = String(text ?? "").trim();
  if (!answer || !pack?.plan) return answer;
  const asking = pack.plan.live?.includes("agents") || pack.plan.currentState === true;
  const items = workforceItems(pack);
  if (!asking && items.length === 0) return answer;
  if (items.length === 0) {
    if (
      pack.plan.currentState &&
      pack.plan.live?.includes("agents") &&
      affirmsWorkforceStatus(answer) &&
      !/not connected|unavailable|no current agent/i.test(answer)
    ) {
      return "Agent state is not connected. No current agent status is available.";
    }
    return answer;
  }
  const facts = items.map(parseWorkforceFact).filter(Boolean);
  if (facts.length) {
    const synthesized = answerFromWorkforce({
      question: latestUserText(transcript),
      modelText: answer,
      facts,
      transcript,
    });
    if (synthesized) return synthesized;
    return sentenceList(answer)
      .map((sentence) => correctWorkforceSentence(sentence, facts, transcript) ?? sentence)
      .join(" ")
      .trim();
  }
  const rewritten = sentenceList(answer).map(
    (sentence) => unsupportedClaim(sentence, items, transcript) ?? sentence
  );
  return rewritten.join(" ").trim();
}

function blockUnsupportedCurrentClaim(text, transcript, pack) {
  const answer = String(text ?? "").trim();
  if (!pack?.plan?.currentState || exploring(transcript)) return answer;
  if (liveReadingReady(pack) || toolResultAfterLatestUser(transcript)) return answer;
  if (!CURRENT_FIGURE.test(answer)) return answer;
  const known = new Set(numbersIn(priorTranscriptText(transcript)));
  const novel = numbersIn(answer).some((value) => value.length > 1 && !known.has(value));
  if (!novel) return answer;
  return UNAVAILABLE_ANSWER;
}

export function settleReply({
  transcript = [],
  text = "",
  toolCalls = [],
  pack = null,
  workforcePicture = null,
} = {}) {
  const calls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  const move = conversationMove(transcript);
  const userText = latestUserText(transcript);
  const delegation = settleDelegation({
    transcript,
    text,
    toolCalls: calls,
    pack,
    workforcePicture,
    userText,
  });
  if (delegation.handled) {
    return {
      text: delegation.text,
      toolCalls: delegation.toolCalls,
      delegation: delegation.delegation,
      clearDelegation: delegation.clearDelegation,
    };
  }
  const modelText =
    delegation.text ||
    (delegation.effect === "read"
      ? "I can answer that directly. It does not need a workforce delegation."
      : "");
  const keptCalls = delegation.toolCalls;
  if (delegation.effect === "external") {
    return {
      text: "Sending that stays with me. I am not handing it to the workforce.",
      toolCalls: keptCalls,
    };
  }
  if (move.kind === MOVE.ACKNOWLEDGE) {
    const claimsWork = WORKFORCE_CLAIMS.some((rule) => rule.claim.test(modelText));
    return {
      text: !claimsWork && reactionIsAlreadyShort(modelText) ? modelText : shortReaction(userText),
      toolCalls: [],
    };
  }
  if (keptCalls.length > 0) return { text: modelText, toolCalls: keptCalls };
  let answer = openWithAnswer(modelText, transcript);
  answer = stripMachinery(answer, transcript);
  answer = stripOffers(answer, transcript);
  answer = blockUnsupportedCurrentClaim(answer, transcript, pack);
  answer = guardWorkforceReply(answer, pack, transcript);
  answer = answer.trim();
  if (!answer) answer = modelText || String(text ?? "").trim();
  return { text: answer, toolCalls: keptCalls };
}
