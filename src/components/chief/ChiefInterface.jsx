import { useId } from "react";
import "./ChiefInterface.css";

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
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.5a2 2 0 0 1-1-2z" />
        <path d="M8 8h8M8 11.5h5" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path
          d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z"
          transform="translate(-1 -1) scale(1.08)"
        />
      </>
    ),
    sliders: (
      <>
        <path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10" />
        <circle cx="11" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="8" cy="18" r="2" />
      </>
    ),
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    file: (
      <>
        <path d="M6 2.8h8l5 5V21H6z" />
        <path d="M14 3v5h5M9 13h6M9 16.5h6" />
      </>
    ),
    chart: <path d="M4 20V11M10 20V5M16 20v-8M22 20V2" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
      </>
    ),
    paperclip: (
      <path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.9 8.9a5 5 0 0 1-7.1-7.1l8.6-8.6" />
    ),
    send: (
      <>
        <path d="m21 3-7.2 18-3.8-7-7-3.8Z" />
        <path d="M21 3 10 14" />
      </>
    ),
    bell: <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    brain: (
      <>
        <path d="M12 4a3 3 0 0 0-5.7 1.2A3.5 3.5 0 0 0 4 11a3.5 3.5 0 0 0 2.3 5.8A3.5 3.5 0 0 0 12 19z" />
        <path d="M12 4a3 3 0 0 1 5.7 1.2A3.5 3.5 0 0 1 20 11a3.5 3.5 0 0 1-2.3 5.8A3.5 3.5 0 0 1 12 19M8 8h4M7 13h5m4-5h-4m4 5h-4" />
      </>
    ),
    network: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="18" r="2" />
        <circle cx="19" cy="18" r="2" />
        <path d="m11 7-5 9m7-9 5 9M7 18h10" />
      </>
    ),
    sparkle: (
      <>
        <path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9Z" />
        <path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9Z" />
      </>
    ),
    layers: <path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />,
  };

  return <svg {...common}>{paths[name] || paths.sparkle}</svg>;
}

