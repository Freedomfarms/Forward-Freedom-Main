/*!
 * @license
 * JarvisOrb is imported from jarvis-ai-web-animation (MIT).
 * Copyright (c) 2026 cyber1443
 * https://github.com/cyber1443/jarvis-ai-orb-web-animation
 * The full notice is in src/third_party/jarvis-ai-web-animation/LICENSE.
 */
import { useEffect, useState } from "react";
import { JarvisOrb } from "jarvis-ai-web-animation";
import jarvisLicense from "../../third_party/jarvis-ai-web-animation/LICENSE?raw";
import "./ChiefInterface.css";

// Violet palette passed through JarvisOrb's native palette object.
// Idle keeps the component's built-in idle target, which already orbits.
const CHIEF_ORB_PALETTE = {
  core: 0xf5e8ff,
  primary: 0xc084fc,
  secondary: 0x7c3aed,
  tertiary: 0xe9d5ff,
  deep: 0x2e1065,
  fallback:
    "radial-gradient(circle at 50% 48%, #f5e8ff 0%, #c084fc 22%, #7c3aed 46%, #2e1065 74%, transparent 88%)",
};

// Custom targets stay put. Built-in "alert" and "success" ease back to idle.
const LISTENING_STATE = {
  energy: 1.4,
  rotationSpeed: 0.6,
  particleSpeed: 1.6,
  shellRadius: 1.08,
  ringSpread: 1,
  filamentOpacity: 0.7,
  coreScale: 1.1,
  bloom: 0.9,
};

const SPEAKING_STATE = {
  energy: 1.12,
  rotationSpeed: 0.74,
  particleSpeed: 0.95,
  shellRadius: 1.05,
  ringSpread: 0.98,
  filamentOpacity: 0.58,
  coreScale: 1.08,
  bloom: 0.8,
};

const ALERT_STATE = {
  energy: 0.94,
  rotationSpeed: 0.92,
  particleSpeed: 0.92,
  shellRadius: 1.04,
  ringSpread: 0.98,
  filamentOpacity: 0.46,
  coreScale: 1,
  bloom: 0.74,
};

function orbMotion({ assistantState, scenePhase, statusTone }) {
  if (statusTone === "error") return ALERT_STATE;
  const motion = String(assistantState || "idle").toLowerCase();
  if (motion === "listening") return LISTENING_STATE;
  if (motion === "speaking" || scenePhase === "responding") return SPEAKING_STATE;
  if (motion === "thinking" || scenePhase === "thinking") return "thinking";
  return "idle";
}

function useHomepageOrbSize() {
  const [orbSize, setOrbSize] = useState("hero");

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const apply = () => setOrbSize(query.matches ? "panel" : "hero");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return orbSize;
}

function Icon({ name, size = 18 }) {
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
  };

  return <svg {...common}>{paths[name] || paths.core}</svg>;
}

export function ChiefInterface({
  activeSection = "",
  navItems = [],
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
  conversation = null,
  workspace = null,
  modelControl = null,
  inputRef = null,
}) {
  const orbSize = useHomepageOrbSize();
  const state = String(assistantState || "idle").toLowerCase();
  const phase = ["idle", "thinking", "responding"].includes(scenePhase) ? scenePhase : "idle";
  const motion = orbMotion({ assistantState: state, scenePhase: phase, statusTone });
  const headerItems = navItems.filter((item) => {
    if (!item || typeof item.onSelect !== "function") return false;
    if (item.id === "chief") return false;
    if (item.id === "settings" && onProfile) return false;
    return true;
  });
  const rootClass = [
    "chief-interface",
    `state-${state}`,
    `phase-${phase}`,
    `is-${statusTone}`,
    reducedMotion ? "is-reduced-motion" : "",
    conversation ? "has-exchange" : "",
    workspace ? "has-workspace" : "",
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
    <main className={rootClass} data-third-party-license={jarvisLicense}>
      <header className="chief-topbar">
        <button
          type="button"
          className="chief-brand"
          onClick={() => onHome?.()}
          aria-label="CHIEF home"
        >
          <span className="chief-brand-mark" aria-hidden="true" />
          <span className="chief-brand-name">CHIEF</span>
        </button>

        <div className="chief-top-actions">
          {headerItems.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={active ? "chief-icon-button is-active" : "chief-icon-button"}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                onClick={item.onSelect}
              >
                <Icon name={item.icon} size={16} />
                {showNavLabels ? <span className="chief-nav-copy">{item.label}</span> : null}
              </button>
            );
          })}
          {onSearch ? (
            <button
              type="button"
              className="chief-icon-button"
              aria-label="Search conversations"
              onClick={() => onSearch("")}
            >
              <Icon name="search" size={16} />
            </button>
          ) : null}
          {onNotifications ? (
            <button
              type="button"
              className="chief-icon-button"
              onClick={onNotifications}
              aria-label="Notifications"
            >
              <Icon name="bell" size={16} />
            </button>
          ) : null}
          {onProfile ? (
            <button
              type="button"
              className="chief-profile"
              onClick={onProfile}
              aria-label="Settings"
            >
              {profileMark ? profileMark.slice(0, 2) : <Icon name="user" size={16} />}
            </button>
          ) : null}
        </div>
      </header>

      <section className="chief-stage" aria-label="CHIEF">
        <div className="chief-orb-well">
          <i className="chief-orb-glow" aria-hidden="true" />
          <div className="chief-orb-frame">
            <JarvisOrb
              className="chief-jarvis-orb"
              size={orbSize}
              state={motion}
              palette={CHIEF_ORB_PALETTE}
              breathing={!reducedMotion}
              breathingIntensity={0.72}
              paused={reducedMotion}
              ariaLabel="CHIEF"
            />
          </div>
          <p className={`chief-orb-status is-${statusTone}`}>{status}</p>
        </div>

        {workspace ? <div className="chief-workspace-slot">{workspace}</div> : null}

        <div className="chief-stage-dock">
          {conversation ? <div className="chief-interface-conversation">{conversation}</div> : null}

          {modelControl ? (
            <div className="chief-model-line">
              <span className="chief-model-label">Model</span>
              {modelControl}
            </div>
          ) : null}

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
        </div>
      </section>

      <p className="chief-sr" aria-live="polite">
        {String(assistantState || "idle")}
      </p>
    </main>
  );
}
