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
  clearPersistedAppState,
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
  isWorkspaceConflictError,
  saveWorkspaceSnapshot,
} from "./utils/api.js";
import { flushPendingLegalConsent } from "./utils/legalConsent.js";

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

// The boot progress is tracked at module level so that the meter keeps filling
// smoothly when the app swaps between sequential loading screens (session
// restore -> workspace fetch -> lazy chunk) instead of restarting at 0%.
const BOOT_PROGRESS_RESUME_WINDOW_MS = 1500;
let bootProgressStartedAt = null;
let bootProgressLastSeenAt = 0;

function getBootProgress() {
  const now = Date.now();
  if (bootProgressStartedAt === null || now - bootProgressLastSeenAt > BOOT_PROGRESS_RESUME_WINDOW_MS) {
    bootProgressStartedAt = now;
  }
  bootProgressLastSeenAt = now;

  // Ramps quickly to ~60% then eases toward 97% while the real work finishes;
  // the screen unmounts when the app is ready, so it never stalls at 100%.
  const elapsedMs = now - bootProgressStartedAt;
  return Math.min(97, 97 * (1 - Math.exp(-elapsedMs / 1100)));
}

const BOOT_SCREEN_STYLES = `
@keyframes ff-boot-spin { to { transform: rotate(360deg); } }
@keyframes ff-boot-streak { from { transform: translateX(-90px); } to { transform: translateX(360px); } }
@keyframes ff-boot-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes ff-boot-glow {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(143,234,255,0.35)); }
  50% { filter: drop-shadow(0 0 20px rgba(143,234,255,0.75)); }
}
@keyframes ff-boot-scan { from { transform: translateY(-12vh); } to { transform: translateY(112vh); } }
.ff-boot-ring { animation: ff-boot-spin 1.15s linear infinite; }
.ff-boot-streak { animation: ff-boot-streak 1.4s ease-in-out infinite; }
.ff-boot-cursor { animation: ff-boot-blink 1s steps(1) infinite; }
.ff-boot-title { animation: ff-boot-glow 2.2s ease-in-out infinite; }
.ff-boot-scanline { animation: ff-boot-scan 3.6s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .ff-boot-ring, .ff-boot-streak, .ff-boot-cursor, .ff-boot-title, .ff-boot-scanline {
    animation: none;
  }
}
`;

