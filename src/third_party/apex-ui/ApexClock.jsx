"use client";

/**
 * Clock block from ApexOverviewPanel (APEX-UI commit a8732fad).
 * Time and date only. The lamp, social tiles, and weather request are not
 * part of this shell: weather lived on a Next.js route this app does not have.
 */

import { useEffect, useState } from "react";

const ACCENT = "#00e5ff";

export default function ApexClock() {
  const [now, setNow] = useState(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <div className="apex-overview" style={{ height: 48 }} />;
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="apex-overview" style={{ pointerEvents: "none" }}>
      <div style={{ paddingLeft: 14, paddingTop: 16, width: "fit-content" }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 300, letterSpacing: "0.04em", color: "#f0ede8", lineHeight: 1, textShadow: `0 0 22px ${ACCENT}33` }}>{time}</div>
          <div style={{ fontSize: 10.5, letterSpacing: "0.2em", color: "rgba(240,237,232,0.55)", marginTop: 4, textTransform: "uppercase" }}>{date}</div>
        </div>
      </div>
    </div>
  );
}
