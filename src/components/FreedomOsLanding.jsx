import { useEffect, useState } from "react";
import { LegalModal } from "./LegalDocuments.jsx";

// Freedom OS public landing — the first page every visitor hits. Sign-in and
// account creation live here; Module 01 (CEO Agents) and Module 02 (Freedom
// Financial) are the two portals into the product.

const TAGLINE = "Your autonomous operating system for life, work, and wealth.";

const BOOT_LINES = [
  { prefix: "sys", text: "freedom_os kernel loaded", tone: "ok" },
  { prefix: "sys", text: "agent mesh online — CEO agent standing by", tone: "ok" },
  { prefix: "sys", text: "encrypted channel established", tone: "ok" },
  { prefix: "sys", text: "awaiting operator authentication…", tone: "wait" },
];

const LANDING_STYLES = `
@keyframes fosl-grid-drift { from { background-position: 0 0; } to { background-position: 0 44px; } }
@keyframes fosl-scan { from { transform: translateY(-14vh); } to { transform: translateY(114vh); } }
@keyframes fosl-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes fosl-glow {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(143,234,255,0.35)); }
  50% { filter: drop-shadow(0 0 26px rgba(143,234,255,0.8)); }
}
@keyframes fosl-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0,216,255,0.35); }
  50% { box-shadow: 0 0 0 7px rgba(0,216,255,0); }
}
@keyframes fosl-orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fosl-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
.fosl-grid { animation: fosl-grid-drift 3.4s linear infinite; }
.fosl-scanline { animation: fosl-scan 4.2s linear infinite; }
.fosl-cursor { animation: fosl-blink 1s steps(1) infinite; }
.fosl-title { animation: fosl-glow 2.6s ease-in-out infinite; }
.fosl-status-dot { animation: fosl-pulse 2.1s ease-out infinite; }
.fosl-ring { animation: fosl-orbit 9s linear infinite; }
.fosl-ring-reverse { animation: fosl-orbit 14s linear infinite reverse; }
.fosl-rise { animation: fosl-rise 640ms cubic-bezier(.2,.7,.3,1) both; }
.fosl-portal { transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease; }
.fosl-portal:hover { transform: translateY(-3px); border-color: rgba(0,216,255,.65) !important; box-shadow: 0 14px 44px rgba(0,140,255,.28) !important; }
.fosl-actions { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
.fosl-portals { display: grid; gap: 16px; width: 100%; max-width: 720px; grid-template-columns: 1fr; }
@media (min-width: 720px) {
  .fosl-portals { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .fosl-actions > button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .fosl-grid, .fosl-scanline, .fosl-cursor, .fosl-title, .fosl-status-dot, .fosl-ring, .fosl-ring-reverse {
    animation: none;
  }
  .fosl-rise { animation: none; opacity: 1; transform: none; }
}
`;

function useTypedText(fullText, speedMs = 34) {
  // Reduced-motion visitors get the full tagline immediately; the interval
  // below then no-ops on its first tick and clears itself.
  const [visibleCount, setVisibleCount] = useState(() =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? fullText.length : 0
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setVisibleCount((current) => {
        if (current >= fullText.length) {
          window.clearInterval(intervalId);
          return current;
        }
        return current + 1;
      });
    }, speedMs);

    return () => window.clearInterval(intervalId);
  }, [fullText, speedMs]);

  return fullText.slice(0, visibleCount);
}

function PrimaryAction({ label, onClick, variant = "primary" }) {
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      className="fosl-portal"
      style={{
        color: isPrimary ? "#01131f" : "#eaf9ff",
        background: isPrimary
          ? "linear-gradient(90deg, #22d3ee, #60a5fa)"
          : "rgba(2,18,36,.66)",
        border: isPrimary ? "1px solid rgba(190,245,255,.7)" : "1px solid rgba(0,216,255,.32)",
        borderRadius: 12,
        padding: "15px 26px",
        cursor: "pointer",
        fontWeight: 900,
        fontSize: 14,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        boxShadow: isPrimary ? "0 0 34px rgba(34,211,238,.4)" : "0 0 18px rgba(0,120,255,.14)",
        minWidth: 190,
      }}
    >
      {label}
    </button>
  );
}

