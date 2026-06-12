const SIZE_PRESETS = {
  nav: {
    diameter: 96,
    forward: 9,
    freedom: 12,
    financial: 8,
    letterSpacing: 2.8,
    freedomLetterSpacing: 3.2,
    gap: 1,
  },
  hero: {
    diameter: 320,
    forward: 30,
    freedom: 40,
    financial: 22,
    letterSpacing: 10,
    freedomLetterSpacing: 12,
    gap: 4,
  },
};

export function ForwardFreedomWordmark({ size = "nav", className = "" }) {
  const preset = SIZE_PRESETS[size] || SIZE_PRESETS.nav;
  const diameter = preset.diameter;

  return (
    <div
      className={className}
      aria-label="Forward Freedom Financial"
      role="img"
      style={{
        position: "relative",
        width: diameter,
        height: diameter,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 38%, rgba(0,136,255,.16), rgba(2,7,17,0) 68%)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: size === "hero" ? "2%" : "4%",
          borderRadius: "50%",
          border: "1px solid rgba(0,174,255,.28)",
          boxShadow:
            "0 0 28px rgba(0,136,255,.22), inset 0 0 24px rgba(0,136,255,.08)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: size === "hero" ? "8%" : "10%",
          borderRadius: "50%",
          border: "2px solid transparent",
          borderTopColor: "rgba(0,216,255,.85)",
          borderRightColor: "rgba(0,136,255,.45)",
          borderBottomColor: "rgba(0,80,180,.12)",
          transform: "rotate(-28deg)",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: size === "hero" ? "14%" : "16%",
          borderRadius: "50%",
          border: "1px dashed rgba(125,220,255,.22)",
          transform: "rotate(18deg)",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          lineHeight: 1.05,
          userSelect: "none",
        }}
      >
        <div
          style={{
            color: "#f4f8ff",
            fontSize: preset.forward,
            fontWeight: 800,
            letterSpacing: preset.letterSpacing,
            textTransform: "uppercase",
          }}
        >
          Forward
        </div>
        <div
          style={{
            color: "#00aaff",
            fontSize: preset.freedom,
            fontWeight: 900,
            letterSpacing: preset.freedomLetterSpacing,
            marginTop: preset.gap,
            textTransform: "uppercase",
            textShadow: "0 0 18px rgba(0,174,255,.55)",
          }}
        >
          Freedom
        </div>
        <div
          style={{
            color: "#f4f8ff",
            fontSize: preset.financial,
            fontWeight: 800,
            letterSpacing: preset.letterSpacing,
            marginTop: preset.gap,
            textTransform: "uppercase",
          }}
        >
          Financial
        </div>
      </div>
    </div>
  );
}
