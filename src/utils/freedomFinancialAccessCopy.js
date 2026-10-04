// Shared Freedom Financial CHIEF-access copy. No network and no Firebase, so
// the sidebar and the tests use the same sentences. Tab labels match APP_TABS.
// The stored flag remains freedomFinancialRead.

export const FREEDOM_FINANCIAL_ACCESS_OFF_COPY =
  "Read-only access allows CHIEF to view your Freedom Financial information. CHIEF cannot make changes.";

export const FREEDOM_FINANCIAL_ACCESS_ON_COPY =
  "CHIEF can view Freedom Financial data. Read-only — CHIEF cannot modify your financial data.";

const NOT_FREEDOM_FINANCIAL = new Set(["Freedom OS", "CHIEF", "Admin Usage"]);

export function isFreedomFinancialTab(tab) {
  return typeof tab === "string" && tab.length > 0 && !NOT_FREEDOM_FINANCIAL.has(tab);
}

export function freedomFinancialAccessPayload(enabled) {
  return { freedomFinancialRead: enabled === true };
}

export function freedomFinancialAccessCopy(enabled) {
  return enabled === true ? FREEDOM_FINANCIAL_ACCESS_ON_COPY : FREEDOM_FINANCIAL_ACCESS_OFF_COPY;
}
