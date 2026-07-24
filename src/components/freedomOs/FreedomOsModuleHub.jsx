// Freedom OS module picker — first screen after sign-in. Module 01 opens the
// CEO Agents deck; Module 02 opens Freedom Financial (the finance workspace).

import { FREEDOM_OS_MODULE_IDS } from "./freedomOsModules.js";

const MODULES = [
  {
    id: FREEDOM_OS_MODULE_IDS.CEO_AGENTS,
    eyebrow: "Module 01",
    title: "CEO Agents",
    description:
      "Your autonomous agent operating system — CEO Agent, digests, and the team that runs missions on your behalf.",
    actionLabel: "Enter CEO Agents",
  },
  {
    id: FREEDOM_OS_MODULE_IDS.FREEDOM_FINANCIAL,
    eyebrow: "Module 02",
    title: "Freedom Financial",
    description:
      "Accounts, budgets, forecasting, and real-time cash intelligence — the financial command center inside Freedom OS.",
    actionLabel: "Enter Freedom Financial",
  },
];

function ModuleCard({ module, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(module.id)}
      className="fos-mod-portal"
      style={{
        textAlign: "left",
        borderRadius: 16,
        border: "1px solid rgba(0,216,255,.24)",
        background: "linear-gradient(160deg, rgba(4,22,42,.92), rgba(2,10,22,.88))",
        boxShadow: "0 10px 34px rgba(0,40,90,.3), inset 0 1px 0 rgba(255,255,255,.04)",
        padding: "22px 24px",
        cursor: "pointer",
        display: "grid",
        gap: 10,
        alignContent: "start",
        minHeight: 180,
      }}
    >
      <div
        style={{
          color: "#67e8f9",
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: 2.2,
          textTransform: "uppercase",
        }}
      >
        {module.eyebrow}
      </div>
      <div style={{ color: "white", fontSize: 22, fontWeight: 900, letterSpacing: 0.3 }}>
        {module.title}
      </div>
      <div style={{ color: "#9fc0dd", fontSize: 13, lineHeight: 1.6 }}>{module.description}</div>
      <div
        style={{
          marginTop: "auto",
          paddingTop: 8,
          color: "#8feaff",
          fontSize: 12,
          fontWeight: 900,
          letterSpacing: 1.1,
          textTransform: "uppercase",
        }}
      >
        {module.actionLabel} <span aria-hidden="true">→</span>
      </div>
    </button>
  );
}

const HUB_STYLES = `
.fos-mod-portal { transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease; }
.fos-mod-portal:hover { transform: translateY(-3px); border-color: rgba(0,216,255,.65) !important; box-shadow: 0 14px 44px rgba(0,140,255,.28) !important; }
.fos-mod-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
@media (min-width: 720px) {
  .fos-mod-grid { grid-template-columns: 1fr 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .fos-mod-portal { transition: none; }
  .fos-mod-portal:hover { transform: none; }
}
`;

export function FreedomOsModuleHub({ onSelectModule }) {
  return (
    <section style={{ display: "grid", gap: 18 }}>
      <style>{HUB_STYLES}</style>
      <div style={{ display: "grid", gap: 6 }}>
        <div
          style={{
            color: "white",
            fontSize: 22,
            fontWeight: 900,
            letterSpacing: 0.4,
          }}
        >
          Choose a module
        </div>
        <div style={{ color: "#8faecc", fontSize: 13.5, lineHeight: 1.55, maxWidth: 520 }}>
          Freedom OS is your home base. Open CEO Agents to run your team, or Freedom Financial for
          cash, budgets, and accounts.
        </div>
      </div>
      <div className="fos-mod-grid">
        {MODULES.map((module) => (
          <ModuleCard key={module.id} module={module} onSelect={onSelectModule} />
        ))}
      </div>
    </section>
  );
}
