import { useState } from "react";
import { submitLegalConsent } from "../utils/legalConsent.js";
import { LegalModal } from "./LegalDocuments.jsx";

// Full-screen blocking gate shown to an authenticated user when server-side
// enforcement (H-9) reports that legal consent is missing or the accepted
// version is out of date. The app cannot be used until consent is recorded.
export function LegalConsentGate({ reason = "missing", onAccepted, user }) {
  const [agreed, setAgreed] = useState(false);
  const [activeDocument, setActiveDocument] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const headline =
    reason === "outdated"
      ? "We've updated our legal terms"
      : "Accept the Terms of Service and Privacy Policy";
  const body =
    reason === "outdated"
      ? "Our Terms of Service and Privacy Policy have changed since you last accepted them. Please review and accept the current version to continue using your workspace."
      : "To continue to your financial workspace, please review and accept the Terms of Service and Privacy Policy.";

  const handleAccept = async () => {
    if (!agreed) {
      setError("Review and accept the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setError("");
    setIsSubmitting(true);
    try {
      await submitLegalConsent({ method: reason === "outdated" ? "reconsent" : "gate" }, { user });
      onAccepted?.();
    } catch (submitError) {
      setError(
        submitError?.message ||
          "We couldn't record your acceptance just now. Please try again in a moment."
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 20% 20%, rgba(0,136,255,.24), transparent 24%), linear-gradient(180deg, #020711, #041121 72%, #030d1a)",
        color: "#eef6ff",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          borderRadius: 24,
          border: "1px solid rgba(0,216,255,.22)",
          background: "rgba(4,14,28,.94)",
          padding: 30,
          boxShadow: "0 0 45px rgba(0,100,220,.16)",
        }}
      >
        <div
          style={{
            color: "#8feaff",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          Legal consent required
        </div>
        <h1 style={{ margin: "12px 0 0", fontSize: 26, lineHeight: 1.2, color: "white" }}>
          {headline}
        </h1>
        <p style={{ marginTop: 14, color: "#b7c9de", fontSize: 15, lineHeight: 1.7 }}>{body}</p>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            color: "#c6d7ea",
            fontSize: 13,
            lineHeight: 1.6,
            marginTop: 20,
          }}
        >
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => {
              setAgreed(event.target.checked);
              if (error) setError("");
            }}
            style={{ marginTop: 3 }}
          />
          <span>
            I agree to the{" "}
            <button
              type="button"
              onClick={() => setActiveDocument("terms")}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
                padding: 0,
                fontWeight: 800,
              }}
            >
              Terms of Service
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => setActiveDocument("privacy")}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
                padding: 0,
                fontWeight: 800,
              }}
            >
              Privacy Policy
            </button>
            , including connected-account data handling through Plaid.
          </span>
        </label>

        {error ? (
          <div
            role="alert"
            style={{
              marginTop: 16,
              borderRadius: 12,
              border: "1px solid rgba(255,93,122,.24)",
              background: "rgba(255,36,77,.08)",
              color: "#ffd9df",
              padding: "12px 14px",
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            void handleAccept();
          }}
          disabled={isSubmitting}
          style={{
            marginTop: 20,
            width: "100%",
            borderRadius: 12,
            border: "1px solid rgba(120,220,255,.45)",
            background: "linear-gradient(90deg,#0077ff,#00d8ff)",
            color: "white",
            padding: "13px 16px",
            cursor: isSubmitting ? "default" : "pointer",
            fontWeight: 800,
            fontSize: 14,
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          {isSubmitting ? "Recording your acceptance..." : "Accept and continue"}
        </button>
      </div>
      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </div>
  );
}
