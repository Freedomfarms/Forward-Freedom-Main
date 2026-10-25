// Decides whether a finished CHIEF turn is spoken on the home conversation path.
// Text rendering stays with the transcript. This module only chooses the
// string passed to voice.speakAnswer(), once. Typed and spoken input share it.

import { CHIEF_STATUS, isSpeakableTurn, MISSING_CHIEF_ANSWER } from "./chiefProtocol.js";
import { shouldSpeakReply } from "./chiefPreferences.js";

export { MISSING_CHIEF_ANSWER };
export const PLAYBACK_BLOCKED_MESSAGE =
  "Playback is blocked. Tap Play response to hear this answer.";

// settled means the Managed Agents turn finished without an error or a pause.
// speak is the response-mode choice. playback is omitted until speakAnswer returns.
export function classifySettledDelivery({
  answer = "",
  speak = false,
  settled = false,
  playback = null,
} = {}) {
  if (!settled) return { action: "pending" };
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!text) return { action: "missing_answer", message: MISSING_CHIEF_ANSWER };
  if (!speak) return { action: "show", text };
  if (!playback) return { action: "speak", text };
  if (playback.ok === true) return { action: "spoken", text };
  if (playback.reason === "aborted") return { action: "stopped", text };
  const blocked = playback.code === "playback_blocked" || playback.reason === "blocked";
  if (blocked) {
    const message =
      typeof playback.error === "string" && playback.error.trim()
        ? playback.error.trim()
        : PLAYBACK_BLOCKED_MESSAGE;
    return { action: "blocked", text, message };
  }
  const message =
    typeof playback.error === "string" && playback.error.trim()
      ? playback.error.trim()
      : "CHIEF could not speak that response.";
  return { action: "tts_failed", text, message };
}

export function replySpeechText({
  streamText = "",
  historyAnswer = "",
  finished = false,
  status = "",
  error = "",
  aborted = false,
  source = "text",
  turnStatus = null,
  preferences,
} = {}) {
  if (aborted || finished !== true) return "";
  if (!isSpeakableTurn(turnStatus)) return "";
  if (status === CHIEF_STATUS.ERROR || error) return "";
  const streamed = typeof streamText === "string" ? streamText.trim() : "";
  const stored = typeof historyAnswer === "string" ? historyAnswer.trim() : "";
  const spoken = streamed || stored;
  if (!spoken) return "";
  if (!shouldSpeakReply({ source, preferences })) return "";
  return spoken;
}

export function speakCompletedReply(voice, input) {
  const spoken = replySpeechText(input);
  if (!spoken || typeof voice?.speakAnswer !== "function") return null;
  return {
    spoken,
    pending: Promise.resolve(voice.speakAnswer(spoken)),
  };
}
