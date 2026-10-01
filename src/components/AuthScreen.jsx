import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  bindPendingLegalConsentEmail,
  clearPendingLegalConsent,
  markPendingLegalConsent,
} from "../utils/legalConsent.js";
import { MadFuturicsGateway } from "./entry/MadFuturicsGateway.jsx";
import { LegalModal } from "./LegalDocuments.jsx";

export function AuthScreen({
  initialMode = "login",
  initialForm = null,
  onBackHome = null,
  onModeChange = null,
}) {
  const {
    error,
    notice,
    clearError,
    clearNotice,
    isBusy,
    requestPasswordReset,
    signInWithEmail,
    signInWithGoogle,
    signUpWithEmail,
  } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({
    fullName: initialForm?.fullName || "",
    email: initialForm?.email || "",
    password: "",
  });
  const [agreedToLegal, setAgreedToLegal] = useState(false);
  const [activeDocument, setActiveDocument] = useState(null);
  const [formError, setFormError] = useState("");
  const [credentialsOpen, setCredentialsOpen] = useState(() => Boolean(initialForm?.email));
  const hasError = Boolean(formError || error);
  const feedbackId = hasError ? "auth-feedback" : notice ? "auth-notice" : undefined;

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (formError) setFormError("");
    if (error) clearError();
    if (notice) clearNotice();
  };

  const revealCredentials = () => {
    if (!form.email.trim() || !form.email.includes("@")) {
      setFormError("Enter your email address.");
      return false;
    }
    setFormError("");
    setCredentialsOpen(true);
    return true;
  };

  const handleEmailSubmit = async (event) => {
    event.preventDefault();

    if (!credentialsOpen) {
      revealCredentials();
      return;
    }
    if (!form.email.trim()) {
      setFormError("Enter your email address.");
      return;
    }
    if (!form.password) {
      setFormError("Enter your password.");
      return;
    }
    if (mode === "register" && !form.fullName.trim()) {
      setFormError("Enter your full name for the workspace owner profile.");
      return;
    }
    if (!agreedToLegal) {
      setFormError("Review and accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    // Stage the acceptance so it is recorded server-side once the session exists.
    markPendingLegalConsent(mode === "register" ? "email-signup" : "email-login", {
      email: form.email.trim(),
    });

    try {
      if (mode === "register") {
        await signUpWithEmail({
          email: form.email.trim(),
          password: form.password,
          displayName: form.fullName.trim(),
        });
      } else {
        await signInWithEmail({
          email: form.email.trim(),
          password: form.password,
        });
      }
    } catch {
      // Auth context already surfaces a friendly error message.
    }
  };

  const handlePasswordReset = async () => {
    if (!form.email.trim()) {
      setFormError("Enter your email address first so we know where to send the reset link.");
      return;
    }

    setFormError("");

    try {
      await requestPasswordReset({ email: form.email.trim() });
    } catch {
      // Auth context already surfaces a friendly error message.
    }
  };

  const handleGoogleSignIn = () => {
    if (!agreedToLegal) {
      setCredentialsOpen(true);
      setFormError("Review and accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    // Stage the acceptance so it is recorded server-side once the session exists.
    markPendingLegalConsent("google");

    clearError();
    setFormError("");
    void signInWithGoogle()
      .then((credential) => {
        const email = credential?.user?.email;
        if (email) bindPendingLegalConsentEmail(email);
      })
      .catch(() => {
        clearPendingLegalConsent();
      });
  };

  return (
    <MadFuturicsGateway variant={mode === "register" ? "signup" : "login"}>
      {typeof onBackHome === "function" ? (
        <button type="button" className="mf-back" onClick={onBackHome}>
          Return
        </button>
      ) : null}
      <form className="mf-auth" onSubmit={handleEmailSubmit}>
        <p className="mf-kicker">IDENTIFY YOURSELF</p>
        <div className="mf-modes">
          {[
            ["login", "Sign in"],
            ["register", "Create account"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setFormError("");
                clearError();
                clearNotice();
                if (typeof onModeChange === "function") onModeChange(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="mf-label" htmlFor="auth-email">
          Email
          <input
            id="auth-email"
            className="mf-input"
            type="email"
            value={form.email}
            onChange={(event) => updateForm("email", event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            aria-invalid={hasError && !form.email.trim() ? "true" : undefined}
            aria-describedby={feedbackId}
          />
        </label>

        {credentialsOpen ? (
          <>
            {mode === "register" ? (
              <label className="mf-label" htmlFor="auth-full-name">
                Full name
                <input
                  id="auth-full-name"
                  className="mf-input"
                  type="text"
                  value={form.fullName}
                  onChange={(event) => updateForm("fullName", event.target.value)}
                  placeholder="Workspace owner"
                  autoComplete="name"
                  required={mode === "register"}
                  aria-invalid={hasError && !form.fullName.trim() ? "true" : undefined}
                  aria-describedby={feedbackId}
                />
              </label>
            ) : null}
            <label className="mf-label" htmlFor="auth-password">
              Password
              <input
                id="auth-password"
                className="mf-input"
                type="password"
                value={form.password}
                onChange={(event) => updateForm("password", event.target.value)}
                placeholder={mode === "register" ? "Choose a secure password" : "Password"}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
                aria-invalid={hasError && !form.password ? "true" : undefined}
                aria-describedby={feedbackId}
              />
            </label>
          </>
        ) : null}

        <label className="mf-consent" htmlFor="auth-legal-consent">
          <input
            id="auth-legal-consent"
            type="checkbox"
            checked={agreedToLegal}
            onChange={(event) => {
              setAgreedToLegal(event.target.checked);
              if (formError) setFormError("");
            }}
            required
            aria-invalid={hasError && !agreedToLegal ? "true" : undefined}
            aria-describedby={feedbackId}
          />
          <span>
            I agree to the{" "}
            <button
              type="button"
              className="mf-inline-button"
              onClick={() => setActiveDocument("terms")}
            >
              Terms of Service
            </button>{" "}
            and{" "}
            <button
              type="button"
              className="mf-inline-button"
              onClick={() => setActiveDocument("privacy")}
            >
              Privacy Policy
            </button>
            , including connected-account data handling through Plaid.
          </span>
        </label>

        {formError || error ? (
          <div id="auth-feedback" className="mf-alert" role="alert">
            {formError || error}
          </div>
        ) : null}
        {notice ? (
          <div id="auth-notice" className="mf-notice" role="status" aria-live="polite">
            {notice}
          </div>
        ) : null}

        <button type="button" className="mf-google" onClick={handleGoogleSignIn} disabled={isBusy}>
          Continue with Google
        </button>

        {credentialsOpen ? (
          <button type="submit" className="mf-submit" disabled={isBusy}>
            {isBusy ? "Working..." : mode === "register" ? "Create access" : "Enter"}
          </button>
        ) : (
          <button type="submit" className="mf-submit">
            Continue
          </button>
        )}

        {credentialsOpen && mode === "login" ? (
          <button
            type="button"
            className="mf-text-button"
            disabled={isBusy}
            onClick={() => {
              void handlePasswordReset();
            }}
          >
            Send password reset
          </button>
        ) : null}
      </form>
      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </MadFuturicsGateway>
  );
}
