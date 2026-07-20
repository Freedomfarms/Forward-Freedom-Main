import { APP_TABS, navMain, navTools } from "../data/constants.jsx";
import { SetupChecklistPanel } from "./OnboardingExperience.jsx";
import { styles } from "../styles.js";
import { HouseholdProfilesControl, SideItem } from "./Common.jsx";

export function AppSidebar({
  activeTab,
  setActiveTab,
  onBackHome,
  sessionControls = null,
  onboardingProgress = null,
  onOpenSetupStep = null,
  onSkipSetup = null,
  className = "",
  onNavigate,
  // Platform admin (from /api/me isAdmin) — gates the Admin Usage entry.
  isAdmin = false,
}) {
  // Freedom OS sits alone at the top; the existing finance tabs group under a
  // "Finance" section label (labels themselves are unchanged).
  const freedomOsItems = navMain.filter((item) => item.label === APP_TABS.FREEDOM_OS);
  const financeItems = navMain.filter((item) => item.label !== APP_TABS.FREEDOM_OS);
  const actionItems = [
    {
      label: "Review transactions",
      note: "Catch uncategorized and recent activity.",
      tab: APP_TABS.TRANSACTIONS,
    },
    {
      label: "Tune the budget",
      note: "Adjust categories and monthly pressure.",
      tab: APP_TABS.BUDGET_COMMAND_CENTER,
    },
    {
      label: "Update accounts",
      note: "Refresh balances and add missing assets.",
      tab: APP_TABS.ADD_ACCOUNTS,
    },
  ];

  return (
    <aside className={`app-sidebar ${className}`.trim()} style={styles.sidebar}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
          <div
            style={{
              position: "relative",
              width: 210,
              height: 110,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ marginTop: -8, textAlign: "center" }}>
              <div
                style={{
                  color: "#f4f8ff",
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 8,
                  textTransform: "uppercase",
                }}
              >
                Forward
              </div>

              <div
                style={{
                  color: "#00aaff",
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 10,
                  marginTop: 2,
                  textTransform: "uppercase",
                  textShadow: "0 0 18px rgba(0,174,255,.55)",
                }}
              >
                Freedom
              </div>

              <div
                style={{
                  color: "#f4f8ff",
                  fontSize: 21,
                  fontWeight: 700,
                  letterSpacing: 8,
                  textTransform: "uppercase",
                }}
              >
                Financial
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          color: "#9fb0c9",
          textTransform: "uppercase",
          fontSize: 12,
          marginBottom: 16,
        }}
      >
        Main
      </div>
      {freedomOsItems.map((item) => (
        <SideItem
          key={item.label}
          item={item}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onNavigate={onNavigate}
        />
      ))}

      <div
        style={{
          color: "#9fb0c9",
          textTransform: "uppercase",
          fontSize: 12,
          marginTop: 18,
          marginBottom: 16,
        }}
      >
        Finance
      </div>
      {financeItems.map((item) => (
        <SideItem
          key={item.label}
          item={item}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onNavigate={onNavigate}
        />
      ))}

      <div
        style={{
          color: "#9fb0c9",
          textTransform: "uppercase",
          fontSize: 12,
          marginTop: 18,
          marginBottom: 16,
        }}
      >
        Tools
      </div>
      {navTools.map((item) => (
        <SideItem
          key={item.label}
          item={item}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onNavigate={onNavigate}
        />
      ))}

      {isAdmin ? (
        <>
          <div
            style={{
              color: "#9fb0c9",
              textTransform: "uppercase",
              fontSize: 12,
              marginTop: 18,
              marginBottom: 16,
            }}
          >
            Admin
          </div>
          <SideItem
            item={{ icon: "⛭", label: APP_TABS.ADMIN_USAGE }}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onNavigate={onNavigate}
          />
        </>
      ) : null}

      <button
        onClick={() => {
          onBackHome();
          onNavigate?.();
        }}
        style={{
          width: "100%",
          marginTop: 24,
          marginBottom: 18,
          background: "linear-gradient(90deg, rgba(0,119,255,.18), rgba(0,216,255,.12))",
          border: "1px solid rgba(0,216,255,.28)",
          borderRadius: 10,
          padding: "14px 16px",
          color: "#eaf3ff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          cursor: "pointer",
          fontWeight: 800,
          letterSpacing: 0.4,
          boxShadow: "0 0 24px rgba(0,136,255,.18)",
        }}
      >
        <span style={{ fontSize: 18 }}>⌂</span>
        Back to Home
      </button>

      {sessionControls ? (
        <div style={{ ...styles.panel, marginBottom: 18, padding: 16 }}>
          {sessionControls.workspaceStatus ? (
            <div style={{ color: "#8feaff", fontSize: 12, lineHeight: 1.5 }}>
              {sessionControls.workspaceStatus}
            </div>
          ) : null}
          {!sessionControls.isEmailVerified && typeof sessionControls.onResendVerification === "function" ? (
            <button
              type="button"
              disabled={sessionControls.isBusy}
              onClick={sessionControls.onResendVerification}
              style={{
                marginTop: 10,
                width: "100%",
                borderRadius: 8,
                border: "1px solid rgba(0,216,255,.24)",
                background: "rgba(0,136,255,.08)",
                color: "#eef6ff",
                padding: "10px 12px",
                cursor: sessionControls.isBusy ? "wait" : "pointer",
                fontWeight: 700,
              }}
            >
              {sessionControls.isBusy ? "Sending email..." : "Resend Verification Email"}
            </button>
          ) : null}
          {sessionControls.notice ? (
            <div
              style={{
                marginTop: 10,
                color: "#dff7ff",
                background: "rgba(0,136,255,.10)",
                border: "1px solid rgba(0,216,255,.22)",
                borderRadius: 8,
                padding: "10px 11px",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {sessionControls.notice}
            </div>
          ) : null}
          {sessionControls.error ? (
            <div
              style={{
                marginTop: 10,
                color: "#ffd9df",
                background: "rgba(255,36,77,.08)",
                border: "1px solid rgba(255,93,122,.22)",
                borderRadius: 8,
                padding: "10px 11px",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {sessionControls.error}
            </div>
          ) : null}
          {sessionControls.error && typeof sessionControls.onRetryWorkspaceSync === "function" ? (
            <button
              type="button"
              disabled={sessionControls.isBusy}
              onClick={sessionControls.onRetryWorkspaceSync}
              style={{
                width: "100%",
                marginTop: 10,
                borderRadius: 8,
                border: "1px solid rgba(0,216,255,.24)",
                background: "rgba(0,136,255,.08)",
                color: "#eef6ff",
                padding: "10px 12px",
                cursor: sessionControls.isBusy ? "wait" : "pointer",
                fontWeight: 800,
              }}
            >
              Retry Secure Sync
            </button>
          ) : null}
          <button
            type="button"
            disabled={sessionControls.isBusy}
            onClick={sessionControls.onSignOut}
            style={{
              width: "100%",
              marginTop: 10,
              borderRadius: 8,
              border: "1px solid rgba(0,216,255,.24)",
              background: "rgba(0,136,255,.08)",
              color: "#eef6ff",
              padding: "10px 12px",
              cursor: sessionControls.isBusy ? "wait" : "pointer",
              fontWeight: 800,
            }}
          >
            {sessionControls.isBusy
              ? "Signing out..."
              : sessionControls.isDemoMode
                ? "Exit Demo"
                : "Sign Out"}
          </button>
        </div>
      ) : null}

      <SetupChecklistPanel
        progress={onboardingProgress}
        activeTab={activeTab}
        onOpenStep={(step) => {
          onOpenSetupStep?.(step);
          onNavigate?.();
        }}
        onSkip={() => {
          onSkipSetup?.();
          onNavigate?.();
        }}
      />

      <div
        style={{
          ...styles.panel,
          marginTop: onboardingProgress?.isActive ? 18 : 48,
          padding: 20,
        }}
      >
        <div style={{ color: "#8feaff", fontSize: 12, fontWeight: 900, letterSpacing: 1.1 }}>
          ACTION CENTER
        </div>
        <div style={{ color: "white", fontSize: 18, fontWeight: 800, marginTop: 8 }}>
          Jump back into the highest-value work.
        </div>
        <div style={{ color: "#c8d7ea", fontSize: 12, lineHeight: 1.6, marginTop: 10 }}>
          Keep the command center feel, but focus this space on useful next actions instead of status
          chrome.
        </div>
        <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
          {actionItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setActiveTab(item.tab);
                onNavigate?.();
              }}
              style={{
                textAlign: "left",
                padding: "12px 14px",
                borderRadius: 10,
                border: "1px solid rgba(0,216,255,.16)",
                background:
                  activeTab === item.tab
                    ? "linear-gradient(90deg, rgba(0,119,255,.2), rgba(0,216,255,.16))"
                    : "rgba(0,108,255,.06)",
                color: "#eaf3ff",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 13 }}>{item.label}</div>
              <div style={{ color: "#9fb0c9", fontSize: 11, marginTop: 4 }}>{item.note}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

export function ModulePlaceholder({ activeTab, householdProfilesProps }) {
  return (
    <div
      style={{
        ...styles.panel,
        minHeight: "78vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(circle at center, rgba(0,136,255,.12), transparent 55%)",
        }}
      />
      <div style={{ ...styles.pageHeader, position: "relative", zIndex: 1 }}>
        <div>
          <h1 style={styles.pageTitle}>{activeTab}</h1>
          <p style={styles.pageSubtitle}>Module initializing...</p>
        </div>
        <HouseholdProfilesControl {...householdProfilesProps} />
      </div>

      <div
        style={{
          position: "relative",
          textAlign: "center",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 72,
            color: "#00d8ff",
            textShadow: "0 0 25px rgba(0,216,255,.7)",
            marginBottom: 18,
          }}
        >
          ◈
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: "white", letterSpacing: 0.4 }}>
          {activeTab}
        </div>
        <div style={{ marginTop: 14, color: "#8faecc", fontSize: 16 }}>Module initializing...</div>
        <div
          style={{
            marginTop: 28,
            width: 260,
            height: 6,
            borderRadius: 999,
            background: "rgba(19,71,129,.4)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "42%",
              height: "100%",
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              boxShadow: "0 0 16px rgba(0,216,255,.8)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
