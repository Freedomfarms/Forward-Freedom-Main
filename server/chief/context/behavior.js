// How CHIEF talks. One contract for every model provider.
//
// This does not route tools, store memory, or start a turn. The context
// orchestrator still chooses sources. TurnMachine still calls the model.
// The contract tells that model to answer like one assistant. conversationMove
// only labels the latest utterance so a follow-up stays on the open thread
// and a reaction does not become a new task.

import { messageText } from "../runtime/compaction.js";
import { buildWorkingMemory, isAnaphoric } from "../memory/working.js";

export const MOVE = Object.freeze({
  ACKNOWLEDGE: "acknowledge",
  CANCEL: "cancel",
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
  "Never say Certainly, Of course, Based on my records, According to the available information, or I'd be happy to. Do not mention the model, the orchestrator, or the prompt.",
].join(" ");

const REACTION =
  /^(?:thanks|thank you|ty|great|nice|cool|awesome|perfect|wow|damn|fuck|shit|hell yeah|not bad|that(?:'s| is)(?: actually)? not bad|that(?:'s| is) crazy|that(?:'s| is) good|that(?:'s| is) great|got it|makes sense|sounds good|alright|all good|nice one|crazy|interesting|that changes things|that(?:'s| is) exactly what i needed|lol|lmao|haha|yeah that(?:'s| is) (?:crazy|wild|a lot|huge|big)|👍)$/i;

const AGREEMENT =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|please do|check it|yeah check(?: it)?|pull it|do that|go for it)$/i;

const REPAIR = /\b(?:i meant|i mean)\b|\binstead\b|^no (?:the|my|that|it)\b/i;

const RETRACTION =
  /^(?:actually )?(?:never mind|nevermind|forget it|cancel(?: that)?|stop|don'?t bother|nvm|scratch that|leave it|drop it|ignore that)$/i;

const DECLINE = /^(?:no|nope|nah|no thanks|no thank you)$/i;

const VALUE_QUESTION = /\b(?:worth|how much|how many|balance|equity|own|cost)\b/i;

const CURRENT_REVIEW = /\b(?:still|anymore|today|right now|currently|where i am now)\b/i;

const REVIEW_INTENT = /\b(?:make sense|compare|comparison|changed|worth it|hold up|good idea)\b/i;

export function historicalQuestion(text) {
  const raw = String(text ?? "");
  if (CURRENT_REVIEW.test(raw) && REVIEW_INTENT.test(raw)) return false;
  if (/\b(?:spent|spending|spend|expenses?)\b/i.test(raw)) return false;
  return /\b(?:what did (?:i|we)|why did i decide|last (?:month|year|week)|earlier|previously|used to|\bago\b|tell you|told you|talked about)\b/i.test(
    raw
  );
}

const EXPLICIT_CHECK = /\b(?:check it|look it up|pull it|go ahead and|do that|do it)\b/i;

const OFFER =
  /\b(?:want me to|should i|i can (?:pull|check|look|grab|get|search)|if needed|if you want)\b/i;

const PUBLIC_SOURCE = /\b(?:zillow|redfin|listing|estimate|look up|search the web|web)\b/i;

const ELLIPSIS =
  /^(?:what about|how about|and |what if|how much\b|why\b|what changed|what happened|the other one|is that|and the)\b/i;

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
  const repairs = REPAIR.test(compact);
  let kind = MOVE.DIRECT;
  if (repairs) kind = MOVE.CONTINUE;
  else if ((agreement && offeredWork) || explicitCheck) kind = MOVE.CONFIRM;
  else if (RETRACTION.test(compact) || (DECLINE.test(compact) && offeredWork)) kind = MOVE.CANCEL;
  else if (agreement || REACTION.test(compact)) kind = MOVE.ACKNOWLEDGE;
  else if (isAnaphoric(latest) || ELLIPSIS.test(latest)) kind = MOVE.CONTINUE;
  const thread = [offered, ...prior].join("\n");
  const unresolved =
    memory.ambiguous !== true &&
    !memory.referent &&
    isAnaphoric(latest) &&
    VALUE_QUESTION.test(latest);
  return {
    kind,
    referent: memory.referent ?? null,
    ambiguous: memory.ambiguous === true,
    unresolved,
    candidates: memory.candidates ?? [],
    repairs,
    historical: historicalQuestion(latest),
    priorUserTexts: prior,
    pullsPublicSource: kind === MOVE.CONFIRM && PUBLIC_SOURCE.test(thread),
  };
}

