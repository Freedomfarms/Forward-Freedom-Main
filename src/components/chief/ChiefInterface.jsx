import { useRef } from "react";
import landscapeUrl from "./chief-landscape.webp";
import { ChiefScene } from "./ChiefScene.jsx";
import { sceneMotion } from "./chiefSceneMotion.js";
import "./ChiefInterface.css";

const SYSTEM_ROWS = [
  ["listening", "Listening", "wave"],
  ["processing", "Processing", "grid"],
  ["reasoning", "Reasoning", "brain"],
  ["searching", "Searching", "search"],
  ["connecting", "Connecting", "network"],
  ["responding", "Responding", "send"],
];

function Icon({ name, size = 22 }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };

  const paths = {
    chat: (
      <>
        <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3v-3.2" />
        <path d="M8 9h8M8 12h5" />
      </>
    ),
    core: (
      <>
        <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="5.4" />
        <path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2" />
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
        <path d="M4.5 12 19 5.5 13.2 19l-1.6-6.2L4.5 12Z" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19h16" />
        <path d="M7 16v-4M12 16V8M17 16v-6" />
      </>
    ),
    pulse: <path d="M3 12h4l2.2-5 3.6 10L15 12h6" />,
    bolt: <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" />,
    brain: (
      <>
        <path d="M9 6.5A2.5 2.5 0 0 1 12 5a2.5 2.5 0 0 1 3 1.6 2.4 2.4 0 0 1 2.2 3.2A2.6 2.6 0 0 1 16 15a2.7 2.7 0 0 1-4 2 2.7 2.7 0 0 1-4-2 2.6 2.6 0 0 1-1.2-5.2A2.4 2.4 0 0 1 9 6.5Z" />
        <path d="M12 5v12" />
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
    users: (
      <>
        <circle cx="9" cy="8" r="2.3" />
        <circle cx="16" cy="8.5" r="1.8" />
        <path d="M4.6 17.6a4.4 4.4 0 0 1 8.6 0" />
        <path d="M13.2 17.4a3.5 3.5 0 0 1 6.2.5" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" />
      </>
    ),
    list: (
      <>
        <path d="M9 7h11M9 12h11M9 17h11" />
        <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
      </>
    ),
    more: (
      <>
        <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
  };

  return <svg {...common}>{paths[name] || paths.core}</svg>;
}

function presenceLabel(status, statusTone) {
  if (statusTone === "signed-out") return "Sign in";
  if (statusTone === "error") return "Error";
  if (statusTone === "wait") return status || "Waiting";
  if (statusTone === "ready") return "Online";
  return status || "Online";
}

export function ChiefInterface({
  activeSection = "",
  navItems = [],
  shortcuts = [],
  showNavLabels = true,
  onHome,
  onSearch,
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
  enterToSend = true,
  showComposer = true,
  allowAttach = false,
  onAttach,
  reducedMotion = false,
  showSystemStatus = true,
  suggestions = [],
  conversation = null,
  workspace = null,
  modelControl = null,
  inputRef = null,
  audioLevelRef = null,
}) {
  const shellRef = useRef(null);
  const state = String(assistantState || "idle").toLowerCase();
  const phase = ["idle", "thinking", "responding"].includes(scenePhase) ? scenePhase : "idle";
  const motion = sceneMotion({
    scenePhase: phase,
    assistantState: state,
    status,
    statusTone,
  });
  const presence = presenceLabel(status, statusTone);
  const chips = [
    ...suggestions.filter((item) => item && typeof item.onSelect === "function"),
    ...shortcuts.filter((item) => item && typeof item.onSelect === "function"),
  ];
  const rootClass = [
    "chief-interface",
    `state-${state}`,
    `phase-${phase}`,
    `is-${statusTone}`,
    reducedMotion ? "is-reduced-motion" : "",
    conversation ? "has-exchange" : "",
    workspace ? "has-workspace" : "",
    showSystemStatus ? "" : "is-telemetry-off",
    showNavLabels ? "" : "is-nav-compact",
  ]
    .filter(Boolean)
    .join(" ");

  function submitMessage(event) {
    event.preventDefault();
    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!showComposer || composerDisabled || !trimmed) return;
    onSend?.(trimmed);
  }

  return (
    <main ref={shellRef} className={rootClass} data-pace={motion.pace}>
      <div className="chief-scene-frame">
        <div className="chief-scene-plate" style={{ backgroundImage: `url("${landscapeUrl}")` }} />
        <ChiefScene
          scenePhase={phase}
          assistantState={state}
          status={status}
          statusTone={statusTone}
          reducedMotion={reducedMotion}
          audioLevelRef={audioLevelRef}
          shellRef={shellRef}
        />
      </div>

      <header className="chief-topbar">
        <button
          type="button"
          className="chief-brand"
          onClick={() => onHome?.()}
          aria-label="CHIEF home"
        >
          <span className="chief-brand-mark" aria-hidden="true" />
          <span className="chief-brand-name">FREEDOM OS</span>
        </button>

        <div className="chief-top-title">
          <strong>CHIEF</strong>
          <span>Central human intelligence & execution fabric</span>
        </div>

        <div className="chief-top-actions">
          <p className={`chief-presence is-${statusTone}`}>
            <i />
            {presence}
          </p>
          {modelControl}
        </div>
      </header>

      <nav className="chief-left-rail" aria-label="Primary navigation">
        <div className="chief-nav-list">
          {navItems.map((item) => {
            const active = activeSection === item.id;
            const interactive = typeof item.onSelect === "function";
            const content = (
              <>
                <span className="chief-nav-icon">
                  <Icon name={item.icon} size={18} />
                </span>
                {showNavLabels ? (
                  <span className="chief-nav-label">{item.label}</span>
                ) : (
                  <span className="chief-sr">{item.label}</span>
                )}
              </>
            );
            if (!interactive) {
              return (
                <div key={item.id} className="chief-nav-item is-inert" aria-disabled="true">
                  {content}
                </div>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                className={active ? "chief-nav-item is-active" : "chief-nav-item"}
                aria-current={active ? "page" : undefined}
                onClick={item.onSelect}
              >
                {content}
              </button>
            );
          })}
        </div>
      </nav>

      <section className="chief-stage" aria-label="CHIEF">
        {workspace ? <div className="chief-workspace-slot">{workspace}</div> : null}
        <div className="chief-stage-dock">
          {conversation ? <div className="chief-interface-conversation">{conversation}</div> : null}
          {showComposer ? (
            <div className="chief-dock">
              <div className="chief-composer">
                <button
                  type="button"
                  className={listening ? "chief-mic-button is-listening" : "chief-mic-button"}
                  onClick={() => onMic?.()}
                  disabled={composerDisabled && !listening}
                  aria-pressed={listening}
                  aria-label={listening ? "Stop listening" : "Voice input"}
                >
                  <Icon name="mic" size={20} />
                </button>
                <form className="chief-message-form" onSubmit={submitMessage}>
                  <input
                    ref={inputRef}
                    value={message}
                    onChange={(event) => onMessageChange?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !enterToSend) event.preventDefault();
                    }}
                    placeholder="Talk to CHIEF..."
                    aria-label="Talk to CHIEF"
                    disabled={composerDisabled}
                  />
                  {allowAttach ? (
                    <button
                      type="button"
                      className="chief-attach-button"
                      onClick={() => onAttach?.()}
                      aria-label="Attach file"
                      disabled={composerDisabled}
                    >
                      <Icon name="paperclip" size={18} />
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="chief-send-button"
                    aria-label="Send message"
                    disabled={composerDisabled || !String(message || "").trim()}
                  >
                    <Icon name="send" size={16} />
                  </button>
                </form>
              </div>
              {chips.length ? (
                <div className="chief-suggestions">
                  {chips.map((item) => (
                    <button key={item.id} type="button" onClick={item.onSelect}>
                      {item.icon ? <Icon name={item.icon} size={13} /> : null}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {onSearch && !chips.some((item) => item.id === "search") ? (
                <div className="chief-suggestions">
                  <button type="button" onClick={() => onSearch("")}>
                    <Icon name="search" size={13} />
                    <span>Search</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {showSystemStatus ? (
        <aside className="chief-right-rail" aria-label="CHIEF system">
          <section className="chief-system-card">
            <h2>CHIEF SYSTEM</h2>
            <ul className="chief-system-list">
              {SYSTEM_ROWS.map(([id, label, icon]) => {
                const live = Boolean(motion.activity[id]);
                return (
                  <li
                    key={id}
                    className={live ? "is-live" : ""}
                    aria-current={live ? "true" : undefined}
                  >
                    <Icon name={icon === "wave" ? "pulse" : icon} size={15} />
                    <span>{label}</span>
                    {id === "listening" ? (
                      <span className="chief-eq" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      ) : null}

      <p className="chief-sr" aria-live="polite">
        {presence}. {state}
      </p>
    </main>
  );
}
