// Freedom OS deck — the full-screen shell wrapped around FreedomOsHome for
// authenticated sessions. Freedom OS is the platform home; FFF (the finance
// dashboard with its sidebar) is entered through the portal button here.

const DECK_STYLES = `
@keyframes fosd-grid-drift { from { background-position: 0 0; } to { background-position: 0 44px; } }
@keyframes fosd-scan { from { transform: translateY(-14vh); } to { transform: translateY(114vh); } }
@keyframes fosd-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0,216,255,0.35); }
  50% { box-shadow: 0 0 0 6px rgba(0,216,255,0); }
}
.fosd-grid { animation: fosd-grid-drift 3.8s linear infinite; }
.fosd-scanline { animation: fosd-scan 5s linear infinite; }
.fosd-status-dot { animation: fosd-pulse 2.2s ease-out infinite; }
.fosd-portal { transition: transform 160ms ease, box-shadow 160ms ease; }
.fosd-portal:hover { transform: translateY(-2px); box-shadow: 0 10px 34px rgba(0,160,255,.38) !important; }
.fosd-topbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
@media (prefers-reduced-motion: reduce) {
  .fosd-grid, .fosd-scanline, .fosd-status-dot { animation: none; }
}
`;

function DeckChipButton({ label, onClick, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: "1px solid rgba(0,216,255,.26)",
        borderRadius: 10,
        background: "rgba(2,18,36,.66)",
        color: "#dff2ff",
        padding: "10px 15px",
        cursor: disabled ? "wait" : "pointer",
        fontWeight: 800,
        fontSize: 12,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

export function FreedomOsDeck({
  sessionControls = null,
  isAdmin = false,
  onEnterFff,
  onOpenAdminUsage,
  children,
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
        overflow: "hidden",
        background:
          "radial-gradient(circle at 16% 8%, rgba(0,140,255,.18), transparent 26%), radial-gradient(circle at 86% 80%, rgba(34,211,238,.11), transparent 30%), linear-gradient(180deg, #010409, #030d1c 58%, #020813)",
        color: "#eaf3ff",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}
    >
      <style>{DECK_STYLES}</style>
      <div
        aria-hidden="true"
        className="fosd-grid"
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(143,234,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(143,234,255,0.045) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(circle at 50% 20%, rgba(0,0,0,.9), transparent 82%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 20%, rgba(0,0,0,.9), transparent 82%)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden="true"
        className="fosd-scanline"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          top: 0,
          height: 2,
          background:
            "linear-gradient(90deg, transparent, rgba(143,234,255,.32) 28%, rgba(143,234,255,.32) 72%, transparent)",
          opacity: 0.35,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1160,
          margin: "0 auto",
          padding: "clamp(16px, 3vh, 28px) clamp(16px, 3vw, 28px) 48px",
          display: "grid",
          gap: 20,
        }}
      >
        {/* Top command bar */}
        <header
          className="fosd-topbar"
          style={{
            border: "1px solid rgba(0,216,255,.2)",
            borderRadius: 16,
            background: "linear-gradient(160deg, rgba(4,22,42,.9), rgba(2,10,22,.86))",
            boxShadow: "0 10px 34px rgba(0,40,90,.28), inset 0 1px 0 rgba(255,255,255,.04)",
            padding: "14px 18px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 200 }}>
            <span
              aria-hidden="true"
              style={{
                fontSize: 26,
                color: "#00d8ff",
                textShadow: "0 0 22px rgba(0,216,255,.8)",
              }}
            >
              ◈
            </span>
            <div>
              <div
                style={{
                  color: "white",
                  fontWeight: 900,
                  fontSize: 16,
                  letterSpacing: 3,
                  textTransform: "uppercase",
                }}
              >
                Freedom OS
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  marginTop: 3,
                  color: "#6ee7b7",
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: 1.6,
                  textTransform: "uppercase",
                }}
              >
                <span
                  className="fosd-status-dot"
                  style={{ width: 7, height: 7, borderRadius: "50%", background: "#34d399" }}
                />
                Operator deck online
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {isAdmin && typeof onOpenAdminUsage === "function" ? (
              <DeckChipButton label="⛭ Admin" onClick={onOpenAdminUsage} />
            ) : null}
            {sessionControls?.onSignOut ? (
              <DeckChipButton
                label={sessionControls.isBusy ? "Signing out…" : "Sign Out"}
                disabled={Boolean(sessionControls.isBusy)}
                onClick={() => void sessionControls.onSignOut()}
              />
            ) : null}
            <button
              type="button"
              onClick={onEnterFff}
              className="fosd-portal"
              style={{
                border: "1px solid rgba(190,245,255,.6)",
                borderRadius: 12,
                background: "linear-gradient(90deg, #22d3ee, #60a5fa)",
                color: "#01131f",
                padding: "12px 20px",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 13,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                boxShadow: "0 0 26px rgba(34,211,238,.38)",
                whiteSpace: "nowrap",
              }}
            >
              Launch FFF <span aria-hidden="true">↗</span>
            </button>
          </div>
        </header>

        {/* Session status strip (mirrors the FFF sidebar session panel) */}
        {sessionControls?.workspaceStatus ||
        sessionControls?.notice ||
        sessionControls?.error ? (
          <div style={{ display: "grid", gap: 10 }}>
            {sessionControls?.workspaceStatus ? (
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 11,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  fontWeight: 800,
                  opacity: 0.85,
                }}
              >
                {sessionControls.workspaceStatus}
              </div>
            ) : null}
            {sessionControls?.notice ? (
              <div
                style={{
                  color: "#dff7ff",
                  background: "rgba(0,136,255,.1)",
                  border: "1px solid rgba(0,216,255,.22)",
                  borderRadius: 10,
                  padding: "11px 14px",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                {sessionControls.notice}
              </div>
            ) : null}
            {sessionControls?.error ? (
              <div
                style={{
                  color: "#ffd9df",
                  background: "rgba(255,36,77,.08)",
                  border: "1px solid rgba(255,93,122,.22)",
                  borderRadius: 10,
                  padding: "11px 14px",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span>{sessionControls.error}</span>
                {typeof sessionControls.onRetryWorkspaceSync === "function" ? (
                  <DeckChipButton
                    label="Retry sync"
                    disabled={Boolean(sessionControls.isBusy)}
                    onClick={sessionControls.onRetryWorkspaceSync}
                  />
                ) : null}
              </div>
            ) : null}
            {!sessionControls?.isEmailVerified &&
            typeof sessionControls?.onResendVerification === "function" ? (
              <div
                style={{
                  color: "#ffe9c2",
                  background: "rgba(255,166,0,.08)",
                  border: "1px solid rgba(255,183,74,.26)",
                  borderRadius: 10,
                  padding: "11px 14px",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span>Verify your email to unlock bank linking inside FFF.</span>
                <DeckChipButton
                  label={sessionControls.isBusy ? "Sending…" : "Resend email"}
                  disabled={Boolean(sessionControls.isBusy)}
                  onClick={sessionControls.onResendVerification}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Freedom OS home content */}
        <main>{children}</main>
      </div>
    </div>
  );
}
