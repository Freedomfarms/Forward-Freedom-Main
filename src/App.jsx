import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { LandingPage } from "./components/LandingPage.jsx";

const ForwardFreedomDashboard = lazy(() => import("./ForwardFreedomDashboard.jsx"));
const AuthScreen = lazy(() =>
  import("./components/AuthScreen.jsx").then((module) => ({ default: module.AuthScreen }))
);
const DemoWorkspaceApp = lazy(() =>
  import("./components/DemoWorkspaceApp.jsx").then((module) => ({ default: module.DemoWorkspaceApp }))
);
import {
  buildScopedAppStateStorageKey,
  createEmptyAppState,
  loadPersistedAppStateRecord,
  persistAppState,
} from "./utils/appState.js";
import {
  sanitizeWorkspaceStateForBrowserCache,
  sanitizeWorkspaceStateForPersistence,
} from "./utils/workspacePersistence.js";
import {
  ApiRequestError,
  AUTHENTICATION_REQUIRED_MESSAGE,
  fetchAuthenticatedUserProfile,
  fetchWorkspaceSnapshot,
  isApiAuthenticationError,
  saveWorkspaceSnapshot,
} from "./utils/api.js";

const WORKSPACE_SAVE_DEBOUNCE_MS = 4000;
const WORKSPACE_RATE_LIMIT_RETRY_MS = 30000;
const WORKSPACE_BOOTSTRAP_RETRY_DELAYS_MS = [0, 800, 2000, 4000];
const WORKSPACE_RECOVERY_RETRY_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function fetchWorkspaceSnapshotWithRetry(options) {
  let lastError = null;

  for (let attempt = 0; attempt < WORKSPACE_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(WORKSPACE_BOOTSTRAP_RETRY_DELAYS_MS[attempt]);
    }

    try {
      return await fetchWorkspaceSnapshot(options);
    } catch (error) {
      lastError = error;
      if (!isApiAuthenticationError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function isWorkspaceRateLimitError(error) {
  return error instanceof ApiRequestError && error.status === 429;
}

function getWorkspaceRateLimitRetryDelayMs(error) {
  if (error?.retryAfterMs > 0) {
    return error.retryAfterMs;
  }

  return WORKSPACE_RATE_LIMIT_RETRY_MS;
}

function AppLoadingScreen({ message = "Loading secure workspace..." }) {
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
        <div style={{ marginTop: 10, fontSize: 28, fontWeight: 900 }}>{message}</div>
      </div>
    </div>
  );
}

function LazyRouteBoundary({ message, children }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<AppLoadingScreen message={message} />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function buildWorkspaceStatus(syncState) {
  if (syncState === "hydrating-cache") return "Restoring cached workspace into the database";
  if (syncState === "initializing-server") return "Creating your first server-backed workspace";
  if (syncState === "syncing") return "Syncing workspace changes to the database";
  if (syncState === "rate-limited") return "Saving paused briefly — retrying automatically";
  if (syncState === "cache-fallback") return "Using a temporary browser cache until the database returns";
  if (syncState === "synced" || syncState === "server-primary") {
    return "Database-backed workspace active";
  }

  return "Loading server-backed workspace";
}

function AuthenticatedWorkspaceApp({
  user,
  signOut,
  isBusy,
  authNotice,
  requestEmailChange,
  resendVerificationEmail,
  requestPasswordReset,
  updateProfileName,
}) {
  const storageKey = useMemo(() => buildScopedAppStateStorageKey(user.uid), [user.uid]);
  const [workspaceSeedState, setWorkspaceSeedState] = useState(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSyncState, setWorkspaceSyncState] = useState("idle");
  const [latestPersistedState, setLatestPersistedState] = useState(null);
  const [workspaceProfile, setWorkspaceProfile] = useState(null);
  const [workspaceBootstrapComplete, setWorkspaceBootstrapComplete] = useState(false);
  const [workspaceLoadGeneration, setWorkspaceLoadGeneration] = useState(0);
  const lastServerSnapshotRef = useRef("");
  const lastQueuedPersistedStateRef = useRef("");
  const hasConfirmedServerSnapshotRef = useRef(false);
  const rateLimitRetryTimeoutRef = useRef(null);
  const cacheWorkspaceState = useCallback(
    (state, cacheState = "browser-cache") => {
      if (!state) return;
      const sanitizedState = sanitizeWorkspaceStateForBrowserCache(state);

      persistAppState(sanitizedState, storageKey, {
        mode: "cache",
        persistedAt: new Date().toISOString(),
        cacheState,
      });
    },
    [storageKey]
  );

  useEffect(() => {
    let cancelled = false;
    const cachedWorkspaceRecord = loadPersistedAppStateRecord(storageKey, {
      fallbackToDefaultStorageKey: false,
      includeLegacyMetricSnapshots: false,
      useSeedData: false,
    });
    const emptyWorkspaceState = createEmptyAppState({
      primaryUserName: user.displayName || user.email || "User 1",
    });
    const cachedState = cachedWorkspaceRecord.hasPersistedState
      ? sanitizeWorkspaceStateForPersistence(cachedWorkspaceRecord.state)
      : emptyWorkspaceState;

    const bootstrapWorkspace = async () => {
      setWorkspaceBootstrapComplete(false);
      hasConfirmedServerSnapshotRef.current = false;

      try {
        const workspacePayload = await fetchWorkspaceSnapshotWithRetry({ user });
        let profilePayload = null;

        try {
          profilePayload = await fetchAuthenticatedUserProfile({ user });
        } catch (profileError) {
          console.warn("[workspace] Profile sync unavailable during bootstrap.", profileError);
        }

        const remoteSnapshot = workspacePayload?.snapshot || null;
        const remoteState = remoteSnapshot?.state
          ? sanitizeWorkspaceStateForPersistence(remoteSnapshot.state)
          : null;
        const nextSeedState = remoteState || cachedState;

        if (cancelled) return;

        setWorkspaceProfile(profilePayload?.user || null);
        setWorkspaceError("");

        if (remoteState) {
          hasConfirmedServerSnapshotRef.current = true;
          setWorkspaceSeedState(nextSeedState);
          lastServerSnapshotRef.current = JSON.stringify(remoteState);
          cacheWorkspaceState(remoteState, "server-snapshot");
          setWorkspaceSyncState("server-primary");
          setWorkspaceBootstrapComplete(true);
          return;
        }

        cacheWorkspaceState(
          nextSeedState,
          cachedWorkspaceRecord.hasPersistedState ? "restored-cache" : "seed-default"
        );
        setWorkspaceSyncState(
          cachedWorkspaceRecord.hasPersistedState ? "hydrating-cache" : "initializing-server"
        );

        const payload = await saveWorkspaceSnapshot(
          {
            state: sanitizeWorkspaceStateForPersistence(nextSeedState),
            source: cachedWorkspaceRecord.hasPersistedState
              ? "phase-5-bootstrap-hydration"
              : "phase-5-bootstrap-seed",
            lastClientUpdatedAt: new Date().toISOString(),
          },
          { user }
        );

        if (cancelled) return;

        const confirmedState = payload?.snapshot?.state || nextSeedState;
        const sanitizedConfirmedState = sanitizeWorkspaceStateForPersistence(confirmedState);
        hasConfirmedServerSnapshotRef.current = true;
        lastServerSnapshotRef.current = JSON.stringify(sanitizedConfirmedState);
        cacheWorkspaceState(sanitizedConfirmedState, "server-confirmed");
        setWorkspaceSeedState(sanitizedConfirmedState);
        setWorkspaceSyncState("synced");
        setWorkspaceBootstrapComplete(true);
      } catch (error) {
        if (cancelled) return;

        lastServerSnapshotRef.current = "";
        setWorkspaceSeedState(cachedState);
        cacheWorkspaceState(
          cachedState,
          cachedWorkspaceRecord.hasPersistedState ? "cache-fallback" : "seed-default"
        );
        setWorkspaceSyncState("cache-fallback");
        setWorkspaceBootstrapComplete(true);
        setWorkspaceError(
          isApiAuthenticationError(error)
            ? AUTHENTICATION_REQUIRED_MESSAGE
            : error?.message ||
                "Workspace server sync is unavailable right now. Using a temporary browser cache until the database is reachable again."
        );
      }
    };

    void bootstrapWorkspace();

    return () => {
      cancelled = true;
    };
  }, [cacheWorkspaceState, storageKey, user, user.displayName, user.email]);

  useEffect(() => {
    if (!workspaceBootstrapComplete || workspaceSyncState !== "cache-fallback") {
      return undefined;
    }

    let cancelled = false;

    const recoverWorkspaceFromServer = async () => {
      try {
        const workspacePayload = await fetchWorkspaceSnapshotWithRetry({ user });
        const remoteState = workspacePayload?.snapshot?.state
          ? sanitizeWorkspaceStateForPersistence(workspacePayload.snapshot.state)
          : null;

        if (!remoteState || cancelled) return;

        hasConfirmedServerSnapshotRef.current = true;
        lastServerSnapshotRef.current = JSON.stringify(remoteState);
        cacheWorkspaceState(remoteState, "server-snapshot");
        setWorkspaceSeedState(remoteState);
        setWorkspaceLoadGeneration((current) => current + 1);
        setWorkspaceSyncState("server-primary");
        setWorkspaceError("");
      } catch (error) {
        if (cancelled) return;

        if (!isApiAuthenticationError(error)) {
          setWorkspaceError(
            error?.message ||
              "Workspace server sync is unavailable right now. Using a temporary browser cache until the database is reachable again."
          );
        }
      }
    };

    const initialRetryTimeoutId = window.setTimeout(() => {
      void recoverWorkspaceFromServer();
    }, 3000);
    const intervalId = window.setInterval(() => {
      void recoverWorkspaceFromServer();
    }, WORKSPACE_RECOVERY_RETRY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialRetryTimeoutId);
      window.clearInterval(intervalId);
    };
  }, [cacheWorkspaceState, user, workspaceBootstrapComplete, workspaceSyncState]);

  const handlePersistedStateChange = useCallback((nextState) => {
    const serializedState = JSON.stringify(nextState);
    if (serializedState === lastQueuedPersistedStateRef.current) {
      return;
    }

    lastQueuedPersistedStateRef.current = serializedState;
    setLatestPersistedState(nextState);
  }, []);

  useEffect(() => {
    if (!latestPersistedState || !workspaceSeedState || !workspaceBootstrapComplete) {
      return undefined;
    }

    if (!hasConfirmedServerSnapshotRef.current && workspaceSyncState === "cache-fallback") {
      return undefined;
    }

    const sanitizedPersistedState = sanitizeWorkspaceStateForPersistence(latestPersistedState);
    cacheWorkspaceState(sanitizedPersistedState, "working-cache");

    const serializedState = JSON.stringify(sanitizedPersistedState);
    if (serializedState === lastServerSnapshotRef.current) {
      return undefined;
    }

    let cancelled = false;

    const attemptSave = () => {
      if (cancelled) return;
      setWorkspaceSyncState("syncing");
      void saveWorkspaceSnapshot(
        {
          state: sanitizedPersistedState,
          source: "phase-5-server-primary",
          lastClientUpdatedAt: new Date().toISOString(),
        },
        { user }
      )
        .then((payload) => {
          if (cancelled) return;
          const confirmedState = sanitizeWorkspaceStateForPersistence(
            payload?.snapshot?.state || sanitizedPersistedState
          );
          lastServerSnapshotRef.current = JSON.stringify(confirmedState);
          cacheWorkspaceState(confirmedState, "server-confirmed");
          setWorkspaceSyncState("synced");
          setWorkspaceError("");
        })
        .catch((error) => {
          if (cancelled) return;

          if (isWorkspaceRateLimitError(error)) {
            cacheWorkspaceState(latestPersistedState, "working-cache");
            setWorkspaceSyncState("rate-limited");
            setWorkspaceError(
              "Saving paused briefly due to high activity. Your changes are cached locally and will sync automatically."
            );

            if (rateLimitRetryTimeoutRef.current) {
              window.clearTimeout(rateLimitRetryTimeoutRef.current);
            }

            rateLimitRetryTimeoutRef.current = window.setTimeout(() => {
              rateLimitRetryTimeoutRef.current = null;
              attemptSave();
            }, getWorkspaceRateLimitRetryDelayMs(error));
            return;
          }

          lastQueuedPersistedStateRef.current = "";
          cacheWorkspaceState(latestPersistedState, "cache-fallback");
          setWorkspaceSyncState("cache-fallback");
          setWorkspaceError(
            error?.message ||
              "Workspace changes are being held in a temporary browser cache until the database is available again."
          );
        });
    };

    const timeoutId = window.setTimeout(attemptSave, WORKSPACE_SAVE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (rateLimitRetryTimeoutRef.current) {
        window.clearTimeout(rateLimitRetryTimeoutRef.current);
        rateLimitRetryTimeoutRef.current = null;
      }
    };
  }, [cacheWorkspaceState, latestPersistedState, user, workspaceBootstrapComplete, workspaceSeedState, workspaceSyncState]);

  if (!workspaceSeedState) {
    return <AppLoadingScreen message={buildWorkspaceStatus(workspaceSyncState)} />;
  }

  const sessionUser = user || workspaceProfile;
  const sessionEmail = sessionUser?.email || user?.email || "";
  const sessionControls = {
    user: sessionUser,
    onSignOut: () => void signOut(),
    isBusy,
    isEmailVerified: Boolean(sessionUser?.emailVerified),
    onResendVerification: () => void resendVerificationEmail(),
    onUpdateProfileName:
      typeof updateProfileName === "function"
        ? ({ displayName }) => updateProfileName({ displayName })
        : null,
    onRequestEmailChange:
      typeof requestEmailChange === "function"
        ? ({ nextEmail }) => requestEmailChange({ nextEmail })
        : null,
    onRequestPasswordReset:
      typeof requestPasswordReset === "function" && sessionEmail
        ? () => void requestPasswordReset({ email: sessionEmail })
        : null,
    workspaceStatus: buildWorkspaceStatus(workspaceSyncState),
    notice: authNotice,
    error: workspaceError,
  };

  return (
    <LazyRouteBoundary message="Loading secure workspace...">
      <ForwardFreedomDashboard
        key={`${user.uid}:${workspaceLoadGeneration}`}
        initialView="app"
        storageKey={storageKey}
        initialAppStateOverride={workspaceSeedState}
        onPersistedStateChange={handlePersistedStateChange}
        sessionControls={sessionControls}
        persistLocally={false}
      />
    </LazyRouteBoundary>
  );
}

function UnconfiguredPublicApp() {
  const [publicView, setPublicView] = useState("landing");
  const [demoSessionKey, setDemoSessionKey] = useState(0);

  if (publicView === "demo") {
    return (
      <LazyRouteBoundary message="Loading demo workspace...">
        <DemoWorkspaceApp
          key={demoSessionKey}
          onExit={() => setPublicView("landing")}
        />
      </LazyRouteBoundary>
    );
  }

  return (
    <LazyRouteBoundary message="Loading workspace...">
      <ForwardFreedomDashboard
        initialView="landing"
        onEnterDemo={() => {
          setDemoSessionKey((current) => current + 1);
          setPublicView("demo");
        }}
      />
    </LazyRouteBoundary>
  );
}

function AppContent() {
  const {
    configured,
    isBusy,
    notice,
    ready,
    requestEmailChange,
    requestPasswordReset,
    resendVerificationEmail,
    signOut,
    updateProfileName,
    user,
  } = useAuth();
  const [publicView, setPublicView] = useState("landing");
  const [demoSessionKey, setDemoSessionKey] = useState(0);
  const [authScreenConfig, setAuthScreenConfig] = useState({
    mode: "login",
    initialForm: null,
  });

  if (!configured) {
    return <UnconfiguredPublicApp />;
  }

  if (!user) {
    if (!ready) {
      return <AppLoadingScreen message="Restoring your session..." />;
    }

    if (publicView === "demo") {
      return (
        <LazyRouteBoundary message="Loading demo workspace...">
          <DemoWorkspaceApp
            key={demoSessionKey}
            onExit={() => setPublicView("landing")}
          />
        </LazyRouteBoundary>
      );
    }

    if (publicView === "auth") {
      return (
        <LazyRouteBoundary message="Loading sign-in...">
          <AuthScreen
            initialMode={authScreenConfig.mode}
            initialForm={authScreenConfig.initialForm}
            onBackHome={() => setPublicView("landing")}
          />
        </LazyRouteBoundary>
      );
    }

    return (
      <LandingPage
        enterApp={(payload = {}) => {
          setAuthScreenConfig({
            mode: payload?.mode === "create-account" ? "register" : "login",
            initialForm:
              payload?.mode === "create-account"
                ? {
                    fullName: payload.primaryUserName || "",
                    email: payload.email || "",
                  }
                : null,
          });
          setPublicView("auth");
        }}
        onEnterDemo={() => {
          setDemoSessionKey((current) => current + 1);
          setPublicView("demo");
        }}
      />
    );
  }

  if (!ready) {
    return <AppLoadingScreen />;
  }

  return (
    <AuthenticatedWorkspaceApp
      key={user.uid}
      user={user}
      signOut={async () => {
        setAuthScreenConfig({ mode: "login", initialForm: null });
        setPublicView("landing");
        return signOut();
      }}
      isBusy={isBusy}
      authNotice={notice}
      requestEmailChange={requestEmailChange}
      resendVerificationEmail={resendVerificationEmail}
      requestPasswordReset={requestPasswordReset}
      updateProfileName={updateProfileName}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
