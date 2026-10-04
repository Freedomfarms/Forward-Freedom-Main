import { useEffect, useState } from "react";
import { fetchChiefVoiceCatalog, fetchChiefWorkforceLink } from "../../utils/chiefApi.js";
import {
  fetchFreedomFinancialChiefAccess,
  saveFreedomFinancialChiefAccess,
} from "../../utils/freedomFinancialChiefAccess.js";
import { freedomFinancialAccessCopy } from "../../utils/freedomFinancialAccessCopy.js";
import { writeChiefPreferences } from "../../utils/chiefPreferences.js";
import { voiceConnectionLabel } from "../../utils/chiefVoiceStatus.js";
import { speechInputSupported } from "./voice/speechInput.js";
import {
  normalizeVoiceSettings,
  readVoiceSettings,
  writeVoiceSettings,
} from "./voice/voiceSettings.js";

const CHIEF_SETTINGS_SECTIONS = Object.freeze([
  Object.freeze(["voice", "Voice"]),
  Object.freeze(["brain", "AI / Brain"]),
  Object.freeze(["conversation", "Conversation"]),
  Object.freeze(["input", "Voice Input"]),
  Object.freeze(["access", "Access & Permissions"]),
  Object.freeze(["systems", "Connected Systems"]),
  Object.freeze(["notifications", "Notifications"]),
  Object.freeze(["appearance", "Appearance"]),
]);

const ACCESS_LABEL = Object.freeze({
  read: "Read",
  write: "Write",
  read_write: "Read/Write",
  not_connected: "Not connected",
});

