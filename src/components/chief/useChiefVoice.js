import { useCallback, useEffect, useRef, useState } from "react";
import { fetchChiefSpeech, fetchChiefVoices } from "../../utils/chiefApi.js";
import { createChiefSpeechInput, playChiefSpeech } from "../../utils/chiefSpeech.js";
import { readChiefVoiceId, writeChiefVoiceId } from "../../utils/chiefVoicePreference.js";

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

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    voiceIdRef.current = voiceId;
  }, [voiceId]);

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
      setVoiceId((current) => {
        const stored = current || readChiefVoiceId(sessionUid);
        const match = list.some((voice) => voice.voice_id === stored);
        const next = match ? stored : list[0].voice_id;
        writeChiefVoiceId(sessionUid, next);
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
      },
      onInterim: (text) => setInterim(text),
      onTranscript: (text) => {
        setInterim("");
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

  const markSpeaking = useCallback(() => {
    setAudioActive(true);
  }, []);

  const stopListening = useCallback(() => {
    speechRef.current?.abort();
    setListening(false);
    setInterim("");
  }, []);

  const speakAnswer = useCallback(
    async (text) => {
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
      speakAbortRef.current?.abort();
      const controller = new AbortController();
      speakAbortRef.current = controller;
      setAudioActive(true);
      setSpeechError("");
      try {
        const response = await fetchChiefSpeech({
          user: currentUser,
          text: spoken,
          voiceId: selected,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        await playChiefSpeech(response, {
          audioContext: ensureAudio(),
          signal: controller.signal,
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
    try {
      input.start();
    } catch (error) {
      setSpeechError(error?.message || "Speech recognition could not start.");
    }
  }, [ensureAudio, listening]);

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
    markSpeaking,
    speakAnswer,
    ensureAudio,
  };
}
