import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForwardFreedomDashboard from "./ForwardFreedomDashboard.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { WorkspaceSessionPanel } from "./components/WorkspaceSessionPanel.jsx";
import {
  buildScopedAppStateStorageKey,
  loadPersistedAppState,
} from "./utils/appState.js";
import {
  fetchAuthenticatedUserProfile,
  fetchWorkspaceSnapshot,
  saveWorkspaceSnapshot,
} from "./utils/api.js";

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

function AuthenticatedWorkspaceApp({ user, signOut, isBusy }) {
  const storageKey = useMemo(() => buildScopedAppStateStorageKey(user.uid), [user.uid]);
  const [workspaceSeedState, setWorkspaceSeedState] = useState(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSyncState, setWorkspaceSyncState] = useState("idle");
  const [latestPersistedState, setLatestPersistedState] = useState(null);
  const [workspaceProfile, setWorkspaceProfile] = useState(null);
  const lastServerSnapshotRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const fallbackState = loadPersistedAppState(storageKey);

    const bootstrapWorkspace = async () => {
      try {
        const [profilePayload, workspacePayload] = await Promise.all([
          fetchAuthenticatedUserProfile(),
          fetchWorkspaceSnapshot(),
        ]);
        const remoteState = workspacePayload?.snapshot?.state;
        const nextSeedState = remoteState || fallbackState;

        if (cancelled) return;

        setWorkspaceProfile(profilePayload?.user || null);
        setWorkspaceSeedState(nextSeedState);
        setWorkspaceSyncState("ready");
        lastServerSnapshotRef.current = remoteState ? JSON.stringify(remoteState) : "";
      } catch (error) {
        if (cancelled) return;

        setWorkspaceSeedState(fallbackState);
        setWorkspaceSyncState("local-only");
        setWorkspaceError(
          error?.message ||
            "Workspace server sync is unavailable right now. Local browser persistence remains active."
        );
      }
    };

    void bootstrapWorkspace();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const handlePersistedStateChange = useCallback((nextState) => {
    setLatestPersistedState(nextState);
  }, []);

  useEffect(() => {
    if (!latestPersistedState || !workspaceSeedState || workspaceSyncState === "local-only") {
      return undefined;
    }

    const serializedState = JSON.stringify(latestPersistedState);
    if (serializedState === lastServerSnapshotRef.current) {
      return undefined;
    }

    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setWorkspaceSyncState("syncing");
      void saveWorkspaceSnapshot({
        state: latestPersistedState,
        source: "phase-2-app-sync",
        lastClientUpdatedAt: new Date().toISOString(),
      })
        .then((payload) => {
          if (cancelled) return;
          lastServerSnapshotRef.current = serializedState;
          setWorkspaceSyncState(payload?.snapshot ? "synced" : "ready");
          setWorkspaceError("");
        })
        .catch((error) => {
          if (cancelled) return;
          setWorkspaceSyncState("local-only");
          setWorkspaceError(
            error?.message ||
              "Workspace changes are only being stored locally until server sync is available."
          );
        });
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [latestPersistedState, workspaceSeedState, workspaceSyncState]);

  if (!workspaceSeedState) {
    return <AppLoadingScreen />;
  }

  return (
    <>
      <WorkspaceSessionPanel
        user={workspaceProfile || user}
        onSignOut={() => void signOut()}
        isBusy={isBusy}
        workspaceStatus={
          workspaceSyncState === "local-only"
            ? "Local persistence fallback"
            : workspaceSyncState === "syncing"
              ? "Syncing workspace to server"
              : workspaceSyncState === "synced"
                ? "Server-backed workspace active"
                : "Authenticated workspace ready"
        }
        workspaceError={workspaceError}
      />
      <ForwardFreedomDashboard
        initialView="app"
        storageKey={storageKey}
        initialAppStateOverride={workspaceSeedState}
        onPersistedStateChange={handlePersistedStateChange}
      />
    </>
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

  return <AuthenticatedWorkspaceApp key={user.uid} user={user} signOut={signOut} isBusy={isBusy} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
