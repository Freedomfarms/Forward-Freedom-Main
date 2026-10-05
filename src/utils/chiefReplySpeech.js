// Decides whether a finished CHIEF turn is spoken on the home conversation path.
// Text rendering stays with the transcript. This module only chooses the
// string passed to voice.speakAnswer(), once.

import { CHIEF_STATUS } from "./chiefProtocol.js";
import { shouldSpeakReply } from "./chiefPreferences.js";

export function replySpeechText({
  streamText = "",
  historyAnswer = "",
  finished = false,
  status = "",
  error = "",
  aborted = false,
  source = "text",
  preferences,
} = {}) {
  if (aborted || finished !== true) return "";
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
  if (!spoken || typeof voice?.speakAnswer !== "function") return "";
  void voice.speakAnswer(spoken);
  return spoken;
}
