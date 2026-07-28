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

function rowDetail(row) {
  if (row?.meta?.agentName && !String(row.label || "").includes(row.meta.agentName)) {
    return row.meta.agentName;
  }
  if (row?.meta?.toolName && row.meta.toolName !== "web_search") {
    return row.meta.toolName;
  }
  return null;
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
  const [expanded, setExpanded] = useState(false);

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

  const latestIndex = latestActiveIndex >= 0 ? latestActiveIndex : rows.length - 1;
  const latestRow = latestIndex >= 0 ? rows[latestIndex] : null;

  const elapsedMs =
    live && startedAt != null ? Math.max(0, now - startedAt) : rows[rows.length - 1]?.elapsedMs;

  const latestLabel = latestRow?.label || (live ? "Understanding request…" : "Activity");
  const latestDetail = latestRow ? rowDetail(latestRow) : null;
  const latestStatus =
    latestRow?.status === "active" || latestIndex === latestActiveIndex
      ? "active"
      : latestRow?.status || (live ? "active" : "completed");
  const latestGlyph = statusGlyph(latestStatus, true);
  const latestColor = statusColor(latestStatus);
  const latestElapsed =
    latestRow?.status === "active" && live
      ? formatElapsed(Math.max(0, now - (startedAt || now)))
      : latestRow?.elapsedMs != null
        ? formatElapsed(latestRow.elapsedMs)
        : elapsedMs != null
          ? formatElapsed(elapsedMs)
          : "";

  return (
    <div
      style={{
        borderRadius: 16,
        padding: "10px 14px",
        border: "1px solid rgba(0,136,255,.22)",
        background: "rgba(3,17,32,.86)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        title={expanded ? "Hide activity steps" : "Show all activity steps"}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto",
          gap: 10,
          alignItems: "center",
          width: "100%",
          margin: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 18px minmax(0, 1fr)",
            gap: 8,
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <span
            style={{
              color: "#8feaff",
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: 1,
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            {agentName}
          </span>
          <span style={{ color: latestColor, fontWeight: 700, fontSize: 13 }}>{latestGlyph}</span>
          <span
            style={{
              color: latestColor,
              fontSize: 13,
              lineHeight: 1.35,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {latestLabel}
            {latestDetail ? (
              <span style={{ color: "#6f879f" }}>{` · ${latestDetail}`}</span>
            ) : null}
          </span>
        </div>
        <span style={{ color: "#6f879f", fontSize: 11, whiteSpace: "nowrap" }}>
          {latestElapsed || (elapsedMs != null ? formatElapsed(elapsedMs) : "")}
        </span>
        <span style={{ color: "#8feaff", fontSize: 11, fontWeight: 800 }} aria-hidden="true">
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      {expanded ? (
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {rows.length === 0 ? (
            <div style={{ color: "#8faecc", fontSize: 13 }}>Understanding request…</div>
          ) : (
            rows.map((row, index) => {
              const glyph = statusGlyph(row.status, index === latestActiveIndex);
              const color = statusColor(
                row.status === "active" || index === latestActiveIndex ? "active" : row.status
              );
              const detail = rowDetail(row);
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
      ) : null}
    </div>
  );
}
