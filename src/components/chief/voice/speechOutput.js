// Speech output. ElevenLabs is primary. Browser speech is an explicit fallback.
// Playback callbacks fire when audio actually starts, stops, ends, or fails.

import { requestChiefSpeech } from "../../../utils/chiefApi.js";
import { spokenText } from "./voiceMachine.js";
import { readVoiceSettings } from "./voiceSettings.js";

let sharedContext = null;

export function unlockSpeechPlayback() {
  const Context =
    typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
  if (!Context) return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new Context();
  if (sharedContext.state === "suspended") void sharedContext.resume();
  return sharedContext;
}

function browserVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return false;
  return typeof window.SpeechSynthesisUtterance === "function";
}

export function createSpeechOutput({
  getUser,
  getSettings = readVoiceSettings,
  requestSpeech = requestChiefSpeech,
  onStart,
  onEnd,
  onStop,
  onError,
} = {}) {
  let generation = 0;
  let speaking = false;
  let stopCurrent = null;
  let activeController = null;
  let startWatch = null;
  let playbackStart = (info) => onStart?.(info);

  function clearStartWatch() {
    clearTimeout(startWatch);
    startWatch = null;
  }

  function finish(kind, token, provider) {
    if (token !== generation) return;
    speaking = false;
    stopCurrent = null;
    activeController = null;
    if (kind === "end") onEnd?.({ provider });
    else if (kind === "stop") onStop?.({ provider });
  }

  function fail(token, error) {
    clearStartWatch();
    if (token !== generation) return;
    speaking = false;
    stopCurrent = null;
    activeController = null;
    onError?.(error);
  }

  async function playBuffer(bytes, token, provider) {
    const context = unlockSpeechPlayback();
    if (!context) throw Object.assign(new Error("playback"), { code: "playback_failed" });
    if (context.state === "suspended") await context.resume();
    const copy = bytes.slice(0);
    const audioBuffer = await context.decodeAudioData(copy);
    if (token !== generation) return;
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (kind) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(kind);
      };
      const guard = setTimeout(
        () => {
          try {
            source.stop();
          } catch {
            settle("end");
          }
        },
        Math.ceil(audioBuffer.duration * 1000) + 1500
      );
      source.onended = () => {
        clearTimeout(guard);
        settle("end");
      };
      stopCurrent = () => {
        clearTimeout(guard);
        try {
          source.stop();
        } catch {
          settle("stop");
        }
      };
      try {
        source.start(0);
      } catch (error) {
        clearTimeout(guard);
        reject(error);
        return;
      }
      speaking = true;
      playbackStart({ provider });
    }).then((kind) => finish(kind, token, provider));
  }

  function playBrowser(text, settings, token) {
    const synthesis = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.speed;
    utterance.onstart = () => {
      if (token !== generation) return;
      speaking = true;
      playbackStart({ provider: "browser" });
    };
    utterance.onend = () => finish("end", token, "browser");
    utterance.onerror = (event) => {
      if (event?.error === "interrupted" || event?.error === "canceled") {
        finish("stop", token, "browser");
        return;
      }
      fail(token, Object.assign(new Error("playback"), { code: "playback_failed" }));
    };
    stopCurrent = () => {
      synthesis.cancel();
    };
    synthesis.cancel();
    synthesis.speak(utterance);
  }

  return {
    isSpeaking() {
      return speaking;
    },
    setVoice(voiceId) {
      const current = getSettings();
      return { ...current, voiceId };
    },
    stop() {
      generation += 1;
      clearStartWatch();
      const halt = stopCurrent;
      stopCurrent = null;
      activeController?.abort();
      activeController = null;
      speaking = false;
      try {
        halt?.();
      } catch {
        // The playback node is already stopped.
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // The browser has no active utterance.
        }
      }
    },
    async speak(text, { signal } = {}) {
      const spoken = spokenText(text);
      if (!spoken) {
        onError?.(Object.assign(new Error("empty"), { code: "playback_failed" }));
        return;
      }
      this.stop();
      const token = ++generation;
      const settings = getSettings();
      clearStartWatch();
      startWatch = setTimeout(() => {
        if (token !== generation || speaking) return;
        this.stop();
        onError?.(Object.assign(new Error("playback"), { code: "playback_failed" }));
      }, 20000);
      playbackStart = (info) => {
        clearStartWatch();
        onStart?.(info);
      };
      const user = typeof getUser === "function" ? getUser() : null;
      const controller = new AbortController();
      activeController = controller;
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        const bytes = await requestSpeech(
          user,
          {
            text: spoken,
            voiceId: settings.voiceId,
            modelId: settings.modelId,
            settings: {
              speed: settings.speed,
              stability: settings.stability,
              similarityBoost: settings.similarityBoost,
              style: settings.style,
            },
          },
          { signal: controller.signal }
        );
        if (token !== generation) {
          clearStartWatch();
          return;
        }
        await playBuffer(bytes, token, "elevenlabs");
      } catch (error) {
        if (token !== generation || error?.name === "AbortError" || error?.code === "aborted") {
          clearStartWatch();
          return;
        }
        if (settings.fallbackEnabled && browserVoices()) {
          try {
            playBrowser(spoken, settings, token);
            return;
          } catch (browserError) {
            fail(token, browserError);
            return;
          }
        }
        fail(token, error);
      }
    },
  };
}
