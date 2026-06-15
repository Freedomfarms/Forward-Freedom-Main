import { useState } from "react";
import { ForwardFreedomWordmark } from "./ForwardFreedomWordmark.jsx";
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
        padding: "24px 56px 36px",
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
        <section
          id="home"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 500px)",
            gap: 32,
            alignItems: "center",
            marginBottom: 28,
          }}
        >
          <div style={{ maxWidth: 700 }}>
            <p
              style={{
                color: "#f0f4fb",
                fontSize: 20,
                lineHeight: 1.6,
                maxWidth: 620,
                margin: "0 0 24px",
              }}
            >
              Forward Freedom Financial is a financial command center that gives you complete
              visibility and control of your money. Track, plan, and execute with confidence using
              real-time data, forecasting, and powerful financial insights.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 220px))",
                gap: 18,
              }}
            >
              <button onClick={openCreateAccess} style={buildPrimaryButtonStyle()}>
                Create Access
              </button>
              <button onClick={enterApp} style={buildPrimaryButtonStyle(true)}>
                Client Login
              </button>
              {typeof onEnterDemo === "function" ? (
                <button onClick={openDemoMode} style={buildPrimaryButtonStyle(true)}>
                  Demo Mode
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => setActiveDocument("security")}
                style={buildPrimaryButtonStyle(true)}
              >
                Security &amp; Privacy
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
              minHeight: 300,
              padding: "4px 0",
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
                style={{
                  position: "relative",
                zIndex: 1,
                width: "100%",
                padding: "28px 24px",
                borderRadius: 36,
                  border: "1px solid rgba(125,220,255,.16)",
                  background:
                    "linear-gradient(180deg, rgba(8, 20, 38, 0.94), rgba(5, 15, 29, 0.84))",
                  boxShadow:
                    "0 28px 70px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
                  display: "flex",
                  alignItems: "center",
                justifyContent: "center",
                minHeight: 260,
              }}
            >
              <ForwardFreedomWordmark size="hero" />
              </div>
            </div>
          </div>
        </section>

        <section
          style={{
            border: "1px solid rgba(0,136,255,.28)",
            background: "rgba(3,17,32,.68)",
            borderRadius: 10,
            padding: "24px 32px 26px",
            boxShadow: "inset 0 0 42px rgba(0,70,150,.11)",
            marginBottom: 22,
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
              color: "#d6e2f0",
              fontSize: 17,
              lineHeight: 1.7,
              marginTop: 12,
            }}
          >
            Turning fear into strategy, debt into freedom, and money into a tool for bold living.
          </div>
        </section>

        <section
          id="contact"
          style={{
            border: "1px solid rgba(0,136,255,.18)",
            background: "rgba(3,17,32,.58)",
            borderRadius: 14,
            padding: "24px 32px",
            marginBottom: 22,
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
            Contact
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
          </div>
        </footer>
      </div>

      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </div>
  );
}