export function renderConversationMove(transcript, query = null) {
  const move = conversationMove(transcript, query);
  if (move.kind === MOVE.ACKNOWLEDGE) {
    return "The latest message is a reaction, not a new task. Answer in a few words, in the same tone. Do not call a tool. Do not offer more work.";
  }
  if (move.kind === MOVE.CANCEL) {
    return "The user is stopping. Acknowledge in a few words. Do not call a tool. Do not continue the task.";
  }
  if (move.ambiguous || move.unresolved) {
    const choices = (move.candidates ?? []).filter(Boolean);
    if (choices.length >= 2) {
      return `This could refer to ${choices.join(" or ")}. Ask which one in a few words. Do not guess.`;
    }
    return "The subject is not in the conversation. Ask which one in a few words. Do not guess.";
  }
  if (move.historical) {
    const subject = move.referent ? ` The subject is ${move.referent}.` : "";
    const asked =
      query != null && String(query).trim() ? String(query) : latestUserText(transcript);
    if (/\b(?:last (?:month|year|week)|ago)\b/i.test(asked)) {
      return `This is about an earlier conversation.${subject} Use history for that period. Do not answer from a current balance.`;
    }
    return `This is about what was decided or said before.${subject} Do not replace it with today's numbers.`;
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

const SIMPLE_FACT =
  /\b(?:how (?:much|many)|what(?:'s| is)(?: it| that| this)? worth|do i own|what do i own)\b/i;

const FILLER =
  /\b(?:it is important|it's important|you may want|keep in mind|this represents|meaningful position|consider diversif|in summary|worth noting)\b/i;

const SELF_TALK =
  /^(?:i (?:analyzed|checked|looked at)(?: [^.]{0,48})?(?:,| and)?|based on my reasoning,?|my tools show)\s+/i;

const SELF_SENTENCE =
  /\b(?:i (?:analyzed|checked|looked)|based on my reasoning|my tools show|i was able to)\b/i;

const SEARCH_NARRATION =
  /\b(?:looking (?:that |it |this )?up|searching|i(?:'ll| will) (?:look|search|check|pull)|let me (?:look|search|check|pull))\b/i;

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

function leadIn(sentence) {
  const bare = String(sentence ?? "").trim();
  if (/^(?:certainly|of course|absolutely)[!,.]?$/i.test(bare)) return "";
  return bare
    .replace(/^(?:certainly|of course|absolutely)[!,.]?\s+/i, "")
    .replace(
      /^based on (?:my |the )?(?:[\w-]+\s+){0,6}?(?:analysis|records|information)(?:\s+available(?: to me)?)?,?\s*/i,
      ""
    )
    .replace(
      /^(?:here(?:'s| is) (?:a |an )?(?:comprehensive |detailed |brief )?(?:analysis|summary|overview)[^.]*\.\s*)/i,
      ""
    )
    .trim();
}

function openWithAnswer(text, transcript) {
  const original = String(text ?? "").trim();
  if (!original || askedForStructure(transcript)) return original;
  const report = REPORT_OPENING.test(original) || /^#{1,3}\s+\S/m.test(original);
  if (!report) return original;
  const kept = sentenceList(original)
    .map(leadIn)
    .filter((sentence) => {
      if (!sentence) return false;
      if (/\d/.test(sentence)) return true;
      if (OFFER_LINE.test(sentence)) return false;
      return !/\b(?:based on|i can provide|let me provide|according to (?:my |the )?(?:records|information|analysis)|here(?:'s| is) (?:a |an )?(?:analysis|summary|overview))\b/i.test(
        sentence
      );
    });
  const lead = kept
    .slice(0, 3)
    .map((sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1))
    .join(" ")
    .trim();
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

function clarification(candidates) {
  const names = (candidates ?? []).filter(Boolean).slice(0, 3);
  if (names.length >= 2) {
    const last = names[names.length - 1];
    const rest = names.slice(0, -1).join(", ");
    return `Which one, ${rest} or ${last}?`;
  }
  return "Which one do you mean?";
}

function alreadyAsking(text) {
  const clean = String(text ?? "").trim();
  return /\?\s*$/.test(clean) && clean.length <= 140 && !CURRENT_FIGURE.test(clean);
}

function polishAnswer(text, transcript) {
  if (exploring(transcript) || askedForStructure(transcript) || askedArchitecture(transcript)) {
    return String(text ?? "").trim();
  }
  const simple = SIMPLE_FACT.test(latestUserText(transcript));
  const original = sentenceList(text);
  const kept = [];
  let changed = false;
  for (const sentence of original) {
    if (simple && FILLER.test(sentence) && !/\d/.test(sentence)) {
      changed = true;
      continue;
    }
    if (SELF_SENTENCE.test(sentence) && !/\d/.test(sentence)) {
      changed = true;
      continue;
    }
    const voiced = sentence.replace(SELF_TALK, "");
    if (voiced !== sentence) changed = true;
    const next = voiced === sentence ? sentence : voiced.charAt(0).toUpperCase() + voiced.slice(1);
    if (!next.trim()) {
      changed = true;
      continue;
    }
    kept.push(next.trim());
  }
  if (!changed || kept.length === 0) return String(text ?? "").trim();
  if (simple && !kept.some((sentence) => /\d/.test(sentence))) return String(text ?? "").trim();
  return kept.slice(0, simple ? 3 : kept.length).join(" ");
}

const UNREAD_SYSTEM = [
  [
    "agents",
    /\b(?:grok\s*bots?|agents?)\b/i,
    /\b(?:working|running|idle|doing|finished|status)\b/i,
    "I don't currently have a live agent status for that.",
  ],
  [
    "schedule",
    /\b(?:schedule|scheduled|task)\b/i,
    /\b(?:today|tomorrow|at \d|due|runs)\b/i,
    "I don't have a schedule reading for that.",
  ],
  [
    "calendar",
    /\bcalendar\b/i,
    /\b(?:shows|meeting|appointment|today)\b/i,
    "I don't have your calendar connected here.",
  ],
  [
    "email",
    /\b(?:inbox|e-?mails?)\b/i,
    /\b(?:shows|unread|received|from)\b/i,
    "I don't have your email connected here.",
  ],
  [
    "web",
    /\b(?:zillow|web search|search results)\b/i,
    /\b(?:says|shows|estimates|lists)\b/i,
    "I can't check the public web for that right now.",
  ],
];

function blockUnreadSystem(text, transcript, pack) {
  const answer = String(text ?? "").trim();
  if (exploring(transcript) || toolResultAfterLatestUser(transcript)) return answer;
  const unavailable = new Set(pack?.unavailable ?? []);
  for (const [system, topic, claim, honest] of UNREAD_SYSTEM) {
    if (!unavailable.has(system)) continue;
    if (topic.test(answer) && claim.test(answer)) return honest;
  }
  return answer;
}

function earlierTranscriptText(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const start = lastIndex(messages, "user");
  return messages
    .slice(0, Math.max(0, start))
    .map((message) => messageText(message))
    .join("\n");
}

function blockInventedHistory(text, transcript, pack) {
  const answer = String(text ?? "").trim();
  if (!pack || !historicalQuestion(latestUserText(transcript))) return answer;
  if (toolResultAfterLatestUser(transcript)) return answer;
  const wanted = pack.plan?.memory ?? [];
  const askedHistory = wanted.includes("decision") || wanted.includes("episodic");
  if (!askedHistory) return answer;
  const remembered = (pack.items ?? []).some(
    (item) => item?.origin === "memory" && item.available !== false
  );
  if (remembered) return answer;
  if (/\b(?:decided|told me|told you)\b/i.test(earlierTranscriptText(transcript))) return answer;
  if (/\b(?:you decided|we decided|you told me|last month you)\b/i.test(answer)) {
    return "I don't have a record of that.";
  }
  return answer;
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

export function settleReply({ transcript = [], text = "", toolCalls = [], pack = null } = {}) {
  const calls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  const move = conversationMove(transcript);
  const userText = latestUserText(transcript);
  const originalText = String(text ?? "");
  let droppedSearch = false;
  if (move.kind === MOVE.ACKNOWLEDGE) {
    const modelText = String(text ?? "").trim();
    return {
      text: reactionIsAlreadyShort(modelText) ? modelText : shortReaction(userText),
      toolCalls: [],
    };
  }
  if (move.kind === MOVE.CANCEL) {
    const modelText = String(text ?? "").trim();
    const keep = reactionIsAlreadyShort(modelText) && !OFFER_LINE.test(modelText);
    return { text: keep ? modelText : "Okay.", toolCalls: [] };
  }
  if (move.ambiguous || move.unresolved) {
    const modelText = String(text ?? "").trim();
    return {
      text: alreadyAsking(modelText) ? modelText : clarification(move.candidates),
      toolCalls: [],
    };
  }
  if (exploring(transcript)) {
    const kept = calls.filter((call) => call?.name !== "web_search");
    droppedSearch = kept.length !== calls.length;
    calls.length = 0;
    calls.push(...kept);
    if (kept.length === 0) {
      text = withoutDroppedSentences(text, (sentence) => SEARCH_NARRATION.test(sentence));
    }
  }
  if (calls.length > 0) return { text: String(text ?? ""), toolCalls: calls };
  let answer = openWithAnswer(text, transcript);
  answer = stripMachinery(answer, transcript);
  answer = stripOffers(answer, transcript);
  answer = blockUnsupportedCurrentClaim(answer, transcript, pack);
  answer = blockUnreadSystem(answer, transcript, pack);
  answer = blockInventedHistory(answer, transcript, pack);
  answer = polishAnswer(answer, transcript);
  answer = answer.trim();
  if (!answer && droppedSearch) answer = "I can check that if you want.";
  if (!answer) answer = originalText.trim();
  return { text: answer, toolCalls: calls };
}
