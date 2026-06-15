const SIZE_PRESETS = {
  nav: {
    diameter: 96,
    white: 8,
    freedom: 12,
    forwardLetterSpacing: 3,
    freedomLetterSpacing: 3.2,
    financialLetterSpacing: 1.5,
    gap: 2,
    ringWidth: 2,
    sweepWidth: 2,
  },
  hero: {
    diameter: 320,
    white: 26,
    freedom: 40,
    forwardLetterSpacing: 14,
    freedomLetterSpacing: 12,
    financialLetterSpacing: 7,
    gap: 6,
    ringWidth: 3,
    sweepWidth: 3,
  },
};

export function ForwardFreedomWordmark({ size = "nav", className = "" }) {
  const preset = SIZE_PRESETS[size] || SIZE_PRESETS.nav;
  const diameter = preset.diameter;
  const isHero = size === "hero";
  const arrowSize = isHero ? 6 : 3;

  const ringMask = `radial-gradient(farthest-side, transparent calc(100% - ${preset.sweepWidth}px), #000 calc(100% - ${preset.sweepWidth}px))`;

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
      {/* Pulsing core halo */}
      <div
        aria-hidden="true"
        className="ff-logo-halo"
        style={{
          position: "absolute",
          inset: "-6%",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 42%, rgba(0,170,255,.34), rgba(0,110,230,.14) 38%, rgba(2,7,17,0) 70%)",
          filter: "blur(6px)",
        }}
      />

      {/* Faint outer rim */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: isHero ? "2%" : "4%",
          borderRadius: "50%",
          border: "1px solid rgba(0,174,255,.30)",
          boxShadow: "0 0 32px rgba(0,136,255,.28), inset 0 0 26px rgba(0,136,255,.10)",
        }}
      />

      {/* Rotating glow sweep (primary) */}
      <div
        aria-hidden="true"
        className="ff-logo-sweep"
        style={{
          position: "absolute",
          inset: isHero ? "6%" : "8%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 0deg, rgba(0,216,255,0) 0deg, rgba(0,216,255,0) 232deg, rgba(0,176,255,.7) 300deg, rgba(140,244,255,1) 350deg, rgba(0,216,255,0) 360deg)",
          WebkitMask: ringMask,
          mask: ringMask,
          filter: "drop-shadow(0 0 6px rgba(0,216,255,.75))",
        }}
      />

      {/* Arrowhead riding the leading edge of the spinning arc (clockwise / forward) */}
      <div
        aria-hidden="true"
        className="ff-logo-sweep"
        style={{
          position: "absolute",
          inset: isHero ? "6%" : "8%",
          borderRadius: "50%",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 0,
            height: 0,
            borderTop: `${arrowSize}px solid transparent`,
            borderBottom: `${arrowSize}px solid transparent`,
            borderLeft: `${arrowSize * 1.6}px solid #b6efff`,
            filter: "drop-shadow(0 0 5px rgba(0,216,255,.95))",
          }}
        />
      </div>

      {/* Counter-rotating glow sweep (secondary, dimmer) */}
      <div
        aria-hidden="true"
        className="ff-logo-sweep--slow"
        style={{
          position: "absolute",
          inset: isHero ? "11%" : "12%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 180deg, rgba(0,136,255,0) 0deg, rgba(0,136,255,0) 280deg, rgba(0,136,255,.55) 340deg, rgba(0,136,255,0) 360deg)",
          WebkitMask: ringMask,
          mask: ringMask,
        }}
      />

      {/* Inner dashed tick ring (rotating) */}
      <div
        aria-hidden="true"
        className="ff-logo-ring-dashed"
        style={{
          position: "absolute",
          inset: isHero ? "15%" : "16%",
          borderRadius: "50%",
          border: "1px dashed rgba(125,220,255,.26)",
        }}
      />

      {/* Forward-moving light sweep (left -> right), clipped to the disc */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: isHero ? "2%" : "4%",
          borderRadius: "50%",
          overflow: "hidden",
        }}
      >
        <div
          className="ff-logo-shine"
          style={{
            position: "absolute",
            top: "-10%",
            bottom: "-10%",
            width: "42%",
            transform: "skewX(-16deg)",
            background:
              "linear-gradient(100deg, rgba(140,220,255,0) 0%, rgba(150,225,255,.22) 50%, rgba(140,220,255,0) 100%)",
          }}
        />
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          lineHeight: 1.08,
          userSelect: "none",
        }}
      >
        <div
          style={{
            color: "#f4f8ff",
            fontSize: preset.white,
            fontWeight: 800,
            letterSpacing: preset.forwardLetterSpacing,
            textTransform: "uppercase",
            textShadow: "0 0 12px rgba(140,200,255,.35)",
          }}
        >
          Forward
        </div>
        <div
          style={{
            fontSize: preset.freedom,
            fontWeight: 900,
            letterSpacing: preset.freedomLetterSpacing,
            margin: `${preset.gap}px 0`,
            textTransform: "uppercase",
            backgroundImage:
              "linear-gradient(180deg, #aef0ff 0%, #2bb8ff 48%, #0066d6 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            WebkitTextFillColor: "transparent",
            filter: "drop-shadow(0 0 18px rgba(0,174,255,.65))",
          }}
        >
          Freedom
        </div>
        <div
          style={{
            color: "#f4f8ff",
            fontSize: preset.white,
            fontWeight: 800,
            letterSpacing: preset.financialLetterSpacing,
            textTransform: "uppercase",
            textShadow: "0 0 12px rgba(140,200,255,.35)",
          }}
        >
          Financial
        </div>
      </div>
    </div>
  );
}
