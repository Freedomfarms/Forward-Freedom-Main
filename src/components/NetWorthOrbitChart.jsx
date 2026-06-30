import { useEffect, useMemo, useState } from "react";
import { money, wholeDollars } from "../utils/format.js";

const SIZE = 240;
const CENTER = SIZE / 2;
const ARC_RADIUS = 96;
const ARC_STROKE = 16;
const TRACK_INNER_RADIUS = 70;
const SEGMENT_GAP_DEG = 4;
const TICK_INNER = ARC_RADIUS + ARC_STROKE / 2 + 2;
const TICK_OUTER = ARC_RADIUS + ARC_STROKE / 2 + 7;

function polar(deg, radius) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(a), y: CENTER + radius * Math.sin(a) };
}

function describeArc(startDeg, endDeg, radius) {
  const start = polar(startDeg, radius);
  const end = polar(endDeg, radius);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function NetWorthOrbitChart({ allocations }) {
  const sortedAllocations = useMemo(
    () =>
      [...allocations].sort(
        (a, b) => Number(b.valueNumber || 0) - Number(a.valueNumber || 0)
      ),
    [allocations]
  );

  const total = useMemo(
    () => allocations.reduce((sum, a) => sum + Number(a.valueNumber || 0), 0),
    [allocations]
  );

  const segments = useMemo(() => {
    if (total <= 0) return [];
    let current = 0;
    return allocations
      .filter((item) => Number(item.valueNumber || 0) > 0)
      .map((item) => {
        const fraction = Number(item.valueNumber) / total;
        const sweep = fraction * 360;
        const startDeg = current;
        const endDeg = current + sweep;
        const centerDeg = current + sweep / 2;
        current += sweep;
        return {
          ...item,
          fraction,
          sweep,
          startDeg,
          endDeg,
          centerDeg,
          percentNumber: fraction * 100,
        };
      });
  }, [allocations, total]);

  const defaultActive = useMemo(() => {
    const largest = sortedAllocations.find((item) => Number(item.valueNumber || 0) > 0);
    return largest?.name || sortedAllocations[0]?.name || "";
  }, [sortedAllocations]);

  const [activeName, setActiveName] = useState(defaultActive);
  const [flashToken, setFlashToken] = useState(0);

  useEffect(() => {
    setActiveName(defaultActive);
  }, [defaultActive]);

  const activeSegment =
    segments.find((s) => s.name === activeName) || segments[0] || null;
  const activeFallback =
    sortedAllocations.find((a) => a.name === activeName) || sortedAllocations[0];
  const activeData = activeSegment || {
    name: activeFallback?.name || "Net Worth",
    color: activeFallback?.color || "#8feaff",
    valueNumber: Number(activeFallback?.valueNumber || 0),
    percentNumber:
      total > 0 ? (Number(activeFallback?.valueNumber || 0) / total) * 100 : 0,
  };

  const focus = (name) => {
    setActiveName(name);
    setFlashToken((t) => t + 1);
  };

  const reset = () => {
    if (!defaultActive || activeName === defaultActive) return;
    setActiveName(defaultActive);
    setFlashToken((t) => t + 1);
  };

  return (
    <div style={{ width: "100%" }} className="net-worth-orbit-chart">
      <div onMouseLeave={reset}>
        <div className="net-worth-orbit-layout">
          <div className="net-worth-orbit-chart-cell">
            <div
              style={{
                position: "relative",
                width: SIZE,
                height: SIZE,
              }}
            >
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              style={{ position: "absolute", inset: 0, overflow: "visible" }}
            >
              <defs>
                <radialGradient id="net-worth-orbit-core" cx="35%" cy="30%" r="75%">
                  <stop offset="0%" stopColor="rgba(0,216,255,.10)" />
                  <stop offset="55%" stopColor="rgba(3,16,31,.92)" />
                  <stop offset="100%" stopColor="rgba(3,16,31,1)" />
                </radialGradient>
              </defs>

              <circle
                cx={CENTER}
                cy={CENTER}
                r={ARC_RADIUS}
                fill="none"
                stroke="rgba(0,136,255,.08)"
                strokeWidth={ARC_STROKE + 4}
              />

              {segments.map((seg, i) => {
                const inner = polar(seg.startDeg, TICK_INNER);
                const outer = polar(seg.startDeg, TICK_OUTER);
                return (
                  <line
                    key={`tick-${i}`}
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    stroke="rgba(120,160,210,.35)"
                    strokeWidth={1}
                  />
                );
              })}

              {segments.length > 0 ? (
                segments.map((seg) => {
                  const isActive = seg.name === activeName;
                  const useGap = seg.sweep > SEGMENT_GAP_DEG * 2 + 2;
                  const gap = useGap ? SEGMENT_GAP_DEG / 2 : 0;
                  const startDeg = seg.startDeg + gap;
                  const endDeg = seg.endDeg - gap;
                  const d = describeArc(startDeg, endDeg, ARC_RADIUS);
                  return (
                    <g
                      key={seg.name}
                      onMouseEnter={() => focus(seg.name)}
                      onClick={() => focus(seg.name)}
                      style={{ cursor: "pointer" }}
                    >
                      <path
                        d={d}
                        stroke="transparent"
                        strokeWidth={ARC_STROKE + 14}
                        strokeLinecap="butt"
                        fill="none"
                        pointerEvents="stroke"
                      />
                      <path
                        d={d}
                        stroke={seg.color}
                        strokeWidth={isActive ? ARC_STROKE + 4 : ARC_STROKE}
                        strokeLinecap="butt"
                        fill="none"
                        opacity={isActive ? 1 : 0.72}
                        pointerEvents="none"
                        style={{ transition: "stroke-width 160ms ease, opacity 160ms ease" }}
                      />
                      {isActive ? (
                        <path
                          d={d}
                          stroke="rgba(255,255,255,.85)"
                          strokeWidth={1.5}
                          strokeLinecap="butt"
                          fill="none"
                          pointerEvents="none"
                        />
                      ) : null}
                    </g>
                  );
                })
              ) : (
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={ARC_RADIUS}
                  fill="none"
                  stroke="rgba(120,160,210,.22)"
                  strokeWidth={ARC_STROKE}
                />
              )}

              <circle
                cx={CENTER}
                cy={CENTER}
                r={TRACK_INNER_RADIUS}
                fill="url(#net-worth-orbit-core)"
                stroke="rgba(120,160,210,.30)"
                strokeWidth={1}
              />
            </svg>

            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                pointerEvents: "none",
                padding: "0 22px",
              }}
            >
              <div
                style={{
                  color: activeData.color,
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                }}
              >
                {activeData.name}
              </div>
              <div
                key={`val-${flashToken}`}
                className="budget-orbit-metric-flash"
                style={{
                  color: "#ffffff",
                  fontSize: 24,
                  fontWeight: 900,
                  lineHeight: 1,
                  marginTop: 6,
                }}
              >
                {wholeDollars(Number(activeData.valueNumber || 0))}
              </div>
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 9,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                Of {wholeDollars(total)}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 9,
                  fontWeight: 900,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: activeData.color,
                  border: `1px solid ${activeData.color}66`,
                  background: `${activeData.color}14`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }}
              >
                {Math.round(activeData.percentNumber || 0)}% Share
              </div>
            </div>
          </div>
          </div>

          <div className="net-worth-orbit-category-list">
            {sortedAllocations.map((item) => {
              const value = Number(item.valueNumber || 0);
              const isZero = value <= 0;
              const isActive = item.name === activeName;
              const share = total > 0 ? Math.round((value / total) * 100) : 0;
              return (
                <button
                  key={item.name}
                  type="button"
                  disabled={isZero}
                  onMouseEnter={() => !isZero && focus(item.name)}
                  onFocus={() => !isZero && focus(item.name)}
                  onClick={() => !isZero && focus(item.name)}
                  className={`net-worth-orbit-category-item${isActive ? " is-active" : ""}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: isActive
                      ? `1px solid ${item.color}`
                      : "1px solid rgba(0,136,255,.12)",
                    background: isActive ? `${item.color}18` : "rgba(3,17,32,.42)",
                    opacity: isZero ? 0.45 : 1,
                    cursor: isZero ? "default" : "pointer",
                    transition: "all 140ms ease",
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: item.color,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      minWidth: 0,
                      color: isActive ? "#ffffff" : "#cfe2ff",
                      fontSize: 12,
                      fontWeight: 800,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        color: isActive ? "#ffffff" : "#8feaff",
                        fontSize: 12,
                        fontWeight: 900,
                      }}
                    >
                      {money(value)}
                    </span>
                    <span
                      style={{
                        color: isActive ? item.color : "#9fb6d6",
                        fontSize: 10,
                        fontWeight: 800,
                      }}
                    >
                      {share}%
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
