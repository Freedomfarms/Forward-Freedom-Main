import ForwardFreedomDashboard from "./ForwardFreedomDashboard.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { WorkspaceSessionPanel } from "./components/WorkspaceSessionPanel.jsx";
import { buildScopedAppStateStorageKey } from "./utils/appState.js";

function AppLoadingScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at 20% 20%, rgba(0,136,255,.24), transparent 24%), linear-gradient(180deg, #020711, #041121 72%, #030d1a)",
        color: "#eef6ff",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            color: "#8feaff",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          Forward Freedom Financial
        </div>
        <div style={{ marginTop: 10, fontSize: 28, fontWeight: 900 }}>Loading secure workspace...</div>
      </div>
    </div>
  );
}

function AppContent() {
  const { configured, isBusy, ready, signOut, user } = useAuth();

  if (!configured) {
    return <ForwardFreedomDashboard initialView="landing" />;
  }

  if (!ready) {
    return <AppLoadingScreen />;
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <>
      <WorkspaceSessionPanel user={user} onSignOut={() => void signOut()} isBusy={isBusy} />
      <ForwardFreedomDashboard
        initialView="app"
        storageKey={buildScopedAppStateStorageKey(user.uid)}
      />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
