import { useEffect, useState } from "react";
import { fetchChiefVoiceConfig, fetchChiefVoices } from "../../utils/chiefApi.js";
import {
  normalizeVoiceSettings,
  readVoiceSettings,
  writeVoiceSettings,
} from "./voice/voiceSettings.js";

function Slider({ label, min, max, step, value, onChange }) {
  return (
    <label className="chief-voice-slider">
      <span>
        {label}
        <span className="chief-voice-slider-value">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ChiefVoiceSheet({
  open = false,
  user,
  onClose,
  onSettings,
  onTest,
  disabled = false,
}) {
  const [settings, setSettings] = useState(() => readVoiceSettings());
  const [voices, setVoices] = useState([]);
  const [configured, setConfigured] = useState(null);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [opened, setOpened] = useState(open);
  if (open !== opened) {
    setOpened(open);
    if (open) setError("");
  }

  useEffect(() => {
    if (!open || !user) return undefined;
    let cancelled = false;
    Promise.all([fetchChiefVoiceConfig(user), fetchChiefVoices(user)])
      .then(([config, list]) => {
        if (cancelled) return;
        setConfigured(Boolean(config?.configured && list?.configured));
        const nextVoices = Array.isArray(list?.voices) ? list.voices : [];
        setVoices(nextVoices);
        const stored = readVoiceSettings();
        const voiceId =
          stored.voiceId ||
          (typeof config?.defaultVoiceId === "string" ? config.defaultVoiceId : "");
        const modelId =
          stored.modelId ||
          (typeof config?.defaultModelId === "string" ? config.defaultModelId : "");
        const next = normalizeVoiceSettings({ ...stored, voiceId, modelId });
        writeVoiceSettings(next);
        onSettings?.(next);
        setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setError("Voices could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, onSettings]);

  function commit(next) {
    const saved = writeVoiceSettings(next);
    setSettings(saved);
    onSettings?.(saved);
  }

  return (
    <aside
      className={
        open
          ? "chief-sheet chief-sheet--right chief-sheet--voice is-open"
          : "chief-sheet chief-sheet--right chief-sheet--voice"
      }
      aria-label="CHIEF voice"
      aria-hidden={open ? undefined : true}
    >
      <div className="chief-sheet-title">Voice</div>
      <p className="chief-sheet-copy">
        ElevenLabs speaks CHIEF. Tap the core to talk. Typed and spoken turns stay in this
        conversation.
      </p>
      <p className="chief-sheet-copy">Provider: ElevenLabs</p>
      {configured === false ? (
        <p className="chief-sheet-copy">ElevenLabs is not configured on the server.</p>
      ) : null}
      {error ? <p className="chief-sheet-copy">{error}</p> : null}
      <label className="chief-voice-slider">
        <span>Voice</span>
        <select
          value={settings.voiceId}
          onChange={(event) => commit({ ...settings, voiceId: event.target.value })}
        >
          <option value="">Select a voice</option>
          {settings.voiceId && !voices.some((voice) => voice.id === settings.voiceId) ? (
            <option value={settings.voiceId}>Configured voice</option>
          ) : null}
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
              {voice.language ? ` · ${voice.language}` : ""}
            </option>
          ))}
        </select>
      </label>
      {voices.map((voice) =>
        voice.id === settings.voiceId && voice.labels && Object.keys(voice.labels).length ? (
          <p key={`${voice.id}-labels`} className="chief-sheet-copy">
            {Object.entries(voice.labels)
              .map(([key, value]) => `${key}: ${value}`)
              .join(" · ")}
          </p>
        ) : null
      )}
      <Slider
        label="Speed"
        min={0.7}
        max={1.2}
        step={0.05}
        value={settings.speed}
        onChange={(speed) => commit({ ...settings, speed })}
      />
      <Slider
        label="Stability"
        min={0}
        max={1}
        step={0.05}
        value={settings.stability}
        onChange={(stability) => commit({ ...settings, stability })}
      />
      <Slider
        label="Similarity"
        min={0}
        max={1}
        step={0.05}
        value={settings.similarityBoost}
        onChange={(similarityBoost) => commit({ ...settings, similarityBoost })}
      />
      <Slider
        label="Style"
        min={0}
        max={1}
        step={0.05}
        value={settings.style}
        onChange={(style) => commit({ ...settings, style })}
      />
      <label className="chief-voice-check">
        <input
          type="checkbox"
          checked={settings.fallbackEnabled}
          onChange={(event) => commit({ ...settings, fallbackEnabled: event.target.checked })}
        />
        Use this browser’s voice if ElevenLabs is unavailable
      </label>
      <div className="chief-approval">
        <button
          type="button"
          className="chief-action"
          disabled={disabled || testing || !user}
          onClick={() => {
            setTesting(true);
            Promise.resolve(onTest?.(settings)).finally(() => setTesting(false));
          }}
        >
          {testing ? "Speaking…" : "Test voice"}
        </button>
        <button type="button" className="chief-action chief-action--quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}
