import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHIEF_STATUS,
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
  renameChiefSession,
  selectChiefModel,
  setChiefSessionArchived,
  streamChiefChat,
} from "../../utils/chiefApi.js";
import {
  currentTurn,
  emptyRoomAccess,
  formatRoomTime,
  modelLabel,
  moneyWebLine,
} from "../../utils/chiefRoom.js";
import { readSidebarCollapsed, writeSidebarCollapsed } from "../../utils/chiefSidebar.js";
import { ChiefAccessSheet } from "./ChiefAccessSheet.jsx";
import { ChiefApprovalCard } from "./ChiefApprovalCard.jsx";
import { ChiefComposer } from "./ChiefComposer.jsx";
import { ChiefConversationList } from "./ChiefConversationList.jsx";
import { ChiefField } from "./ChiefField.jsx";
import { ChiefModelSelect } from "./ChiefModelSelect.jsx";
import { ChiefStatus } from "./ChiefStatus.jsx";
import { ChiefEarlierTurns, ChiefTranscript } from "./ChiefTranscript.jsx";

const ACTIVE_SESSION_KEY = "chief.activeSessionId";
const NARROW_NAV_QUERY = "(max-width: 1023px)";

function readNarrowNav() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(NARROW_NAV_QUERY).matches;
}

function sidebarStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

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

