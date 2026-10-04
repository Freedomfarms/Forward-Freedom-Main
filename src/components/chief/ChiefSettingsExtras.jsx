import { useCallback, useEffect, useRef, useState } from "react";
import { conversationLabel, fetchChiefHistory, fetchChiefSessions } from "../../utils/chiefApi.js";
import { readChiefActiveSessionId } from "../../utils/chiefActiveSession.js";
import { publicTranscriptMessages } from "../../utils/chiefProtocol.js";
import { ChiefMarkdown } from "./ChiefTranscript.jsx";
import { ChiefVoiceSheet } from "./ChiefVoiceSheet.jsx";
import { createSpeechOutput, unlockSpeechPlayback } from "./voice/speechOutput.js";
import { readVoiceSettings } from "./voice/voiceSettings.js";

function errorText(error) {
  return error?.message || "Conversation history could not be loaded.";
}

export function ChiefSettingsExtras({ user, onVoiceSettings }) {
  const uid = typeof user?.uid === "string" ? user.uid : "";
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(Boolean(uid));
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState("");
  const [trackedUid, setTrackedUid] = useState(uid);
  const [trackedSession, setTrackedSession] = useState(null);
  const outputRef = useRef(null);
  const voiceSettingsRef = useRef(readVoiceSettings());

  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setSessions([]);
    setSessionId(null);
    setMessages([]);
    setError("");
    setSessionsLoading(Boolean(uid));
    setMessagesLoading(false);
  }

  if (sessionId !== trackedSession) {
    setTrackedSession(sessionId);
    setMessages([]);
    setMessagesLoading(Boolean(sessionId));
  }

  useEffect(() => {
    return () => {
      outputRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!user || !uid) return undefined;
    let cancelled = false;
    Promise.all([fetchChiefSessions(user), fetchChiefSessions(user, { archived: true })])
      .then(([active, archived]) => {
        if (cancelled) return;
        const rows = [
          ...(Array.isArray(active?.sessions) ? active.sessions : []).map((session) => ({
            ...session,
            archived: false,
          })),
          ...(Array.isArray(archived?.sessions) ? archived.sessions : []).map((session) => ({
            ...session,
            archived: true,
          })),
        ];
        setSessions(rows);
        const stored = readChiefActiveSessionId(uid);
        const initial = rows.some((session) => session.sessionId === stored)
          ? stored
          : rows[0]?.sessionId || null;
        setSessionId(initial);
        setError("");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setSessions([]);
        setSessionId(null);
        setError(errorText(loadError));
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, uid]);

  useEffect(() => {
    if (!user || !sessionId) return undefined;
    let cancelled = false;
    fetchChiefHistory(user, sessionId)
      .then((payload) => {
        if (cancelled) return;
        setMessages(publicTranscriptMessages(payload?.messages));
        setError("");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setMessages([]);
        setError(errorText(loadError));
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, sessionId]);

  const handleSettings = useCallback(
    (settings) => {
      if (settings) voiceSettingsRef.current = settings;
      onVoiceSettings?.(settings);
    },
    [onVoiceSettings]
  );

  function testVoice(settings) {
    if (settings) voiceSettingsRef.current = settings;
    unlockSpeechPlayback();
    if (!outputRef.current) {
      outputRef.current = createSpeechOutput({
        getUser: () => user,
        getSettings: () => voiceSettingsRef.current,
      });
    }
    return outputRef.current.speak("CHIEF is ready.");
  }

  return (
    <div className="chief-settings-extras">
      <section className="chief-history" aria-label="Conversation history">
        <div className="chief-sheet-title">Conversation history</div>
        {sessionsLoading ? <p className="chief-turn-note">Loading conversation...</p> : null}
        {!sessionsLoading && error ? <p className="chief-turn-note">{error}</p> : null}
        {!sessionsLoading && !error && sessions.length === 0 ? (
          <p className="chief-turn-note">No conversations yet.</p>
        ) : null}
        {sessions.length > 0 ? (
          <div className="chief-history-sessions">
            {sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                className={
                  session.sessionId === sessionId
                    ? "chief-history-session is-active"
                    : "chief-history-session"
                }
                aria-current={session.sessionId === sessionId ? "true" : undefined}
                onClick={() => setSessionId(session.sessionId)}
              >
                <span>{conversationLabel(session)}</span>
                {session.archived ? <span className="chief-convo-flag">Archived</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {messagesLoading ? <p className="chief-turn-note">Loading conversation...</p> : null}
        {!messagesLoading && sessionId && messages.length === 0 && !error ? (
          <p className="chief-turn-note">This conversation has no messages yet.</p>
        ) : null}
        {messages.length > 0 ? (
          <div className="chief-history-log">
            {messages.map((message) => (
              <div key={message.id} className="chief-history-line">
                <span className="chief-turn-who">{message.role === "user" ? "You:" : "CHIEF:"}</span>
                {message.role === "user" ? (
                  <p className="chief-earlier-user">{message.text}</p>
                ) : (
                  <div className="chief-earlier-chief">
                    <ChiefMarkdown text={message.text} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <ChiefVoiceSheet
        open
        inline
        user={user}
        onClose={() => {}}
        onSettings={handleSettings}
        onTest={testVoice}
      />
    </div>
  );
}
