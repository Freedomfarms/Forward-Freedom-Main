import footerUrl from "./chief-footer.webp";
import sceneUrl from "./chief-scene.webp";
import "./ChiefInterface.css";

const FEATURES = [
  {
    icon: "brain",
    title: "Deep Understanding",
    text: "Context across your world",
  },
  {
    icon: "pulse",
    title: "Strategic Reasoning",
    text: "Multi-step replies",
  },
  {
    icon: "bolt",
    title: "Real Execution",
    text: "Approval before action",
  },
  {
    icon: "chart",
    title: "Compounding Value",
    text: "Continues across conversations",
  },
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
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="5.5" />
        <circle cx="12" cy="12" r="9" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.2v1.8M12 19v1.8M4.9 6.5l1.4 1.1M17.7 16.4l1.4 1.1M4.9 17.5l1.4-1.1M17.7 7.6l1.4-1.1M3.2 12h1.8M19 12h1.8" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
        <circle cx="8" cy="7" r="2" fill="#03101f" />
        <circle cx="15" cy="12" r="2" fill="#03101f" />
        <circle cx="10" cy="17" r="2" fill="#03101f" />
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
        <path d="M4 12h12" />
        <path d="m12 6 6 6-6 6" />
      </>
    ),
    bell: (
      <>
        <path d="M6 16V10a6 6 0 1 1 12 0v6" />
        <path d="M4.5 16.5h15M10 19a2 2 0 0 0 4 0" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
      </>
    ),
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
    chart: (
      <>
        <path d="M4 19h16" />
        <path d="M7 16v-4M12 16V8M17 16v-6" />
      </>
    ),
    pulse: <path d="M3 12h4l2.2-5 3.6 10L15 12h6" />,
    bolt: <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" />,
  };

  return <svg {...common}>{paths[name] || paths.core}</svg>;
}

function metricValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { kind: "percent", text: Math.max(0, Math.min(100, value)) };
  }
  if (typeof value === "string" && value.trim()) return { kind: "text", text: value.trim() };
  return { kind: "empty", text: "" };
}

