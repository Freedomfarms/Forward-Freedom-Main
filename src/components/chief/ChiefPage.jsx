import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHIEF_STATUS,
  acceptChiefSubmission,
  applyChiefEvent,
  decideChiefApproval,
  deleteChiefSession,
  fetchChiefHistory,
  fetchChiefModels,
  fetchChiefPendingApproval,
  fetchChiefRoomAccess,
  fetchChiefSessionSearch,
  fetchChiefSessions,
  initialTurnState,
  isActiveChiefTurn,
  renameChiefSession,
  restoredChiefTurn,
  selectChiefModel,
  setChiefSessionArchived,
  streamChiefChat,
} from "../../utils/chiefApi.js";
import { currentTurn, emptyRoomAccess, moneyWebLine } from "../../utils/chiefRoom.js";
import {
  discardLegacyChiefActiveSessionKey,
  readChiefActiveSessionId,
  writeChiefActiveSessionId,
} from "../../utils/chiefActiveSession.js";
import { conversationSearchTarget } from "../../utils/chiefConversationWorkspace.js";
import { scenePhaseForInteraction, visualStateForInteraction } from "./apexVisualState.js";
import { ChiefAccessSheet } from "./ChiefAccessSheet.jsx";
import { ChiefInterface } from "./ChiefInterface.jsx";
import { ChiefApprovalCard } from "./ChiefApprovalCard.jsx";
import { ChiefConversationList } from "./ChiefConversationList.jsx";
import { ChiefEarlierTurns, ChiefTranscript } from "./ChiefTranscript.jsx";
import { ChiefSettings } from "./ChiefSettings.jsx";
import { useChiefVoice } from "./useChiefVoice.js";
import {
  readChiefPreferences,
  shouldShowAssistantText,
  shouldSpeakReply,
  writeChiefPreferences,
} from "../../utils/chiefPreferences.js";
import { classifySettledDelivery, speakCompletedReply } from "../../utils/chiefReplySpeech.js";
import { isSpeakableTurn } from "../../utils/chiefProtocol.js";
import {
  CHIEF_FOLLOW_CONNECTION,
  canAutoSpeak,
  followManagedTurn,
} from "../../utils/chiefFollow.js";
import {
  isRevealedAnswer,
  readRevealedAnswers,
  rememberRevealedAnswer,
} from "../../utils/chiefRevealedAnswers.js";

function errorText(error) {
  return error?.message || "CHIEF could not complete that request.";
}

function waitForAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function profileName(user) {
  const name = typeof user?.displayName === "string" ? user.displayName.trim() : "";
  if (name) return name.split(/\s+/)[0];
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  if (!email.includes("@")) return "";
  return email.split("@")[0];
}

