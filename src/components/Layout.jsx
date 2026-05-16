import { navMain, navTools } from "../data/constants.jsx";
import { styles } from "../styles.js";
import { HouseholdProfilesControl, SideItem } from "./Common.jsx";

export function AppSidebar({ activeTab, setActiveTab, onBackHome }) {
  return (
    <aside style={styles.sidebar}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
          <div
            style={{
              position: "relative",
              width: 210,
              height: 110,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ marginTop: -8, textAlign: "center" }}>
              <div
                style={{
                  color: "#f4f8ff",
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 8,
                  textTransform: "uppercase",
                }}
              >
                Forward
              </div>

              <div
                style={{
                  color: "#00aaff",
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 10,
                  marginTop: 2,
                  textTransform: "uppercase",
                  textShadow: "0 0 18px rgba(0,174,255,.55)",
                }}
              >
                Freedom
              </div>

              <div
                style={{
                  color: "#f4f8ff",
                  fontSize: 21,
                  fontWeight: 700,
                  letterSpacing: 8,
                  textTransform: "uppercase",
                }}
              >
                Financial
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          color: "#9fb0c9",
          textTransform: "uppercase",
          fontSize: 12,
          marginBottom: 16,
        }}
      >
        Main
      </div>
      {navMain.map((item) => (
        <SideItem key={item.label} item={item} activeTab={activeTab} setActiveTab={setActiveTab} />
      ))}

      <div
        style={{
          color: "#9fb0c9",
          textTransform: "uppercase",
          fontSize: 12,
          marginTop: 18,
          marginBottom: 16,
        }}
      >
        Tools
      </div>
      {navTools.map((item) => (
        <SideItem key={item.label} item={item} activeTab={activeTab} setActiveTab={setActiveTab} />
      ))}

      <button
        onClick={onBackHome}
        style={{
          width: "100%",
          marginTop: 24,
          marginBottom: 18,
          background: "linear-gradient(90deg, rgba(0,119,255,.18), rgba(0,216,255,.12))",
          border: "1px solid rgba(0,216,255,.28)",
          borderRadius: 10,
          padding: "14px 16px",
          color: "#eaf3ff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          cursor: "pointer",
          fontWeight: 800,
          letterSpacing: 0.4,
          boxShadow: "0 0 24px rgba(0,136,255,.18)",
        }}
      >
        <span style={{ fontSize: 18 }}>⌂</span>
        Back to Home
      </button>

      <div style={{ ...styles.panel, marginTop: 48, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{ color: "#00d8ff", fontSize: 34, textShadow: "0 0 12px rgba(0,216,255,.9)" }}
          >
            ◇
          </div>
          <div style={{ fontWeight: 800 }}>Forward Freedom PRIME</div>
        </div>
        <div style={{ color: "#c8d7ea", fontSize: 12, marginTop: 14 }}>All systems operational</div>
        <button
          style={{
            marginTop: 20,
            color: "#d9ecff",
            background: "rgba(0,108,255,.08)",
            border: "1px solid rgba(86,157,255,.28)",
            borderRadius: 6,
            padding: "10px 18px",
          }}
        >
          View Status
        </button>
      </div>
    </aside>
  );
}

export function ModulePlaceholder({ activeTab, householdProfilesProps }) {
  return (
    <div
      style={{
        ...styles.panel,
        minHeight: "78vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(circle at center, rgba(0,136,255,.12), transparent 55%)",
        }}
      />
      <div style={{ ...styles.pageHeader, position: "relative", zIndex: 1 }}>
        <div>
          <h1 style={styles.pageTitle}>{activeTab}</h1>
          <p style={styles.pageSubtitle}>Module initializing...</p>
        </div>
        <HouseholdProfilesControl {...householdProfilesProps} />
      </div>

      <div
        style={{
          position: "relative",
          textAlign: "center",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 72,
            color: "#00d8ff",
            textShadow: "0 0 25px rgba(0,216,255,.7)",
            marginBottom: 18,
          }}
        >
          ◈
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: "white", letterSpacing: 0.4 }}>
          {activeTab}
        </div>
        <div style={{ marginTop: 14, color: "#8faecc", fontSize: 16 }}>Module initializing...</div>
        <div
          style={{
            marginTop: 28,
            width: 260,
            height: 6,
            borderRadius: 999,
            background: "rgba(19,71,129,.4)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "42%",
              height: "100%",
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              boxShadow: "0 0 16px rgba(0,216,255,.8)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
