/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getFirebaseAuthInstance,
  getFirebaseClientConfig,
  onAuthStateChanged,
  registerWithEmail,
  requestCurrentUserEmailChange,
  requestPasswordReset,
  resendCurrentUserVerification,
  signInWithEmail,
  signInWithGooglePopup,
  signOutCurrentUser,
  updateCurrentUserDisplayName,
  waitForUserIdToken,
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
  if (code.includes("invalid-email")) {
    return "Enter a valid email address.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts right now. Wait a moment and try again.";
  }
  if (code.includes("requires-recent-login")) {
    return "For security, sign out and sign back in before changing that account detail.";
  }
  if (code.includes("network-request-failed")) {
    return "Network issue detected. Please check your connection and try again.";
  }

  return error?.message || "Authentication could not be completed right now.";
}

export function AuthProvider({ children }) {
  const clientConfig = getFirebaseClientConfig();
  const auth = clientConfig.configured ? getFirebaseAuthInstance() : null;
  const [user, setUser] = useState(() => auth?.currentUser || null);
  const [ready, setReady] = useState(() => !clientConfig.configured);
  const [error, setError] = useState(() =>
    clientConfig.configured && !auth ? "Firebase Authentication is configured incorrectly." : ""
  );
  const [notice, setNotice] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!clientConfig.configured || !auth) {
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(
      auth,
      (nextUser) => {
        setUser(nextUser);
        setError("");

        if (!nextUser) {
          setReady(true);
          return;
        }

        setReady(false);
        void waitForUserIdToken(nextUser).finally(() => {
          setReady(true);
        });
      },
      (authError) => {
        setError(mapFirebaseError(authError));
        setReady(true);
        setUser(null);
      }
    );

    return unsubscribe;
  }, [auth, clientConfig.configured]);

  const runAuthAction = useCallback(async (action, options = {}) => {
    const successMessage = typeof options.successMessage === "string" ? options.successMessage : "";
    setIsBusy(true);
    setError("");
    setNotice("");

    try {
      const result = await action();
      if (successMessage) {
        setNotice(successMessage);
      }
      return result;
    } catch (actionError) {
      const message = mapFirebaseError(actionError);
      setNotice("");
      setError(message);
      throw new Error(message, { cause: actionError });
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
      notice,
      isBusy,
      clearError: () => setError(""),
      clearNotice: () => setNotice(""),
      signInWithGoogle: () => runAuthAction(() => signInWithGooglePopup()),
      signInWithEmail: (payload) => runAuthAction(() => signInWithEmail(payload)),
      signUpWithEmail: (payload) =>
        runAuthAction(() => registerWithEmail(payload), {
          successMessage:
            "Verification email sent. Check your inbox and use the link there to confirm this account.",
        }),
      requestPasswordReset: (payload) =>
        runAuthAction(() => requestPasswordReset(payload), {
          successMessage:
            "If that email has an account, a password reset link is now on the way.",
        }),
      updateProfileName: (payload) =>
        runAuthAction(() => updateCurrentUserDisplayName(payload), {
          successMessage: "Profile name updated.",
        }),
      requestEmailChange: (payload) =>
        runAuthAction(() => requestCurrentUserEmailChange(payload), {
          successMessage:
            "Check the new email inbox for a confirmation link to finish this email change.",
        }),
      resendVerificationEmail: () =>
        runAuthAction(() => resendCurrentUserVerification(), {
          successMessage: "Verification email sent again. Check your inbox and spam folder.",
        }),
      signOut: () => runAuthAction(() => signOutCurrentUser()),
    }),
    [
      clientConfig.configured,
      clientConfig.missingKeys,
      error,
      isBusy,
      notice,
      ready,
      runAuthAction,
      user,
    ]
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
