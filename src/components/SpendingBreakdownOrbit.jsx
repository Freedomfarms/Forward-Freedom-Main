import { useEffect, useMemo, useState } from "react";
import { wholeDollars } from "../utils/format.js";

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

export function SpendingBreakdownOrbit({ categories, activeCategoryId, onSelectCategory }) {
  const spendingCategories = useMemo(
    () =>
      categories
        .filter((item) => item.id !== "all-spending")
        .map((item) => ({
          id: item.id,
          name: item.name,
          color: item.color,
          valueNumber: Number(item.total || 0),
        })),
    [categories]
  );

  const total = useMemo(
    () => spendingCategories.reduce((sum, item) => sum + Number(item.valueNumber || 0), 0),
    [spendingCategories]
  );

  const sortedCategories = useMemo(
    () =>
      [...spendingCategories].sort(
        (a, b) => Number(b.valueNumber || 0) - Number(a.valueNumber || 0)
      ),
    [spendingCategories]
  );

  const segments = useMemo(() => {
    if (total <= 0) return [];
    let current = 0;
    return sortedCategories
      .filter((item) => Number(item.valueNumber || 0) > 0)
      .map((item) => {
        const fraction = Number(item.valueNumber) / total;
        const sweep = fraction * 360;
        const startDeg = current;
        const endDeg = current + sweep;
        current += sweep;
        return {
          ...item,
          fraction,
          sweep,
          startDeg,
          endDeg,
          percentNumber: fraction * 100,
        };
      });
  }, [sortedCategories, total]);

  const syncedName = useMemo(() => {
    const bySelection = segments.find((seg) => seg.id === activeCategoryId);
    if (bySelection) return bySelection.name;
    return segments[0]?.name || "";
  }, [segments, activeCategoryId]);

  const [activeName, setActiveName] = useState(syncedName);
  const [flashToken, setFlashToken] = useState(0);

  useEffect(() => {
    setActiveName(syncedName);
  }, [syncedName]);

  const activeSegment = segments.find((seg) => seg.name === activeName) || segments[0] || null;
  const activeData = activeSegment || {
    name: "No spending",
    color: "#8feaff",
    valueNumber: 0,
    percentNumber: 0,
  };

  const preview = (name) => {
    setActiveName(name);
    setFlashToken((token) => token + 1);
  };

  const reset = () => {
    if (!syncedName || activeName === syncedName) return;
    setActiveName(syncedName);
    setFlashToken((token) => token + 1);
  };

  const select = (id, name) => {
    setActiveName(name);
    setFlashToken((token) => token + 1);
    if (typeof onSelectCategory === "function") onSelectCategory(id);
  };

  return (
    <div style={{ width: "100%" }} className="spending-breakdown-orbit">
      <div onMouseLeave={reset} style={{ display: "flex", justifyContent: "center", width: "100%" }}>
        <div style={{ position: "relative", width: SIZE, height: SIZE }}>
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            <defs>
              <radialGradient id="spending-breakdown-core" cx="35%" cy="30%" r="75%">
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
                    key={seg.id}
                    onMouseEnter={() => preview(seg.name)}
                    onClick={() => select(seg.id, seg.name)}
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
              fill="url(#spending-breakdown-core)"
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
    </div>
  );
}
