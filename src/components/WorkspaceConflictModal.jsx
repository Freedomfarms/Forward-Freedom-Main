// Shown when a workspace save is rejected with 409 because another session
// saved newer changes first (H-10). Instead of silently discarding the user's
// unsaved edits, we keep their draft and let them choose how to reconcile.
export function WorkspaceConflictModal({ onKeepMine, onDiscardMine }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 11000,
        background: "rgba(1,6,14,.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          borderRadius: 18,
          border: "1px solid rgba(0,174,255,.24)",
          background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
          boxShadow: "0 0 50px rgba(0,136,255,.22)",
          padding: 26,
          color: "#eef6ff",
        }}
      >
        <div
          style={{
            color: "#8feaff",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          Workspace changed elsewhere
        </div>
        <div style={{ color: "white", fontSize: 22, fontWeight: 900, marginTop: 10 }}>
          Your workspace changed in another session
        </div>
        <p style={{ color: "#c6d7ea", lineHeight: 1.7, marginTop: 12, fontSize: 14 }}>
          Another browser or device saved newer changes while you were editing. Your unsaved changes
          here have been kept. Choose how you'd like to continue.
        </p>

        <div style={{ display: "grid", gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={onKeepMine}
            style={{
              width: "100%",
              borderRadius: 12,
              border: "1px solid rgba(120,220,255,.45)",
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              color: "white",
              padding: "12px 16px",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Keep my changes and overwrite
          </button>
          <button
            type="button"
            onClick={onDiscardMine}
            style={{
              width: "100%",
              borderRadius: 12,
              border: "1px solid rgba(255,93,122,.34)",
              background: "rgba(255,36,77,.10)",
              color: "#ffd9df",
              padding: "12px 16px",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Discard my changes and load the latest
          </button>
        </div>
      </div>
    </div>
  );
}
