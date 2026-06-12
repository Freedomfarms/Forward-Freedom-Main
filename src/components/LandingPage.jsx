import { useState } from "react";
import forwardFreedomLogo from "../assets/forward-freedom-logo-main.jpeg";
import { LegalModal } from "./LegalDocuments.jsx";

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

const CREATE_ACCESS_POINTS = [
  "Build a protected Forward Freedom workspace",
  "See budgets, transactions, and forecasts together",
  "Start with a cleaner command-center experience",
];

const LOGIN_POINTS = [
  "Resume planning and budgeting",
  "Review synced accounts and transactions",
  "Continue household profile setup",
];

const CONTACT_CARDS = [
  [
    "Client onboarding",
    "Guide new households into planning, account setup, and their first budgeting workflow.",
  ],
  [
    "Email support",
    "Reach Forward Freedom Financial directly when you need help or want a guided next step.",
  ],
  [
    "Workspace support",
    "Help returning clients access their saved planning workspace and continue with confidence.",
  ],
];

export function LandingPage({ enterApp, onEnterDemo }) {
  const [activeDocument, setActiveDocument] = useState(null);
  const openCreateAccess = () => enterApp({ mode: "create-account" });
  const openDemoMode = () => {
    if (typeof onEnterDemo === "function") {
      onEnterDemo();
    }
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
            gridTemplateColumns: "minmax(180px, 228px) 1fr auto",
            alignItems: "center",
            marginBottom: 84,
            gap: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", minHeight: 88 }}>
            <img
              src={forwardFreedomLogo}
              alt="Forward Freedom Financial logo"
              width={96}
              height={96}
              decoding="async"
              fetchPriority="high"
              style={{
                width: 96,
                height: 96,
                display: "block",
                objectFit: "cover",
                objectPosition: "center",
                borderRadius: 24,
                border: "1px solid rgba(125,220,255,.32)",
                boxShadow: "0 18px 36px rgba(0, 0, 0, 0.34), 0 0 30px rgba(0, 136, 255, 0.12)",
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
            <button
              type="button"
              onClick={() => setActiveDocument("terms")}
              style={{
                color: "#cfe7ff",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              LEGAL
            </button>
            <a href="#contact" style={{ color: "#cfe7ff", textDecoration: "none" }}>
              Contact
            </a>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14 }}
          >
            {typeof onEnterDemo === "function" ? (
              <button onClick={openDemoMode} style={buildPrimaryButtonStyle(true)}>
                Enter Demo Mode
              </button>
            ) : null}
            <button onClick={enterApp} style={buildPrimaryButtonStyle(true)}>
              Client Login
            </button>
            <button onClick={openCreateAccess} style={buildPrimaryButtonStyle()}>
              Create Access
            </button>
          </div>
        </nav>

        <section
          id="home"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 500px)",
            gap: 40,
            alignItems: "center",
            marginBottom: 40,
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
              Forward Freedom Financial is a financial command center that gives you complete
              visibility and control of your money. Track, plan, and execute with confidence using
              real-time data, forecasting, and powerful financial insights.
            </p>

            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <button onClick={openCreateAccess} style={{ ...buildPrimaryButtonStyle(), minWidth: 220 }}>
                Create Access
              </button>
              {typeof onEnterDemo === "function" ? (
                <button
                  onClick={openDemoMode}
                  style={{ ...buildPrimaryButtonStyle(true), minWidth: 220 }}
                >
                  Enter Demo Mode
                </button>
              ) : null}
              <button
                onClick={enterApp}
                style={{ ...buildPrimaryButtonStyle(true), minWidth: 220 }}
              >
                Client Login
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              justifySelf: "center",
              width: "100%",
              minHeight: 460,
              padding: "8px 0",
            }}
          >
            <div
              style={{
                position: "relative",
                width: "100%",
                maxWidth: 520,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                isolation: "isolate",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: "4%",
                  background:
                    "radial-gradient(circle at 50% 42%, rgba(7,166,255,.3) 0%, rgba(5,96,214,.18) 32%, rgba(2,7,17,0) 74%)",
                  filter: "blur(34px)",
                  opacity: 0.92,
                  transform: "scale(1.02)",
                }}
              />
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: "11%",
                  backgroundImage: `url(${forwardFreedomLogo})`,
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                  backgroundSize: "cover",
                  opacity: 0.3,
                  filter: "blur(44px) saturate(1.1)",
                  transform: "scale(1.06)",
                  borderRadius: 36,
                }}
              />
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  width: "100%",
                  padding: 20,
                  borderRadius: 36,
                  border: "1px solid rgba(125,220,255,.16)",
                  background:
                    "linear-gradient(180deg, rgba(8, 20, 38, 0.94), rgba(5, 15, 29, 0.84))",
                  boxShadow:
                    "0 28px 70px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
                }}
              >
                <img
                  src={forwardFreedomLogo}
                  alt="Forward Freedom Financial logo"
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    aspectRatio: "1 / 1",
                    display: "block",
                    margin: "0 auto",
                    objectFit: "cover",
                    objectPosition: "center",
                    borderRadius: 28,
                    filter: "saturate(1.03) contrast(1.02)",
                  }}
                />
              </div>
            </div>
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
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 22,
            marginBottom: 30,
          }}
        >
          <div
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
              Create Access
            </div>
            <div style={{ color: "white", fontSize: 28, fontWeight: 900 }}>
              Start a new workspace
            </div>
            <p style={{ color: "#bcd1e8", lineHeight: 1.65, marginTop: 12, maxWidth: 640 }}>
              Create protected access and begin building your financial command center with
              budgeting, forecasting, account visibility, and a clearer picture of where your money
              is going.
            </p>
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {CREATE_ACCESS_POINTS.map((item) => (
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
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 22 }}>
              <button type="button" onClick={openCreateAccess} style={buildPrimaryButtonStyle()}>
                Create Access
              </button>
            </div>
          </div>

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
              Existing clients can jump straight back into their command center to review accounts,
              transactions, budgets, forecasts, and household progress.
            </p>
            <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
              {LOGIN_POINTS.map((item) => (
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
            <div style={{ display: "grid", gap: 12, marginTop: 22 }}>
              {typeof onEnterDemo === "function" ? (
                <button onClick={openDemoMode} style={{ ...buildPrimaryButtonStyle(true), width: "100%" }}>
                  Enter Demo Mode
                </button>
              ) : null}
              <button onClick={enterApp} style={{ ...buildPrimaryButtonStyle(), width: "100%" }}>
                Client Login
              </button>
            </div>
          </div>
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
            Support and onboarding
          </div>
          <div style={{ color: "#c6d2e1", lineHeight: 1.7, marginTop: 12, maxWidth: 760 }}>
            For support, onboarding assistance, or policy questions, please contact Forward Freedom
            Financial at{' '}
            <a
              href="mailto:forwardfreedomfinancial@gmail.com"
              style={{ color: "#8feaff", textDecoration: "none", fontWeight: 700 }}
            >
              forwardfreedomfinancial@gmail.com
            </a>
            .
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 16,
              marginTop: 20,
            }}
          >
            {CONTACT_CARDS.map(([title, text]) => (
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
                fontWeight: 800,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              TERMS OF SERVICE
            </button>
            <button
              onClick={() => setActiveDocument("privacy")}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
                fontWeight: 800,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              PRIVACY POLICY
            </button>
            <button
              onClick={openCreateAccess}
              style={{
                background: "transparent",
                border: "none",
                color: "#8feaff",
                cursor: "pointer",
              }}
            >
              Create Access
            </button>
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
