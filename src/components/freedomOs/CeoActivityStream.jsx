import { useEffect, useState } from "react";

// CEO Activity Stream renderer — operational events only (no chain-of-thought).

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) * 100)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusGlyph(status, isLatestActive) {
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  if (status === "active" || isLatestActive) return "◉";
  return "○";
}

function statusColor(status) {
  if (status === "completed") return "#6dffb0";
  if (status === "failed") return "#ff8f8f";
  if (status === "active") return "#8feaff";
  return "#6f879f";
}

/**
 * @param {{
 *   agentName?: string,
 *   activities?: Array<object>,
 *   live?: boolean,
 *   startedAt?: number|null,
 * }} props
 */
export default function CeoActivityStream({
  agentName = "CEO",
  activities = [],
  live = false,
  startedAt = null,
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [live]);

  const rows = Array.isArray(activities) ? activities : [];
  const latestActiveIndex = (() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]?.status === "active") return i;
    }
    return -1;
  })();

  const elapsedMs =
    live && startedAt != null ? Math.max(0, now - startedAt) : rows[rows.length - 1]?.elapsedMs;

  return (
    <div
      style={{
        borderRadius: 16,
        padding: "12px 14px",
        border: "1px solid rgba(0,136,255,.22)",
        background: "rgba(3,17,32,.86)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            color: "#8feaff",
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          {agentName}
        </div>
        {elapsedMs != null ? (
          <div style={{ color: "#6f879f", fontSize: 11 }}>{formatElapsed(elapsedMs)}</div>
        ) : null}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {rows.length === 0 ? (
          <div style={{ color: "#8faecc", fontSize: 13 }}>Understanding request…</div>
        ) : (
          rows.map((row, index) => {
            const glyph = statusGlyph(row.status, index === latestActiveIndex);
            const color = statusColor(
              row.status === "active" || index === latestActiveIndex ? "active" : row.status
            );
            const detail =
              row.meta?.agentName && !String(row.label || "").includes(row.meta.agentName)
                ? row.meta.agentName
                : row.meta?.toolName && row.meta.toolName !== "web_search"
                  ? row.meta.toolName
                  : null;
            return (
              <div
                key={row.id || `${row.key}-${index}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "18px 1fr auto",
                  gap: 8,
                  alignItems: "start",
                  color,
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <span style={{ fontWeight: 700 }}>{glyph}</span>
                <span>
                  {row.label}
                  {detail ? (
                    <span style={{ color: "#6f879f" }}>{` · ${detail}`}</span>
                  ) : null}
                </span>
                <span style={{ color: "#6f879f", fontSize: 11 }}>
                  {row.status === "active" && live
                    ? formatElapsed(Math.max(0, now - (startedAt || now)))
                    : row.elapsedMs != null
                      ? formatElapsed(row.elapsedMs)
                      : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
