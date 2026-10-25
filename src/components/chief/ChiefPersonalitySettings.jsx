import { useEffect, useState } from "react";
import { fetchChiefPersonality, saveChiefPersonalitySettings } from "../../utils/chiefApi.js";
import {
  CHIEF_PERSONALITY_PRESETS,
  CHIEF_RESPONSE_LENGTHS,
  CUSTOM_INSTRUCTIONS_MAX,
  defaultChiefPersonality,
  normalizeChiefPersonality,
  presetPackage,
} from "../../utils/chiefPersonality.js";

const LENGTH_LABEL = Object.freeze({
  concise: "Concise",
  balanced: "Balanced",
  detailed: "Detailed",
});

const LENGTH_DETAIL = Object.freeze({
  concise: "Short answers first. Expand when you ask.",
  balanced: "Moderate detail.",
  detailed: "Thorough explanations.",
});

function Slider({ label, value, onChange }) {
  return (
    <label className="chief-voice-slider">
      <span>
        {label}
        <span className="chief-voice-slider-value">{value}</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ChiefPersonalitySettings({ user, active = false }) {
  const [draft, setDraft] = useState(() => defaultChiefPersonality());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadToken = active && user?.uid ? user.uid : "";
  const [seenToken, setSeenToken] = useState("");
  if (loadToken !== seenToken) {
    setSeenToken(loadToken);
    if (loadToken) setLoaded(false);
  }

  useEffect(() => {
    if (!active || !user?.uid) return undefined;
    let cancelled = false;
    fetchChiefPersonality(user)
      .then((row) => {
        if (cancelled) return;
        setDraft(normalizeChiefPersonality(row));
        setError("");
        setNotice("");
        setLoaded(true);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setDraft(defaultChiefPersonality());
        setError(loadError?.message || "Personality could not be loaded.");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, user]);

  function choosePreset(preset) {
    setNotice("");
    setDraft((current) => ({
      ...current,
      ...presetPackage(preset),
      customInstructions: current.customInstructions,
    }));
  }

  async function save() {
    if (!user || busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const saved = await saveChiefPersonalitySettings(user, {
        preset: draft.preset,
        responseLength: draft.responseLength,
        humor: draft.humor,
        directness: draft.directness,
        proactiveness: draft.proactiveness,
        customInstructions: draft.customInstructions,
      });
      setDraft(normalizeChiefPersonality(saved));
      setNotice("Saved. The next reply follows this personality.");
    } catch (saveError) {
      setError(saveError?.message || "Personality could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="chief-sheet-title">Personality</div>
      <p className="chief-sheet-copy">
        This changes how CHIEF talks. It does not change the model, tools, or permissions.
      </p>
      {!loaded ? <p className="chief-sheet-copy">Loading personality…</p> : null}
      <div className="chief-settings-group">
        {Object.entries(CHIEF_PERSONALITY_PRESETS).map(([id, preset]) => (
          <button
            key={id}
            type="button"
            className={
              draft.preset === id ? "chief-settings-choice is-current" : "chief-settings-choice"
            }
            aria-pressed={draft.preset === id}
            onClick={() => choosePreset(id)}
          >
            <span>{preset.label}</span>
            <span>{draft.preset === id ? "Current" : preset.summary}</span>
          </button>
        ))}
      </div>
      <div className="chief-sheet-title">Response length</div>
      <div className="chief-settings-group">
        {CHIEF_RESPONSE_LENGTHS.map((length) => (
          <button
            key={length}
            type="button"
            className={
              draft.responseLength === length
                ? "chief-settings-choice is-current"
                : "chief-settings-choice"
            }
            aria-pressed={draft.responseLength === length}
            onClick={() => {
              setNotice("");
              setDraft((current) => ({ ...current, responseLength: length }));
            }}
          >
            <span>{LENGTH_LABEL[length]}</span>
            <span>{LENGTH_DETAIL[length]}</span>
          </button>
        ))}
      </div>
      <Slider
        label="Humor"
        value={draft.humor}
        onChange={(humor) => {
          setNotice("");
          setDraft((current) => ({ ...current, humor }));
        }}
      />
      <Slider
        label="Directness"
        value={draft.directness}
        onChange={(directness) => {
          setNotice("");
          setDraft((current) => ({ ...current, directness }));
        }}
      />
      <Slider
        label="Proactiveness"
        value={draft.proactiveness}
        onChange={(proactiveness) => {
          setNotice("");
          setDraft((current) => ({ ...current, proactiveness }));
        }}
      />
      <label className="chief-voice-slider">
        <span>
          Custom instructions
          <span className="chief-voice-slider-value">
            {draft.customInstructions.length}/{CUSTOM_INSTRUCTIONS_MAX}
          </span>
        </span>
        <textarea
          className="chief-personality-notes"
          aria-label="Custom instructions"
          maxLength={CUSTOM_INSTRUCTIONS_MAX}
          rows={5}
          value={draft.customInstructions}
          placeholder="Speak naturally, like a highly capable personal assistant. Avoid corporate language. Challenge my thinking when necessary. Keep everyday answers short, but go deep when we're discussing complicated subjects."
          onChange={(event) => {
            setNotice("");
            setDraft((current) => ({ ...current, customInstructions: event.target.value }));
          }}
        />
      </label>
      <div className="chief-approval">
        <button
          type="button"
          className="chief-action"
          disabled={!user || busy || !loaded}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save personality"}
        </button>
      </div>
      {notice ? <p className="chief-sheet-copy">{notice}</p> : null}
      {error ? <p className="chief-sheet-copy">{error}</p> : null}
    </>
  );
}
