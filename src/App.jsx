import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { LandingPage } from "./components/LandingPage.jsx";
import { PublicFreedomOsHome } from "./components/FreedomOsLanding.jsx";
import { FreedomShell } from "./components/freedom/FreedomShell.jsx";
import { navigateApp, readSignupInitialForm } from "./routing/appLocation.js";
import { presentationForRoute } from "./routing/appRoutes.js";
import { clearSignedOutClientState } from "./utils/clientSessionCleanup.js";

const ForwardFreedomDashboard = lazy(() => import("./ForwardFreedomDashboard.jsx"));
const AuthScreen = lazy(() =>
  import("./components/AuthScreen.jsx").then((module) => ({ default: module.AuthScreen }))
);
const DemoWorkspaceApp = lazy(() =>
  import("./components/DemoWorkspaceApp.jsx").then((module) => ({
    default: module.DemoWorkspaceApp,
  }))
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
  detectBrowserTimeZone,
  fetchAuthenticatedUserProfile,
  fetchWorkspaceSnapshot,
  isApiAuthenticationError,
  isLegalConsentRequiredError,
  isWorkspaceConflictError,
  saveWorkspaceSnapshot,
  updateUserTimezone,
} from "./utils/api.js";
import { flushPendingLegalConsent } from "./utils/legalConsent.js";
import { LEGAL_CONSENT_VERSION } from "./content/legalContent.js";
import { LegalConsentGate } from "./components/LegalConsentGate.jsx";
import { WorkspaceConflictModal } from "./components/WorkspaceConflictModal.jsx";

