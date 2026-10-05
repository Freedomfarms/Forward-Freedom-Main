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
  /^(?:thanks|thank you|ty|great|nice|cool|awesome|perfect|wow|damn|fuck|shit|hell yeah|not bad|that's not bad|that's crazy|crazy|lol|lmao|haha|yeah that's (?:crazy|wild|a lot|huge|big)|👍)[.!\s]*$/i;

const AGREEMENT =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|please do|check it|yeah check(?: it)?|pull it|do that|go for it)[.!\s]*$/i;

const OFFER =
  /\b(?:want me to|should i|i can (?:pull|check|look|grab|get|search)|if needed|if you want)\b/i;

const PUBLIC_SOURCE = /\b(?:zillow|redfin|listing|estimate|look up|search the web|web)\b/i;

const ELLIPSIS =
  /^(?:what about|how about|and |what if|how much\b|why\b|what changed|what happened|the other one|is that|and the)\b/i;

function spoken(text) {
  return String(text ?? "")
    .trim()
    .replace(/[!?.,]+$/g, "")
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
  let kind = MOVE.DIRECT;
  if (agreement && offeredWork) kind = MOVE.CONFIRM;
  else if (agreement || REACTION.test(compact)) kind = MOVE.ACKNOWLEDGE;
  else if (isAnaphoric(latest) || ELLIPSIS.test(latest)) kind = MOVE.CONTINUE;
  return {
    kind,
    referent: memory.referent ?? null,
    priorUserTexts: priorUserTexts(messages, latestIndex),
    pullsPublicSource: kind === MOVE.CONFIRM && PUBLIC_SOURCE.test(offered),
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