function IntelligenceCore() {
  const ticks = Array.from({ length: 72 }, (_, i) => i);
  const rawId = useId().replace(/:/g, "");
  const fillId = `chiefCoreFill-${rawId}`;
  const ringId = `chiefRing-${rawId}`;
  const glowId = `chiefGlow-${rawId}`;
  const clipId = `chiefCoreClip-${rawId}`;

  return (
    <div className="chief-core" aria-hidden="true">
      <div className="core-aura" />
      <div className="core-stream core-stream-a" />
      <div className="core-stream core-stream-b" />

      <svg className="core-svg" viewBox="0 0 600 600">
        <defs>
          <radialGradient id={fillId}>
            <stop offset="0%" stopColor="#e8ffff" />
            <stop offset="17%" stopColor="#50eaff" />
            <stop offset="48%" stopColor="#087eff" />
            <stop offset="78%" stopColor="#092e9c" />
            <stop offset="100%" stopColor="#020a22" />
          </radialGradient>
          <linearGradient id={ringId} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#75faff" />
            <stop offset=".48" stopColor="#1478ff" />
            <stop offset="1" stopColor="#9d5dff" />
          </linearGradient>
          <filter id={glowId}>
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={clipId}>
            <circle cx="300" cy="300" r="119" />
          </clipPath>
        </defs>

        {[146, 158, 174, 191, 209, 229, 250].map((r, i) => (
          <circle
            key={r}
            cx="300"
            cy="300"
            r={r}
            fill="none"
            stroke={i % 2 ? "#258cff" : "#6cefff"}
            strokeOpacity={i % 3 === 0 ? ".72" : ".25"}
            strokeWidth={i % 3 === 0 ? "1.7" : "1"}
          />
        ))}

        <circle
          cx="300"
          cy="300"
          r="136"
          fill="none"
          stroke={`url(#${ringId})`}
          strokeWidth="7"
          strokeDasharray="140 24 62 16 22 19"
          filter={`url(#${glowId})`}
          className="core-ring-rotate"
        />

        <circle
          cx="300"
          cy="300"
          r="201"
          fill="none"
          stroke="#36b9ff"
          strokeOpacity=".85"
          strokeWidth="4"
          strokeDasharray="86 34 8 30 42 14 16 50"
          className="core-ring-reverse"
        />

        <circle
          cx="300"
          cy="300"
          r="218"
          fill="none"
          stroke="#8ddcff"
          strokeOpacity=".5"
          strokeWidth="1.5"
          strokeDasharray="2 8"
        />

        <circle
          cx="300"
          cy="300"
          r="239"
          fill="none"
          stroke="#1878ff"
          strokeOpacity=".6"
          strokeWidth="1"
          strokeDasharray="1 7"
        />

        {ticks.map((i) => {
          const a = (i / 72) * Math.PI * 2;
          const r1 = i % 6 === 0 ? 224 : 231;
          const r2 = i % 6 === 0 ? 241 : 235;

          return (
            <line
              key={i}
              x1={300 + Math.cos(a) * r1}
              y1={300 + Math.sin(a) * r1}
              x2={300 + Math.cos(a) * r2}
              y2={300 + Math.sin(a) * r2}
              stroke={i % 6 === 0 ? "#7ceeff" : "#2688ff"}
              strokeOpacity={i % 6 === 0 ? ".95" : ".42"}
              strokeWidth={i % 6 === 0 ? "2" : "1"}
            />
          );
        })}

        <circle
          cx="300"
          cy="300"
          r="123"
          fill={`url(#${fillId})`}
          stroke="#9efbff"
          strokeWidth="2"
          filter={`url(#${glowId})`}
        />

        <g clipPath={`url(#${clipId})`}>
          <path
            className="core-wave core-wave-one"
            d="M160 335 C215 240 255 390 319 298 S420 224 452 280"
            fill="none"
            stroke="#a8ffff"
            strokeWidth="5"
            filter={`url(#${glowId})`}
          />

          <path
            className="core-wave core-wave-two"
            d="M170 370 C235 290 258 340 313 320 S392 260 442 235"
            fill="none"
            stroke="#5f9bff"
            strokeWidth="12"
            strokeOpacity=".75"
          />

          <path
            d="M170 265 C220 205 270 238 300 276 S370 385 435 327"
            fill="none"
            stroke="#ffffff"
            strokeOpacity=".65"
            strokeWidth="2"
          />

          {Array.from({ length: 48 }, (_, i) => (
            <circle
              key={i}
              cx={178 + ((i * 47) % 245)}
              cy={188 + ((i * 71) % 220)}
              r={i % 5 === 0 ? 1.8 : 0.8}
              fill="#d7ffff"
              opacity={i % 4 === 0 ? ".85" : ".38"}
            />
          ))}
        </g>

        {[0, 90, 180, 270].map((deg) => (
          <g key={deg} transform={`rotate(${deg} 300 300)`}>
            <line x1="300" y1="36" x2="300" y2="64" stroke="#69eaff" strokeWidth="1.5" />
            <circle cx="300" cy="30" r="5" fill="#04152f" stroke="#59efff" strokeWidth="2" />
            <circle cx="300" cy="64" r="3" fill="#b7ffff" />
          </g>
        ))}
      </svg>

      <div className="core-label core-label-left">
        <span>NLP</span>
        <span>VISION</span>
        <span>PLANNING</span>
        <span>TOOLS</span>
        <span>AGENTS</span>
      </div>
      <div className="core-label core-label-right">
        <span>ANALYZE</span>
        <span>REASON</span>
        <span>CREATE</span>
        <span>EXECUTE</span>
        <span>ASSIST</span>
      </div>
    </div>
  );
}

function Panel({ className = "", children }) {
  return <section className={`chief-panel ${className}`}>{children}</section>;
}

function metricValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { kind: "percent", text: Math.max(0, Math.min(100, value)) };
  }
  if (typeof value === "string" && value.trim()) return { kind: "text", text: value.trim() };
  return { kind: "empty", text: "—" };
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
  status = "Ready",
  statusTone = "ready",
  assistantState = "idle",
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
  conversation = null,
  inputRef = null,
}) {
  const state = String(assistantState || "idle").toLowerCase();
  const stateLabel = String(assistantState || "idle").toUpperCase();
  const metricRows = [
    ["CPU", systemStatus.cpu],
    ["MEMORY", systemStatus.memory],
    ["AGENTS", systemStatus.agents],
    ["TOOLS", systemStatus.tools],
    ["NETWORK", systemStatus.network],
  ];
  const rootClass = [
    "chief-interface",
    `state-${state}`,
    `is-${statusTone}`,
    reducedMotion ? "is-reduced-motion" : "",
    conversation ? "has-exchange" : "",
    showSystemStatus ? "" : "is-telemetry-off",
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
    <main className={rootClass}>
      <div className="chief-starfield" />
      <div className="chief-nebula chief-nebula-a" />
      <div className="chief-nebula chief-nebula-b" />

      <header className="chief-topbar">
        <button
          type="button"
          className="chief-brand"
          onClick={() => onHome?.()}
          aria-label="CHIEF home"
        >
          <span className="chief-brand-mark">A</span>
          <span className="chief-brand-name">CHIEF</span>
          <span className="chief-brand-divider" />
          <span className="chief-brand-subtitle">PERSONAL INTELLIGENCE</span>
        </button>

        <div className="chief-top-actions">
          {onSearch ? (
            <button
              type="button"
              className="chief-icon-button"
              onClick={onSearch}
              aria-label="Search"
            >
              <Icon name="search" />
            </button>
          ) : null}
          {onNotifications ? (
            <button
              type="button"
              className="chief-icon-button"
              onClick={onNotifications}
              aria-label="Notifications"
            >
              <Icon name="bell" />
            </button>
          ) : null}
          <div className={`chief-online is-${statusTone}`}>
            <i /> {status}
          </div>
          {onProfile ? (
            <button
              type="button"
              className="chief-profile"
              onClick={onProfile}
              aria-label="Settings"
            >
              <Icon name="user" size={27} />
            </button>
          ) : null}
        </div>
      </header>

      <nav className="chief-left-rail" aria-label="Primary navigation">
        {navItems.map((item) => {
          const active = activeSection === item.id;
          const interactive = typeof item.onSelect === "function";
          const content = (
            <>
              <Icon name={item.icon} size={28} />
              {showNavLabels ? (
                <span>{item.label}</span>
              ) : (
                <span className="chief-sr">{item.label}</span>
              )}
              <b aria-hidden="true">›</b>
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
      </nav>

      <section className="chief-stage" aria-label="CHIEF intelligence visualization">
        <IntelligenceCore />
      </section>

      <aside className="chief-right-rail">
        <Panel className="chief-assistant-panel">
          <div className="chief-assistant-head">
            <div>
              <h2>CHIEF</h2>
              <p>AI ASSISTANT</p>
              <div className={`chief-ready is-${statusTone}`}>
                <i />
                {status}
              </div>
            </div>
            <div className="chief-mini-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>

          <div className="chief-capability">
            <Icon name="brain" size={29} />
            <div>
              <strong>UNDERSTAND</strong>
              <span>Context across your world</span>
            </div>
          </div>
          <div className="chief-capability">
            <Icon name="network" size={29} />
            <div>
              <strong>REASON</strong>
              <span>Find insights and solutions</span>
            </div>
          </div>
          <div className="chief-capability">
            <Icon name="sparkle" size={29} />
            <div>
              <strong>CREATE</strong>
              <span>Turn ideas into action</span>
            </div>
          </div>
          <div className="chief-capability">
            <Icon name="layers" size={29} />
            <div>
              <strong>ASSIST</strong>
              <span>Across work, life, and wealth</span>
            </div>
          </div>
        </Panel>

        {showSystemStatus ? (
          <Panel className="chief-system-panel">
            <div className="chief-system-title">
              <strong>SYSTEM STATUS</strong>
              <span className="chief-signal" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>

            {metricRows.map(([label, value]) => {
              const metric = metricValue(value);
              return (
                <div className="chief-metric" key={label}>
                  <span>{label}</span>
                  {metric.kind === "percent" ? (
                    <>
                      <div className="chief-meter">
                        <i style={{ width: `${metric.text}%` }} />
                      </div>
                      <b>{metric.text}%</b>
                    </>
                  ) : (
                    <>
                      <div className="chief-meter chief-meter-empty">
                        <i />
                      </div>
                      <b>{metric.text}</b>
                    </>
                  )}
                </div>
              );
            })}
          </Panel>
        ) : null}
      </aside>

      <div className="chief-bottom-stack">
        {conversation ? <div className="chief-interface-conversation">{conversation}</div> : null}
        <div className="chief-bottom-area">
          <div className="chief-bottom-mark" aria-hidden="true">
            ▤
          </div>

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
                <Icon name="mic" size={30} />
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
                    <Icon name="paperclip" size={22} />
                  </button>
                ) : null}

                <button
                  type="submit"
                  className="chief-send-button"
                  aria-label="Send message"
                  disabled={composerDisabled || !String(message || "").trim()}
                >
                  <Icon name="send" size={25} />
                </button>
              </form>
            </div>
          ) : (
            <div className="chief-composer chief-composer--quiet" />
          )}

          <div className="chief-shortcuts">
            {shortcuts.map((item) =>
              typeof item.onSelect === "function" ? (
                <button
                  key={item.id}
                  type="button"
                  className="chief-shortcut"
                  onClick={item.onSelect}
                >
                  <span>
                    <Icon name={item.icon} size={25} />
                  </span>
                  <small>{item.label}</small>
                </button>
              ) : (
                <div key={item.id} className="chief-shortcut is-inert" aria-disabled="true">
                  <span>
                    <Icon name={item.icon} size={25} />
                  </span>
                  <small>{item.label}</small>
                </div>
              )
            )}
          </div>
        </div>
      </div>

      <div className="chief-state-caption">{stateLabel}</div>
    </main>
  );
}