function AppLoadingScreen({ message = "Loading secure workspace..." }) {
  const [progress, setProgress] = useState(() => getBootProgress());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setProgress(getBootProgress());
    }, 80);
    return () => window.clearInterval(intervalId);
  }, []);

  const percent = Math.round(progress);

  return (
    <div
      role="status"
      aria-busy="true"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        position: "relative",
        overflow: "hidden",
        background:
          "radial-gradient(circle at 20% 20%, rgba(0,136,255,.24), transparent 24%), radial-gradient(circle at 80% 78%, rgba(56,189,248,.14), transparent 30%), linear-gradient(180deg, #020711, #041121 72%, #030d1a)",
        color: "#eef6ff",
      }}
    >
      <style>{BOOT_SCREEN_STYLES}</style>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(143,234,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(143,234,255,0.05) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(circle at 50% 45%, rgba(0,0,0,0.9), transparent 75%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 45%, rgba(0,0,0,0.9), transparent 75%)",
        }}
      />
      <div
        aria-hidden="true"
        className="ff-boot-scanline"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 2,
          background:
            "linear-gradient(90deg, transparent, rgba(143,234,255,0.35) 30%, rgba(143,234,255,0.35) 70%, transparent)",
          opacity: 0.5,
        }}
      />
      <div style={{ textAlign: "center", position: "relative", zIndex: 1, padding: "0 24px" }}>
        <div style={{ position: "relative", width: 76, height: 76, margin: "0 auto 22px" }}>
          <div
            className="ff-boot-ring"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "2px solid rgba(143,234,255,0.18)",
              borderTopColor: "#8feaff",
              boxShadow: "0 0 24px rgba(143,234,255,0.25)",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 17,
              fontWeight: 900,
              letterSpacing: 1,
              color: "#8feaff",
            }}
          >
            FF
          </div>
        </div>
        <div
          style={{
            color: "#8feaff",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontSize: 12,
            fontWeight: 900,
            opacity: 0.85,
          }}
        >
          Forward Freedom Financial
        </div>
        <div
          className="ff-boot-title"
          style={{
            marginTop: 10,
            fontSize: 34,
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: 6,
            background: "linear-gradient(90deg, #8feaff, #3b82f6 55%, #8feaff)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Powering Freedom
        </div>
        <div
          style={{
            marginTop: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 300,
              maxWidth: "68vw",
              height: 8,
              borderRadius: 999,
              background: "rgba(143,234,255,0.1)",
              border: "1px solid rgba(143,234,255,0.22)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                borderRadius: 999,
                background: "linear-gradient(90deg, #0ea5e9, #8feaff)",
                boxShadow: "0 0 14px rgba(143,234,255,0.8)",
                transition: "width 120ms linear",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                className="ff-boot-streak"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: 60,
                  background:
                    "linear-gradient(90deg, transparent, rgba(255,255,255,0.75), transparent)",
                }}
              />
            </div>
          </div>
          <div
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 900,
              fontSize: 14,
              color: "#8feaff",
              width: 42,
              textAlign: "left",
            }}
          >
            {percent}%
          </div>
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 12,
            letterSpacing: 1.6,
            textTransform: "uppercase",
            color: "rgba(238,246,255,0.72)",
            fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
          }}
        >
          <span style={{ color: "#8feaff" }}>&gt;</span> {message}
          <span className="ff-boot-cursor" style={{ marginLeft: 6, color: "#8feaff" }}>
            ▊
          </span>
        </div>
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

