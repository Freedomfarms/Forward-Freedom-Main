import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChiefSpeech, fetchChiefVoices } from "../../utils/chiefApi.js";
import { createChiefSpeechInput, playChiefSpeech } from "../../utils/chiefSpeech.js";
import {
  readChiefVoiceId,
  selectChiefVoiceId,
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
  const [speechError, setSpeechError] = useState("");
  const [voiceAttempt, setVoiceAttempt] = useState(0);

  if (voiceScope !== sessionUid) {
    setVoiceScope(sessionUid);
    setVoiceId(readChiefVoiceId(sessionUid) || "");
  }

  const voiceIdRef = useRef(voiceId);
  const speakAbortRef = useRef(null);
  const audioCtxRef = useRef(null);
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
        const next = selectChiefVoiceId(list, { stored, configured });
        if (next) writeChiefVoiceId(sessionUid, next);
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

  const ensureAudio = useCallback(() => {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === "suspended") void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const stopSpeaking = useCallback(() => {
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    setAudioActive(false);
  }, []);

  const stopListening = useCallback(() => {
    speechRef.current?.abort();
    setListening(false);
    setInterim("");
    void meterRef.current?.stop();
  }, []);

  const speakAnswer = useCallback(
    async (text, settingsOverride) => {
      const spoken = typeof text === "string" ? text.trim() : "";
      const selected = voiceIdRef.current;
      const currentUser = userRef.current;
      if (!spoken || !currentUser) {
        setAudioActive(false);
        return;
      }
      if (!selected) {
        setAudioActive(false);
        setSpeechError("Select an ElevenLabs voice before CHIEF can speak.");
        return;
      }
      const saved = readVoiceSettings();
      const voiceSettings = settingsOverride
        ? normalizeVoiceSettings({ ...saved, ...settingsOverride })
        : saved;
      speakAbortRef.current?.abort();
      const controller = new AbortController();
      speakAbortRef.current = controller;
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
        if (controller.signal.aborted) return;
        await playChiefSpeech(response, {
          audioContext: ensureAudio(),
          signal: controller.signal,
          onPlaybackStart: () => {
            if (!controller.signal.aborted && speakAbortRef.current === controller) {
              setAudioActive(true);
            }
          },
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setSpeechError(error?.message || "CHIEF could not speak that response.");
      } finally {
        if (speakAbortRef.current === controller) {
          speakAbortRef.current = null;
          setAudioActive(false);
        }
      }
    },
    [ensureAudio]
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
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    setAudioActive(false);
    setSpeechError("");
    ensureAudio();
    void meterRef.current?.start();
    try {
      input.start();
    } catch (error) {
      setSpeechError(error?.message || "Speech recognition could not start.");
    }
  }, [ensureAudio, listening]);

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
    speechError,
    toggleListening,
    stopListening,
    stopSpeaking,
    speakAnswer,
    ensureAudio,
    audioLevelRef,
    consumeVoiceTurn,
  };
}
