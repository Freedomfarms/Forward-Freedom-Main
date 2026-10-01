import { useEffect, useState } from "react";

import { styles } from "../styles.js";
import { module02AccessCopy } from "../utils/module02AccessCopy.js";
import {
  fetchModule02ChiefAccess,
  saveModule02ChiefAccess,
} from "../utils/module02ChiefAccess.js";

// Small Module 02 control. Freedom Financial has no settings screen, so this
// sits at the bottom of the Module 02 sidebar and writes the same server
// record CHIEF uses.
export function Module02ChiefAccess({ user }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchModule02ChiefAccess(user)
      .then((row) => {
        if (cancelled) return;
        setEnabled(row.module02Read === true);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setEnabled(false);
        setError(err?.message || "CHIEF access could not be loaded.");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function toggle() {
    if (!loaded || busy) return;
    const next = !enabled;
    setBusy(true);
    setError("");
    try {
      const saved = await saveModule02ChiefAccess(user, next);
      setEnabled(saved.module02Read === true);
    } catch (err) {
      setError(err?.message || "CHIEF access could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...styles.panel, marginBottom: 18, padding: 16 }}>
      <div
        style={{
          color: "#9fb0c9",
          fontSize: 12,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          fontWeight: 800,
        }}
      >
        CHIEF Access
      </div>
      <button
        type="button"
        aria-pressed={enabled}
        aria-label={enabled ? "CHIEF read-only access on" : "CHIEF read-only access off"}
        disabled={!loaded || busy}
        onClick={() => void toggle()}
        style={{
          marginTop: 10,
          borderRadius: 8,
          border: "1px solid rgba(0,216,255,.28)",
          background: enabled ? "rgba(0,174,255,.22)" : "rgba(0,136,255,.08)",
          color: "#eef6ff",
          padding: "8px 14px",
          cursor: !loaded || busy ? "wait" : "pointer",
          fontWeight: 800,
          letterSpacing: 0.4,
        }}
      >
        {enabled ? "ON" : "OFF"}
      </button>
      <div style={{ color: "#d5e4f7", fontSize: 12, lineHeight: 1.45, marginTop: 10 }}>
        {module02AccessCopy(enabled)}
      </div>
      {error ? (
        <div style={{ color: "#ffd0d6", fontSize: 12, lineHeight: 1.4, marginTop: 8 }}>{error}</div>
      ) : null}
    </div>
  );
}