function buildWorkspaceStatus(syncState, { failureKind = null } = {}) {
  if (syncState === "hydrating-cache") return "Restoring cached workspace into the database";
  if (syncState === "initializing-server") return "Creating your first server-backed workspace";
  if (syncState === "syncing") return "Syncing workspace changes to the database";
  if (syncState === "rate-limited") return "Saving paused briefly — retrying automatically";
  if (syncState === "recovering") return "Retrying secure workspace sync";
  if (syncState === "cache-fallback") {
    if (failureKind === "auth") {
      return "Secure sync is paused while your sign-in session finishes restoring";
    }
    return "Using a temporary browser cache until the database returns";
  }
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
  const [workspaceBootstrapRequestId, setWorkspaceBootstrapRequestId] = useState(0);
  const [workspaceFailureKind, setWorkspaceFailureKind] = useState(null);
  const [workspaceLoadGeneration, setWorkspaceLoadGeneration] = useState(0);
  const lastServerSnapshotRef = useRef("");
  // Server `updatedAt` of the snapshot the local state is based on; sent with
  // every save so the server can detect concurrent writes from other sessions.
  const lastServerSnapshotUpdatedAtRef = useRef(null);
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

  const retryWorkspaceSync = useCallback(() => {
    setWorkspaceBootstrapRequestId((current) => current + 1);
  }, []);

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
      setWorkspaceFailureKind(null);
      hasConfirmedServerSnapshotRef.current = false;
      setWorkspaceSyncState(workspaceBootstrapRequestId > 0 ? "recovering" : "idle");

      try {
        const workspacePayload = await fetchWorkspaceSnapshotWithRetry({ user });
        let profilePayload = null;

        try {
          profilePayload = await fetchAuthenticatedUserProfile({ user });
        } catch (profileError) {
          console.warn("[workspace] Profile sync unavailable during bootstrap.", profileError);
        }

        // Record any legal consent accepted during sign-in on the server now
        // that an authenticated session exists (kept pending until it lands).
        void flushPendingLegalConsent({ user });

        const remoteSnapshot = workspacePayload?.snapshot || null;
        const remoteState = remoteSnapshot?.state
          ? sanitizeWorkspaceStateForPersistence(remoteSnapshot.state)
          : null;
        const nextSeedState = remoteState || cachedState;

        if (cancelled) return;

        setWorkspaceProfile(profilePayload?.user || null);
        setWorkspaceError("");
        setWorkspaceFailureKind(null);

        if (remoteState) {
          hasConfirmedServerSnapshotRef.current = true;
          setWorkspaceSeedState(nextSeedState);
          setWorkspaceLoadGeneration((current) => current + 1);
          lastServerSnapshotRef.current = JSON.stringify(remoteState);
          lastServerSnapshotUpdatedAtRef.current = remoteSnapshot?.updatedAt || null;
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
            // A snapshot row can exist with empty state; base the write on the
            // version we just fetched so concurrent bootstraps are detected.
            baseSnapshotUpdatedAt: remoteSnapshot?.updatedAt || null,
          },
          { user }
        );

        if (cancelled) return;

        const confirmedState = payload?.snapshot?.state || nextSeedState;
        const sanitizedConfirmedState = sanitizeWorkspaceStateForPersistence(confirmedState);
        hasConfirmedServerSnapshotRef.current = true;
        lastServerSnapshotRef.current = JSON.stringify(sanitizedConfirmedState);
        lastServerSnapshotUpdatedAtRef.current = payload?.snapshot?.updatedAt || null;
        cacheWorkspaceState(sanitizedConfirmedState, "server-confirmed");
        setWorkspaceSeedState(sanitizedConfirmedState);
        setWorkspaceLoadGeneration((current) => current + 1);
        setWorkspaceSyncState("synced");
        setWorkspaceBootstrapComplete(true);
      } catch (error) {
        if (cancelled) return;

        const conflictSnapshot = isWorkspaceConflictError(error) ? error.payload?.snapshot : null;
        const conflictState = conflictSnapshot?.state
          ? sanitizeWorkspaceStateForPersistence(conflictSnapshot.state)
          : null;
        if (conflictState) {
          // Another session created the first snapshot while this one was
          // bootstrapping; adopt the server copy instead of overwriting it.
          hasConfirmedServerSnapshotRef.current = true;
          lastServerSnapshotRef.current = JSON.stringify(conflictState);
          lastServerSnapshotUpdatedAtRef.current = conflictSnapshot.updatedAt || null;
          cacheWorkspaceState(conflictState, "server-snapshot");
          setWorkspaceSeedState(conflictState);
          setWorkspaceLoadGeneration((current) => current + 1);
          setWorkspaceSyncState("server-primary");
          setWorkspaceFailureKind(null);
          setWorkspaceBootstrapComplete(true);
          setWorkspaceError("");
          return;
        }

        const authFailure = isApiAuthenticationError(error);
        lastServerSnapshotRef.current = "";
        setWorkspaceSeedState(cachedState);
        setWorkspaceLoadGeneration((current) => current + 1);
        cacheWorkspaceState(
          cachedState,
          cachedWorkspaceRecord.hasPersistedState ? "cache-fallback" : "seed-default"
        );
        setWorkspaceSyncState("cache-fallback");
        setWorkspaceFailureKind(authFailure ? "auth" : "server");
        setWorkspaceBootstrapComplete(true);
        setWorkspaceError(
          error?.message ||
            (authFailure
              ? AUTHENTICATION_REQUIRED_MESSAGE
              : "Workspace server sync is unavailable right now. Using a temporary browser cache until the database is reachable again.")
        );
      }
    };

    void bootstrapWorkspace();

    return () => {
      cancelled = true;
    };
  }, [
    cacheWorkspaceState,
    storageKey,
    user,
    user.displayName,
    user.email,
    workspaceBootstrapRequestId,
  ]);

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
        lastServerSnapshotUpdatedAtRef.current = workspacePayload?.snapshot?.updatedAt || null;
        cacheWorkspaceState(remoteState, "server-snapshot");
        setWorkspaceSeedState(remoteState);
        setWorkspaceLoadGeneration((current) => current + 1);
        setWorkspaceSyncState("server-primary");
        setWorkspaceFailureKind(null);
        setWorkspaceError("");
      } catch (error) {
        if (cancelled) return;

        if (!isApiAuthenticationError(error)) {
          setWorkspaceFailureKind("server");
          setWorkspaceError(
            error?.message ||
              "Workspace server sync is unavailable right now. Using a temporary browser cache until the database is reachable again."
          );
        } else {
          setWorkspaceFailureKind("auth");
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
          baseSnapshotUpdatedAt: lastServerSnapshotUpdatedAtRef.current || null,
        },
        { user }
      )
        .then((payload) => {
          if (cancelled) return;
          const confirmedState = sanitizeWorkspaceStateForPersistence(
            payload?.snapshot?.state || sanitizedPersistedState
          );
          lastServerSnapshotRef.current = JSON.stringify(confirmedState);
          lastServerSnapshotUpdatedAtRef.current =
            payload?.snapshot?.updatedAt || lastServerSnapshotUpdatedAtRef.current;
          cacheWorkspaceState(confirmedState, "server-confirmed");
          setWorkspaceSyncState("synced");
          setWorkspaceError("");
        })
        .catch((error) => {
          if (cancelled) return;

          if (isWorkspaceConflictError(error)) {
            // Another session saved a newer snapshot first. Adopt the server
            // copy (returned with the 409) instead of overwriting it blindly.
            const conflictSnapshot = error.payload?.snapshot || null;
            const conflictState = conflictSnapshot?.state
              ? sanitizeWorkspaceStateForPersistence(conflictSnapshot.state)
              : null;

            lastQueuedPersistedStateRef.current = "";

            if (conflictState) {
              hasConfirmedServerSnapshotRef.current = true;
              lastServerSnapshotRef.current = JSON.stringify(conflictState);
              lastServerSnapshotUpdatedAtRef.current = conflictSnapshot.updatedAt || null;
              cacheWorkspaceState(conflictState, "server-snapshot");
              setWorkspaceSeedState(conflictState);
              // Align the pending-save queue with the adopted server state so
              // the stale local state is not immediately re-saved over it.
              setLatestPersistedState(conflictState);
              setWorkspaceLoadGeneration((current) => current + 1);
              setWorkspaceSyncState("server-primary");
            } else {
              retryWorkspaceSync();
            }

            setWorkspaceError(
              "Another session saved newer workspace changes, so the latest version was loaded. Re-apply any edits made here that are missing."
            );
            return;
          }

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
  }, [cacheWorkspaceState, latestPersistedState, retryWorkspaceSync, user, workspaceBootstrapComplete, workspaceSeedState, workspaceSyncState]);

  if (!workspaceSeedState) {
    return (
      <AppLoadingScreen
        message={buildWorkspaceStatus(workspaceSyncState, { failureKind: workspaceFailureKind })}
      />
    );
  }

  const profileDetails = workspaceProfile || null;
  const sessionEmail = user?.email || profileDetails?.email || "";
  const sessionControls = {
    user,
    onSignOut: () => void signOut(),
    isBusy,
    isEmailVerified: Boolean(user?.emailVerified ?? profileDetails?.emailVerified),
    onResendVerification: () => void resendVerificationEmail(),
    onRetryWorkspaceSync: retryWorkspaceSync,
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
    workspaceStatus: buildWorkspaceStatus(workspaceSyncState, { failureKind: workspaceFailureKind }),
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

  // Without Firebase there is no authenticated owner, so this public path must
  // never persist financial data. Also purge anything a previous visit wrote to
  // the default localStorage key before persistence was disabled here.
  useEffect(() => {
    clearPersistedAppState();
  }, []);

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
        persistLocally={false}
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
