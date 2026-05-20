import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getFirebaseAuthInstance,
  getFirebaseClientConfig,
  onAuthStateChanged,
  registerWithEmail,
  signInWithEmail,
  signInWithGooglePopup,
  signOutCurrentUser,
} from "../utils/firebase.js";

const AuthContext = createContext(null);

function mapFirebaseError(error) {
  const code = error?.code || "";

  if (code.includes("invalid-credential") || code.includes("wrong-password")) {
    return "That email or password did not match our records.";
  }
  if (code.includes("user-not-found")) {
    return "No account was found for that email address.";
  }
  if (code.includes("email-already-in-use")) {
    return "That email address is already in use.";
  }
  if (code.includes("weak-password")) {
    return "Choose a stronger password with at least 6 characters.";
  }
  if (code.includes("popup-closed-by-user")) {
    return "Google sign-in was cancelled before it completed.";
  }
  if (code.includes("network-request-failed")) {
    return "Network issue detected. Please check your connection and try again.";
  }

  return error?.message || "Authentication could not be completed right now.";
}

export function AuthProvider({ children }) {
  const clientConfig = getFirebaseClientConfig();
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!clientConfig.configured);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!clientConfig.configured) {
      setReady(true);
      setUser(null);
      return undefined;
    }

    const auth = getFirebaseAuthInstance();
    if (!auth) {
      setReady(true);
      setUser(null);
      setError("Firebase Authentication is configured incorrectly.");
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(
      auth,
      (nextUser) => {
        setUser(nextUser);
        setReady(true);
      },
      (authError) => {
        setError(mapFirebaseError(authError));
        setReady(true);
      }
    );

    return unsubscribe;
  }, [clientConfig.configured]);

  const runAuthAction = useCallback(async (action) => {
    setIsBusy(true);
    setError("");

    try {
      return await action();
    } catch (actionError) {
      const message = mapFirebaseError(actionError);
      setError(message);
      throw new Error(message);
    } finally {
      setIsBusy(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      configured: clientConfig.configured,
      missingKeys: clientConfig.missingKeys,
      ready,
      user,
      error,
      isBusy,
      clearError: () => setError(""),
      signInWithGoogle: () => runAuthAction(() => signInWithGooglePopup()),
      signInWithEmail: (payload) => runAuthAction(() => signInWithEmail(payload)),
      signUpWithEmail: (payload) => runAuthAction(() => registerWithEmail(payload)),
      signOut: () => runAuthAction(() => signOutCurrentUser()),
    }),
    [clientConfig.configured, clientConfig.missingKeys, error, isBusy, ready, runAuthAction, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
