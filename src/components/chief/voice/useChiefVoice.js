// ChiefPage owns this controller. Speech becomes sendMessage on the open session.

import { useCallback, useEffect, useRef, useState } from "react";
import { recordChiefVoiceTrace } from "../../../utils/chiefApi.js";
import { createAudioLevel } from "./audioLevel.js";
import { createSpeechInput } from "./speechInput.js";
import { createSpeechOutput, unlockSpeechPlayback } from "./speechOutput.js";
import {
  VOICE_PHASE,
  recognitionErrorCode,
  transcriptForTurn,
  voiceErrorMessage,
} from "./voiceMachine.js";
import { readVoiceSettings } from "./voiceSettings.js";
import { shouldSpeakReply } from "../../../utils/chiefPreferences.js";

const LISTEN_LIMIT_MS = 45000;
const SPEAK_LIMIT_MS = 120000;
const ERROR_LIMIT_MS = 4000;

export function useChiefVoice({
  user,
  sessionIdRef,
  sendMessageRef,
  abortTurnRef,
  silenceRef,
  setTurnError,
  preferences = null,
  speakReplyRef = null,
}) {
  const userRef = useRef(user);
  userRef.current = user;
  const [phase, setPhaseState] = useState(VOICE_PHASE.IDLE);
  const phaseRef = useRef(VOICE_PHASE.IDLE);
  const [interim, setInterim] = useState("");
  const [submittedLine, setSubmittedLine] = useState("");
  const epochRef = useRef(0);
  const kindRef = useRef("reply");
  const timerRef = useRef(null);
  const settingsRef = useRef(readVoiceSettings());
  const preferencesRef = useRef(preferences);
  const audioRef = useRef(null);
  const inputRef = useRef(null);
  const outputRef = useRef(null);
  if (!audioRef.current) audioRef.current = createAudioLevel();

  function trace(event, detail) {
    const current = userRef.current;
    if (!current) return;
    const sessionId = sessionIdRef?.current || undefined;
    recordChiefVoiceTrace(current, { event, sessionId, detail }).catch(() => {});
  }

  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function setPhase(next) {
    phaseRef.current = next;
    setPhaseState(next);
    clearTimer();
    if (next === VOICE_PHASE.ERROR) {
      timerRef.current = setTimeout(() => {
        if (phaseRef.current === VOICE_PHASE.ERROR) setPhase(VOICE_PHASE.IDLE);
      }, ERROR_LIMIT_MS);
    } else if (next === VOICE_PHASE.LISTENING) {
      timerRef.current = setTimeout(() => {
        if (phaseRef.current === VOICE_PHASE.LISTENING) cancelListening();
      }, LISTEN_LIMIT_MS);
    } else if (next === VOICE_PHASE.SPEAKING) {
      timerRef.current = setTimeout(() => {
        if (phaseRef.current !== VOICE_PHASE.SPEAKING) return;
        outputRef.current?.stop();
        trace("voice.tts_stopped", { stage: "tts" });
        setPhase(VOICE_PHASE.IDLE);
      }, SPEAK_LIMIT_MS);
    }
  }

  function releaseInput() {
    inputRef.current?.cancel();
    void audioRef.current?.stop();
  }

  function fail(stage, code, message) {
    epochRef.current += 1;
    releaseInput();
    outputRef.current?.stop();
    setInterim("");
    setTurnError?.(message || voiceErrorMessage(code));
    setPhase(VOICE_PHASE.ERROR);
    trace("voice.error", { stage, code });
  }

  function cancelListening() {
    releaseInput();
    setInterim("");
    setPhase(VOICE_PHASE.IDLE);
  }

  function ensureOutput() {
    if (outputRef.current) return outputRef.current;
    outputRef.current = createSpeechOutput({
      getUser: () => userRef.current,
      getSettings: () => settingsRef.current,
      onStart: ({ provider }) => {
        const test = kindRef.current === "test";
        const allowed = test
          ? phaseRef.current === VOICE_PHASE.IDLE || phaseRef.current === VOICE_PHASE.SPEAKING
          : phaseRef.current === VOICE_PHASE.THINKING || phaseRef.current === VOICE_PHASE.IDLE;
        if (!allowed) {
          outputRef.current?.stop();
          return;
        }
        setInterim("");
        if (!test) setSubmittedLine("");
        setPhase(VOICE_PHASE.SPEAKING);
        trace("voice.tts_started", {
          stage: "tts",
          provider: provider === "browser" ? "browser" : "elevenlabs",
        });
      },
      onEnd: ({ provider }) => {
        if (phaseRef.current === VOICE_PHASE.SPEAKING) setPhase(VOICE_PHASE.IDLE);
        trace("voice.tts_completed", {
          stage: "tts",
          provider: provider === "browser" ? "browser" : "elevenlabs",
        });
      },
      onError: (error) => {
        const code = typeof error?.code === "string" ? error.code : "provider_error";
        fail("tts", code);
      },
    });
    return outputRef.current;
  }

  async function handleFinal(text) {
    if (phaseRef.current !== VOICE_PHASE.LISTENING) return;
    releaseInput();
    setInterim("");
    trace("voice.transcription_completed", { stage: "stt" });
    const transcript = transcriptForTurn(text);
    if (!transcript) {
      setPhase(VOICE_PHASE.IDLE);
      return;
    }
    const epoch = epochRef.current;
    setSubmittedLine(transcript);
    setPhase(VOICE_PHASE.THINKING);
    trace("voice.request_submitted", { stage: "turn" });
    let result;
    try {
      result = await sendMessageRef.current?.(transcript, { source: "voice" });
    } catch {
      if (epochRef.current !== epoch || phaseRef.current !== VOICE_PHASE.THINKING) return;
      fail("turn", "network");
      return;
    }
    if (epochRef.current !== epoch || phaseRef.current !== VOICE_PHASE.THINKING) return;
    if (result?.aborted) return;
    if (result?.approval) {
      setSubmittedLine("");
      setPhase(VOICE_PHASE.IDLE);
      return;
    }
    if (!result?.ok || typeof result.text !== "string" || !result.text.trim()) {
      fail("turn", "turn_failed", result?.error || "");
      return;
    }
    if (!shouldSpeakReply({ source: "voice", preferences: preferencesRef?.current })) {
      setSubmittedLine("");
      setPhase(VOICE_PHASE.IDLE);
      return;
    }
    kindRef.current = "reply";
    await ensureOutput().speak(result.text);
  }

  function ensureInput() {
    if (inputRef.current) return inputRef.current;
    inputRef.current = createSpeechInput({
      onInterim: (text) => {
        if (phaseRef.current === VOICE_PHASE.LISTENING) setInterim(text);
      },
      onFinal: (text) => {
        void handleFinal(text);
      },
      onError: (error) => {
        if (phaseRef.current !== VOICE_PHASE.LISTENING && phaseRef.current !== VOICE_PHASE.IDLE) {
          return;
        }
        const code = error === "unsupported" ? "unsupported" : recognitionErrorCode(error);
        if (!code) return;
        fail("stt", code);
      },
      onEnd: ({ finalSeen } = {}) => {
        if (phaseRef.current === VOICE_PHASE.LISTENING && !finalSeen) cancelListening();
      },
    });
    return inputRef.current;
  }

  function beginListening() {
    if (!userRef.current) {
      setTurnError?.("Sign in to talk with CHIEF.");
      setPhase(VOICE_PHASE.ERROR);
      return;
    }
    epochRef.current += 1;
    setSubmittedLine("");
    setInterim("");
    setTurnError?.("");
    const input = ensureInput();
    if (!input.supported) {
      fail("stt", "unsupported");
      return;
    }
    let started;
    try {
      started = input.start();
    } catch {
      fail("stt", "stt_error");
      return;
    }
    if (!started || phaseRef.current === VOICE_PHASE.ERROR) return;
    setPhase(VOICE_PHASE.LISTENING);
    trace("voice.listen_started", { stage: "stt" });
    void audioRef.current.start();
  }

  function onCoreTap() {
    unlockSpeechPlayback();
    const current = phaseRef.current;
    if (current === VOICE_PHASE.LISTENING) {
      cancelListening();
      return;
    }
    if (current === VOICE_PHASE.SPEAKING) {
      ensureOutput().stop();
      trace("voice.interrupted", { stage: "playback" });
      trace("voice.tts_stopped", { stage: "tts" });
      beginListening();
      return;
    }
    if (current === VOICE_PHASE.THINKING) {
      epochRef.current += 1;
      abortTurnRef.current?.();
      ensureOutput().stop();
      trace("voice.interrupted", { stage: "turn" });
      beginListening();
      return;
    }
    beginListening();
  }

  function silence() {
    epochRef.current += 1;
    releaseInput();
    outputRef.current?.stop();
    setInterim("");
    setSubmittedLine("");
    if (phaseRef.current !== VOICE_PHASE.IDLE) setPhase(VOICE_PHASE.IDLE);
  }

  useEffect(() => {
    if (!silenceRef) return undefined;
    silenceRef.current = silence;
    return undefined;
  });

  async function testVoice(settings) {
    if (settings) settingsRef.current = settings;
    if (phaseRef.current !== VOICE_PHASE.IDLE || !userRef.current) return;
    kindRef.current = "test";
    unlockSpeechPlayback();
    await ensureOutput().speak("CHIEF is ready.");
  }

  const updateSettings = useCallback((settings) => {
    settingsRef.current = settings;
  }, []);

  async function speakTypedReply(text) {
    if (!shouldSpeakReply({ source: "text", preferences: preferencesRef?.current })) return;
    if (phaseRef.current !== VOICE_PHASE.IDLE || !userRef.current) return;
    kindRef.current = "reply";
    unlockSpeechPlayback();
    await ensureOutput().speak(text);
  }

  useEffect(() => {
    preferencesRef.current = preferences;
    if (speakReplyRef) speakReplyRef.current = speakTypedReply;
  });

  useEffect(() => {
    return () => {
      epochRef.current += 1;
      clearTimer();
      inputRef.current?.cancel();
      void audioRef.current?.stop();
      outputRef.current?.stop();
    };
  }, []);

  const signedIn = Boolean(user);
  const [trackedSignIn, setTrackedSignIn] = useState(signedIn);
  if (signedIn !== trackedSignIn) {
    setTrackedSignIn(signedIn);
    if (!signedIn) {
      setInterim("");
      setSubmittedLine("");
      setPhaseState(VOICE_PHASE.IDLE);
    }
  }

  useEffect(() => {
    if (user) return undefined;
    epochRef.current += 1;
    phaseRef.current = VOICE_PHASE.IDLE;
    clearTimer();
    inputRef.current?.cancel();
    void audioRef.current?.stop();
    outputRef.current?.stop();
    return undefined;
  }, [user]);

  const caption =
    phase === VOICE_PHASE.LISTENING ? interim : phase === VOICE_PHASE.THINKING ? submittedLine : "";

  return {
    phase,
    audioLevelRef: audioRef.current.levelRef,
    caption,
    onCoreTap,
    testVoice,
    updateSettings,
    speakTypedReply,
  };
}