function Panel({ className = "", children }) {
  return <section className={`chief-panel ${className}`}>{children}</section>;
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
  systemStatus = {
    cpu: null,
    memory: null,
    agents: null,
    tools: null,
    network: null,
  },
  quickActions = [],
  recent = null,
  suggestions = [],
  conversation = null,
  inputRef = null,
}) {
  const state = String(assistantState || "idle").toLowerCase();
  const phase = ["idle", "thinking", "responding"].includes(scenePhase) ? scenePhase : "idle";
  const metricRows = [
    ["CPU", systemStatus.cpu],
    ["Memory", systemStatus.memory],
    ["Agents", systemStatus.agents],
    ["Tools", systemStatus.tools],
    ["Network", systemStatus.network],
  ].flatMap(([label, value]) => {
    const metric = metricValue(value);
    return metric.kind === "empty" ? [] : [[label, metric]];
  });
  const rootClass = [
    "chief-interface",
    `state-${state}`,
    `phase-${phase}`,
    `is-${statusTone}`,
    reducedMotion ? "is-reduced-motion" : "",
    conversation ? "has-exchange" : "",
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

  function submitSearch(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSearch?.(String(data.get("q") || ""));
  }

  return (
    <main className={rootClass}>
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
          {onSearch ? (
            <form className="chief-search" role="search" onSubmit={submitSearch}>
              <Icon name="search" size={16} />
              <input
                name="q"
                type="search"
                placeholder="Search conversations"
                aria-label="Search conversations"
                enterKeyHint="search"
              />
            </form>
          ) : null}
          {onNotifications ? (
            <button
              type="button"
              className="chief-icon-button"
              onClick={onNotifications}
              aria-label="Notifications"
            >
              <Icon name="bell" size={18} />
            </button>
          ) : null}
          {onProfile ? (
            <button
              type="button"
              className="chief-profile"
              onClick={onProfile}
              aria-label="Settings"
            >
              {profileMark ? profileMark.slice(0, 2) : <Icon name="user" size={18} />}
            </button>
          ) : null}
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
                  <span className="chief-nav-copy">
                    <strong>{item.label}</strong>
                    {item.detail ? <small>{item.detail}</small> : null}
                  </span>
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
        {onHome ? (
          <button type="button" className="chief-rail-foot" onClick={() => onHome()}>
            <img src={footerUrl} alt="" />
            <span>
              <strong>Freedom OS</strong>
              <small>Live the Future You Own</small>
            </span>
          </button>
        ) : null}
      </nav>

      <section className="chief-stage" aria-label="CHIEF">
        <div className="chief-scene-frame">
          <div className="chief-scene-plate">
            <img className="chief-scene" src={sceneUrl} alt="" draggable="false" />
            <i className="chief-core-field" />
            <i className="chief-core-wash" />
            <img className="chief-ring-field" src={sceneUrl} alt="" draggable="false" />
            <i className="chief-ring-flow" />
          </div>
        </div>

        <div className="chief-stage-dock">
          <div className="chief-stage-copy">
            <p className="chief-wordmark">CHIEF</p>
            <p className="chief-mantra">Understand · Reason · Plan · Execute</p>
            <p className="chief-tagline">
              Your personal intelligence layer for a more free, sovereign, and abundant life.
            </p>
          </div>

          <div className="chief-features">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="chief-feature">
                <span>
                  <Icon name={feature.icon} size={16} />
                </span>
                <strong>{feature.title}</strong>
                <small>{feature.text}</small>
              </div>
            ))}
          </div>

          {conversation ? <div className="chief-interface-conversation">{conversation}</div> : null}

          {showComposer ? (
            <div className="chief-composer">
              <button
                type="button"
                className={listening ? "chief-mic-button is-listening" : "chief-mic-button"}
                onClick={() => onMic?.()}
                disabled={composerDisabled && !listening}
                aria-pressed={listening}
                aria-label={listening ? "Stop listening" : "Voice input"}
              >
                <Icon name="mic" size={18} />
              </button>
              <form className="chief-message-form" onSubmit={submitMessage}>
                <input
                  ref={inputRef}
                  value={message}
                  onChange={(event) => onMessageChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !enterToSend) event.preventDefault();
                  }}
                  placeholder="Ask CHIEF anything..."
                  aria-label="Ask CHIEF anything"
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
                  <Icon name="send" size={18} />
                </button>
              </form>
            </div>
          ) : null}

          {showComposer && suggestions.length ? (
            <div className="chief-suggestions">
              {suggestions.map((item) =>
                typeof item.onSelect === "function" ? (
                  <button key={item.id} type="button" onClick={item.onSelect}>
                    {item.label}
                  </button>
                ) : null
              )}
            </div>
          ) : null}

          {shortcuts.length ? (
            <div className="chief-shortcuts">
              {shortcuts.map((item) =>
                typeof item.onSelect === "function" ? (
                  <button
                    key={item.id}
                    type="button"
                    className="chief-shortcut"
                    onClick={item.onSelect}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{item.label}</span>
                  </button>
                ) : null
              )}
            </div>
          ) : null}
        </div>
      </section>

      <aside className="chief-right-rail">
        <Panel className="chief-identity">
          <span className="chief-identity-mark" aria-hidden="true" />
          <div>
            <h2>CHIEF</h2>
            <p className={`chief-ready is-${statusTone}`}>
              <i />
              {status}
            </p>
            <p className="chief-identity-line">Personal intelligence for this account.</p>
          </div>
        </Panel>

        {showSystemStatus && metricRows.length ? (
          <Panel className="chief-system-panel">
            <div className="chief-system-title">
              <strong>System status</strong>
              <span className={`chief-ready is-${statusTone}`}>
                <i />
                {status}
              </span>
            </div>
            {metricRows.map(([label, metric]) => (
              <div
                className={
                  metric.kind === "percent" ? "chief-metric" : "chief-metric chief-metric-text"
                }
                key={label}
              >
                <span>{label}</span>
                {metric.kind === "percent" ? (
                  <div className="chief-meter" aria-hidden="true">
                    <i style={{ width: `${metric.text}%` }} />
                  </div>
                ) : null}
                <b>{metric.kind === "percent" ? `${metric.text}%` : metric.text}</b>
              </div>
            ))}
          </Panel>
        ) : null}

        {quickActions.length ? (
          <Panel className="chief-actions-panel">
            <div className="chief-system-title">
              <strong>Quick actions</strong>
            </div>
            <div className="chief-actions">
              {quickActions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={item.onSelect}
                  disabled={item.disabled}
                  aria-pressed={item.pressed || undefined}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </Panel>
        ) : null}

        {recent ? (
          <Panel className="chief-recent-panel">
            <div className="chief-system-title">
              <strong>Recent conversations</strong>
              {typeof recent.onViewAll === "function" ? (
                <button type="button" className="chief-text-link" onClick={recent.onViewAll}>
                  View all
                </button>
              ) : null}
            </div>
            {recent.loading ? <p className="chief-panel-note">Loading</p> : null}
            {!recent.loading && recent.error ? (
              <p className="chief-panel-note">Unavailable</p>
            ) : null}
            {!recent.loading && !recent.error && recent.items?.length ? (
              <div className="chief-recent-list">
                {recent.items.map((item) => (
                  <button key={item.id} type="button" onClick={item.onSelect}>
                    <Icon name="chat" size={15} />
                    <span>{item.label}</span>
                    {item.time ? <time>{item.time}</time> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {!recent.loading && !recent.error && !recent.items?.length ? (
              <p className="chief-panel-note">No recent conversations</p>
            ) : null}
          </Panel>
        ) : null}
      </aside>

      <p className="chief-sr" aria-live="polite">
        {String(assistantState || "idle")}
      </p>
    </main>
  );
}