export function ChiefPage({
  user,
  embedded = false,
  onOpenFinancial,
  onOpenCeoAgents,
  onOpenModules,
  onSignOut,
}) {
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
  const [streamText, setStreamText] = useState("");
  const [turnError, setTurnError] = useState("");
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => readSidebarCollapsed(sidebarStorage()));
  const [narrowNav, setNarrowNav] = useState(readNarrowNav);
  const [navQuery, setNavQuery] = useState("");
  const [searchState, setSearchState] = useState({
    query: "",
    hits: [],
    loading: false,
    error: "",
  });
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [access, setAccess] = useState(emptyRoomAccess);
  const [now, setNow] = useState(() => new Date());
  const [models, setModels] = useState([]);
  const [modelRoute, setModelRoute] = useState(null);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const activeSessionIdRef = useRef(null);
  const lastTextRef = useRef("");
  const answerRef = useRef(null);
  const composerRef = useRef(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const turnView = useMemo(() => currentTurn(messages, streamText), [messages, streamText]);
  const activeArchived = archivedSessions.some((session) => session.sessionId === activeSessionId);

  function setBusyState(value) {
    busyRef.current = value;
    setBusy(value);
  }

  function stopActiveTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
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
        setMessages(Array.isArray(payload?.messages) ? payload.messages : []);
        setModelRoute(typeof payload?.modelRoute === "string" ? payload.modelRoute : null);
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
    [user]
  );

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchChiefModels(user)
      .then((payload) => {
        if (!cancelled) setModels(Array.isArray(payload?.models) ? payload.models : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
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
  }, [user, loadHistory]);

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
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(NARROW_NAV_QUERY);
    function apply() {
      const next = media.matches;
      setNarrowNav(next);
      if (!next) setDrawerOpen(false);
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
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
    if (!drawerOpen && !placesOpen && !accessOpen) return undefined;
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setDrawerOpen(false);
      setPlacesOpen(false);
      setAccessOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, placesOpen, accessOpen]);

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
    setModelRoute(null);
    loadHistory(sessionId, token);
  }

  function startNewConversation() {
    stopActiveTurn();
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
    setStatus(CHIEF_STATUS.READY);
    setBusyState(false);
    setDraft("");
    if (window.matchMedia(NARROW_NAV_QUERY).matches) setDrawerOpen(false);
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
    if (archivedSessions.some((session) => session.sessionId === sessionId)) {
      setTurnError("This conversation is archived. Restore it before sending.");
      return;
    }
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
    void refreshAccess();
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
  const stateDetail = transcriptError || "";
  const canLeave = Boolean(onOpenFinancial || onOpenCeoAgents || onOpenModules);
  const sheetOpen = drawerOpen || placesOpen || accessOpen;
  const desktopNav = Boolean(user) && !narrowNav;
  const navExpanded = narrowNav ? drawerOpen : !navCollapsed;
  const navQueryTrimmed = navQuery.trim();
  const searchMatches = Boolean(navQueryTrimmed) && searchState.query === navQueryTrimmed;
  const searchResults = searchMatches ? searchState.hits : [];
  const searchLoading = Boolean(navQueryTrimmed) && (!searchMatches || searchState.loading);
  const searchError = searchMatches ? searchState.error : "";
  const roomClass = [
    "chief-room",
    embedded ? "chief-room--embedded" : "",
    desktopNav ? "has-nav" : "",
    desktopNav && navCollapsed ? "is-nav-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!showEmpty || busy || approval || sheetOpen) return;
    composerRef.current?.focus();
  }, [showEmpty, busy, approval, sheetOpen]);

  function toggleNavigation() {
    if (narrowNav) {
      setPlacesOpen(false);
      setAccessOpen(false);
      setDrawerOpen((open) => !open);
      return;
    }
    setNavCollapsed((collapsed) => {
      const next = !collapsed;
      writeSidebarCollapsed(sidebarStorage(), next);
      return next;
    });
  }

  function openPlaces() {
    setDrawerOpen(false);
    setAccessOpen(false);
    setPlacesOpen(true);
  }

  function openAccess() {
    setDrawerOpen(false);
    setPlacesOpen(false);
    setAccessOpen(true);
  }

  function closeSheets() {
    setDrawerOpen(false);
    setPlacesOpen(false);
    setAccessOpen(false);
  }

  const conversationList = (
    <ChiefConversationList
      sessions={sessions}
      archivedSessions={archivedSessions}
      activeSessionId={activeSessionId}
      isLoading={!sessionsResolved}
      error={sessionsError}
      disabled={busy}
      query={navQuery}
      onQueryChange={setNavQuery}
      searchResults={searchResults}
      searchLoading={searchLoading}
      searchError={searchError}
      onNewConversation={startNewConversation}
      onSelect={selectSession}
      onRename={renameConversation}
      onArchive={archiveConversation}
      onRestore={restoreConversation}
      onDelete={deleteConversation}
      onSearchRetry={refreshSearch}
      onRetry={() => {
        setSessionsResolved(false);
        setSessionsError("");
        refreshSessions()
          .catch((error) => setSessionsError(errorText(error)))
          .finally(() => setSessionsResolved(true));
      }}
    />
  );

  function navToggle(className) {
    return (
      <button
        type="button"
        className={className}
        aria-expanded={navExpanded}
        aria-controls="chief-conversation-nav"
        aria-label={navExpanded ? "Hide conversations" : "Show conversations"}
        onClick={toggleNavigation}
      >
        <span aria-hidden="true">☰</span>
      </button>
    );
  }

  return (
    <section className={roomClass} aria-label="CHIEF">
      {desktopNav ? (
        <aside
          id="chief-conversation-nav"
          className={navCollapsed ? "chief-nav is-collapsed" : "chief-nav"}
          aria-label="Conversations"
        >
          {navToggle("chief-nav-toggle")}
          {navCollapsed ? null : (
            <>
              {conversationList}
              <ChiefEarlierTurns earlier={turnView.earlier} />
            </>
          )}
        </aside>
      ) : null}
      {sheetOpen ? <div className="chief-sheet-backdrop is-open" onClick={closeSheets} /> : null}
      <div className="chief-room-top">
        <div className="chief-room-brand">
          {user && narrowNav ? navToggle("chief-nav-toggle") : null}
          {canLeave ? (
            <button
              type="button"
              className="chief-places-button"
              aria-expanded={placesOpen}
              onClick={openPlaces}
            >
              CHIEF
            </button>
          ) : (
            <div className="chief-place chief-place--here">CHIEF</div>
          )}
        </div>
        {canLeave ? (
          <nav className="chief-places" aria-label="Places">
            <button
              type="button"
              className="chief-place chief-place--here"
              aria-current="page"
              onClick={closeSheets}
            >
              CHIEF
            </button>
            {onOpenFinancial ? (
              <button type="button" className="chief-place" onClick={onOpenFinancial}>
                Freedom Financial
              </button>
            ) : null}
            {onOpenCeoAgents ? (
              <button type="button" className="chief-place" onClick={onOpenCeoAgents}>
                CEO Agents
              </button>
            ) : null}
            {onOpenModules ? (
              <button type="button" className="chief-place" onClick={onOpenModules}>
                Modules
              </button>
            ) : null}
          </nav>
        ) : null}
        <div className="chief-instruments">
          <div className="chief-instrument">{formatRoomTime(now)}</div>
          {user ? (
            <div className="chief-instrument chief-instrument--state">
              <ChiefStatus status={status} detail={stateDetail} />
              {transcriptError ? (
                <button type="button" className="chief-text-button" onClick={retryTranscript}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {user ? (
            models.length > 0 ? (
              <ChiefModelSelect
                models={models}
                value={modelRoute}
                disabled={busy || historyLoading || notFound || Boolean(approval)}
                onChange={chooseModel}
              />
            ) : (
              <div className="chief-instrument">{modelLabel(models, modelRoute)}</div>
            )
          ) : null}
          {user ? (
            <button
              type="button"
              className="chief-instrument chief-access"
              aria-expanded={accessOpen}
              onClick={openAccess}
            >
              {moneyWebLine(access.money, access.web)}
            </button>
          ) : null}
        </div>
      </div>
      <div className={sheetOpen ? "chief-room-stage is-dim" : "chief-room-stage"}>
        <ChiefField status={user ? status : CHIEF_STATUS.READY} />
        {user ? (
          <ChiefTranscript
            userLine={turnView.userLine}
            answer={turnView.answer}
            answerRef={answerRef}
            isLoading={historyLoading}
            notFound={notFound}
            showEmpty={showEmpty}
            onBackToList={backToConversations}
          />
        ) : (
          <div className="chief-turn">
            <p className="chief-turn-empty">Sign in to talk with CHIEF.</p>
          </div>
        )}
      </div>
      {user ? (
        <div className="chief-room-bottom">
          {approval && !activeArchived ? (
            <ChiefApprovalCard
              disabled={busy}
              onApprove={() => resolveApproval("approve")}
              onDeny={() => resolveApproval("deny")}
            />
          ) : (
            <div className="chief-composer-row">
              {activeArchived ? (
                <div className="chief-archived-note">
                  <p>This conversation is archived. Restore it to continue.</p>
                  <button
                    type="button"
                    className="chief-action"
                    disabled={busy}
                    onClick={() => {
                      restoreConversation(activeSessionId).catch((error) =>
                        setTurnError(errorText(error))
                      );
                    }}
                  >
                    Restore
                  </button>
                </div>
              ) : (
                <ChiefComposer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => sendMessage(draft)}
                  disabled={busy || historyLoading || notFound}
                  inputRef={composerRef}
                />
              )}
            </div>
          )}
        </div>
      ) : null}
      {narrowNav && drawerOpen ? (
        <aside
          id="chief-conversation-nav"
          className="chief-sheet is-open"
          aria-label="Conversations"
        >
          {conversationList}
          <ChiefEarlierTurns earlier={turnView.earlier} />
          <button type="button" className="chief-action chief-action--quiet" onClick={closeSheets}>
            Close
          </button>
        </aside>
      ) : null}
      {placesOpen ? (
        <aside className="chief-sheet is-open" aria-label="Places">
          <nav className="chief-place-list">
            <button type="button" className="chief-place chief-place--here" onClick={closeSheets}>
              CHIEF
            </button>
            {onOpenFinancial ? (
              <button type="button" className="chief-place" onClick={onOpenFinancial}>
                Freedom Financial
              </button>
            ) : null}
            {onOpenCeoAgents ? (
              <button type="button" className="chief-place" onClick={onOpenCeoAgents}>
                CEO Agents
              </button>
            ) : null}
            {onOpenModules ? (
              <button type="button" className="chief-place" onClick={onOpenModules}>
                Modules
              </button>
            ) : null}
            {onSignOut ? (
              <button type="button" className="chief-place" onClick={onSignOut}>
                Sign out
              </button>
            ) : null}
          </nav>
        </aside>
      ) : null}
      {accessOpen ? <ChiefAccessSheet open access={access} onClose={closeSheets} /> : null}
    </section>
  );
}