function browserSpeechSupported() {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis === "object" &&
    window.speechSynthesis !== null &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

function Slider({ label, min, max, step, value, disabled = false, onChange }) {
  return (
    <label className="chief-voice-slider">
      <span>
        {label}
        <span className="chief-voice-slider-value">{Number(value).toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange, detail }) {
  return (
    <label className="chief-settings-toggle">
      <span>
        <span className="chief-settings-toggle-label">{label}</span>
        {detail ? <span className="chief-sheet-copy">{detail}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function ChiefSettings({
  open = false,
  section = "voice",
  onSection,
  onClose,
  user,
  models = [],
  defaultModel = null,
  modelRoute = null,
  modelBusy = false,
  onChooseModel,
  access = null,
  onRefreshAccess,
  activeSessionId = null,
  onStartConversation,
  onClearConversation,
  preferences,
  onPreferences,
  onVoiceSettings,
  onTestVoice,
  voiceDisabled = false,
  activeVoiceId = "",
}) {
  const [voiceDraft, setVoiceDraft] = useState(() => readVoiceSettings());
  const [voices, setVoices] = useState([]);
  const [voiceStatus, setVoiceStatus] = useState("unavailable");
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const [moduleOn, setModuleOn] = useState(false);
  const [moduleLoaded, setModuleLoaded] = useState(false);
  const [moduleBusy, setModuleBusy] = useState(false);
  const [moduleError, setModuleError] = useState("");
  const [moduleWrite, setModuleWrite] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [micPermission, setMicPermission] = useState("");
  const [workforce, setWorkforce] = useState(null);
  const [seenOpen, setSeenOpen] = useState(open);
  const accessToken = open && section === "access" ? "access" : "";
  const [seenAccess, setSeenAccess] = useState(accessToken);
  const browserSpeech = browserSpeechSupported();
  const speechInput = speechInputSupported();
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      const stored = readVoiceSettings();
      setVoiceDraft(
        normalizeVoiceSettings({
          ...stored,
          voiceId: activeVoiceId || stored.voiceId,
        })
      );
      setVoiceNotice("");
      setConfirmClear(false);
    }
  }
  if (accessToken !== seenAccess) {
    setSeenAccess(accessToken);
    if (accessToken) setModuleLoaded(false);
  }

  useEffect(() => {
    if (!open || !user || section !== "voice") return undefined;
    let cancelled = false;
    fetchChiefVoiceCatalog(user)
      .then((catalog) => {
        if (cancelled) return;
        setVoiceStatus(catalog.status);
        setVoices(Array.isArray(catalog.voices) ? catalog.voices : []);
        setVoiceError("");
        const stored = readVoiceSettings();
        const voiceId = activeVoiceId || stored.voiceId || catalog.config?.defaultVoiceId || "";
        const modelId = stored.modelId || catalog.config?.defaultModelId || "";
        setVoiceDraft(normalizeVoiceSettings({ ...stored, voiceId, modelId }));
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceStatus("unavailable");
          setVoiceError("Unable to load voices.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, section, activeVoiceId]);

  useEffect(() => {
    if (!open || !user || section !== "access") return undefined;
    let cancelled = false;
    fetchFreedomFinancialChiefAccess(user)
      .then((row) => {
        if (cancelled) return;
        setModuleOn(row.freedomFinancialRead === true);
        setModuleWrite(row.writeAccess === true);
        setModuleError("");
        setModuleLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setModuleOn(false);
        setModuleWrite(false);
        setModuleError(error?.message || "Module 02 access could not be loaded.");
        setModuleLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, section]);

  useEffect(() => {
    if (!open || !user || section !== "systems") return undefined;
    let cancelled = false;
    fetchChiefWorkforceLink(user)
      .then((row) => {
        if (!cancelled) setWorkforce(row);
      })
      .catch(() => {
        if (!cancelled) setWorkforce({ readable: false, active: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, section]);

  useEffect(() => {
    if (!open || section !== "input") return undefined;
    let cancelled = false;
    const permissions = typeof navigator !== "undefined" ? navigator.permissions : null;
    if (!permissions?.query) return undefined;
    permissions
      .query({ name: "microphone" })
      .then((status) => {
        if (cancelled) return;
        setMicPermission(status.state || "browser");
        status.onchange = () => {
          if (!cancelled) setMicPermission(status.state || "browser");
        };
      })
      .catch(() => {
        if (!cancelled) setMicPermission("browser");
      });
    return () => {
      cancelled = true;
    };
  }, [open, section]);

  function savePreferences(next) {
    const saved = writeChiefPreferences(next);
    onPreferences?.(saved);
  }

  function patchConversation(patch) {
    savePreferences({
      ...preferences,
      conversation: { ...preferences.conversation, ...patch },
    });
  }

  function patchAppearance(patch) {
    savePreferences({
      ...preferences,
      appearance: { ...preferences.appearance, ...patch },
    });
  }

  async function saveVoice() {
    const saved = writeVoiceSettings(voiceDraft);
    setVoiceDraft(saved);
    onVoiceSettings?.(saved);
    setVoiceNotice("Voice settings saved.");
  }

  async function toggleModule() {
    if (!moduleLoaded || moduleBusy) return;
    const next = !moduleOn;
    setModuleBusy(true);
    setModuleError("");
    try {
      const saved = await saveFreedomFinancialChiefAccess(user, next);
      setModuleOn(saved.freedomFinancialRead === true);
      setModuleWrite(saved.writeAccess === true);
      onRefreshAccess?.();
    } catch (error) {
      setModuleError(error?.message || "Module 02 access could not be updated.");
    } finally {
      setModuleBusy(false);
    }
  }

  const currentModel = models.find((model) => model.id === (modelRoute || defaultModel)) || null;
  const providers = [];
  for (const model of models) {
    if (!model?.group) continue;
    if (!providers.includes(model.group)) providers.push(model.group);
  }
  const systems = Array.isArray(access?.systems) ? access.systems : null;
  const shownSystems = systems
    ? systems.map((system) => {
        if (system.id !== "grokbot" || !workforce) return system;
        if (!workforce.readable) {
          return { ...system, status: "Unavailable" };
        }
        if (workforce.active) {
          return {
            ...system,
            status: "Self-report key active",
            detail:
              "A self-report key is active. CHIEF still has no workforce read or write grant.",
          };
        }
        return system;
      })
    : null;

  return (
    <aside
      className={open ? "chief-settings is-open" : "chief-settings"}
      aria-label="CHIEF Settings"
      aria-hidden={open ? undefined : true}
    >
      <div className="chief-settings-head">
        <div>
          <div className="chief-sheet-title">CHIEF Settings</div>
          <p className="chief-sheet-copy">Control center for this CHIEF session.</p>
        </div>
        <button type="button" className="chief-action chief-action--quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="chief-settings-layout">
        <nav className="chief-settings-nav" aria-label="Settings sections">
          {CHIEF_SETTINGS_SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={section === id ? "is-current" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={() => onSection?.(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="chief-settings-body">
          {section === "voice" ? (
            <>
              <div className="chief-sheet-title">Voice</div>
              <p className="chief-sheet-copy">
                Provider: ElevenLabs. Status: {voiceConnectionLabel(voiceStatus)}.
              </p>
              {voiceStatus === "not_configured" ? (
                <p className="chief-sheet-copy">
                  ElevenLabs is not configured on this server. The API key stays in the server
                  environment and is not shown here.
                </p>
              ) : null}
              {voiceStatus === "authentication_failed" ? (
                <p className="chief-sheet-copy">
                  ElevenLabs rejected the server credential. The API key is not shown here.
                </p>
              ) : null}
              {voiceStatus === "unavailable" ? (
                <p className="chief-sheet-copy">Unable to load voices from ElevenLabs.</p>
              ) : null}
              {voiceError ? <p className="chief-sheet-copy">{voiceError}</p> : null}
              <label className="chief-voice-slider">
                <span>Voice</span>
                <select
                  aria-label="ElevenLabs voice"
                  value={voiceDraft.voiceId}
                  onChange={(event) =>
                    setVoiceDraft({ ...voiceDraft, voiceId: event.target.value })
                  }
                >
                  <option value="">Select a voice</option>
                  {voiceDraft.voiceId &&
                  !voices.some((voice) => voice.id === voiceDraft.voiceId) ? (
                    <option value={voiceDraft.voiceId}>Configured voice</option>
                  ) : null}
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                      {voice.language ? ` · ${voice.language}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Slider
                label="Speed"
                min={0.7}
                max={1.2}
                step={0.05}
                value={voiceDraft.speed}
                onChange={(speed) => setVoiceDraft({ ...voiceDraft, speed })}
              />
              <Slider
                label="Stability"
                min={0}
                max={1}
                step={0.05}
                value={voiceDraft.stability}
                onChange={(stability) => setVoiceDraft({ ...voiceDraft, stability })}
              />
              <Slider
                label="Similarity"
                min={0}
                max={1}
                step={0.05}
                value={voiceDraft.similarityBoost}
                onChange={(similarityBoost) => setVoiceDraft({ ...voiceDraft, similarityBoost })}
              />
              <Slider
                label="Style (unavailable)"
                min={0}
                max={1}
                step={0.05}
                value={voiceDraft.style}
                disabled
                onChange={() => {}}
              />
              <p className="chief-sheet-copy">
                The selected voice is the voice CHIEF speaks with. Speed, stability, and similarity
                are sent on that ElevenLabs speech request. Style is unavailable because CHIEF
                speaks with eleven_flash_v2_5, which does not support style exaggeration.
              </p>
              {browserSpeech ? (
                <label className="chief-voice-check">
                  <input
                    type="checkbox"
                    checked={voiceDraft.fallbackEnabled}
                    onChange={(event) =>
                      setVoiceDraft({ ...voiceDraft, fallbackEnabled: event.target.checked })
                    }
                  />
                  Use this browser&apos;s voice if ElevenLabs is unavailable
                </label>
              ) : (
                <p className="chief-sheet-copy">This browser has no speech synthesis.</p>
              )}
              <div className="chief-approval">
                <button
                  type="button"
                  className="chief-action"
                  disabled={!user || voiceDisabled || testing}
                  onClick={() => {
                    setTesting(true);
                    setVoiceNotice("");
                    Promise.resolve(onTestVoice?.(voiceDraft)).finally(() => setTesting(false));
                  }}
                >
                  {testing ? "Speaking…" : "Test Voice"}
                </button>
                <button type="button" className="chief-action" onClick={() => void saveVoice()}>
                  Save Voice Settings
                </button>
              </div>
              {voiceNotice ? <p className="chief-sheet-copy">{voiceNotice}</p> : null}
            </>
          ) : null}

          {section === "brain" ? (
            <>
              <div className="chief-sheet-title">AI / Brain</div>
              {models.length ? (
                <>
                  <p className="chief-sheet-copy">
                    Current provider: {currentModel?.group || "Server default"}. Current model:{" "}
                    {currentModel?.name || currentModel?.id || defaultModel || "Server default"}.
                  </p>
                  <p className="chief-sheet-copy">
                    Server default: {defaultModel || "not set"}. Choosing a model uses the existing
                    conversation model selection.
                  </p>
                  {providers.map((provider) => (
                    <section key={provider} className="chief-settings-group">
                      <div className="chief-settings-row">
                        <span>{provider}</span>
                        <span>Available</span>
                      </div>
                      {models
                        .filter((model) => model.group === provider)
                        .map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            className={
                              model.id === (modelRoute || defaultModel)
                                ? "chief-settings-choice is-current"
                                : "chief-settings-choice"
                            }
                            disabled={modelBusy || !user}
                            onClick={() => onChooseModel?.(model.id)}
                          >
                            <span>{model.name || model.id}</span>
                            <span>{model.id === modelRoute ? "Current" : "Available"}</span>
                          </button>
                        ))}
                    </section>
                  ))}
                </>
              ) : (
                <p className="chief-sheet-copy">
                  No CHIEF provider is configured on this server. A provider appears here only after
                  its server credential is present.
                </p>
              )}
            </>
          ) : null}

          {section === "conversation" ? (
            <>
              <div className="chief-sheet-title">Conversation</div>
              <div className="chief-approval">
                <button
                  type="button"
                  className="chief-action"
                  onClick={() => {
                    setConfirmClear(false);
                    onStartConversation?.();
                  }}
                >
                  Start new conversation
                </button>
                <button
                  type="button"
                  className="chief-action chief-action--danger"
                  disabled={!activeSessionId}
                  onClick={() => setConfirmClear(true)}
                >
                  Clear current conversation
                </button>
              </div>
              {!activeSessionId ? (
                <p className="chief-sheet-copy">There is no current conversation to clear.</p>
              ) : null}
              {confirmClear && activeSessionId ? (
                <div className="chief-settings-confirm">
                  <p className="chief-sheet-copy">
                    Clear deletes this conversation. Archived and other conversations stay.
                  </p>
                  <div className="chief-approval">
                    <button
                      type="button"
                      className="chief-action chief-action--danger"
                      onClick={() => {
                        setConfirmClear(false);
                        onClearConversation?.(activeSessionId);
                      }}
                    >
                      Delete this conversation
                    </button>
                    <button
                      type="button"
                      className="chief-action chief-action--quiet"
                      onClick={() => setConfirmClear(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <Toggle
                label="Voice responses"
                checked={preferences.conversation.voiceResponses}
                detail="Spoken turns are read aloud through the existing voice path."
                onChange={(voiceResponses) => patchConversation({ voiceResponses })}
              />
              <Toggle
                label="Automatically speak CHIEF responses"
                checked={preferences.conversation.autoSpeak}
                detail="Typed replies are spoken when voice responses are on."
                onChange={(autoSpeak) => patchConversation({ autoSpeak })}
              />
              <Toggle
                label="Show CHIEF response text"
                checked={preferences.conversation.showResponseText}
                onChange={(showResponseText) => patchConversation({ showResponseText })}
              />
              <Toggle
                label="Enter to send"
                checked={preferences.conversation.enterToSend}
                detail="Shift+Enter adds a new line."
                onChange={(enterToSend) => patchConversation({ enterToSend })}
              />
            </>
          ) : null}

          {section === "input" ? (
            <>
              <div className="chief-sheet-title">Voice Input</div>
              <p className="chief-sheet-copy">
                Microphone permission is controlled by the browser. CHIEF cannot grant or revoke it.
              </p>
              <p className="chief-sheet-copy">
                Microphone:{" "}
                {micPermission === "granted"
                  ? "Allowed by the browser"
                  : micPermission === "denied"
                    ? "Blocked by the browser"
                    : micPermission === "prompt"
                      ? "The browser will ask"
                      : "Ask the browser"}
                .
              </p>
              {speechInput ? (
                <p className="chief-sheet-copy">
                  Voice input is tap-to-talk. Tap the core or the microphone to listen, and tap
                  again to stop. Push-to-talk and automatic listening are not part of this voice
                  path. Recognition uses en-US.
                </p>
              ) : (
                <p className="chief-sheet-copy">
                  This browser cannot hear speech. The microphone control stays unavailable.
                </p>
              )}
            </>
          ) : null}

          {section === "access" ? (
            <>
              <div className="chief-sheet-title">Access & Permissions</div>
              <p className="chief-sheet-copy">
                Module 02 is Freedom Financial. Access is off until you turn it on. Enabling access
                allows CHIEF to read Module 02 data. This toggle does not give CHIEF write access.
              </p>
              <button
                type="button"
                className="chief-action"
                aria-pressed={moduleOn}
                disabled={!moduleLoaded || moduleBusy}
                onClick={() => void toggleModule()}
              >
                Module 02 read {moduleOn ? "ON" : "OFF"}
              </button>
              <p className="chief-sheet-copy">{freedomFinancialAccessCopy(moduleOn)}</p>
              <p className="chief-sheet-copy">Write access: {moduleWrite ? "on" : "off"}.</p>
              {moduleError ? <p className="chief-sheet-copy">{moduleError}</p> : null}
              <div className="chief-sheet-title">Grants</div>
              <p className="chief-sheet-copy">
                Read-only summary from the control plane. This screen does not grant or deny
                capabilities.
              </p>
              {access?.inventory ? (
                <>
                  <p className="chief-sheet-copy">
                    Money {access.money || "unavailable"} · Web {access.web || "unavailable"}.
                  </p>
                  <GrantList title="Read" rows={access.inventory.read} />
                  <GrantList title="Actions" rows={access.inventory.actions} />
                  <GrantList title="Unavailable" rows={access.inventory.unavailable} />
                </>
              ) : (
                <p className="chief-sheet-copy">Access could not be read.</p>
              )}
            </>
          ) : null}

          {section === "systems" ? (
            <>
              <div className="chief-sheet-title">Connected Systems</div>
              {shownSystems ? (
                shownSystems.length ? (
                  <div className="chief-settings-systems">
                    {shownSystems.map((system) => (
                      <article key={system.id} className="chief-settings-system">
                        <div className="chief-settings-row">
                          <span>{system.name}</span>
                          <span>{system.status}</span>
                        </div>
                        <p className="chief-sheet-copy">
                          Access: {ACCESS_LABEL[system.access] || "Not connected"}
                        </p>
                        {system.detail ? <p className="chief-sheet-copy">{system.detail}</p> : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="chief-sheet-copy">No connected systems are registered.</p>
                )
              ) : (
                <p className="chief-sheet-copy">Connected systems could not be read.</p>
              )}
            </>
          ) : null}

          {section === "notifications" ? (
            <>
              <div className="chief-sheet-title">Notifications</div>
              <p className="chief-sheet-copy">
                CHIEF does not store notification preferences. Approval requests stay in the
                conversation. Freedom OS agent notifications are a separate in-app list and are not
                configured here.
              </p>
            </>
          ) : null}

          {section === "appearance" ? (
            <>
              <div className="chief-sheet-title">Appearance</div>
              <label className="chief-voice-slider">
                <span>Reduced motion</span>
                <select
                  aria-label="Reduced motion"
                  value={preferences.appearance.reducedMotion}
                  onChange={(event) => patchAppearance({ reducedMotion: event.target.value })}
                >
                  <option value="system">Follow system</option>
                  <option value="reduce">Reduce motion</option>
                </select>
              </label>
              <label className="chief-voice-slider">
                <span>Animation intensity</span>
                <select
                  aria-label="Animation intensity"
                  value={preferences.appearance.animationIntensity}
                  onChange={(event) => patchAppearance({ animationIntensity: event.target.value })}
                >
                  <option value="full">Full</option>
                  <option value="low">Low</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <p className="chief-sheet-copy">
                These settings change the existing core, wave, and orbit motion.
              </p>
              <Toggle
                label="Show telemetry"
                checked={preferences.appearance.showTelemetry}
                onChange={(showTelemetry) => patchAppearance({ showTelemetry })}
              />
              <Toggle
                label="Show navigation labels"
                checked={preferences.appearance.showNavLabels}
                onChange={(showNavLabels) => patchAppearance({ showNavLabels })}
              />
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function GrantList({ title, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <section className="chief-settings-group">
      <div className="chief-sheet-title">{title}</div>
      {list.length ? (
        list.map((row) => (
          <div key={row.id} className="chief-settings-row">
            <span>{row.id}</span>
            <span>
              {row.state === "gated" ? "gated" : row.approval ? "approval" : row.state || "listed"}
            </span>
          </div>
        ))
      ) : (
        <p className="chief-sheet-copy">None.</p>
      )}
    </section>
  );
}
