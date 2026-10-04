// Browser speech recognition. Interim text stays on the client.
// A final transcript is delivered once per utterance.

function defaultRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechInputSupported(Recognition = defaultRecognition()) {
  return typeof Recognition === "function";
}

export function createSpeechInput({
  Recognition = defaultRecognition(),
  lang = "en-US",
  onStart,
  onInterim,
  onFinal,
  onError,
  onEnd,
} = {}) {
  let recognition = null;
  let acceptResults = false;
  let finalDelivered = false;

  function handleResult(event) {
    if (!acceptResults) return;
    let interim = "";
    let finalText = "";
    const results = event?.results;
    if (!results) return;
    const start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
    for (let index = start; index < results.length; index += 1) {
      const piece = results[index]?.[0]?.transcript;
      if (typeof piece !== "string") continue;
      if (results[index].isFinal) finalText += piece;
      else interim += piece;
    }
    if (interim.trim()) onInterim?.(interim);
    const trimmed = finalText.trim();
    if (trimmed && !finalDelivered) {
      finalDelivered = true;
      acceptResults = false;
      onFinal?.(trimmed);
    }
  }

  function handleError(event) {
    if (!acceptResults && finalDelivered) return;
    onError?.(event?.error || "stt_error");
  }

  function handleEnd() {
    const delivered = finalDelivered;
    acceptResults = false;
    recognition = null;
    onEnd?.({ finalSeen: delivered });
  }

  return {
    get supported() {
      return speechInputSupported(Recognition);
    },
    start() {
      if (!speechInputSupported(Recognition)) {
        onError?.("unsupported");
        return false;
      }
      this.cancel();
      finalDelivered = false;
      acceptResults = true;
      const next = new Recognition();
      next.lang = lang;
      next.continuous = false;
      next.interimResults = true;
      next.maxAlternatives = 1;
      next.onstart = () => onStart?.();
      next.onresult = handleResult;
      next.onerror = handleError;
      next.onend = handleEnd;
      recognition = next;
      next.start();
      return true;
    },
    stop() {
      acceptResults = false;
      const current = recognition;
      if (!current) return;
      try {
        current.stop();
      } catch {
        recognition = null;
      }
    },
    cancel() {
      acceptResults = false;
      finalDelivered = true;
      const current = recognition;
      recognition = null;
      if (!current) return;
      current.onresult = null;
      current.onerror = null;
      current.onend = null;
      try {
        current.abort();
      } catch {
        try {
          current.stop();
        } catch {
          // The recognition object is already stopped.
        }
      }
    },
  };
}
