import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChiefSpeech, fetchChiefVoices } from "../../utils/chiefApi.js";
import {
  createChiefSpeechInput,
  holdAudioContext,
  playChiefSpeech,
  speakBrowserText,
} from "../../utils/chiefSpeech.js";
import {
  readChiefVoiceId,
  selectChiefVoiceId,
  speechVoiceId,
  writeChiefVoiceId,
} from "../../utils/chiefVoicePreference.js";
import { createAudioLevel } from "./voice/audioLevel.js";
import { normalizeVoiceSettings, readVoiceSettings } from "./voice/voiceSettings.js";

// Voice list, microphone capture, and spoken playback for the open CHIEF
// session. Transcripts are handed back to the page so they enter the same
// sendMessage path as typed text.

export function useChiefVoice({ user, sessionUid, onTranscript }) {
  const onTranscriptRef = useRef(onTranscript);
  const [voices, setVoices] = useState([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState("");
  const [voiceId, setVoiceId] = useState(() => readChiefVoiceId(sessionUid) || "");
  const [voiceScope, setVoiceScope] = useState(sessionUid);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [audioActive, setAudioActive] = useState(false);
  const [playback, setPlayback] = useState("idle");
  const [speechError, setSpeechError] = useState("");
  const [voiceAttempt, setVoiceAttempt] = useState(0);

  if (voiceScope !== sessionUid) {
    setVoiceScope(sessionUid);
    setVoiceId(readChiefVoiceId(sessionUid) || "");
  }

  const voiceIdRef = useRef(voiceId);
  const speakAbortRef = useRef(null);
  const speakGenerationRef = useRef(0);
  const audioCtxRef = useRef(null);
  const audioHoldRef = useRef(null);
  const speechRef = useRef(null);
  const userRef = useRef(user);
  const voiceTurnRef = useRef(false);
  const meterRef = useRef(null);
  const [audioLevelRef] = useState(() => ({ current: 0 }));

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    voiceIdRef.current = voiceId;
  }, [voiceId]);

  useEffect(() => {
    const meter = createAudioLevel({ levelRef: audioLevelRef });
    meterRef.current = meter;
    return () => {
      void meter.stop();
    };
  }, [audioLevelRef]);

  const loadVoices = useCallback(async () => {
    const currentUser = userRef.current;
    if (!currentUser) return;
    setVoicesLoading(true);
    setVoicesError("");
    try {
      const payload = await fetchChiefVoices(currentUser);
      const list = Array.isArray(payload?.voices) ? payload.voices : [];
      setVoices(list);
      if (!list.length) {
        setVoicesError("ElevenLabs returned no voices.");
        return;
      }
      const configured = typeof payload?.defaultVoiceId === "string" ? payload.defaultVoiceId : "";
      setVoiceId((current) => {
        const stored = current || readChiefVoiceId(sessionUid);
        const next = speechVoiceId(selectChiefVoiceId(list, { stored, configured }), stored);
        if (next) {
          writeChiefVoiceId(sessionUid, next);
          voiceIdRef.current = next;
        }
        return next;
      });
    } catch (error) {
      setVoices([]);
      setVoicesError(error?.message || "ElevenLabs voice list failed.");
    } finally {
      setVoicesLoading(false);
    }
  }, [sessionUid]);

  useEffect(() => {
    if (!sessionUid || !userRef.current) return undefined;
    loadVoices();
    return undefined;
  }, [sessionUid, loadVoices, voiceAttempt]);

  const releaseAudioHold = useCallback(() => {
    const release = audioHoldRef.current;
    audioHoldRef.current = null;
    release?.();
  }, []);

  useEffect(() => {
    return () => {
      const release = audioHoldRef.current;
      audioHoldRef.current = null;
      release?.();
      const controller = speakAbortRef.current;
      speakAbortRef.current = null;
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    const input = createChiefSpeechInput({
      onStart: () => setListening(true),
      onEnd: () => {
        setListening(false);
        setInterim("");
        void meterRef.current?.stop();
      },
      onInterim: (text) => setInterim(text),
      onTranscript: (text) => {
        setInterim("");
        voiceTurnRef.current = true;
        onTranscriptRef.current?.(text);
      },
      onError: (message) => {
        setListening(false);
        setInterim("");
        if (message) setSpeechError(message);
      },
    });
    speechRef.current = input;
    return () => input.abort();
  }, []);

  const openAudioContext = useCallback(() => {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === "suspended") void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const ensureAudio = useCallback(() => {
    const context = openAudioContext();
    if (!context) return null;
    if (!audioHoldRef.current) audioHoldRef.current = holdAudioContext(context);
    return context;
  }, [openAudioContext]);

  const stopSpeaking = useCallback(
    (options) => {
      speakGenerationRef.current += 1;
      speakAbortRef.current?.abort();
      speakAbortRef.current = null;
      if (!options?.preserveHold) releaseAudioHold();
      if (typeof globalThis.speechSynthesis?.cancel === "function") {
        try {
          globalThis.speechSynthesis.cancel();
        } catch {
          // The browser has no active utterance.
        }
      }
      setAudioActive(false);
      setPlayback("idle");
    },
    [releaseAudioHold]
  );

  const clearSpeechError = useCallback(() => {
    setSpeechError("");
  }, []);

  const reportSpeechError = useCallback((message) => {
    const text = typeof message === "string" ? message.trim() : "";
    if (text) setSpeechError(text);
  }, []);

  const stopListening = useCallback(() => {
    speechRef.current?.abort();
    setListening(false);
    setInterim("");
    void meterRef.current?.stop();
  }, []);

  const speakAnswer = useCallback(
    async (text, settingsOverride) => {
      const generation = ++speakGenerationRef.current;
      const stale = () => speakGenerationRef.current !== generation;
      const spoken = typeof text === "string" ? text.trim() : "";
      const currentUser = userRef.current;
      const saved = readVoiceSettings();
      const voiceSettings = settingsOverride
        ? normalizeVoiceSettings({ ...saved, ...settingsOverride })
        : saved;
      const overrideId =
        settingsOverride && typeof settingsOverride.voiceId === "string"
          ? settingsOverride.voiceId
          : "";
      const selected = speechVoiceId(
        speechVoiceId(overrideId, voiceIdRef.current),
        voiceSettings.voiceId
      );
      if (selected) voiceIdRef.current = selected;
      if (!spoken || !currentUser) {
        speakAbortRef.current?.abort();
        speakAbortRef.current = null;
        setAudioActive(false);
        setPlayback("idle");
        return { ok: false, reason: "empty" };
      }
      const controller = new AbortController();
      const previous = speakAbortRef.current;
      speakAbortRef.current = controller;
      previous?.abort();
      if (stale()) {
        controller.abort();
        return { ok: false, reason: "aborted" };
      }
      setPlayback("preparing");
      setAudioActive(false);
      setSpeechError("");
      try {
        const response = await fetchChiefSpeech({
          user: currentUser,
          text: spoken,
          voiceId: selected,
          voiceSettings,
          signal: controller.signal,
        });
        if (stale() || controller.signal.aborted) {
          return { ok: false, reason: "aborted" };
        }
        await playChiefSpeech(response, {
          audioContext: openAudioContext(),
          signal: controller.signal,
          onPlaybackStart: () => {
            if (stale() || controller.signal.aborted || speakAbortRef.current !== controller) {
              return;
            }
            setPlayback("playing");
            setAudioActive(true);
          },
        });
        if (stale() || controller.signal.aborted) {
          return { ok: false, reason: "aborted" };
        }
        return { ok: true };
      } catch (error) {
        if (stale() || controller.signal.aborted || error?.name === "AbortError") {
          return { ok: false, reason: "aborted" };
        }
        if (voiceSettings.fallbackEnabled) {
          try {
            await speakBrowserText(spoken, {
              rate: voiceSettings.speed,
              signal: controller.signal,
              onStart: () => {
                if (stale() || controller.signal.aborted || speakAbortRef.current !== controller) {
                  return;
                }
                setPlayback("playing");
                setAudioActive(true);
              },
            });
            if (stale() || controller.signal.aborted) return { ok: false, reason: "aborted" };
            return { ok: true };
          } catch (browserError) {
            if (
              stale() ||
              controller.signal.aborted ||
              browserError?.name === "AbortError" ||
              browserError?.code === "aborted"
            ) {
              return { ok: false, reason: "aborted" };
            }
          }
        }
        const message = error?.message || "CHIEF could not speak that response.";
        setSpeechError(message);
        return { ok: false, reason: "error", error: message };
      } finally {
        if (!stale()) releaseAudioHold();
        if (speakAbortRef.current === controller) {
          speakAbortRef.current = null;
          setPlayback("idle");
          setAudioActive(false);
        }
      }
    },
    [openAudioContext, releaseAudioHold]
  );

  const toggleListening = useCallback(() => {
    const input = speechRef.current;
    if (!input) return;
    if (listening) {
      input.abort();
      setListening(false);
      setInterim("");
      return;
    }
    stopSpeaking();
    setSpeechError("");
    ensureAudio();
    void meterRef.current?.start();
    try {
      input.start();
    } catch (error) {
      setSpeechError(error?.message || "Speech recognition could not start.");
    }
  }, [ensureAudio, listening, stopSpeaking]);

  const consumeVoiceTurn = useCallback(() => {
    const armed = voiceTurnRef.current;
    voiceTurnRef.current = false;
    return armed;
  }, []);

  const chooseVoice = useCallback(
    (next) => {
      voiceIdRef.current = next;
      setVoiceId(next);
      writeChiefVoiceId(sessionUid, next);
    },
    [sessionUid]
  );

  return {
    voices,
    voicesLoading,
    voicesError,
    voiceId,
    chooseVoice,
    retryVoices: () => setVoiceAttempt((value) => value + 1),
    listening,
    interim,
    audioActive,
    playback,
    speechError,
    toggleListening,
    stopListening,
    stopSpeaking,
    clearSpeechError,
    reportSpeechError,
    speakAnswer,
    ensureAudio,
    releaseAudioHold,
    audioLevelRef,
    consumeVoiceTurn,
  };
}
