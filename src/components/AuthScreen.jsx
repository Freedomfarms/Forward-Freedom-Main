import { useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../context/AuthContext.jsx";
import {
  bindPendingLegalConsentEmail,
  clearPendingLegalConsent,
  markPendingLegalConsent,
} from "../utils/legalConsent.js";
import { LegalModal } from "./LegalDocuments.jsx";

const COPY = {
  login: {
    heading: "Make yourself at home.",
    caption: "Your next conversation starts here.",
    submit: "CONTINUE",
  },
  register: {
    heading: "A new chapter starts here.",
    caption: "Make room for your own second mind.",
    submit: "CREATE ACCOUNT",
  },
};

export function AuthScreen({ initialMode = "login", initialForm = null, onModeChange = null }) {
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
  const mode = initialMode === "register" ? "register" : "login";
  const [form, setForm] = useState({
    fullName: initialForm?.fullName || "",
    email: initialForm?.email || "",
    password: "",
  });
  const [agreedToLegal, setAgreedToLegal] = useState(false);
  const [activeDocument, setActiveDocument] = useState(null);
  const [formError, setFormError] = useState("");
  const copy = COPY[mode];
  const feedback = formError || error;
  const feedbackId = feedback || notice ? "form-status" : undefined;

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (formError) setFormError("");
    if (error) clearError();
    if (notice) clearNotice();
  };

  const selectMode = (next) => {
    if (next === mode) return;
    setFormError("");
    clearError();
    clearNotice();
    if (typeof onModeChange === "function") onModeChange(next);
  };

  const onTabKeyDown = (event, index) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? "login" : event.key === "End" ? "register" : index === 0 ? "register" : "login";
    selectMode(next);
  };

  const handleEmailSubmit = async (event) => {
    event.preventDefault();

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
      setFormError("Review and accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

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
    <>
      <div className="form-brand">
        <svg className="bolt-mark" viewBox="0 0 30 42" aria-hidden="true">
          <path d="M19 1 3 24h11l-5 17 19-26H16z" />
        </svg>
        <span>
          FREEDOM OS
          <small>YOUR PERSONAL INTELLIGENCE SYSTEM</small>
        </span>
        <i className="dot" />
      </div>
      <h3 id="form-heading">{copy.heading}</h3>
      <p className="form-caption">{copy.caption}</p>
      <div className="tabs" role="tablist" aria-label="Account action">
        {[
          ["login", "SIGN IN", "signin-tab"],
          ["register", "CREATE ACCOUNT", "signup-tab"],
        ].map(([value, label, id], index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={id}
            aria-selected={mode === value}
            aria-controls="auth-panel"
            tabIndex={mode === value ? 0 : -1}
            onClick={() => selectMode(value)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="auth-panel" role="tabpanel" aria-labelledby={mode === "register" ? "signup-tab" : "signin-tab"}>
        <form id="entry-form" onSubmit={handleEmailSubmit}>
          {mode === "register" ? (
            <>
              <label htmlFor="full-name">FULL NAME</label>
              <input
                id="full-name"
                type="text"
                value={form.fullName}
                placeholder="Workspace owner"
                autoComplete="name"
                required
                aria-invalid={feedback && !form.fullName.trim() ? "true" : undefined}
                aria-describedby={feedbackId}
                onChange={(event) => updateForm("fullName", event.target.value)}
              />
            </>
          ) : null}
          <label htmlFor="email">EMAIL ADDRESS</label>
          <input
            id="email"
            type="email"
            value={form.email}
            placeholder="you@example.com"
            autoComplete="email"
            maxLength={254}
            required
            aria-invalid={feedback && !form.email.trim() ? "true" : undefined}
            aria-describedby={feedbackId}
            onChange={(event) => updateForm("email", event.target.value)}
          />
          <label htmlFor="password">PASSWORD</label>
          <input
            id="password"
            type="password"
            value={form.password}
            placeholder={mode === "register" ? "Choose a secure password" : "Password"}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
            aria-invalid={feedback && !form.password ? "true" : undefined}
            aria-describedby={feedbackId}
            onChange={(event) => updateForm("password", event.target.value)}
          />
          {mode === "login" ? (
            <button
              type="button"
              className="reset-link"
              disabled={isBusy}
              onClick={() => {
                void handlePasswordReset();
              }}
            >
              SEND PASSWORD RESET
            </button>
          ) : null}
          <label className="consent">
            <input
              type="checkbox"
              checked={agreedToLegal}
              required
              aria-invalid={feedback && !agreedToLegal ? "true" : undefined}
              aria-describedby={feedbackId}
              onChange={(event) => {
                setAgreedToLegal(event.target.checked);
                if (formError) setFormError("");
              }}
            />
            <span>
              I agree to the{" "}
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveDocument("terms");
                }}
              >
                Terms of Service
              </button>{" "}
              and{" "}
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveDocument("privacy");
                }}
              >
                Privacy Policy
              </button>
              , including connected-account data handling through Plaid.
            </span>
          </label>
          <button className="continue" type="submit" disabled={isBusy}>
            <span id="continue-label">{isBusy ? "WORKING..." : copy.submit}</span>
            <b aria-hidden="true">↗</b>
          </button>
        </form>
        <div className="divider">OR</div>
        <button className="google" id="google" type="button" disabled={isBusy} onClick={handleGoogleSignIn}>
          <b aria-hidden="true">G</b>CONTINUE WITH GOOGLE
        </button>
      </div>
      {feedback ? (
        <p className="form-status is-error" id="form-status" role="alert">
          {feedback}
        </p>
      ) : notice ? (
        <p className="form-status" id="form-status" role="status">
          {notice}
        </p>
      ) : null}
      {activeDocument
        ? createPortal(
            <LegalModal
              activeDocument={activeDocument}
              closeDocument={() => setActiveDocument(null)}
            />,
            document.body
          )
        : null}
    </>
  );
}