const WORKSPACE_SAVE_DEBOUNCE_MS = 2000;
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
    <div role="status" aria-busy="true">
      <span className="chief-sr">{message}</span>
      <FreedomShell />
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
  if (syncState === "conflict") return "Workspace changed elsewhere — review to continue";
  if (syncState === "blocked-consent") return "Accept the updated legal terms to continue saving";
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
  osSurface = "chief",
  onNavigateOs,
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
  // Server-side legal-consent gate (H-9): null, "missing", or "outdated".
  const [legalConsentRequired, setLegalConsentRequired] = useState(null);
  // Workspace save conflict (H-10): holds the winning server snapshot so the
  // user can reconcile without losing their local draft.
  const [workspaceConflict, setWorkspaceConflict] = useState(null);
  const lastServerSnapshotRef = useRef("");
  // Server `updatedAt` of the snapshot the local state is based on; sent with
  // every save so the server can detect concurrent writes from other sessions.
  const lastServerSnapshotUpdatedAtRef = useRef(null);
  // Tracks whether the user had any prior consent, so a consent-required
  // rejection can choose the "outdated" vs "missing" gate copy without adding
  // workspaceProfile to the save effect's dependencies.
  const hadPriorConsentRef = useRef(false);
  const lastQueuedPersistedStateRef = useRef("");
  const hasConfirmedServerSnapshotRef = useRef(false);
  const rateLimitRetryTimeoutRef = useRef(null);
  // Latest sanitized state that still needs to reach the server. Lets us flush
  // a pending debounced save immediately on sign-out / tab-hide so recent edits
  // aren't dropped when the save effect unmounts before its timer fires.
  const pendingSaveRef = useRef(null);
  // Serializes snapshot PUTs from this tab. Two overlapping saves would race
  // on the base version marker and 409 against each other, showing a false
  // "changed in another session" conflict to a single-session user.
  const saveQueueRef = useRef(Promise.resolve());
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

        // Auto-detect browser IANA timezone on first login / when unset.
        // Fall back to America/New_York (Eastern) — never UTC.
        if (profilePayload?.user && !profilePayload.user.timezone) {
          const detectedTz = detectBrowserTimeZone() || "America/New_York";
          try {
            const tzPayload = await updateUserTimezone(detectedTz, { user });
            if (tzPayload?.user) {
              profilePayload = tzPayload;
            }
          } catch (tzError) {
            console.warn("[workspace] Timezone sync unavailable during bootstrap.", tzError);
          }
        }

        // Record any legal consent accepted during sign-in on the server now
        // that an authenticated session exists. Awaited so a first-time seed
        // save (gated server-side) is not rejected for missing consent.
        const profileUser = profilePayload?.user || null;
        let consentedVersion = profileUser?.legalConsentVersion || null;
        if (consentedVersion !== LEGAL_CONSENT_VERSION) {
          const flushed = await flushPendingLegalConsent({ user });
          if (flushed) consentedVersion = LEGAL_CONSENT_VERSION;
        }

        if (cancelled) return;

        // If we can determine consent is missing/outdated, gate proactively
        // rather than letting a gated write fail. When the profile fetch
        // failed (profileUser is null) we proceed and rely on server-side 403
        // enforcement as the backstop. When the server reports its consent
        // schema is not migrated yet (legalConsentSchemaReady === false),
        // consent cannot be recorded or enforced, so blocking sign-on here
        // would lock the user out with no way through — skip the gate and let
        // the staged pending consent flush once the migration lands.
        if (
          profileUser &&
          profileUser.legalConsentSchemaReady !== false &&
          consentedVersion !== LEGAL_CONSENT_VERSION
        ) {
          setWorkspaceProfile(profileUser);
          setLegalConsentRequired(profileUser.legalConsentAt ? "outdated" : "missing");
          setWorkspaceBootstrapComplete(true);
          return;
        }

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

        if (isLegalConsentRequiredError(error)) {
          // Seed save was blocked for missing/outdated consent (e.g. the
          // profile fetch failed so we could not gate proactively). Show the
          // gate; accepting re-runs bootstrap.
          setLegalConsentRequired(hadPriorConsentRef.current ? "outdated" : "missing");
          setWorkspaceBootstrapComplete(true);
          return;
        }

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

    // Pause auto-save while an unresolved consent gate or save conflict is
    // open so we neither overwrite the server nor lose the local draft.
    if (legalConsentRequired || workspaceConflict) {
      return undefined;
    }

    const sanitizedPersistedState = sanitizeWorkspaceStateForPersistence(latestPersistedState);
    cacheWorkspaceState(sanitizedPersistedState, "working-cache");

    const serializedState = JSON.stringify(sanitizedPersistedState);
    if (serializedState === lastServerSnapshotRef.current) {
      pendingSaveRef.current = null;
      return undefined;
    }

    // Record the not-yet-saved state so an out-of-band flush (sign-out /
    // tab-hide) can push it immediately instead of relying on the debounce.
    pendingSaveRef.current = { serializedState, sanitizedPersistedState };

    let cancelled = false;

    const attemptSave = () => {
      if (cancelled) return;
      setWorkspaceSyncState("syncing");
      // Queue behind any in-flight save and re-read the base version marker
      // only once it settles. A cancelled effect run (e.g. deps changed while
      // this request was in flight) must still record the server's confirmed
      // version in the refs — otherwise the next save is sent with a stale
      // base marker and 409s against our own previous write, popping the
      // "changed in another session" conflict with only one session open.
      const queuedSave = saveQueueRef.current
        .then(() => {
          // By the time the queue drains, an earlier save may have already
          // confirmed this exact state; skip the redundant write.
          if (serializedState === lastServerSnapshotRef.current) {
            return null;
          }
          return saveWorkspaceSnapshot(
            {
              state: sanitizedPersistedState,
              source: "phase-5-server-primary",
              lastClientUpdatedAt: new Date().toISOString(),
              baseSnapshotUpdatedAt: lastServerSnapshotUpdatedAtRef.current || null,
            },
            { user }
          );
        })
        .then((payload) => {
          if (payload) {
            const confirmedState = sanitizeWorkspaceStateForPersistence(
              payload?.snapshot?.state || sanitizedPersistedState
            );
            lastServerSnapshotRef.current = JSON.stringify(confirmedState);
            lastServerSnapshotUpdatedAtRef.current =
              payload?.snapshot?.updatedAt || lastServerSnapshotUpdatedAtRef.current;
            cacheWorkspaceState(confirmedState, "server-confirmed");
          }
          if (cancelled) return;
          setWorkspaceSyncState("synced");
          setWorkspaceError("");
        })
        .catch((error) => {
          if (cancelled) return;

          if (isLegalConsentRequiredError(error)) {
            // Server rejected the write for missing/outdated consent. Open the
            // consent gate; the local draft is preserved and re-saved after
            // acceptance (auto-save is paused while the gate is open).
            setLegalConsentRequired(hadPriorConsentRef.current ? "outdated" : "missing");
            setWorkspaceSyncState("blocked-consent");
            return;
          }

          if (isWorkspaceConflictError(error)) {
            // Another session saved a newer snapshot first. Preserve the local
            // draft and let the user decide how to reconcile instead of
            // silently replacing their unsaved work (H-10 UX).
            setWorkspaceConflict({ serverSnapshot: error.payload?.snapshot || null });
            setWorkspaceSyncState("conflict");
            setWorkspaceError(
              "Your workspace changed elsewhere. Review and re-apply your changes."
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

      saveQueueRef.current = queuedSave;
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
  }, [
    cacheWorkspaceState,
    latestPersistedState,
    legalConsentRequired,
    user,
    workspaceBootstrapComplete,
    workspaceConflict,
    workspaceSeedState,
    workspaceSyncState,
  ]);

  useEffect(() => {
    hadPriorConsentRef.current = Boolean(workspaceProfile?.legalConsentAt);
  }, [workspaceProfile]);

  // Immediately push any pending (debounced) save to the server. Used on
  // sign-out and tab-hide so edits made within the debounce window are not
  // lost when the save effect unmounts before its timer fires. Best-effort:
  // failures leave the working cache in place for the next session.
  const flushPendingWorkspaceSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (!pending || !user) return;
    if (pending.serializedState === lastServerSnapshotRef.current) return;
    if (legalConsentRequired || workspaceConflict) return;

    try {
      const payload = await saveQueueRef.current
        .catch(() => null)
        .then(() => {
          if (pending.serializedState === lastServerSnapshotRef.current) return null;
          return saveWorkspaceSnapshot(
            {
              state: pending.sanitizedPersistedState,
              source: "flush-on-exit",
              lastClientUpdatedAt: new Date().toISOString(),
              baseSnapshotUpdatedAt: lastServerSnapshotUpdatedAtRef.current || null,
            },
            { user }
          );
        });

      if (payload) {
        const confirmedState = sanitizeWorkspaceStateForPersistence(
          payload?.snapshot?.state || pending.sanitizedPersistedState
        );
        lastServerSnapshotRef.current = JSON.stringify(confirmedState);
        lastServerSnapshotUpdatedAtRef.current =
          payload?.snapshot?.updatedAt || lastServerSnapshotUpdatedAtRef.current;
        pendingSaveRef.current = null;
        cacheWorkspaceState(confirmedState, "server-confirmed");
      }
    } catch {
      // Best-effort flush; the debounced save / working cache remain the
      // fallback so nothing here should surface an error to the user.
    }
  }, [cacheWorkspaceState, legalConsentRequired, user, workspaceConflict]);

  // Flush pending edits when the tab is hidden (backgrounded, closed, or
  // navigated away). visibilitychange fires reliably before unload in modern
  // browsers and, unlike beforeunload, still allows an async request to start.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushPendingWorkspaceSave();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPendingWorkspaceSave]);

  const handleConsentAccepted = useCallback(() => {
    setLegalConsentRequired(null);
    setWorkspaceProfile((current) =>
      current
        ? {
            ...current,
            legalConsentVersion: LEGAL_CONSENT_VERSION,
            legalConsentAt: new Date().toISOString(),
          }
        : current
    );
    retryWorkspaceSync();
  }, [retryWorkspaceSync]);

  const handleConflictKeepMine = useCallback(() => {
    const server = workspaceConflict?.serverSnapshot || null;
    // Re-base onto the latest server version and force a re-save of the local
    // draft on top of it.
    lastServerSnapshotUpdatedAtRef.current =
      server?.updatedAt || lastServerSnapshotUpdatedAtRef.current;
    lastServerSnapshotRef.current = "";
    setWorkspaceConflict(null);
    setWorkspaceError("");
    setWorkspaceSyncState("syncing");
  }, [workspaceConflict]);

  const handleConflictDiscardMine = useCallback(() => {
    const server = workspaceConflict?.serverSnapshot || null;
    const serverState = server?.state ? sanitizeWorkspaceStateForPersistence(server.state) : null;
    setWorkspaceConflict(null);
    setWorkspaceError("");
    if (serverState) {
      hasConfirmedServerSnapshotRef.current = true;
      lastServerSnapshotRef.current = JSON.stringify(serverState);
      lastServerSnapshotUpdatedAtRef.current = server.updatedAt || null;
      lastQueuedPersistedStateRef.current = JSON.stringify(serverState);
      cacheWorkspaceState(serverState, "server-snapshot");
      setWorkspaceSeedState(serverState);
      setLatestPersistedState(serverState);
      setWorkspaceLoadGeneration((current) => current + 1);
      setWorkspaceSyncState("server-primary");
    } else {
      retryWorkspaceSync();
    }
  }, [cacheWorkspaceState, retryWorkspaceSync, workspaceConflict]);

  // Server-side consent gate blocks the entire authenticated app until the
  // current legal version is accepted (H-9). Rendered before the loading/seed
  // checks so it also covers the pre-seed proactive-gate case.
  if (legalConsentRequired) {
    return (
      <LegalConsentGate
        reason={legalConsentRequired === "outdated" ? "outdated" : "missing"}
        user={user}
        onAccepted={handleConsentAccepted}
      />
    );
  }

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
    onSignOut: () =>
      void flushPendingWorkspaceSave().finally(() => {
        signOut();
      }),
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
    workspaceStatus: buildWorkspaceStatus(workspaceSyncState, {
      failureKind: workspaceFailureKind,
    }),
    notice: authNotice,
    error: workspaceError,
  };

  return (
    <>
      <LazyRouteBoundary message="Loading secure workspace...">
        <ForwardFreedomDashboard
          key={`${user.uid}:${workspaceLoadGeneration}`}
          initialView="app"
          storageKey={storageKey}
          initialAppStateOverride={workspaceSeedState}
          onPersistedStateChange={handlePersistedStateChange}
          sessionControls={sessionControls}
          persistLocally={false}
          workspaceProfile={profileDetails}
          osSurface={osSurface}
          onNavigateOs={onNavigateOs}
        />
      </LazyRouteBoundary>
      {workspaceConflict ? (
        <WorkspaceConflictModal
          onKeepMine={handleConflictKeepMine}
          onDiscardMine={handleConflictDiscardMine}
        />
      ) : null}
    </>
  );
}