function PortalCard({ eyebrow, title, description, actionLabel, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fosl-portal"
      style={{
        textAlign: "left",
        borderRadius: 16,
        border: "1px solid rgba(0,216,255,.24)",
        background: "linear-gradient(160deg, rgba(4,22,42,.92), rgba(2,10,22,.88))",
        boxShadow: "0 10px 34px rgba(0,40,90,.3), inset 0 1px 0 rgba(255,255,255,.04)",
        padding: "20px 22px",
        cursor: "pointer",
        display: "grid",
        gap: 9,
        alignContent: "start",
      }}
    >
      <div
        style={{
          color: "#67e8f9",
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: 2.2,
          textTransform: "uppercase",
        }}
      >
        {eyebrow}
      </div>
      <div style={{ color: "white", fontSize: 18, fontWeight: 900, letterSpacing: 0.3 }}>{title}</div>
      <div style={{ color: "#9fc0dd", fontSize: 12.5, lineHeight: 1.6 }}>{description}</div>
      <div
        style={{
          marginTop: 4,
          color: "#8feaff",
          fontSize: 12,
          fontWeight: 900,
          letterSpacing: 1.1,
          textTransform: "uppercase",
        }}
      >
        {actionLabel} <span aria-hidden="true">→</span>
      </div>
    </button>
  );
}

