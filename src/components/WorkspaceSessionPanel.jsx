export function WorkspaceSessionPanel({
  user,
  onSignOut,
  isBusy = false,
  workspaceStatus = "",
  workspaceError = "",
}) {
  if (!user) return null;

  const label = user.displayName?.trim() || user.email || "Authenticated User";

  return (
    <div
      style={{
        position: "fixed",
        top: 18,
        right: 20,
        zIndex: 200,
        display: "grid",
        gap: 8,
        minWidth: 260,
      }}
    >
      <div
        style={{
          borderRadius: 16,
          border: "1px solid rgba(0,216,255,.22)",
          background: "rgba(4,16,31,.9)",
          color: "#eef6ff",
          padding: "14px 16px",
          boxShadow: "0 0 24px rgba(0,80,180,.18)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div
          style={{
            color: "#8feaff",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: 900,
          }}
        >
          Authenticated Workspace
        </div>
        <div style={{ color: "white", fontWeight: 900, marginTop: 7 }}>{label}</div>
        <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 6 }}>
          {user.emailVerified ? "Verified account" : "Email verification pending"}
        </div>
        {workspaceStatus ? (
          <div style={{ color: "#8feaff", fontSize: 12, marginTop: 8 }}>{workspaceStatus}</div>
        ) : null}
        {workspaceError ? (
          <div
            style={{
              marginTop: 10,
              color: "#ffd9df",
              background: "rgba(255,36,77,.08)",
              border: "1px solid rgba(255,93,122,.22)",
              borderRadius: 10,
              padding: "10px 11px",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {workspaceError}
          </div>
        ) : null}
        <button
          type="button"
          disabled={isBusy}
          onClick={onSignOut}
          style={{
            marginTop: 12,
            width: "100%",
            borderRadius: 10,
            border: "1px solid rgba(0,216,255,.24)",
            background: "rgba(0,136,255,.08)",
            color: "#eef6ff",
            padding: "10px 12px",
            cursor: isBusy ? "wait" : "pointer",
            fontWeight: 800,
          }}
        >
          {isBusy ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </div>
  );
}