function useAppPathname() {
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname
  );

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return pathname;
}

function openFinanceAuth(payload = {}) {
  if (payload?.mode === "create-account") {
    navigateApp("/signup", {
      state: {
        initialForm: {
          fullName: payload.primaryUserName || "",
          email: payload.email || "",
        },
      },
    });
    return;
  }
  navigateApp("/login");
}

function PublicRouteScreen({ screen, demoSessionKey }) {
  if (screen === "demo") {
    return (
      <LazyRouteBoundary message="Loading demo workspace...">
        <DemoWorkspaceApp key={demoSessionKey} onExit={() => navigateApp("/")} />
      </LazyRouteBoundary>
    );
  }

  if (screen === "login" || screen === "signup") {
    const initialForm = screen === "signup" ? readSignupInitialForm() : null;
    return (
      <LazyRouteBoundary message="Loading sign-in...">
        <AuthScreen
          key={screen}
          initialMode={screen === "signup" ? "register" : "login"}
          initialForm={initialForm}
          onBackHome={() => navigateApp("/")}
          onModeChange={(mode) => navigateApp(mode === "register" ? "/signup" : "/login")}
        />
      </LazyRouteBoundary>
    );
  }

  if (screen === "finance-marketing") {
    return (
      <LandingPage
        enterApp={openFinanceAuth}
        onEnterDemo={() => navigateApp("/demo")}
        onBackToOs={() => navigateApp("/")}
      />
    );
  }

  return (
    <PublicFreedomOsHome
      onSignIn={() => navigateApp("/login")}
      onCreateAccount={() => navigateApp("/signup")}
      onExploreCeoAgents={() => navigateApp("/login")}
      onExploreFreedomFinancial={() => navigateApp("/finance")}
    />
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
  const pathname = useAppPathname();
  const [demoSessionKey, setDemoSessionKey] = useState(0);
  const demoPathRef = useRef(false);
  const suspendRedirectRef = useRef(false);
  const presentation = presentationForRoute({
    configured,
    ready,
    authenticated: Boolean(user),
    pathname,
  });

  useEffect(() => {
    if (!configured) clearPersistedAppState();
  }, [configured]);

  useEffect(() => {
    if (suspendRedirectRef.current) return;
    if (presentation.screen !== "redirect" || !presentation.redirectTo) return;
    if (normalizeRedirectPath(presentation.redirectTo) === normalizeRedirectPath(pathname)) return;
    navigateApp(presentation.redirectTo, { replace: true });
  }, [pathname, presentation.redirectTo, presentation.screen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("next")) return;
    navigateApp(`${window.location.pathname}${window.location.search}${window.location.hash}`, {
      replace: true,
    });
  }, [pathname]);

  useEffect(() => {
    const onDemo = normalizeRedirectPath(pathname) === "/demo";
    if (onDemo && !demoPathRef.current) {
      setDemoSessionKey((current) => current + 1);
    }
    demoPathRef.current = onDemo;
  }, [pathname]);

  if (presentation.screen === "restoring") {
    return (
      <AppLoadingScreen
        message={user ? "Loading secure workspace..." : "Restoring your session..."}
      />
    );
  }

  if (presentation.screen === "redirect" || presentation.screen === "reserved") {
    return <AppLoadingScreen message={user ? "Opening Freedom OS..." : "Loading Freedom OS..."} />;
  }

  if (presentation.surface && user) {
    return (
      <AuthenticatedWorkspaceApp
        key={user.uid}
        user={user}
        osSurface={presentation.surface}
        onNavigateOs={(path) => navigateApp(path)}
        signOut={async () => {
          // Hold path redirects until Firebase has cleared the user. Otherwise
          // "/" is treated as an authenticated entry and bounced back to /os/chief,
          // or /os is treated as signed-out and bounced to /login.
          suspendRedirectRef.current = true;
          clearSignedOutClientState(user.uid);
          try {
            await signOut();
          } finally {
            navigateApp("/", { replace: true });
            suspendRedirectRef.current = false;
          }
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

  return <PublicRouteScreen screen={presentation.screen} demoSessionKey={demoSessionKey} />;
}

function normalizeRedirectPath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
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
