import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";

function buildButtonStyle({ primary = false, danger = false } = {}) {
  return {
    width: "100%",
    borderRadius: 12,
    border: primary
      ? "1px solid rgba(120,220,255,.45)"
      : danger
        ? "1px solid rgba(255,93,122,.34)"
        : "1px solid rgba(0,216,255,.22)",
    background: primary
      ? "linear-gradient(90deg,#0077ff,#00d8ff)"
      : danger
        ? "rgba(255,36,77,.10)"
        : "rgba(0,136,255,.08)",
    color: "white",
    padding: "13px 16px",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 14,
    letterSpacing: 0.3,
    boxShadow: primary ? "0 0 22px rgba(0,136,255,.24)" : "none",
  };
}

function buildInputStyle() {
  return {
    width: "100%",
    background: "rgba(0,136,255,.08)",
    border: "1px solid rgba(0,216,255,.22)",
    color: "#eef6ff",
    borderRadius: 12,
    padding: "13px 14px",
    outline: "none",
    fontSize: 14,
    fontWeight: 600,
    boxSizing: "border-box",
  };
}

export function AuthScreen() {
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
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
  });
  const [formError, setFormError] = useState("");

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (formError) setFormError("");
    if (error) clearError();
    if (notice) clearNotice();
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

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 20% 20%, rgba(0,136,255,.24), transparent 24%), radial-gradient(circle at 80% 18%, rgba(0,216,255,.16), transparent 20%), linear-gradient(180deg, #020711, #041121 72%, #030d1a)",
        color: "#eef6ff",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(1080px, 100%)",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.08fr) minmax(360px, .92fr)",
          gap: 28,
          alignItems: "stretch",
        }}
      >
        <section
          style={{
            borderRadius: 24,
            border: "1px solid rgba(0,216,255,.20)",
            background: "rgba(3,17,32,.78)",
            padding: "38px 42px",
            boxShadow: "inset 0 0 80px rgba(0,70,150,.12)",
          }}
        >
          <div
            style={{
              color: "#8feaff",
              textTransform: "uppercase",
              letterSpacing: 1.6,
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            Forward Freedom Financial
          </div>
          <h1 style={{ margin: "16px 0 0", fontSize: 44, lineHeight: 1.1, color: "white" }}>
            Production workspace access is now protected.
          </h1>
          <p style={{ marginTop: 18, color: "#b7c9de", fontSize: 17, lineHeight: 1.75 }}>
            Sign in to enter your financial workspace. This is the first step toward a real
            production architecture with authenticated sessions, secure Plaid APIs, and server-side
            persistence.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 14,
              marginTop: 28,
            }}
          >
            {[
              ["Firebase Auth", "Google + email/password login for owner and future invited users."],
              ["Postgres Ready", "Database foundation is moving toward a durable server-side source of truth."],
              ["Plaid Hardening", "Live production usage stays off until backend security is locked down."],
            ].map(([title, body]) => (
              <div
                key={title}
                style={{
                  borderRadius: 16,
                  border: "1px solid rgba(0,216,255,.14)",
                  background: "rgba(4,18,34,.72)",
                  padding: "18px 18px 16px",
                }}
              >
                <div style={{ color: "white", fontWeight: 800, fontSize: 15 }}>{title}</div>
                <div style={{ color: "#8ea8ca", lineHeight: 1.6, fontSize: 13, marginTop: 10 }}>
                  {body}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          style={{
            borderRadius: 24,
            border: "1px solid rgba(0,216,255,.22)",
            background: "rgba(4,14,28,.92)",
            padding: 28,
            boxShadow: "0 0 45px rgba(0,100,220,.16)",
          }}
        >
          <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
            {[
              ["login", "Sign In"],
              ["register", "Create Access"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setFormError("");
                  clearError();
                  clearNotice();
                }}
                style={{
                  flex: 1,
                  borderRadius: 999,
                  border:
                    mode === value
                      ? "1px solid rgba(0,216,255,.42)"
                      : "1px solid rgba(0,216,255,.18)",
                  background: mode === value ? "rgba(0,136,255,.18)" : "rgba(0,136,255,.06)",
                  color: mode === value ? "#f4fbff" : "#9fb0c9",
                  padding: "11px 14px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              clearError();
              setFormError("");
              void signInWithGoogle().catch(() => {});
            }}
            disabled={isBusy}
            style={buildButtonStyle({ primary: true })}
          >
            Continue with Google
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              color: "#7d97b9",
              fontSize: 12,
              margin: "18px 0",
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            <div style={{ height: 1, flex: 1, background: "rgba(0,216,255,.14)" }} />
            or use email
            <div style={{ height: 1, flex: 1, background: "rgba(0,216,255,.14)" }} />
          </div>

          <form onSubmit={handleEmailSubmit} style={{ display: "grid", gap: 14 }}>
            {mode === "register" ? (
              <label style={{ display: "grid", gap: 7 }}>
                <span style={{ color: "#8fb1d9", fontSize: 12, fontWeight: 800 }}>Full name</span>
                <input
                  type="text"
                  value={form.fullName}
                  onChange={(event) => updateForm("fullName", event.target.value)}
                  placeholder="Workspace owner"
                  autoComplete="name"
                  style={buildInputStyle()}
                />
              </label>
            ) : null}

            <label style={{ display: "grid", gap: 7 }}>
              <span style={{ color: "#8fb1d9", fontSize: 12, fontWeight: 800 }}>Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => updateForm("email", event.target.value)}
                placeholder="you@forwardfreedomfinancial.com"
                autoComplete="email"
                style={buildInputStyle()}
              />
            </label>

            <label style={{ display: "grid", gap: 7 }}>
              <span style={{ color: "#8fb1d9", fontSize: 12, fontWeight: 800 }}>Password</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => updateForm("password", event.target.value)}
                placeholder={mode === "register" ? "Choose a secure password" : "Enter your password"}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                style={buildInputStyle()}
              />
            </label>

            {formError || error ? (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(255,93,122,.24)",
                  background: "rgba(255,36,77,.08)",
                  color: "#ffd9df",
                  padding: "12px 14px",
                  lineHeight: 1.5,
                }}
              >
                {formError || error}
              </div>
            ) : null}

            {notice ? (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(0,216,255,.22)",
                  background: "rgba(0,136,255,.10)",
                  color: "#dff7ff",
                  padding: "12px 14px",
                  lineHeight: 1.5,
                }}
              >
                {notice}
              </div>
            ) : null}

            <button type="submit" disabled={isBusy} style={buildButtonStyle({ primary: true })}>
              {isBusy
                ? "Working..."
                : mode === "register"
                  ? "Create Protected Access"
                  : "Enter Workspace"}
            </button>

            {mode === "login" ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  void handlePasswordReset();
                }}
                style={buildButtonStyle()}
              >
                Send Password Reset Email
              </button>
            ) : null}
          </form>

          <div style={{ marginTop: 18, color: "#7d97b9", fontSize: 12, lineHeight: 1.6 }}>
            By continuing, you confirm this workspace should move from prototype access toward
            authenticated production usage.
          </div>
        </section>
      </div>
    </div>
  );
}
