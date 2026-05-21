import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForwardFreedomDashboard from "./ForwardFreedomDashboard.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { WorkspaceSessionPanel } from "./components/WorkspaceSessionPanel.jsx";
import {
  buildScopedAppStateStorageKey,
  loadPersistedAppStateRecord,
  persistAppState,
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

function buildWorkspaceStatus(syncState) {
  if (syncState === "hydrating-cache") return "Restoring cached workspace into the database";
  if (syncState === "initializing-server") return "Creating your first server-backed workspace";
  if (syncState === "syncing") return "Syncing workspace changes to the database";
  if (syncState === "cache-fallback") return "Using a temporary browser cache until the database returns";
  if (syncState === "synced" || syncState === "server-primary") {
    return "Database-backed workspace active";
  }

  return "Loading server-backed workspace";
}

function AuthenticatedWorkspaceApp({ user, signOut, isBusy }) {
  const storageKey = useMemo(() => buildScopedAppStateStorageKey(user.uid), [user.uid]);
  const [workspaceSeedState, setWorkspaceSeedState] = useState(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSyncState, setWorkspaceSyncState] = useState("idle");
  const [latestPersistedState, setLatestPersistedState] = useState(null);
  const [workspaceProfile, setWorkspaceProfile] = useState(null);
  const lastServerSnapshotRef = useRef("");
  const cacheWorkspaceState = useCallback(
    (state, cacheState = "browser-cache") => {
      if (!state) return;

      persistAppState(state, storageKey, {
        mode: "cache",
        persistedAt: new Date().toISOString(),
        cacheState,
      });
    },
    [storageKey]
  );

  useEffect(() => {
    let cancelled = false;
    const cachedWorkspaceRecord = loadPersistedAppStateRecord(storageKey);
    const cachedState = cachedWorkspaceRecord.state;

    const bootstrapWorkspace = async () => {
      try {
        const [profilePayload, workspacePayload] = await Promise.all([
          fetchAuthenticatedUserProfile(),
          fetchWorkspaceSnapshot(),
        ]);
        const remoteSnapshot = workspacePayload?.snapshot || null;
        const remoteState = remoteSnapshot?.state;
        const nextSeedState = remoteState || cachedState;

        if (cancelled) return;

        setWorkspaceProfile(profilePayload?.user || null);
        setWorkspaceSeedState(nextSeedState);
        setWorkspaceError("");

        if (remoteState) {
          lastServerSnapshotRef.current = JSON.stringify(remoteState);
          cacheWorkspaceState(remoteState, "server-snapshot");
          setWorkspaceSyncState("server-primary");
          return;
        }

        const serializedSeedState = JSON.stringify(nextSeedState);
        lastServerSnapshotRef.current = serializedSeedState;
        cacheWorkspaceState(
          nextSeedState,
          cachedWorkspaceRecord.hasPersistedState ? "restored-cache" : "seed-default"
        );
        setWorkspaceSyncState(
          cachedWorkspaceRecord.hasPersistedState ? "hydrating-cache" : "initializing-server"
        );

        const payload = await saveWorkspaceSnapshot({
          state: nextSeedState,
          source: cachedWorkspaceRecord.hasPersistedState
            ? "phase-5-bootstrap-hydration"
            : "phase-5-bootstrap-seed",
          lastClientUpdatedAt: new Date().toISOString(),
        });

        if (cancelled) return;

        const confirmedState = payload?.snapshot?.state || nextSeedState;
        lastServerSnapshotRef.current = JSON.stringify(confirmedState);
        cacheWorkspaceState(confirmedState, "server-confirmed");
        setWorkspaceSeedState(confirmedState);
        setWorkspaceSyncState("synced");
      } catch (error) {
        if (cancelled) return;

        lastServerSnapshotRef.current = "";
        setWorkspaceSeedState(cachedState);
        cacheWorkspaceState(
          cachedState,
          cachedWorkspaceRecord.hasPersistedState ? "cache-fallback" : "seed-default"
        );
        setWorkspaceSyncState("cache-fallback");
        setWorkspaceError(
          error?.message ||
            "Workspace server sync is unavailable right now. Using a temporary browser cache until the database is reachable again."
        );
      }
    };

    void bootstrapWorkspace();

    return () => {
      cancelled = true;
    };
  }, [cacheWorkspaceState, storageKey]);

  const handlePersistedStateChange = useCallback((nextState) => {
    setLatestPersistedState(nextState);
  }, []);

  useEffect(() => {
    if (!latestPersistedState || !workspaceSeedState) {
      return undefined;
    }

    cacheWorkspaceState(latestPersistedState, "working-cache");

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
        source: "phase-5-server-primary",
        lastClientUpdatedAt: new Date().toISOString(),
      })
        .then((payload) => {
          if (cancelled) return;
          const confirmedState = payload?.snapshot?.state || latestPersistedState;
          lastServerSnapshotRef.current = JSON.stringify(confirmedState);
          cacheWorkspaceState(confirmedState, "server-confirmed");
          setWorkspaceSyncState("synced");
          setWorkspaceError("");
        })
        .catch((error) => {
          if (cancelled) return;
          cacheWorkspaceState(latestPersistedState, "cache-fallback");
          setWorkspaceSyncState("cache-fallback");
          setWorkspaceError(
            error?.message ||
              "Workspace changes are being held in a temporary browser cache until the database is available again."
          );
        });
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [cacheWorkspaceState, latestPersistedState, workspaceSeedState]);

  if (!workspaceSeedState) {
    return <AppLoadingScreen />;
  }

  return (
    <>
      <WorkspaceSessionPanel
        user={workspaceProfile || user}
        onSignOut={() => void signOut()}
        isBusy={isBusy}
        workspaceStatus={buildWorkspaceStatus(workspaceSyncState)}
        workspaceError={workspaceError}
      />
      <ForwardFreedomDashboard
        initialView="app"
        storageKey={storageKey}
        initialAppStateOverride={workspaceSeedState}
        onPersistedStateChange={handlePersistedStateChange}
        persistLocally={false}
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
