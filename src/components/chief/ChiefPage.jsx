import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHIEF_STATUS,
  applyChiefEvent,
  decideChiefApproval,
  fetchChiefHistory,
  fetchChiefPendingApproval,
  fetchChiefSessions,
  initialTurnState,
  publicTranscriptMessages,
  streamChiefChat,
} from "../../utils/chiefApi.js";
import { ChiefApprovalCard } from "./ChiefApprovalCard.jsx";
import { ChiefComposer } from "./ChiefComposer.jsx";
import { ChiefConversationList } from "./ChiefConversationList.jsx";
import { ChiefStatus } from "./ChiefStatus.jsx";
import { ChiefTranscript } from "./ChiefTranscript.jsx";

const ACTIVE_SESSION_KEY = "chief.activeSessionId";

function readStoredSessionId() {
  try {
    const value = sessionStorage.getItem(ACTIVE_SESSION_KEY);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSessionId(sessionId) {
  try {
    if (sessionId) sessionStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    else sessionStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Private browsing can reject storage. The open tab still works.
  }
}

function errorText(error) {
  return error?.message || "CHIEF could not complete that request.";
}

export function ChiefPage({ user }) {
  const [sessions, setSessions] = useState([]);
  const [sessionsResolved, setSessionsResolved] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(CHIEF_STATUS.READY);
  const [streamText, setStreamText] = useState("");
  const [turnError, setTurnError] = useState("");
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const activeSessionIdRef = useRef(null);
  const lastTextRef = useRef("");
  const scrollRef = useRef(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const transcriptMessages = useMemo(() => publicTranscriptMessages(messages), [messages]);

  function setBusyState(value) {
    busyRef.current = value;
    setBusy(value);
  }

  function stopActiveTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  const refreshSessions = useCallback(async () => {
    const payload = await fetchChiefSessions(user);
    setSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
    setSessionsError("");
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
        setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
        const pending = await fetchChiefPendingApproval(user, sessionId).catch(() => null);
        if (token !== generation.current) return;
        setApproval(pending);
        setStatus(pending ? CHIEF_STATUS.APPROVAL : CHIEF_STATUS.READY);
        setStreamText("");
      } catch (error) {
        if (token !== generation.current) return;
        if (error?.status === 404) {
          setNotFound(true);
          setMessages([]);
          setApproval(null);
          writeStoredSessionId(null);
        } else {
          setHistoryError(errorText(error));
        }
      } finally {
        if (token === generation.current) setHistoryLoading(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const token = generation.current;
    fetchChiefSessions(user)
      .then((payload) => {
        if (cancelled) return null;
        setSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
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
  }, [user, loadHistory]);

  useEffect(() => {
    const active = abortRef;
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcriptMessages, streamText, approval, historyLoading, turnError]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  function selectSession(sessionId) {
    stopActiveTurn();
    generation.current += 1;
    const token = generation.current;
    setActiveSessionId(sessionId);
    writeStoredSessionId(sessionId);
    setDrawerOpen(false);
    setStreamText("");
    setTurnError("");
    setDraft("");
    setBusyState(false);
    setMessages([]);
    loadHistory(sessionId, token);
  }

  function startNewConversation() {
    stopActiveTurn();
    generation.current += 1;
    setActiveSessionId(null);
    writeStoredSessionId(null);
    setMessages([]);
    setStreamText("");
    setApproval(null);
    setTurnError("");
    setHistoryError("");
    setNotFound(false);
    setHistoryLoading(false);
    setStatus(CHIEF_STATUS.READY);
    setBusyState(false);
    setDraft("");
    setDrawerOpen(false);
  }

  function backToConversations() {
    setNotFound(false);
    setActiveSessionId(null);
    setMessages([]);
    setApproval(null);
    setStatus(CHIEF_STATUS.READY);
    writeStoredSessionId(null);
    if (window.matchMedia("(max-width: 1023px)").matches) setDrawerOpen(true);
  }

  // Text send is the only V1 entry. A later push-to-talk control should call
  // sendMessage with the same session so voice joins this conversation.
  async function sendMessage(
    text,
    { appendUser = true, sessionId = activeSessionIdRef.current } = {}
  ) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed || !user || busyRef.current) return;
    lastTextRef.current = trimmed;
    stopActiveTurn();
    const controller = new AbortController();
    abortRef.current = controller;
    generation.current += 1;
    setBusyState(true);
    setTurnError("");
    setHistoryError("");
    setApproval(null);
    setStreamText("");
    setStatus(CHIEF_STATUS.WORKING);
    setDraft("");
    if (appendUser) {
      setMessages((current) => [...current, { role: "user", text: trimmed }]);
    }
    let turn = initialTurnState(sessionId);
    try {
      await streamChiefChat({
        user,
        sessionId,
        text: trimmed,
        signal: controller.signal,
        onEvent: (event) => {
          if (controller.signal.aborted) return;
          turn = applyChiefEvent(turn, event);
          setStatus(turn.status);
          setStreamText(turn.streamText);
          if (turn.sessionId && turn.sessionId !== activeSessionIdRef.current) {
            activeSessionIdRef.current = turn.sessionId;
            setActiveSessionId(turn.sessionId);
            writeStoredSessionId(turn.sessionId);
          }
          if (turn.approval) setApproval(turn.approval);
          if (turn.error) setTurnError(turn.error);
        },
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      if (abortRef.current !== controller) return;
      setStatus(CHIEF_STATUS.ERROR);
      setTurnError(errorText(error));
      setBusyState(false);
      return;
    }
    if (controller.signal.aborted || abortRef.current !== controller) return;

    const sessionIdNow = turn.sessionId;
    if (sessionIdNow && (turn.finished || turn.approval)) {
      try {
        const payload = await fetchChiefHistory(user, sessionIdNow);
        if (abortRef.current !== controller) return;
        setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
        setStreamText("");
        setNotFound(false);
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
      setStatus(CHIEF_STATUS.APPROVAL);
      if (sessionIdNow) {
        const pending = await fetchChiefPendingApproval(user, sessionIdNow).catch(() => null);
        if (abortRef.current !== controller) return;
        if (pending) setApproval(pending);
      }
    } else {
      setApproval(null);
      setStatus(turn.status === CHIEF_STATUS.ERROR ? CHIEF_STATUS.ERROR : CHIEF_STATUS.READY);
    }
    setBusyState(false);
  }

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

  if (!user) {
    return (
      <section className="chief-page chief-page--solo" aria-label="CHIEF">
        <div className="chief-stage">
          <header className="chief-stage-header">
            <div className="chief-title">CHIEF</div>
            <ChiefStatus status={CHIEF_STATUS.READY} />
          </header>
          <div className="chief-transcript-scroll">
            <div className="chief-empty-title">CHIEF</div>
            <p className="chief-empty-copy">Sign in to talk with CHIEF.</p>
          </div>
        </div>
      </section>
    );
  }

  const showEmpty = !historyLoading && !notFound && transcriptMessages.length === 0 && !streamText;
  const transcriptError = historyError || turnError;

  return (
    <section className="chief-page" aria-label="CHIEF">
      <div
        className={drawerOpen ? "chief-rail-backdrop is-open" : "chief-rail-backdrop"}
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        className={drawerOpen ? "chief-rail is-open" : "chief-rail"}
        aria-label="Conversations"
      >
        <ChiefConversationList
          sessions={sessions}
          activeSessionId={activeSessionId}
          isLoading={!sessionsResolved}
          error={sessionsError}
          disabled={busy}
          onNewConversation={startNewConversation}
          onSelect={selectSession}
          onRetry={() => {
            setSessionsResolved(false);
            setSessionsError("");
            refreshSessions()
              .catch((error) => setSessionsError(errorText(error)))
              .finally(() => setSessionsResolved(true));
          }}
        />
      </aside>
      <div className="chief-stage">
        <header className="chief-stage-header">
          <div className="chief-stage-heading">
            <button
              type="button"
              className="chief-action chief-conversations-button"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              Conversations
            </button>
            <div className="chief-title">CHIEF</div>
          </div>
          <ChiefStatus status={status} />
        </header>
        <div className="chief-transcript-scroll" ref={scrollRef}>
          <ChiefTranscript
            messages={transcriptMessages}
            streamText={streamText}
            isLoading={historyLoading}
            error={transcriptError}
            notFound={notFound}
            showEmpty={showEmpty}
            onRetry={transcriptError ? retryTranscript : undefined}
            onBackToList={backToConversations}
          />
          {approval ? (
            <div className="chief-approval-slot">
              <ChiefApprovalCard
                disabled={busy}
                onApprove={() => resolveApproval("approve")}
                onDeny={() => resolveApproval("deny")}
              />
            </div>
          ) : null}
        </div>
        <div className="chief-composer-wrap">
          <ChiefComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => sendMessage(draft)}
            disabled={busy || historyLoading || notFound || Boolean(approval)}
          />
        </div>
      </div>
    </section>
  );
}
