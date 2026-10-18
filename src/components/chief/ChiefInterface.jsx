import { useEffect, useRef, useState } from "react";
import { ChiefResponseMode } from "./ChiefResponseMode.jsx";
import { frontierActivity, frontierStatusCopy } from "./frontier/frontierActivity.js";
import { useFrontierScene } from "./frontier/useFrontierScene.js";
import "./ChiefInterface.css";

const SUGGESTION_ICONS = {
  plan: "core",
  finances: "chart",
  research: "search",
  projects: "network",
};

const ACTIVITIES = [
  ["idle", "Standing by"],
  ["listening", "Listening"],
  ["thinking", "Reasoning"],
  ["responding", "Responding"],
];

function Icon({ name }) {
  const common = {
    className: "icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    core: <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" />,
    chat: (
      <>
        <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3v-3.2" />
        <path d="M8 9h8M8 12h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.2v1.8M12 19v1.8M4.9 6.5l1.4 1.1M17.7 16.4l1.4 1.1M4.9 17.5l1.4-1.1M17.7 7.6l1.4-1.1M3.2 12h1.8M19 12h1.8" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
      </>
    ),
    paperclip: (
      <path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.9 8.9a5 5 0 0 1-7.1-7.1l8.6-8.6" />
    ),
    send: (
      <>
        <path d="M5 12h12" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    bell: (
      <>
        <path d="M6 16V10a6 6 0 1 1 12 0v6" />
        <path d="M4.5 16.5h15M10 19a2 2 0 0 0 4 0" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19h16" />
        <path d="M7 16v-4M12 16V8M17 16v-6" />
      </>
    ),
    network: (
      <>
        <circle cx="7" cy="8" r="2" />
        <circle cx="17" cy="8" r="2" />
        <circle cx="12" cy="16" r="2" />
        <path d="m8.6 9.4 2.2 4.4M15.4 9.4l-2.2 4.4M9 8h6" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14" />
        <path d="M16 5v14" />
      </>
    ),
    expand: (
      <>
        <path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
  };
  return <svg {...common}>{paths[name] || paths.core}</svg>;
}

function Flag() {
  return (
    <svg className="mini-flag" viewBox="0 0 28 17" aria-hidden="true">
      <rect width="28" height="17" fill="#0c2740" />
      <path d="M0 2h28M0 6h28M0 10h28M0 14h28" stroke="#8ebfe0" strokeWidth="1.2" />
      <rect width="12" height="8" fill="#163a5c" />
    </svg>
  );
}

function greetingFor(date) {
  const hour = date.getHours();
  if (hour < 12) return "GOOD MORNING";
  if (hour < 17) return "GOOD AFTERNOON";
  return "GOOD EVENING";
}

function localTime(date) {
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${clock} LOCAL`;
}

export function ChiefInterface({
  activeSection = "",
  navItems = [],
  shortcuts = [],
  showNavLabels = true,
  onHome,
  onSearch,
  onNotifications,
  onProfile,
  profileMark = "",
  profileName = "",
  status = "Ready",
  statusTone = "ready",
  assistantState = "idle",
  scenePhase = "idle",
  message = "",
  onMessageChange,
  onSend,
  onMic,
  listening = false,
  composerDisabled = false,
  generating = false,
  onStopTurn,
  enterToSend = true,
  showComposer = true,
  allowAttach = false,
  onAttach,
  reducedMotion = false,
  showSystemStatus = true,
  systemStatus = {},
  quickActions = [],
  recent = null,
  suggestions = [],
  conversation = null,
  workspace = null,
  modelControl = null,
  inputRef = null,
  responseMode = "both",
  onResponseMode,
  speechActive = false,
  onStopSpeech,
  systems = null,
  accessLine = "",
  onOpenSystem,
  onOpenAccess,
}) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const anchorRef = useRef(null);
  const stageRef = useRef(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [systemReduced, setSystemReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );
  const [clock, setClock] = useState(() => new Date());
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const reduced = Boolean(reducedMotion || systemReduced);
  const paused = reduced || motionPaused;
  const phase = ["idle", "thinking", "responding"].includes(scenePhase) ? scenePhase : "idle";
  const activity = frontierActivity({
    listening,
    assistantState,
    scenePhase: phase,
    status,
  });
  const copy = frontierStatusCopy(activity, status);
  const trimmed = typeof message === "string" ? message.trim() : "";
  const stopping = Boolean(generating && onStopTurn);
  const newConversation = quickActions.find((item) => item.id === "new-conversation");
  const metricBits = [
    ["Tools", systemStatus.tools],
    ["Web", systemStatus.network],
  ].flatMap(([label, value]) =>
    typeof value === "string" && value.trim() ? [`${label} ${value.trim()}`] : []
  );

  useFrontierScene({
    rootRef,
    canvasRef,
    anchorRef,
    stageRef,
    activity,
    paused: paused || reduced,
    reduced,
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    function onChange() {
      setSystemReduced(media.matches);
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    function onChange() {
      setFullscreen(document.fullscreenElement === rootRef.current);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function submitMessage(event) {
    event.preventDefault();
    if (stopping) {
      onStopTurn?.();
      return;
    }
    if (!showComposer || composerDisabled || !trimmed) return;
    onSend?.(trimmed);
  }

  async function toggleFullscreen() {
    const node = rootRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      setFullscreen(false);
    }
  }

  const rootClass = [
    "chief-frontier",
    "chief-interface",
    `phase-${phase}`,
    `is-${statusTone}`,
    workspace ? "has-workspace" : "",
    conversation ? "has-response" : "",
    showNavLabels ? "" : "is-nav-compact",
    showSystemStatus ? "" : "is-telemetry-off",
    reduced ? "is-reduced-motion reduced-motion" : "",
    paused || reduced ? "paused" : "",
    menuOpen ? "is-menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main ref={rootRef} className={rootClass} data-activity={activity}>
      <canvas ref={canvasRef} className="universe" aria-hidden="true" />
      <div className="atmosphere" />
      <div className="screen-frame" />
      <div className="os-shell">
        <header className="topbar">
          <button
            type="button"
            className="brand"
            onClick={() => onHome?.()}
            aria-label="CHIEF home"
          >
            <svg className="bolt-mark" viewBox="0 0 24 36" aria-hidden="true">
              <path d="M14 1 6 16h7l-2 18 12-20h-8L14 1z" />
            </svg>
            <span>
              CHIEF
              <small>FREEDOM OS</small>
            </span>
          </button>
          <div className="top-center">
            <span className="top-route">FREEDOM</span>
            <span className="route-slash">/</span>
            <span className="route-current">CHIEF</span>
          </div>
          <div className="top-actions">
            <span className="local-time">{localTime(clock)}</span>
            <button
              type="button"
              className="icon-btn frontier-menu"
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
              onClick={() => setMenuOpen((current) => !current)}
            >
              <Icon name="chat" />
            </button>
            {onNotifications ? (
              <button
                type="button"
                className="icon-btn"
                onClick={onNotifications}
                aria-label="Notifications"
              >
                <Icon name="bell" />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              aria-pressed={paused || reduced}
              aria-label={
                paused || reduced ? "Resume ambient animation" : "Pause ambient animation"
              }
              title={paused || reduced ? "Resume ambient animation" : "Pause ambient animation"}
              disabled={reduced}
              onClick={() => setMotionPaused((current) => !current)}
            >
              {paused || reduced ? <span style={{ fontSize: 10 }}>▶</span> : <Icon name="pause" />}
            </button>
            <button
              type="button"
              className="icon-btn fullscreen"
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={() => void toggleFullscreen()}
            >
              <Icon name="expand" />
            </button>
            {onProfile ? (
              <button type="button" className="avatar" onClick={onProfile} aria-label="Settings">
                {profileMark ? profileMark.slice(0, 2) : "•"}
              </button>
            ) : null}
          </div>
        </header>

        <div className="workspace">
          <aside className="sidebar">
            <div className="side-label">
              NAVIGATION
              <span>OS</span>
            </div>
            <nav aria-label="Primary navigation">
              {navItems.map((item) => {
                const active = activeSection === item.id;
                const interactive = typeof item.onSelect === "function";
                const className = active ? "nav-item selected" : "nav-item";
                const content = (
                  <>
                    <Icon name={item.icon} />
                    <span>
                      {item.label}
                      {item.detail ? <small>{item.detail}</small> : null}
                    </span>
                    {active ? <i className="small-light" /> : <span className="nav-mark">+</span>}
                  </>
                );
                if (!interactive) {
                  return (
                    <div key={item.id} className={`${className} passive`} aria-disabled="true">
                      {content}
                    </div>
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={className}
                    aria-current={active ? "page" : undefined}
                    onClick={item.onSelect}
                  >
                    {content}
                  </button>
                );
              })}
            </nav>
            {recent ? (
              <div className="recent">
                <div className="side-label">
                  RECENT
                  {onSearch ? (
                    <button type="button" onClick={() => onSearch("")}>
                      SEARCH
                    </button>
                  ) : null}
                </div>
                {recent.loading ? <p className="frontier-note">Loading</p> : null}
                {!recent.loading && recent.error ? (
                  <p className="frontier-note">Unavailable</p>
                ) : null}
                {!recent.loading && !recent.error && recent.items?.length
                  ? recent.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="recent-item"
                        onClick={item.onSelect}
                      >
                        <i className="thread-line" />
                        <span>
                          {item.label}
                          {item.time ? <small>{item.time}</small> : null}
                        </span>
                        <span className="thread-arrow">→</span>
                      </button>
                    ))
                  : null}
                {!recent.loading && !recent.error && !recent.items?.length ? (
                  <p className="frontier-note">No recent conversations</p>
                ) : null}
                {newConversation ? (
                  <button
                    type="button"
                    className="new-conversation"
                    onClick={newConversation.onSelect}
                    disabled={newConversation.disabled}
                  >
                    <Icon name="plus" />
                    New conversation
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="sidebar-bottom">
              <div className="independence">
                <Flag />
                <span>FREEDOM OS</span>
              </div>
              <p>
                Central human <em>intelligence</em>.
              </p>
              <div className="sidebar-foot">
                <i className="small-light" />
                SIGNED IN WORKSPACE
              </div>
            </div>
          </aside>

          <section className="central" aria-label="CHIEF">
            <div className="welcome">
              <div>
                <p className="eyebrow">
                  <i className="tiny-diamond" />
                  {greetingFor(clock)}
                </p>
                <h1>
                  {profileName ? (
                    <>
                      Welcome back, <em>{profileName}</em>
                    </>
                  ) : (
                    <>
                      Welcome to <em>CHIEF</em>
                    </>
                  )}
                </h1>
              </div>
              {modelControl ? (
                <div className="model-control">
                  <Icon name="core" />
                  {modelControl}
                  <span className="select-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </div>
              ) : null}
            </div>

            <div className={`core-stage${conversation ? " has-response" : ""}`} ref={stageRef}>
              <div className="core-title">
                <p className="eyebrow">
                  <i className="tiny-diamond" />
                  INTELLIGENCE
                </p>
                <h2>CHIEF</h2>
                <p>CENTRAL HUMAN INTELLIGENCE</p>
              </div>
              <div className="core-anchor" ref={anchorRef} />
              <div className="core-caption caption-left">
                <span className="caption-rule" />
                <small>FIELD</small>
                <span>SPHERE</span>
                <span className="mini-wave" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className="core-caption caption-right">
                <span className="caption-rule" />
                <small>TRACE</small>
                <span>ORBIT</span>
              </div>
              <div className="core-coordinate">
                <span className="coordinate-line" />
                CHIEF
                <span className="coordinate-line" />
              </div>
              <div className="presence">
                <span className="presence-dot" />
                <span>{copy.label}</span>
                <span>{copy.presence}</span>
              </div>
              {conversation ? (
                <article className="response-card">
                  <div className="response-head">
                    <span>
                      CHIEF
                      <small>{status}</small>
                    </span>
                  </div>
                  <div className="assistant-message">{conversation}</div>
                </article>
              ) : null}
              {workspace ? <div className="chief-workspace-slot">{workspace}</div> : null}
            </div>

            <div className="conversation-dock">
              <div className="dock-topline">
                <span>COMMAND</span>
                <div className="response-modes">
                  {onResponseMode ? (
                    <ChiefResponseMode mode={responseMode} onChange={onResponseMode} />
                  ) : null}
                  {speechActive ? (
                    <button
                      type="button"
                      className="chief-stop-speech"
                      onClick={() => onStopSpeech?.()}
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              </div>
              {showComposer ? (
                <form className="composer" onSubmit={submitMessage}>
                  <button
                    type="button"
                    className={listening ? "mic-button active" : "mic-button"}
                    onClick={() => onMic?.()}
                    disabled={composerDisabled && !listening}
                    aria-pressed={listening}
                    aria-label={listening ? "Stop listening" : "Voice input"}
                  >
                    <Icon name="mic" />
                  </button>
                  <input
                    ref={inputRef}
                    value={message}
                    onChange={(event) => onMessageChange?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !enterToSend) event.preventDefault();
                    }}
                    placeholder="Share a thought with CHIEF"
                    aria-label="Ask CHIEF anything"
                    disabled={composerDisabled}
                  />
                  {allowAttach ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onAttach?.()}
                      aria-label="Attach file"
                      disabled={composerDisabled}
                    >
                      <Icon name="paperclip" />
                    </button>
                  ) : null}
                  {enterToSend ? <span className="input-hint">↵</span> : null}
                  <button
                    type={stopping ? "button" : "submit"}
                    className={stopping ? "send-button busy" : "send-button"}
                    aria-label={stopping ? "Stop response" : "Send message"}
                    disabled={!stopping && (composerDisabled || !trimmed)}
                    onClick={
                      stopping
                        ? () => {
                            onStopTurn?.();
                          }
                        : undefined
                    }
                  >
                    {stopping ? (
                      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M7 7h10v10H7z" />
                      </svg>
                    ) : (
                      <Icon name="send" />
                    )}
                  </button>
                </form>
              ) : null}
              {showComposer && !workspace && suggestions.length ? (
                <div className={suggestions.length === 4 ? "suggestions is-four" : "suggestions"}>
                  {suggestions.map((item) =>
                    typeof item.onSelect === "function" ? (
                      <button key={item.id} type="button" onClick={item.onSelect}>
                        <Icon name={item.icon || SUGGESTION_ICONS[item.id] || "core"} />
                        {item.label}
                        <span>→</span>
                      </button>
                    ) : null
                  )}
                </div>
              ) : null}
              {shortcuts.length ? (
                <div className="suggestions">
                  {shortcuts.map((item) =>
                    typeof item.onSelect === "function" ? (
                      <button
                        key={item.id}
                        type="button"
                        className="frontier-shortcut"
                        onClick={item.onSelect}
                      >
                        <Icon name={item.icon} />
                        {item.label}
                      </button>
                    ) : null
                  )}
                </div>
              ) : null}
              <div className="dock-foot">
                <span>
                  <Icon name="core" />
                  {enterToSend ? "ENTER TO SEND" : "CLICK SEND"}
                </span>
                <span>{metricBits.join("  ·  ") || status}</span>
              </div>
            </div>
          </section>

          <aside className="inspector">
            {showSystemStatus ? (
              <section className="system-panel" aria-label="CHIEF system">
                <div className="panel-heading">
                  <p className="eyebrow">SYSTEM</p>
                  <span className="panel-index">01</span>
                </div>
                <div className="system-status">
                  <div className="status-orbit" aria-hidden="true">
                    <i />
                  </div>
                  <div>
                    <h3>{copy.title}</h3>
                    <p>{copy.subtitle}</p>
                  </div>
                </div>
                <div className="signal" aria-hidden="true">
                  <svg viewBox="0 0 220 34">
                    <path className="signal-grid" d="M0 17h220M20 2v30M70 2v30M120 2v30M170 2v30" />
                    <path
                      className="signal-path"
                      d="M0 22c18 0 22-14 40-14s24 16 42 16 20-18 40-16 24 12 42 8 28-10 56-6"
                    />
                  </svg>
                  <i />
                </div>
                <div className="state-list">
                  {ACTIVITIES.map(([id, label]) => {
                    const active = activity === id;
                    return (
                      <div key={id} className={active ? "active" : undefined} data-state={id}>
                        <span className="state-node" />
                        <span>{label}</span>
                        <span className="state-indicator">{active ? "ACTIVE" : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section className="context-panel" aria-label="Connections">
              <div className="panel-heading">
                <p className="eyebrow">CONTEXT</p>
                <span className="panel-index">02</span>
              </div>
              <p className="panel-description">
                {accessLine || "Connections follow the permissions on this account."}
              </p>
              {Array.isArray(systems) && systems.length ? (
                <div className="context-grid">
                  {systems.map((system) => (
                    <button
                      key={system.id}
                      type="button"
                      onClick={() => onOpenSystem?.(system.id)}
                      disabled={!onOpenSystem}
                    >
                      <Icon
                        name={
                          system.id === "freedom-financial"
                            ? "chart"
                            : system.id === "codebase"
                              ? "search"
                              : system.id === "grokbot"
                                ? "network"
                                : "core"
                        }
                      />
                      <span>{system.name}</span>
                      <small>{system.status || "Unavailable"}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="frontier-note">
                  {systems === null
                    ? "Connections could not be read."
                    : "No connections are configured."}
                </p>
              )}
              {onOpenAccess ? (
                <button type="button" className="context-foot" onClick={onOpenAccess}>
                  <Icon name="lock" />
                  Permissions
                </button>
              ) : null}
            </section>

            <div className="inspector-bottom">
              <p className="eyebrow">ACCESS</p>
              <p>
                Tools run only with the <em>access you allow</em>.
              </p>
              <div className="stars" aria-hidden="true">
                ✦ ✦ ✦
              </div>
            </div>
          </aside>
        </div>

        <footer className="statusbar">
          <span>
            <i className="small-light" />
            {status}
          </span>
          <span className="footer-center">FREEDOM OS</span>
          <span>
            {accessLine || "CHIEF"}
            <span className="footer-cross">+</span>
          </span>
        </footer>
      </div>
      <p className="chief-sr" aria-live="polite">
        {String(assistantState || "idle")}
      </p>
    </main>
  );
}
