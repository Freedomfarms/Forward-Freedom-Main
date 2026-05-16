import { useState } from "react";
import forwardFreedomLogo from "../assets/forward-freedom-logo.svg";

const LEGAL_CONTENT = {
  terms: {
    title: "Terms of Service",
    updated: "May 2026",
    sections: [
      {
        heading: "Platform use",
        body: "Forward Freedom Financial provides planning tools, dashboards, and workspace features to help households organize financial information. The platform is intended for informational and workflow support purposes and does not replace legal, tax, accounting, or investment advice.",
      },
      {
        heading: "Account responsibility",
        body: "Users are responsible for maintaining accurate information, reviewing synced financial data, and securing access to their device and workspace. You agree not to misuse the platform, interfere with service operations, or attempt unauthorized access.",
      },
      {
        heading: "Financial decisions",
        body: "Any budgeting, debt planning, allocation, or forecasting decisions remain the user’s responsibility. You should review all recommendations, AI-based categorizations, and synced data before acting on them.",
      },
      {
        heading: "Service availability",
        body: "Features, integrations, and data providers may change over time. Some services depend on third-party providers such as Plaid, and availability may vary by institution, geography, and account type.",
      },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    updated: "May 2026",
    sections: [
      {
        heading: "Information collected",
        body: "The platform stores planning data you enter, such as budgets, income streams, transactions, and profile information. If enabled, connected financial institutions may also provide account and transaction data through third-party providers.",
      },
      {
        heading: "How data is used",
        body: "Your data is used to power dashboards, planning workflows, categorizations, and account-based features such as syncing, forecasting, and budgeting. User corrections may also improve future categorization behavior within that user’s own workspace.",
      },
      {
        heading: "Data sharing",
        body: "Forward Freedom Financial should limit data sharing to what is necessary to operate the service and approved integrations. Sensitive credentials and linked-account access tokens should never be exposed in the client application.",
      },
      {
        heading: "Review before launch",
        body: "This privacy content is a product-ready draft and should be reviewed with legal counsel before public launch, especially if you introduce production authentication, payments, or customer communications.",
      },
    ],
  },
};

function buildPrimaryButtonStyle(isSecondary = false) {
  return {
    color: "white",
    background: isSecondary ? "rgba(2,16,34,.62)" : "linear-gradient(90deg,#0077ff,#00aaff)",
    border: "1px solid rgba(125,220,255,.45)",
    borderRadius: 10,
    padding: "14px 20px",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 14,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    boxShadow: isSecondary ? "none" : "0 0 24px rgba(0,136,255,.32)",
  };
}

function LegalModal({ activeDocument, closeDocument }) {
  const document = activeDocument ? LEGAL_CONTENT[activeDocument] : null;
  if (!document) return null;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDocument();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20,
        background: "rgba(1,6,14,.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(860px, 100%)",
          maxHeight: "82vh",
          overflowY: "auto",
          borderRadius: 18,
          border: "1px solid rgba(0,174,255,.24)",
          background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
          boxShadow: "0 0 50px rgba(0,136,255,.22)",
          padding: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            alignItems: "flex-start",
            marginBottom: 24,
          }}
        >
          <div>
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.4,
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              Legal Center
            </div>
            <h2 style={{ margin: "8px 0 0", color: "white", fontSize: 30 }}>{document.title}</h2>
            <div style={{ color: "#9fb0c9", marginTop: 6 }}>Last updated {document.updated}</div>
          </div>
          <button onClick={closeDocument} style={buildPrimaryButtonStyle(true)}>
            Close
          </button>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          {document.sections.map((section) => (
            <div
              key={section.heading}
              style={{
                border: "1px solid rgba(0,136,255,.18)",
                borderRadius: 14,
                background: "rgba(3,17,32,.66)",
                padding: "18px 20px",
              }}
            >
              <div
                style={{
                  color: "white",
                  fontWeight: 800,
                  fontSize: 18,
                  marginBottom: 10,
                }}
              >
                {section.heading}
              </div>
              <div style={{ color: "#c6d2e1", lineHeight: 1.7, fontSize: 15 }}>{section.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LandingPage({ enterApp }) {
  const [activeDocument, setActiveDocument] = useState(null);
  const [createAccount, setCreateAccount] = useState({
    fullName: "",
    email: "",
    agreedToTerms: false,
  });
  const [createError, setCreateError] = useState("");

  const updateCreateAccount = (field, value) => {
    setCreateAccount((current) => ({ ...current, [field]: value }));
  };

  const handleCreateAccount = (event) => {
    event.preventDefault();

    if (!createAccount.fullName.trim()) {
      setCreateError("Enter your full name to create your workspace.");
      return;
    }

    if (!createAccount.email.trim() || !/\S+@\S+\.\S+/.test(createAccount.email.trim())) {
      setCreateError("Enter a valid email address.");
      return;
    }

    if (!createAccount.agreedToTerms) {
      setCreateError("You need to agree to the Terms of Service and Privacy Policy to continue.");
      return;
    }

    setCreateError("");
    enterApp({
      mode: "create-account",
      primaryUserName: createAccount.fullName.trim(),
      email: createAccount.email.trim(),
    });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
        overflow: "hidden",
        padding: "28px 56px 60px",
        background: "#020711",
        color: "#eef6ff",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 76% 18%, rgba(0,136,255,.32), transparent 30%), radial-gradient(circle at 64% 52%, rgba(0,216,255,.18), transparent 18%), linear-gradient(90deg, rgba(0,0,0,.92) 0%, rgba(0,0,0,.46) 43%, rgba(0,0,0,.26) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 72,
          top: 112,
          width: 540,
          height: 540,
          borderRadius: "50%",
          background: "radial-gradient(circle at center, rgba(22,110,255,.22), rgba(2,7,17,0) 62%)",
          filter: "blur(8px)",
          opacity: 0.82,
        }}
      />

      <div style={{ position: "relative", zIndex: 2 }}>
        <nav
          style={{
            display: "grid",
            gridTemplateColumns: "280px 1fr auto",
            alignItems: "center",
            marginBottom: 108,
            gap: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <img
              src={forwardFreedomLogo}
              alt="Forward Freedom Financial logo"
              style={{
                width: 214,
                maxWidth: "100%",
                filter: "drop-shadow(0 0 18px rgba(0,136,255,.28))",
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 30,
              color: "#f5f7fb",
              fontSize: 14,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            <a href="#home" style={{ color: "white", textDecoration: "none" }}>
              Home
            </a>
            <a href="#account-access" style={{ color: "#cfe7ff", textDecoration: "none" }}>
              Access
            </a>
            <a href="#legal" style={{ color: "#cfe7ff", textDecoration: "none" }}>
              Legal
            </a>
            <a href="#contact" style={{ color: "#cfe7ff", textDecoration: "none" }}>
              Contact
            </a>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14 }}
          >
            <button onClick={enterApp} style={buildPrimaryButtonStyle(true)}>
              Client Login
            </button>
            <a href="#account-access" style={{ textDecoration: "none" }}>
              <button style={buildPrimaryButtonStyle()}>Create Account</button>
            </a>
          </div>
        </nav>

        <section
          id="home"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 460px)",
            gap: 36,
            alignItems: "start",
            marginBottom: 42,
          }}
        >
          <div style={{ maxWidth: 700 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                color: "#00aaff",
                fontSize: 36,
                fontWeight: 900,
                letterSpacing: 10,
                textTransform: "uppercase",
                marginBottom: 24,
                textShadow: "0 0 24px rgba(0,170,255,.55)",
              }}
            >
              Forward Freedom Financial
              <span
                style={{
                  width: 180,
                  height: 1,
                  background: "linear-gradient(90deg,#00aaff,transparent)",
                }}
              />
            </div>

            <p
              style={{
                color: "#f0f4fb",
                fontSize: 20,
                lineHeight: 1.65,
                maxWidth: 620,
                margin: "18px 0 30px",
              }}
            >
              Build a client workspace, return to your saved dashboard, and review the legal terms
              that govern account access, planning data, and connected financial tools.
            </p>

            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <a href="#account-access" style={{ textDecoration: "none" }}>
                <button style={{ ...buildPrimaryButtonStyle(), minWidth: 220 }}>
                  Create Account
                </button>
              </a>
              <button
                onClick={enterApp}
                style={{ ...buildPrimaryButtonStyle(true), minWidth: 220 }}
              >
                Client Login
              </button>
              <button
                onClick={() => setActiveDocument("terms")}
                style={{ ...buildPrimaryButtonStyle(true), minWidth: 220 }}
              >
                Review Terms
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 430,
              padding: 8,
            }}
          >
            <img
              src={forwardFreedomLogo}
              alt="Forward Freedom Financial logo"
              style={{
                width: "100%",
                maxWidth: 500,
                filter:
                  "drop-shadow(0 0 18px rgba(0,136,255,.36)) drop-shadow(0 0 42px rgba(0,98,255,.2))",
              }}
            />
          </div>
        </section>

        <section
          style={{
            border: "1px solid rgba(0,136,255,.28)",
            background: "rgba(3,17,32,.68)",
            borderRadius: 10,
            padding: "30px 36px 34px",
            boxShadow: "inset 0 0 42px rgba(0,70,150,.11)",
            marginBottom: 30,
          }}
        >
          <div
            style={{
              color: "#8feaff",
              textTransform: "uppercase",
              letterSpacing: 1.8,
              fontSize: 12,
              fontWeight: 900,
              marginBottom: 16,
            }}
          >
            Our Mission
          </div>
          <div style={{ color: "white", fontSize: 34, lineHeight: 1.18, fontWeight: 800 }}>
            Moving Forward with <span style={{ color: "#00aaff" }}>Financial Freedom</span>
          </div>
          <div
            style={{
              maxWidth: 1080,
              color: "#d6e2f0",
              fontSize: 17,
              lineHeight: 1.85,
              marginTop: 18,
            }}
          >
            <p style={{ margin: 0 }}>
              Forward Freedom Financial exists to help people build unshakable financial foundations
              through discipline, wisdom, and action.
            </p>
            <p style={{ margin: "18px 0 0" }}>
              We believe financial leadership requires a wartime mindset: scanning the battlefield,
              taking ownership, protecting and providing your family, and advancing with purpose no
              matter the economic battlefield.
            </p>
            <p style={{ margin: "18px 0 0" }}>
              Our mission is to turn fear into strategy, debt into freedom, and money into a tool
              that empowers people to live boldly, give generously, and lead with conviction.
            </p>
          </div>
        </section>

        <section
          id="account-access"
          style={{
            display: "grid",
            gridTemplateColumns: "1.15fr .85fr",
            gap: 22,
            marginBottom: 30,
          }}
        >
          <form
            onSubmit={handleCreateAccount}
            style={{
              border: "1px solid rgba(0,136,255,.24)",
              borderRadius: 14,
              background: "rgba(3,17,32,.82)",
              padding: 26,
              boxShadow: "inset 0 0 34px rgba(0,70,150,.08)",
            }}
          >
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.2,
                fontWeight: 900,
                fontSize: 12,
                marginBottom: 10,
              }}
            >
              Create Account
            </div>
            <div style={{ color: "white", fontSize: 28, fontWeight: 900 }}>
              Open a new workspace
            </div>
            <p style={{ color: "#bcd1e8", lineHeight: 1.65, marginTop: 12, maxWidth: 640 }}>
              Start a private planning workspace for your household. This version launches a fresh
              local client workspace on this device so you can begin budgeting, forecasting, and
              account setup immediately.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 14,
                marginTop: 18,
              }}
            >
              <label style={{ display: "grid", gap: 8 }}>
                <span style={{ color: "#8fb1d9", fontSize: 12, fontWeight: 800 }}>Full Name</span>
                <input
                  value={createAccount.fullName}
                  onChange={(event) => updateCreateAccount("fullName", event.target.value)}
                  placeholder="Enter your full name"
                  style={{
                    color: "#eaf3ff",
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.18)",
                    borderRadius: 10,
                    padding: "12px 14px",
                    outline: "none",
                  }}
                />
              </label>
              <label style={{ display: "grid", gap: 8 }}>
                <span style={{ color: "#8fb1d9", fontSize: 12, fontWeight: 800 }}>
                  Email Address
                </span>
                <input
                  value={createAccount.email}
                  onChange={(event) => updateCreateAccount("email", event.target.value)}
                  placeholder="name@example.com"
                  style={{
                    color: "#eaf3ff",
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.18)",
                    borderRadius: 10,
                    padding: "12px 14px",
                    outline: "none",
                  }}
                />
              </label>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                marginTop: 18,
                color: "#d5e2f2",
                lineHeight: 1.6,
              }}
            >
              <input
                type="checkbox"
                checked={createAccount.agreedToTerms}
                onChange={(event) => updateCreateAccount("agreedToTerms", event.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span>
                I agree to the{" "}
                <button
                  type="button"
                  onClick={() => setActiveDocument("terms")}
                  style={{
                    color: "#8feaff",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  Terms of Service
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => setActiveDocument("privacy")}
                  style={{
                    color: "#8feaff",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  Privacy Policy
                </button>
                .
              </span>
            </label>

            {createError ? (
              <div
                style={{
                  marginTop: 14,
                  color: "#ff9a76",
                  border: "1px solid rgba(255,154,118,.18)",
                  background: "rgba(62,16,9,.24)",
                  borderRadius: 10,
                  padding: "10px 12px",
                }}
              >
                {createError}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 22 }}>
              <button type="submit" style={buildPrimaryButtonStyle()}>
                Create Account
              </button>
              <button type="button" onClick={enterApp} style={buildPrimaryButtonStyle(true)}>
                Skip to Client Workspace
              </button>
            </div>
          </form>

          <div
            style={{
              border: "1px solid rgba(0,136,255,.18)",
              borderRadius: 14,
              background: "linear-gradient(180deg, rgba(5,19,37,.92), rgba(2,10,21,.86))",
              padding: 24,
            }}
          >
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.2,
                fontWeight: 900,
                fontSize: 12,
                marginBottom: 10,
              }}
            >
              Client Login
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900 }}>
              Return to your workspace
            </div>
            <p style={{ color: "#c6d2e1", lineHeight: 1.65, marginTop: 12 }}>
              Existing clients can continue into the planning workspace saved on this device and
              review linked accounts, budgets, forecast plans, and household profiles.
            </p>
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {[
                "Resume planning and budgeting",
                "Review synced accounts and transactions",
                "Continue household profile setup",
              ].map((item) => (
                <div
                  key={item}
                  style={{
                    border: "1px solid rgba(0,136,255,.14)",
                    borderRadius: 12,
                    background: "rgba(3,17,32,.58)",
                    padding: "12px 14px",
                    color: "#d9e8f8",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
            <button
              onClick={enterApp}
              style={{ ...buildPrimaryButtonStyle(), marginTop: 22, width: "100%" }}
            >
              Client Login
            </button>
          </div>
        </section>

        <section
          id="legal"
          style={{
            border: "1px solid rgba(0,136,255,.18)",
            background: "linear-gradient(90deg, rgba(3,17,32,.86), rgba(3,17,32,.45))",
            borderRadius: 10,
            padding: "24px 32px",
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 18,
            marginBottom: 30,
          }}
        >
          {Object.entries(LEGAL_CONTENT).map(([key, document]) => (
            <div
              key={key}
              style={{
                border: "1px solid rgba(0,136,255,.16)",
                borderRadius: 14,
                background: "rgba(3,17,32,.64)",
                padding: 20,
              }}
            >
              <div
                style={{
                  color: "#8feaff",
                  textTransform: "uppercase",
                  letterSpacing: 1.1,
                  fontWeight: 900,
                  fontSize: 12,
                }}
              >
                {document.updated}
              </div>
              <div style={{ color: "white", fontSize: 24, fontWeight: 900, marginTop: 10 }}>
                {document.title}
              </div>
              <div style={{ color: "#c6d2e1", lineHeight: 1.65, marginTop: 12 }}>
                {document.sections[0].body}
              </div>
              <button
                onClick={() => setActiveDocument(key)}
                style={{ ...buildPrimaryButtonStyle(true), marginTop: 18 }}
              >
                View Full {document.title}
              </button>
            </div>
          ))}
        </section>

        <section
          id="contact"
          style={{
            border: "1px solid rgba(0,136,255,.18)",
            background: "rgba(3,17,32,.58)",
            borderRadius: 14,
            padding: "24px 32px",
            marginBottom: 26,
          }}
        >
          <div
            style={{
              color: "#8feaff",
              textTransform: "uppercase",
              letterSpacing: 1.2,
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            Contact & Footer
          </div>
          <div style={{ color: "white", fontSize: 28, fontWeight: 900, marginTop: 10 }}>
            Support, onboarding, and legal review
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 16,
              marginTop: 20,
            }}
          >
            {[
              [
                "Client onboarding",
                "Guide new households into planning, account setup, and their first budgeting workflow.",
              ],
              [
                "Policy questions",
                "Make terms, privacy, and connected-account disclosures easy to review before launch.",
              ],
              [
                "Workspace support",
                "Help returning clients access their saved planning workspace and continue with confidence.",
              ],
            ].map(([title, text]) => (
              <div
                key={title}
                style={{
                  border: "1px solid rgba(0,136,255,.16)",
                  borderRadius: 14,
                  background: "rgba(2,12,24,.64)",
                  padding: "18px 18px 20px",
                }}
              >
                <div style={{ color: "white", fontWeight: 900, fontSize: 18 }}>{title}</div>
                <div style={{ color: "#c6d2e1", lineHeight: 1.65, marginTop: 10 }}>{text}</div>
              </div>
            ))}
          </div>
        </section>

        <footer
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
            borderTop: "1px solid rgba(0,136,255,.18)",
            paddingTop: 20,
            color: "#8faecc",
            fontSize: 13,
          }}
        >
          <div>© 2026 Forward Freedom Financial. All rights reserved.</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <button
              onClick={() => setActiveDocument("terms")}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
              }}
            >
              Terms of Service
            </button>
            <button
              onClick={() => setActiveDocument("privacy")}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
              }}
            >
              Privacy Policy
            </button>
            <a href="#account-access" style={{ color: "#8feaff", textDecoration: "none" }}>
              Create Account
            </a>
            <button
              onClick={enterApp}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
              }}
            >
              Client Login
            </button>
          </div>
        </footer>
      </div>

      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </div>
  );
}
