import { useEffect, useState } from "react";
import { styles } from "../../styles.js";
import { fetchAdminUsage } from "../../utils/agentsApi.js";
import { describeAgentApiError, formatRelativeTime, fosStyles, getAgentTypeMeta } from "./freedomOsShared.js";

// Platform admin usage table (GET /api/admin/usage). Plain HTML table by
// design — no charts. The tab is only rendered for isAdmin users, and the API
// enforces the same gate server-side.

const cellStyle = {
  padding: "10px 12px",
  borderBottom: "1px solid rgba(30,144,255,.14)",
  color: "#d7ebff",
  fontSize: 13,
  verticalAlign: "top",
  textAlign: "left",
};

const headerCellStyle = {
  ...cellStyle,
  color: "#8feaff",
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  borderBottom: "1px solid rgba(0,216,255,.28)",
  whiteSpace: "nowrap",
};

function formatCost(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

export function AdminUsagePanel({ user }) {
  const [usage, setUsage] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const payload = await fetchAdminUsage({ user });
        if (!cancelled) {
          setUsage(Array.isArray(payload?.usage) ? payload.usage : []);
          setLoadError("");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(describeAgentApiError(error, "Unable to load platform usage."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <div style={{ ...styles.panel, padding: 24, display: "grid", gap: 18 }}>
      <div>
        <h1 style={styles.pageTitle}>Admin Usage</h1>
        <p style={styles.pageSubtitle}>
          Per-user agent runs, tokens, and estimated cost across the platform.
        </p>
      </div>

      {loadError ? <div style={fosStyles.errorBox}>{loadError}</div> : null}
      {isLoading ? <div style={{ color: "#8faecc", fontSize: 13 }}>Loading usage…</div> : null}

      {!isLoading && !loadError && usage?.length === 0 ? (
        <div style={{ color: "#8faecc", fontSize: 13 }}>No users or usage recorded yet.</div>
      ) : null}

      {usage?.length ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
            <thead>
              <tr>
                <th style={headerCellStyle}>User</th>
                <th style={headerCellStyle}>Last active</th>
                <th style={headerCellStyle}>Runs (all / month)</th>
                <th style={headerCellStyle}>Tokens (all / month)</th>
                <th style={headerCellStyle}>Est. cost (all / month)</th>
                <th style={headerCellStyle}>By agent type</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((row) => (
                <tr key={row.userId}>
                  <td style={cellStyle}>
                    <div style={{ fontWeight: 700 }}>{row.email || "(no email)"}</div>
                    <div style={{ color: "#5f7896", fontSize: 11, marginTop: 2 }}>{row.userId}</div>
                  </td>
                  <td style={cellStyle}>{formatRelativeTime(row.lastActive)}</td>
                  <td style={cellStyle}>
                    {row.runsAllTime.toLocaleString()} / {row.runsThisMonth.toLocaleString()}
                  </td>
                  <td style={cellStyle}>
                    {row.tokensAllTime.toLocaleString()} / {row.tokensThisMonth.toLocaleString()}
                  </td>
                  <td style={cellStyle}>
                    {formatCost(row.costAllTime)} / {formatCost(row.costThisMonth)}
                  </td>
                  <td style={cellStyle}>
                    {Object.keys(row.byAgentType || {}).length === 0 ? (
                      <span style={{ color: "#5f7896" }}>—</span>
                    ) : (
                      <div style={{ display: "grid", gap: 4 }}>
                        {Object.entries(row.byAgentType).map(([agentType, bucket]) => (
                          <div key={agentType} style={{ fontSize: 12, color: "#c8d7ea" }}>
                            <span style={{ color: getAgentTypeMeta(agentType).color, fontWeight: 800 }}>
                              {getAgentTypeMeta(agentType).label}
                            </span>
                            : {bucket.runs.toLocaleString()} runs, {bucket.tokens.toLocaleString()}{" "}
                            tokens, {formatCost(bucket.cost)}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
