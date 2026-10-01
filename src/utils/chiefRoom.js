// Presentation helpers for the CHIEF room. No network and no Firebase.
// The conversation runtime stays in chiefProtocol.js.

import { CHIEF_STATUS, publicTranscriptMessages } from "./chiefProtocol.js";

export const CHIEF_ACCESS = Object.freeze({
  ON: "on",
  OFF: "off",
  UNAVAILABLE: "unavailable",
});

const ACCESS_WORDS = new Set([CHIEF_ACCESS.ON, CHIEF_ACCESS.OFF, CHIEF_ACCESS.UNAVAILABLE]);

export function accessWord(value) {
  return ACCESS_WORDS.has(value) ? value : CHIEF_ACCESS.UNAVAILABLE;
}

export function moneyWebLine(money, web) {
  return `Money ${accessWord(money)} · Web ${accessWord(web)}`;
}

export function conversationAccessWords(payload, { readable = true } = {}) {
  if (readable === false || !payload || typeof payload !== "object") {
    return {
      read: CHIEF_ACCESS.UNAVAILABLE,
      organize: CHIEF_ACCESS.UNAVAILABLE,
      delete: CHIEF_ACCESS.UNAVAILABLE,
    };
  }
  const word = (value) => (value === true ? CHIEF_ACCESS.ON : CHIEF_ACCESS.OFF);
  if (typeof payload.conversationRead !== "boolean") {
    return conversationAccessWords(null, { readable: false });
  }
  return {
    read: word(payload.conversationRead),
    organize: word(payload.conversationOrganize),
    delete: word(payload.conversationDelete),
  };
}

export function emptyRoomAccess() {
  return {
    money: CHIEF_ACCESS.UNAVAILABLE,
    web: CHIEF_ACCESS.UNAVAILABLE,
    read: CHIEF_ACCESS.UNAVAILABLE,
    organize: CHIEF_ACCESS.UNAVAILABLE,
    delete: CHIEF_ACCESS.UNAVAILABLE,
  };
}

export function formatRoomTime(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function modelLabel(models, route) {
  if (typeof route !== "string" || !route) return "Default";
  if (!Array.isArray(models)) return route;
  const match = models.find((model) => model?.id === route);
  if (!match) return route;
  return typeof match.name === "string" && match.name.trim() ? match.name.trim() : route;
}

export function currentTurn(messages, streamText = "") {
  const visible = publicTranscriptMessages(messages);
  let userIndex = -1;
  let assistantIndex = -1;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (userIndex === -1 && visible[index].role === "user") userIndex = index;
    if (assistantIndex === -1 && visible[index].role === "assistant") assistantIndex = index;
  }
  const userLine = userIndex === -1 ? "" : visible[userIndex].text;
  const storedAnswer = assistantIndex > userIndex ? visible[assistantIndex].text : "";
  const streaming = typeof streamText === "string" && streamText.length > 0;
  const answer = streaming ? streamText : storedAnswer;
  const hidden = new Set();
  if (userIndex !== -1) hidden.add(userIndex);
  if (!streaming && assistantIndex > userIndex) hidden.add(assistantIndex);
  return {
    userLine,
    answer,
    earlier: visible.filter((_, index) => !hidden.has(index)),
  };
}

export function fieldKindForStatus(status) {
  if (status === CHIEF_STATUS.ERROR) return "error";
  if (status === CHIEF_STATUS.APPROVAL) return "approval";
  if (status === CHIEF_STATUS.RESPONDING) return "responding";
  if (status === CHIEF_STATUS.READY) return "ready";
  return "working";
}