export function ChiefPage({ user, embedded = false, onOpenFinancial, onOpenAgents, onSignOut }) {
  const sessionUid = typeof user?.uid === "string" ? user.uid : "";
  const [sessions, setSessions] = useState([]);
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [sessionsResolved, setSessionsResolved] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(CHIEF_STATUS.READY);
  const [turnStatus, setTurnStatus] = useState("");
  const [streamText, setStreamText] = useState("");
  const [turnError, setTurnError] = useState("");
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [navQuery, setNavQuery] = useState("");
  const [searchState, setSearchState] = useState({
    query: "",
    hits: [],
    loading: false,
    error: "",
  });
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [room, setRoom] = useState("home");
  const [accessOpen, setAccessOpen] = useState(false);
  const [access, setAccess] = useState(emptyRoomAccess);
  const [now, setNow] = useState(() => new Date());
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState(null);
  const [modelRoute, setModelRoute] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("voice");
  const [archiveFocusId, setArchiveFocusId] = useState("");
  const [preferences, setPreferences] = useState(() => readChiefPreferences());
  const [speechStopped, setSpeechStopped] = useState(false);
  const [revealedAnswers, setRevealedAnswers] = useState(() =>
    readRevealedAnswers(sessionUid, readChiefActiveSessionId(sessionUid))
  );
  const [focusConversationSearch, setFocusConversationSearch] = useState(false);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const activeSessionIdRef = useRef(null);
  const lastTextRef = useRef("");
  const answerRef = useRef(null);
  const composerRef = useRef(null);
  const sendRef = useRef(() => {});
  const speechEpoch = useRef(0);
  const speakOnSettleRef = useRef(false);
  const turnStatusRef = useRef("");
  const answerTextRef = useRef("");
  const preferencesRef = useRef(preferences);
  const voice = useChiefVoice({
    user,
    sessionUid,
    onTranscript: (text) => sendRef.current(text),
  });

  const readStoredSessionId = useCallback(() => {
    discardLegacyChiefActiveSessionKey();
    return readChiefActiveSessionId(sessionUid);
  }, [sessionUid]);

  const writeStoredSessionId = useCallback(
    (sessionId) => {
      discardLegacyChiefActiveSessionKey();
      writeChiefActiveSessionId(sessionUid, sessionId);
    },
    [sessionUid]
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const turnView = useMemo(() => currentTurn(messages, streamText), [messages, streamText]);

  useEffect(() => {
    preferencesRef.current = preferences;
    answerTextRef.current = turnView.answer;
  });

  const revealScopeKey = `${sessionUid}:${activeSessionId || ""}`;
  const [revealScope, setRevealScope] = useState(revealScopeKey);
  if (revealScope !== revealScopeKey) {
    setRevealScope(revealScopeKey);
    setRevealedAnswers(readRevealedAnswers(sessionUid, activeSessionId));
  }
  const activeArchived = archivedSessions.some((session) => session.sessionId === activeSessionId);

  function setBusyState(value) {
    busyRef.current = value;
    setBusy(value);
  }

  const streamTurn = useCallback(
    ({ sessionId, text, resume, signal, onEvent }) =>
      streamChiefChat({ user, sessionId, text, resume, signal, onEvent }),
    [user]
  );

  function stopActiveTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function commitAcceptedUser(turn) {
    const text = typeof turn?.acceptedUserText === "string" ? turn.acceptedUserText.trim() : "";
    if (!text) return turn;
    setDraft((current) => (current.trim() === text ? "" : current));
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.role === "user" && last.text === text) return current;
      return [...current, { role: "user", text }];
    });
    return { ...turn, acceptedUserText: "" };
  }

  const refreshSessions = useCallback(async () => {
    const [active, archived] = await Promise.all([
      fetchChiefSessions(user),
      fetchChiefSessions(user, { archived: true }),
    ]);
    setSessions(Array.isArray(active?.sessions) ? active.sessions : []);
    setArchivedSessions(Array.isArray(archived?.sessions) ? archived.sessions : []);
    setSessionsError("");
  }, [user]);

  const refreshAccess = useCallback(async () => {
    if (!user) return;
    setAccess(await fetchChiefRoomAccess(user));
  }, [user]);

  const loadHistory = useCallback(
    async (sessionId, token = generation.current) => {
      if (!sessionId) return;
      setHistoryLoading(true);
      setHistoryError("");
      setNotFound(false);
      try {
        const payload = await fetchChiefHistory(user, sessionId);
        if (token !== generation.current) return;
        const restored = restoredChiefTurn({
          messages: payload?.messages,
          turnStatus: payload?.turnStatus,
          heldPrompt: payload?.heldPrompt,
          turnError: payload?.turnError,
        });
        setMessages(restored.messages);
        setModelRoute(typeof payload?.modelRoute === "string" ? payload.modelRoute : null);
        const pending = await fetchChiefPendingApproval(user, sessionId).catch(() => null);
        if (token !== generation.current) return;
        setApproval(pending);
        setTurnError(restored.error || "");
        setTurnStatus(restored.turnStatus);
        setStatus(pending ? CHIEF_STATUS.APPROVAL : restored.status);
        setStreamText("");
        if (restored.heldPrompt) {
          setDraft((current) => (current.trim() ? current : restored.heldPrompt));
        }
      } catch (error) {
        if (token !== generation.current) return;
        if (error?.status === 404) {
          setNotFound(true);
          setMessages([]);
          setModelRoute(null);
          setApproval(null);
          writeStoredSessionId(null);
        } else {
          setHistoryError(errorText(error));
        }
      } finally {
        if (token === generation.current) setHistoryLoading(false);
      }
    },
    [user, writeStoredSessionId]
  );

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchChiefModels(user)
      .then((payload) => {
        if (cancelled) return;
        setModels(Array.isArray(payload?.models) ? payload.models : []);
        setDefaultModel(typeof payload?.defaultModel === "string" ? payload.defaultModel : null);
      })
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setDefaultModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const token = generation.current;
    Promise.all([fetchChiefSessions(user), fetchChiefSessions(user, { archived: true })])
      .then(([active, archived]) => {
        if (cancelled) return null;
        setSessions(Array.isArray(active?.sessions) ? active.sessions : []);
        setArchivedSessions(Array.isArray(archived?.sessions) ? archived.sessions : []);
        setSessionsError("");
        setSessionsResolved(true);
        const stored = readStoredSessionId();
        if (stored) {
          setActiveSessionId(stored);
          return loadHistory(stored, token);
        }
        return null;
      })
      .catch((error) => {
        if (cancelled) return;
        setSessionsError(errorText(error));
        setSessionsResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user, loadHistory, readStoredSessionId]);

  useEffect(() => {
    const active = abortRef;
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, []);

  useEffect(() => {
    const node = answerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turnView.answer, streamText]);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchChiefRoomAccess(user).then((next) => {
      if (!cancelled) setAccess(next);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    function onResize() {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--chief-keyboard", `${Math.round(inset)}px`);
    }
    onResize();
    viewport.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", onResize);
    return () => {
      viewport.removeEventListener("resize", onResize);
      viewport.removeEventListener("scroll", onResize);
      document.documentElement.style.removeProperty("--chief-keyboard");
    };
  }, []);

  useEffect(() => {
    const query = navQuery.trim();
    if (!user || !query) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchState((current) => ({ ...current, query, loading: true, error: "" }));
      fetchChiefSessionSearch(user, query)
        .then((payload) => {
          if (cancelled) return;
          setSearchState({
            query,
            hits: Array.isArray(payload?.conversations) ? payload.conversations : [],
            loading: false,
            error: "",
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchState({
            query,
            hits: [],
            loading: false,
            error: error?.status === 400 ? "" : errorText(error),
          });
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [navQuery, searchAttempt, user]);

  useEffect(() => {
    if (!accessOpen && !settingsOpen) return undefined;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setAccessOpen(false);
      setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accessOpen, settingsOpen]);

  useEffect(() => {
    turnStatusRef.current = turnStatus;
  }, [turnStatus]);

  const openFollowKey =
    !user || busy || !isActiveChiefTurn(turnStatus) ? "" : activeSessionId || "";

  useEffect(() => {
    if (!openFollowKey) return undefined;
    const sessionAtStart = openFollowKey;
    const controller = new AbortController();
    let cancelled = false;
    // This path updates a conversation that is already open and not inside
    // sendMessage. It does not speak. Speech stays with the send gesture.
    followManagedTurn({
      sessionId: sessionAtStart,
      isCurrent: () =>
        !cancelled && !controller.signal.aborted && activeSessionIdRef.current === sessionAtStart,
      wait: (ms) => waitForAbort(ms, controller.signal),
      onUpdate: (turn, info) => {
        if (cancelled || activeSessionIdRef.current !== sessionAtStart) return;
        setHistoryError(info?.connectionError ? CHIEF_FOLLOW_CONNECTION : "");
        setTurnStatus(isActiveChiefTurn(turn.turnStatus) ? turn.turnStatus : "continuing");
        setStatus(turn.streamText ? CHIEF_STATUS.RESPONDING : CHIEF_STATUS.WORKING);
        if (turn.streamText) setStreamText(turn.streamText);
      },
      stream: async () => {
        let turn = {
          ...initialTurnState(sessionAtStart),
          turnStatus: "continuing",
          finished: false,
        };
        await streamTurn({
          sessionId: sessionAtStart,
          text: "",
          resume: true,
          signal: controller.signal,
          onEvent: (event) => {
            if (controller.signal.aborted) return;
            turn = commitAcceptedUser(applyChiefEvent(turn, event));
            if (activeSessionIdRef.current !== sessionAtStart) return;
            if (turn.streamText) setStreamText(turn.streamText);
            if (!isActiveChiefTurn(turn.turnStatus)) return;
            setTurnStatus(turn.turnStatus);
            setStatus(
              turn.streamText ? CHIEF_STATUS.RESPONDING : turn.status || CHIEF_STATUS.WORKING
            );
          },
        });
        return turn;
      },
      readHistory: (id) => fetchChiefHistory(user, id),
    })
      .then(async (followed) => {
        if (cancelled || activeSessionIdRef.current !== sessionAtStart) return;
        if (followed.reason !== "settled") return;
        try {
          const payload = followed.turn?.history || (await fetchChiefHistory(user, sessionAtStart));
          if (cancelled || activeSessionIdRef.current !== sessionAtStart) return;
          const historyMessages = Array.isArray(payload?.messages) ? payload.messages : [];
          if (historyMessages.length) setMessages(historyMessages);
          setStreamText("");
          const nextStatus = typeof payload?.turnStatus === "string" ? payload.turnStatus : "";
          if (isActiveChiefTurn(nextStatus)) {
            setTurnStatus(nextStatus);
            return;
          }
          setTurnStatus("");
          setHistoryError("");
          setStatus(nextStatus === "suspended" ? CHIEF_STATUS.APPROVAL : CHIEF_STATUS.READY);
          if (nextStatus === "suspended") {
            const pending = await fetchChiefPendingApproval(user, sessionAtStart).catch(() => null);
            if (!cancelled && activeSessionIdRef.current === sessionAtStart && pending) {
              setApproval(pending);
            }
          }
        } catch (error) {
          if (!cancelled && error?.status !== 404) setHistoryError(errorText(error));
        }
      })
      .catch((error) => {
        if (!cancelled && error?.name !== "AbortError") setHistoryError(errorText(error));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [openFollowKey, streamTurn, user]);

  function revealStoredAnswer(text, sessionId = activeSessionIdRef.current) {
    const saved = rememberRevealedAnswer(sessionUid, sessionId, text);
    if (saved) setRevealedAnswers(saved);
  }

  function selectSession(sessionId) {
    speechEpoch.current += 1;
    speakOnSettleRef.current = false;
    setSpeechStopped(false);
    setRevealedAnswers(readRevealedAnswers(sessionUid, sessionId));
    stopActiveTurn();
    voice.stopListening();
    voice.stopSpeaking();
    voice.clearSpeechError();
    generation.current += 1;
    const token = generation.current;
    setActiveSessionId(sessionId);
    writeStoredSessionId(sessionId);
    setStreamText("");
    setTurnError("");
    setDraft("");
    setBusyState(false);
    setMessages([]);
    setModelRoute(null);
    loadHistory(sessionId, token);
  }

  function startNewConversation() {
    speechEpoch.current += 1;
    speakOnSettleRef.current = false;
    setSpeechStopped(false);
    setRevealedAnswers(readRevealedAnswers(sessionUid, null));
    stopActiveTurn();
    voice.stopListening();
    voice.stopSpeaking();
    voice.clearSpeechError();
    generation.current += 1;
    setActiveSessionId(null);
    writeStoredSessionId(null);
    setMessages([]);
    setModelRoute(null);
    setStreamText("");
    setApproval(null);
    setTurnError("");
    setHistoryError("");
    setNotFound(false);
    setHistoryLoading(false);
    setTurnStatus("");
    setStatus(CHIEF_STATUS.READY);
    setBusyState(false);
    setDraft("");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function refreshSearch() {
    setSearchAttempt((value) => value + 1);
  }

  async function renameConversation(sessionId, title) {
    const payload = await renameChiefSession(user, sessionId, title);
    const nextTitle = payload?.session?.title ?? title.trim();
    const apply = (rows) =>
      rows.map((row) => (row.sessionId === sessionId ? { ...row, title: nextTitle } : row));
    setSessions(apply);
    setArchivedSessions(apply);
    setSearchState((current) => ({
      ...current,
      hits: current.hits.map((row) =>
        row.sessionId === sessionId ? { ...row, title: nextTitle } : row
      ),
    }));
  }

  async function archiveConversation(sessionId) {
    await setChiefSessionArchived(user, sessionId, true);
    await refreshSessions();
    refreshSearch();
  }

  async function restoreConversation(sessionId) {
    await setChiefSessionArchived(user, sessionId, false);
    await refreshSessions();
    refreshSearch();
  }

  async function deleteConversation(sessionId) {
    await deleteChiefSession(user, sessionId);
    if (activeSessionIdRef.current === sessionId) startNewConversation();
    await refreshSessions();
    refreshSearch();
  }

  function backToConversations() {
    speechEpoch.current += 1;
    speakOnSettleRef.current = false;
    setTurnStatus("");
    setSpeechStopped(false);
    stopActiveTurn();
    voice.stopListening();
    voice.stopSpeaking();
    voice.clearSpeechError();
    setNotFound(false);
    setActiveSessionId(null);
    setMessages([]);
    setApproval(null);
    setStatus(CHIEF_STATUS.READY);
    writeStoredSessionId(null);
    setRoom("convos");
  }

  // Typed text and speech transcripts both enter here. The session id is the
  // open conversation, so voice and text share one TurnMachine history.
  async function sendMessage(
    text,
    { appendUser = true, sessionId = activeSessionIdRef.current } = {}
  ) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    const source = voice.consumeVoiceTurn() ? "voice" : "text";
    if (!trimmed || !user) return;
    const gate = acceptChiefSubmission({
      busy: busyRef.current,
      turnStatus: turnStatusRef.current,
      text: trimmed,
    });
    if (gate.action !== "send") {
      if (gate.action === "preserve") setDraft(gate.draft);
      return;
    }
    speechEpoch.current += 1;
    const epoch = speechEpoch.current;
    speakOnSettleRef.current = false;
    setSpeechStopped(false);
    voice.clearSpeechError();
    voice.stopListening();
    voice.stopSpeaking({ preserveHold: true });
    voice.ensureAudio();
    try {
      if (archivedSessions.some((session) => session.sessionId === sessionId)) {
        setTurnError("This conversation is archived. Restore it before sending.");
        return;
      }
      lastTextRef.current = trimmed;
      stopActiveTurn();
      const controller = new AbortController();
      abortRef.current = controller;
      generation.current += 1;
      const turnToken = generation.current;
      const releaseBusy = () => {
        if (generation.current === turnToken) setBusyState(false);
      };
      setBusyState(true);
      setTurnError("");
      setHistoryError("");
      setApproval(null);
      setStreamText("");
      setStatus(CHIEF_STATUS.WORKING);
      setTurnStatus("running");
      speakOnSettleRef.current = true;
      setDraft("");
      if (appendUser) {
        setMessages((current) => [...current, { role: "user", text: trimmed }]);
      }
      let turn = initialTurnState(sessionId);
      const applyEvent = (event) => {
        if (controller.signal.aborted) return;
        turn = commitAcceptedUser(applyChiefEvent(turn, event));
        const displayStatus =
          turn.finished && turn.status === CHIEF_STATUS.READY
            ? turn.streamText
              ? CHIEF_STATUS.RESPONDING
              : CHIEF_STATUS.WORKING
            : turn.status;
        setStatus(displayStatus);
        setTurnStatus(turn.turnStatus || "");
        setStreamText(turn.streamText);
        if (turn.sessionId && turn.sessionId !== activeSessionIdRef.current) {
          activeSessionIdRef.current = turn.sessionId;
          setActiveSessionId(turn.sessionId);
          writeStoredSessionId(turn.sessionId);
        }
        if (turn.approval) setApproval(turn.approval);
        if (turn.error) setTurnError(turn.error);
      };
      const stillThisTurn = () => !controller.signal.aborted && abortRef.current === controller;
      const followed = await followManagedTurn({
        sessionId,
        isCurrent: stillThisTurn,
        wait: (ms) => waitForAbort(ms, controller.signal),
        onUpdate: (next, info) => {
          if (!stillThisTurn()) return;
          turn = next;
          setHistoryError(info?.connectionError ? CHIEF_FOLLOW_CONNECTION : "");
          setTurnStatus(isActiveChiefTurn(next.turnStatus) ? next.turnStatus : "continuing");
          setStatus(next.streamText ? CHIEF_STATUS.RESPONDING : CHIEF_STATUS.WORKING);
          if (next.streamText) setStreamText(next.streamText);
        },
        stream: async ({ resume, sessionId: streamSession }) => {
          await streamTurn({
            sessionId: resume ? streamSession : sessionId,
            text: trimmed,
            resume,
            signal: controller.signal,
            onEvent: applyEvent,
          });
          return turn;
        },
        readHistory: (id) => fetchChiefHistory(user, id),
      });
      if (!stillThisTurn() || followed.reason === "cancelled") return;
      if (followed.reason === "error") {
        setStatus(CHIEF_STATUS.ERROR);
        setTurnStatus("");
        setTurnError(errorText(followed.error));
        releaseBusy();
        return;
      }
      turn = followed.turn || turn;

      const sessionIdNow = turn.sessionId;
      let historyAnswer = "";
      if (abortRef.current !== controller) return;
      if (sessionIdNow && (turn.finished || turn.approval || turn.turnStatus === "suspended")) {
        try {
          const payload = await fetchChiefHistory(user, sessionIdNow);
          if (abortRef.current !== controller) return;
          const historyMessages = Array.isArray(payload?.messages) ? payload.messages : [];
          setMessages(historyMessages);
          setNotFound(false);
          if (turn.finished && turn.status !== CHIEF_STATUS.ERROR && !turn.error) {
            historyAnswer = currentTurn(historyMessages, "").answer;
          }
          if (historyAnswer) setStreamText("");
          if (isActiveChiefTurn(payload?.turnStatus) && !turn.finished) {
            turn = { ...turn, finished: false, turnStatus: payload.turnStatus };
          }
        } catch (error) {
          if (abortRef.current !== controller) return;
          if (error?.status === 404) {
            setNotFound(true);
            setMessages([]);
          } else {
            setHistoryError(errorText(error));
          }
        }
        try {
          await refreshSessions();
        } catch (error) {
          if (abortRef.current === controller) setSessionsError(errorText(error));
        }
      }
      if (abortRef.current !== controller) return;
      if (turn.approval || turn.turnStatus === "suspended") {
        setTurnStatus("");
        setStatus(CHIEF_STATUS.APPROVAL);
        if (sessionIdNow) {
          const pending = await fetchChiefPendingApproval(user, sessionIdNow).catch(() => null);
          if (abortRef.current !== controller) return;
          if (pending) setApproval(pending);
        }
      } else if (isActiveChiefTurn(turn.turnStatus)) {
        setApproval(null);
        setTurnStatus(turn.turnStatus);
        setStatus(turn.streamText ? CHIEF_STATUS.RESPONDING : CHIEF_STATUS.WORKING);
        releaseBusy();
        return;
      } else if (turn.status === CHIEF_STATUS.ERROR) {
        setApproval(null);
        setTurnStatus("");
        setStatus(CHIEF_STATUS.ERROR);
      } else {
        setApproval(null);
        setTurnStatus("");
      }
      void refreshAccess();
      const answerForReveal = (historyAnswer || turn.streamText || "").trim();
      const maySpeak = canAutoSpeak({
        aborted: controller.signal.aborted || abortRef.current !== controller,
        epoch,
        currentEpoch: speechEpoch.current,
        speak: speakOnSettleRef.current,
        sessionId: sessionIdNow,
        activeSessionId: activeSessionIdRef.current,
      });
      const speechInput = {
        streamText: turn.streamText,
        historyAnswer,
        finished: maySpeak && turn.finished === true,
        status: turn.status,
        error: turn.error,
        aborted: !maySpeak,
        source,
        turnStatus: turn.turnStatus,
        preferences: preferencesRef.current,
      };
      const settled =
        turn.finished === true &&
        !turn.error &&
        turn.status !== CHIEF_STATUS.ERROR &&
        !turn.approval &&
        turn.turnStatus !== "suspended" &&
        !isActiveChiefTurn(turn.turnStatus) &&
        isSpeakableTurn(turn.turnStatus);
      const plan = classifySettledDelivery({
        answer: answerForReveal,
        speak: settled && maySpeak && shouldSpeakReply({ preferences: preferencesRef.current }),
        settled,
      });
      if (plan.action === "missing_answer") {
        setTurnError(plan.message);
        setStatus(CHIEF_STATUS.ERROR);
        voice.clearSpeechError();
        releaseBusy();
        return;
      }
      const delivery = plan.action === "speak" ? speakCompletedReply(voice, speechInput) : null;
      if (!delivery?.pending) {
        if (!isActiveChiefTurn(turn.turnStatus) && turn.status !== CHIEF_STATUS.ERROR) {
          if (turn.turnStatus !== "suspended" && !turn.approval) setStatus(CHIEF_STATUS.READY);
        }
        releaseBusy();
        return;
      }
      setStatus(CHIEF_STATUS.RESPONDING);
      const result = await delivery.pending;
      if (speechEpoch.current !== epoch || activeSessionIdRef.current !== sessionIdNow) {
        if (!isActiveChiefTurn(turnStatusRef.current)) setStatus(CHIEF_STATUS.READY);
        releaseBusy();
        return;
      }
      releaseBusy();
      setStatus(CHIEF_STATUS.READY);
      const played = classifySettledDelivery({
        answer: answerForReveal,
        speak: true,
        settled: true,
        playback: result,
      });
      if (played.action === "spoken") return;
      if (played.text) revealStoredAnswer(played.text, sessionIdNow);
      if (played.action === "stopped") setSpeechStopped(true);
      else if (played.message) voice.reportSpeechError(played.message);
    } finally {
      if (speechEpoch.current === epoch) voice.releaseAudioHold?.();
    }
  }

  useEffect(() => {
    sendRef.current = sendMessage;
  });

  async function resolveApproval(decision) {
    if (!approval?.id || !activeSessionId || busyRef.current) return;
    setBusyState(true);
    setTurnError("");
    try {
      const result = await decideChiefApproval({
        user,
        sessionId: activeSessionId,
        approvalId: approval.id,
        decision,
      });
      const nextPending =
        result?.pendingApproval && typeof result.pendingApproval.id === "string"
          ? {
              id: result.pendingApproval.id,
              turnId:
                typeof result.pendingApproval.turnId === "string"
                  ? result.pendingApproval.turnId
                  : "",
            }
          : null;
      setApproval(nextPending);
      setStatus(
        nextPending || result?.status === "suspended" ? CHIEF_STATUS.APPROVAL : CHIEF_STATUS.READY
      );
      const payload = await fetchChiefHistory(user, activeSessionId);
      setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
      setStreamText("");
      await refreshSessions();
    } catch (error) {
      setStatus(CHIEF_STATUS.ERROR);
      setTurnError(errorText(error));
    } finally {
      setBusyState(false);
      void refreshAccess();
    }
  }

  async function chooseModel(route) {
    if (!route || !user || busyRef.current) return;
    setBusyState(true);
    setTurnError("");
    try {
      const result = await selectChiefModel({
        user,
        sessionId: activeSessionIdRef.current,
        route,
      });
      if (result.sessionId && result.sessionId !== activeSessionIdRef.current) {
        activeSessionIdRef.current = result.sessionId;
        setActiveSessionId(result.sessionId);
        writeStoredSessionId(result.sessionId);
      }
      setModelRoute(result.route);
      try {
        await refreshSessions();
      } catch (error) {
        setSessionsError(errorText(error));
      }
    } catch (error) {
      setTurnError(errorText(error));
    } finally {
      setBusyState(false);
    }
  }

  function retryTranscript() {
    if (activeSessionId) {
      setTurnError("");
      loadHistory(activeSessionId);
      return;
    }
    if (lastTextRef.current)
      sendMessage(lastTextRef.current, { appendUser: false, sessionId: null });
  }

  const showEmpty =
    Boolean(user) && !historyLoading && !notFound && !turnView.userLine && !turnView.answer;
  const transcriptError = historyError || turnError;
  const navQueryTrimmed = navQuery.trim();
  const searchMatches = Boolean(navQueryTrimmed) && searchState.query === navQueryTrimmed;
  const searchResults = searchMatches ? searchState.hits : [];
  const searchLoading = Boolean(navQueryTrimmed) && (!searchMatches || searchState.loading);
  const searchError = searchMatches ? searchState.error : "";

  useEffect(() => {
    if (room === "convos" || !showEmpty || busy || approval || accessOpen || settingsOpen) return;
    composerRef.current?.focus();
  }, [room, showEmpty, busy, approval, accessOpen, settingsOpen]);

  useEffect(() => {
    if (room !== "convos" || !focusConversationSearch) return undefined;
    const id = window.setTimeout(() => setFocusConversationSearch(false), 0);
    return () => window.clearTimeout(id);
  }, [room, focusConversationSearch]);

  function openAccess() {
    setAccessOpen(true);
  }

  function openSystem(id) {
    if (id === "freedom-financial" && onOpenFinancial) {
      onOpenFinancial();
      return;
    }
    if (id === "grokbot" && onOpenAgents) {
      onOpenAgents();
      return;
    }
    setSettingsSection("systems");
    setSettingsOpen(true);
  }

  function returnHome() {
    setAccessOpen(false);
    setRoom("home");
  }

  function openNode(node) {
    const key = node?.key;
    if (key === "finance") {
      onOpenFinancial?.();
      return;
    }
    if (key === "convos") {
      setRoom("convos");
      return;
    }
    if (key === "agents") {
      onOpenAgents?.();
      return;
    }
    if (key === "settings") {
      setSettingsSection("voice");
      setSettingsOpen(true);
      setRoom("home");
    }
  }

  function applyPreferences(next) {
    const saved = writeChiefPreferences(next);
    if (saved.conversation.responseMode === "text") {
      voice.stopSpeaking();
      setSpeechStopped(false);
    }
    setPreferences(saved);
  }

  function changeResponseMode(responseMode) {
    applyPreferences({
      ...preferences,
      conversation: { ...preferences.conversation, responseMode },
    });
  }

  function stopSpeech() {
    voice.stopSpeaking();
    const answer = typeof answerTextRef.current === "string" ? answerTextRef.current.trim() : "";
    if (answer) revealStoredAnswer(answer);
    setSpeechStopped(true);
  }

  function applyVoiceSettings(saved) {
    if (typeof saved?.voiceId === "string" && saved.voiceId) voice.chooseVoice(saved.voiceId);
  }

  async function testVoice(draft) {
    if (typeof draft?.voiceId === "string" && draft.voiceId) voice.chooseVoice(draft.voiceId);
    voice.ensureAudio();
    await voice.speakAnswer("Hello. I am CHIEF.", draft);
  }

  function stopTurn() {
    const stillWorking = isActiveChiefTurn(turnStatusRef.current);
    const playing = voice.playback === "playing" || voice.playback === "preparing";
    speechEpoch.current += 1;
    speakOnSettleRef.current = false;
    stopActiveTurn();
    voice.stopSpeaking();
    if (playing) setSpeechStopped(true);
    setBusyState(false);
    if (!stillWorking) setStatus(CHIEF_STATUS.READY);
  }

  async function replaySpeech() {
    const answer = typeof answerTextRef.current === "string" ? answerTextRef.current.trim() : "";
    if (!answer) return;
    speechEpoch.current += 1;
    const epoch = speechEpoch.current;
    setSpeechStopped(false);
    voice.clearSpeechError();
    voice.ensureAudio();
    setStatus(CHIEF_STATUS.RESPONDING);
    const result = await voice.speakAnswer(answer);
    if (speechEpoch.current !== epoch) return;
    setStatus(CHIEF_STATUS.READY);
    if (result?.ok) return;
    revealStoredAnswer(answer);
    if (result?.reason === "aborted") setSpeechStopped(true);
  }

  const fieldStatus = user ? status : CHIEF_STATUS.READY;
  const turnStillRunning = isActiveChiefTurn(turnStatus);
  const interaction = {
    status: fieldStatus,
    listening: voice.listening,
    speaking: voice.audioActive,
    playback: voice.playback,
    turnStatus,
  };
  const orbState = visualStateForInteraction(interaction);
  const scenePhase = scenePhaseForInteraction(interaction);
  const voiceNote = voice.interim || voice.speechError || (speechStopped ? "Speech stopped." : "");
  const showAssistantText = shouldShowAssistantText({ preferences });
  const homeClass = embedded ? "chief-apex-home chief-apex-home--embedded" : "chief-apex-home";
  const homeStatus = user ? fieldStatus : "Sign in";
  const homeStatusTone = !user
    ? "signed-out"
    : fieldStatus === CHIEF_STATUS.ERROR
      ? "error"
      : fieldStatus === CHIEF_STATUS.APPROVAL
        ? "wait"
        : fieldStatus === CHIEF_STATUS.READY
          ? "ready"
          : "active";
  const toolActions = access?.inventory?.actions;
  const homeSystemStatus = {
    cpu: null,
    memory: null,
    agents: null,
    tools: Array.isArray(toolActions) ? `${toolActions.length} ready` : null,
    network: access?.web === "on" ? "ON" : access?.web === "off" ? "OFF" : null,
  };
  const motionReduced =
    preferences.appearance.reducedMotion === "reduce" ||
    preferences.appearance.animationIntensity === "off";

  function submitDraft(text) {
    voice.ensureAudio();
    return sendMessage(text);
  }

  function toggleMicrophone() {
    if (busy || turnStillRunning || historyLoading || notFound || activeArchived || approval)
      return;
    voice.ensureAudio();
    voice.toggleListening();
  }

  function openConversations({ focusSearch = false, query } = {}) {
    if (typeof query === "string") setNavQuery(query);
    setFocusConversationSearch(focusSearch);
    setAccessOpen(false);
    setRoom("convos");
  }

  const showHomeExchange =
    !user ||
    historyLoading ||
    notFound ||
    Boolean(turnView.userLine) ||
    Boolean(turnView.answer) ||
    Boolean(transcriptError) ||
    Boolean(approval) ||
    activeArchived ||
    Boolean(voice.interim) ||
    Boolean(voice.speechError) ||
    speechStopped;

  const homeExchange = !user ? (
    <div className="chief-turn">
      <p className="chief-turn-empty">Sign in to talk with CHIEF.</p>
    </div>
  ) : (
    <>
      <ChiefTranscript
        labeled
        userLine={turnView.userLine}
        answer={turnView.answer}
        answerRef={answerRef}
        isLoading={historyLoading}
        notFound={notFound}
        showEmpty={showEmpty}
        showResponseText={showAssistantText || isRevealedAnswer(revealedAnswers, turnView.answer)}
        onReveal={(text) => revealStoredAnswer(text)}
        onBackToList={backToConversations}
      />
      {transcriptError ? (
        <p className="chief-turn-note">
          {transcriptError}{" "}
          <button type="button" className="chief-text-button" onClick={retryTranscript}>
            Retry
          </button>
        </p>
      ) : null}
      {approval && !activeArchived ? (
        <ChiefApprovalCard
          disabled={busy}
          onApprove={() => resolveApproval("approve")}
          onDeny={() => resolveApproval("deny")}
        />
      ) : null}
      {activeArchived ? (
        <div className="chief-archived-note">
          <p>This conversation is archived. Restore it to continue.</p>
          <button
            type="button"
            className="chief-action"
            disabled={busy}
            onClick={() => {
              restoreConversation(activeSessionId).catch((error) => setTurnError(errorText(error)));
            }}
          >
            Restore
          </button>
        </div>
      ) : null}
      {voice.interim ? <p className="chief-voice-interim">{voice.interim}</p> : null}
      {voice.speechError || speechStopped ? (
        <p className="chief-turn-note" role="alert">
          {voice.speechError || "Speech stopped."}
        </p>
      ) : null}
    </>
  );

  const threadDetail = (
    <>
      {showHomeExchange ? (
        homeExchange
      ) : (
        <p className="chief-workspace-status">
          {activeSessionId
            ? "This conversation is empty."
            : "Select a conversation, or start a new one. The thread stays on this session."}
        </p>
      )}
      {user ? (
        <ChiefEarlierTurns
          earlier={turnView.earlier}
          showResponseText={showAssistantText}
          revealedKeys={revealedAnswers}
          onReveal={(text) => revealStoredAnswer(text)}
        />
      ) : null}
    </>
  );

  function openListedConversation(sessionId) {
    const hit = searchResults.find((row) => row.sessionId === sessionId);
    const target = conversationSearchTarget(hit ?? { sessionId });
    if (target.kind === "archive") {
      setArchiveFocusId(target.sessionId);
      setSettingsSection("archive");
      setSettingsOpen(true);
      return;
    }
    selectSession(sessionId);
  }

  const conversationList = (
    <ChiefConversationList
      sessions={sessions}
      archivedSessions={archivedSessions}
      activeSessionId={activeSessionId}
      isLoading={!sessionsResolved}
      error={sessionsError}
      disabled={busy}
      signedIn={Boolean(user)}
      query={navQuery}
      onQueryChange={setNavQuery}
      searchResults={searchResults}
      searchLoading={searchLoading}
      searchError={searchError}
      onNewConversation={startNewConversation}
      onSelect={openListedConversation}
      onRename={renameConversation}
      onArchive={archiveConversation}
      onRestore={restoreConversation}
      onDelete={deleteConversation}
      onSearchRetry={refreshSearch}
      searchAutoFocus={focusConversationSearch}
      now={now.getTime()}
      detail={threadDetail}
      accessLabel={user ? moneyWebLine(access.money, access.web) : ""}
      onOpenAccess={user ? openAccess : undefined}
      onSignOut={onSignOut}
      onRetry={() => {
        setSessionsResolved(false);
        setSessionsError("");
        refreshSessions()
          .catch((error) => setSessionsError(errorText(error)))
          .finally(() => setSessionsResolved(true));
      }}
    />
  );

  const homeNavItems = [
    {
      id: "chief",
      label: "CHIEF",
      detail: "Intelligence & Execution",
      icon: "core",
      onSelect: returnHome,
    },
    {
      id: "conversations",
      label: "Conversations",
      detail: "Sessions",
      icon: "chat",
      onSelect: () => openConversations(),
    },
  ];
  if (onOpenFinancial) {
    homeNavItems.push({
      id: "finance",
      label: "Finance",
      detail: "Freedom Financial",
      icon: "chart",
      onSelect: () => openNode({ key: "finance" }),
    });
  }
  if (onOpenAgents) {
    homeNavItems.push({
      id: "agents",
      label: "Agents",
      detail: "GrokBot",
      icon: "network",
      onSelect: () => openNode({ key: "agents" }),
    });
  }
  homeNavItems.push({
    id: "settings",
    label: "Settings",
    detail: "System configuration",
    icon: "settings",
    onSelect: () => openNode({ key: "settings" }),
  });

  const homeQuickActions = user
    ? [
        {
          id: "new-conversation",
          label: "New conversation",
          icon: "chat",
          onSelect: startNewConversation,
        },
        {
          id: "voice",
          label: voice.listening ? "Listening" : "Voice",
          icon: "mic",
          pressed: voice.listening,
          disabled:
            busy ||
            turnStillRunning ||
            historyLoading ||
            notFound ||
            Boolean(approval) ||
            activeArchived,
          onSelect: toggleMicrophone,
        },
      ]
    : [];

  if (room === "home" || room === "convos") {
    return (
      <section className={homeClass} aria-label="CHIEF">
        <ChiefInterface
          activeSection={room === "convos" ? "conversations" : "chief"}
          navItems={homeNavItems}
          showNavLabels={preferences.appearance.showNavLabels}
          quickActions={homeQuickActions}
          status={homeStatus}
          statusTone={homeStatusTone}
          assistantState={orbState}
          scenePhase={scenePhase}
          message={draft}
          onMessageChange={setDraft}
          onSend={submitDraft}
          onMic={toggleMicrophone}
          listening={voice.listening}
          playback={voice.playback}
          turnStatus={turnStatus}
          composerDisabled={busy || turnStillRunning || historyLoading || notFound}
          enterToSend={preferences.conversation.enterToSend}
          showComposer={Boolean(user) && !approval && !activeArchived}
          reducedMotion={motionReduced}
          showSystemStatus={preferences.appearance.showTelemetry}
          systemStatus={homeSystemStatus}
          conversation={room === "convos" ? null : showHomeExchange ? homeExchange : null}
          workspace={room === "convos" ? conversationList : null}
          inputRef={composerRef}
          responseMode={preferences.conversation.responseMode}
          onResponseMode={user ? changeResponseMode : undefined}
          speechActive={voice.playback === "preparing" || voice.playback === "playing"}
          onStopSpeech={stopSpeech}
          onReplaySpeech={
            shouldSpeakReply({ preferences }) &&
            turnView.answer.trim() &&
            voice.playback === "idle" &&
            (voice.speechError || speechStopped)
              ? replaySpeech
              : undefined
          }
          profileName={profileName(user)}
          generating={busy || turnStillRunning}
          onStopTurn={stopTurn}
          systems={access.systems}
          accessLine={user ? moneyWebLine(access.money, access.web) : ""}
          onOpenSystem={user ? openSystem : undefined}
          onOpenAccess={user ? openAccess : undefined}
        />
        <p className="chief-sr" aria-live="polite">
          {voice.listening
            ? "Listening"
            : voice.playback === "preparing"
              ? "Generating audio"
              : voice.audioActive
                ? "Speaking"
                : voiceNote}
        </p>
        <ChiefSettings
          open={settingsOpen}
          section={settingsSection}
          archiveFocusId={archiveFocusId}
          onSection={setSettingsSection}
          onClose={() => setSettingsOpen(false)}
          user={user}
          models={models}
          defaultModel={defaultModel}
          modelRoute={modelRoute}
          modelBusy={busy}
          onChooseModel={chooseModel}
          access={access}
          onRefreshAccess={() => {
            void refreshAccess();
          }}
          activeSessionId={activeSessionId}
          onStartConversation={() => {
            startNewConversation();
            setRoom("convos");
            setSettingsOpen(false);
          }}
          onClearConversation={(sessionId) => {
            deleteConversation(sessionId).catch((error) => setTurnError(errorText(error)));
          }}
          preferences={preferences}
          onPreferences={applyPreferences}
          activeVoiceId={voice.voiceId}
          onVoiceSettings={applyVoiceSettings}
          onTestVoice={testVoice}
          voiceDisabled={voice.listening || voice.audioActive}
        />
        {accessOpen ? (
          <div className="chief-sheet-backdrop is-open" onClick={() => setAccessOpen(false)} />
        ) : null}
        {accessOpen ? (
          <ChiefAccessSheet open access={access} onClose={() => setAccessOpen(false)} />
        ) : null}
      </section>
    );
  }

  return null;
}