export function FreedomOsLanding({
  onSignIn,
  onCreateAccount,
  onExploreCeoAgents,
  onExploreFreedomFinancial,
  // Legacy alias used by older call sites.
  onExploreFff,
}) {
  const openCeoAgents = onExploreCeoAgents || onSignIn;
  const openFreedomFinancial = onExploreFreedomFinancial || onExploreFff;
  const [activeDocument, setActiveDocument] = useState(null);
  const typedTagline = useTypedText(TAGLINE);
  const taglineDone = typedTagline.length === TAGLINE.length;

  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
        overflow: "hidden",
        background:
          "radial-gradient(circle at 18% 12%, rgba(0,140,255,.2), transparent 26%), radial-gradient(circle at 84% 74%, rgba(34,211,238,.13), transparent 30%), radial-gradient(circle at 50% 120%, rgba(59,130,246,.2), transparent 42%), linear-gradient(180deg, #010409, #030d1c 58%, #020813)",
        color: "#eef6ff",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "clamp(24px, 5vh, 56px) 20px 32px",
      }}
    >
      <style>{LANDING_STYLES}</style>

      {/* Animated grid floor */}
      <div
        aria-hidden="true"
        className="fosl-grid"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(143,234,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(143,234,255,0.055) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(circle at 50% 38%, rgba(0,0,0,.95), transparent 78%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 38%, rgba(0,0,0,.95), transparent 78%)",
        }}
      />
      {/* Scanline sweep */}
      <div
        aria-hidden="true"
        className="fosl-scanline"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 2,
          background:
            "linear-gradient(90deg, transparent, rgba(143,234,255,.4) 28%, rgba(143,234,255,.4) 72%, transparent)",
          opacity: 0.45,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 980,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          flex: 1,
        }}
      >
        {/* Status badge */}
        <div
          className="fosl-rise"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            border: "1px solid rgba(52,211,153,.35)",
            background: "rgba(6,24,20,.72)",
            borderRadius: 999,
            padding: "7px 16px",
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "#6ee7b7",
          }}
        >
          <span
            className="fosl-status-dot"
            style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399" }}
          />
          System online
        </div>

        {/* Emblem with orbiting rings */}
        <div
          className="fosl-rise"
          style={{
            position: "relative",
            width: 128,
            height: 128,
            margin: "clamp(18px, 4vh, 38px) auto 0",
            animationDelay: "80ms",
          }}
        >
          <div
            aria-hidden="true"
            className="fosl-ring"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "1px solid rgba(143,234,255,.28)",
              borderTopColor: "#8feaff",
              boxShadow: "0 0 30px rgba(143,234,255,.22)",
            }}
          />
          <div
            aria-hidden="true"
            className="fosl-ring-reverse"
            style={{
              position: "absolute",
              inset: 14,
              borderRadius: "50%",
              border: "1px dashed rgba(96,165,250,.35)",
              borderBottomColor: "#60a5fa",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 44,
              color: "#00d8ff",
              textShadow: "0 0 34px rgba(0,216,255,.85)",
            }}
          >
            ◈
          </div>
        </div>

        {/* Title */}
        <h1
          className="fosl-title fosl-rise"
          style={{
            margin: "clamp(16px, 3vh, 30px) 0 0",
            fontSize: "clamp(44px, 8.5vw, 84px)",
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: "clamp(6px, 1.6vw, 16px)",
            lineHeight: 1.04,
            background: "linear-gradient(92deg, #8feaff 5%, #3b82f6 48%, #22d3ee 78%, #8feaff)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            animationDelay: "140ms",
          }}
        >
          Freedom OS
        </h1>

        {/* Typed tagline */}
        <p
          style={{
            marginTop: 16,
            minHeight: 26,
            fontSize: "clamp(13px, 2.4vw, 17px)",
            letterSpacing: 0.6,
            fontWeight: 700,
            color: "rgba(222,242,255,.86)",
            maxWidth: 720,
          }}
        >
          <span style={{ color: "#8feaff" }}>&gt;</span> {typedTagline}
          <span className="fosl-cursor" style={{ marginLeft: 5, color: "#8feaff" }}>
            ▊
          </span>
        </p>

        {/* Boot log */}
        <div
          className="fosl-rise"
          style={{
            marginTop: "clamp(14px, 3vh, 26px)",
            display: "grid",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: 0.4,
            textAlign: "left",
            border: "1px solid rgba(0,216,255,.18)",
            borderRadius: 12,
            background: "rgba(1,10,20,.66)",
            padding: "14px 18px",
            opacity: taglineDone ? 1 : 0.55,
            transition: "opacity 400ms ease",
            animationDelay: "220ms",
          }}
        >
          {BOOT_LINES.map((line) => (
            <div key={line.text} style={{ color: line.tone === "ok" ? "#9fdcc8" : "#ffd38a" }}>
              <span style={{ color: "#5f7896" }}>[{line.prefix}]</span>{" "}
              <span style={{ color: line.tone === "ok" ? "#34d399" : "#fbbf24" }}>
                {line.tone === "ok" ? "OK" : ".."}
              </span>{" "}
              {line.text}
            </div>
          ))}
        </div>

        {/* Auth actions — sign-in lives here now */}
        <div
          className="fosl-actions fosl-rise"
          style={{ marginTop: "clamp(22px, 4vh, 38px)", animationDelay: "300ms" }}
        >
          <PrimaryAction label="Sign In" onClick={onSignIn} />
          <PrimaryAction label="Create Access" variant="secondary" onClick={onCreateAccount} />
        </div>

        {/* Module portals */}
        <div
          className="fosl-portals fosl-rise"
          style={{ marginTop: "clamp(24px, 4.5vh, 42px)", animationDelay: "380ms" }}
        >
          <PortalCard
            eyebrow="Module 01"
            title="CEO Agents"
            description="Your autonomous agent operating system — CEO Agent, digests, and the team that runs missions on your behalf. Sign in to enter."
            actionLabel="Enter CEO Agents"
            onClick={openCeoAgents}
          />
          <PortalCard
            eyebrow="Module 02"
            title="Freedom Financial"
            description="Accounts, budgets, forecasting, and real-time cash intelligence — including a no-sign-up demo sandbox."
            actionLabel="Explore Freedom Financial"
            onClick={openFreedomFinancial}
          />
        </div>
      </div>

      {/* Footer */}
      <footer
        style={{
          position: "relative",
          zIndex: 1,
          marginTop: 36,
          width: "100%",
          maxWidth: 980,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          borderTop: "1px solid rgba(0,136,255,.16)",
          paddingTop: 16,
          color: "#7f9cbd",
          fontSize: 12,
        }}
      >
        <div>© 2026 Forward Freedom Financial. All rights reserved.</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {[
            { key: "terms", label: "Terms of Service" },
            { key: "privacy", label: "Privacy Policy" },
          ].map((doc) => (
            <button
              key={doc.key}
              type="button"
              onClick={() => setActiveDocument(doc.key)}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
                fontWeight: 800,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                fontSize: 11,
              }}
            >
              {doc.label}
            </button>
          ))}
        </div>
      </footer>

      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </div>
  );
}
