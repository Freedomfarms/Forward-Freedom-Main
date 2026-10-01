// Shared Module 02 CHIEF-access copy. No network and no Firebase, so the
// sidebar and the tests use the same sentences. Tab labels match APP_TABS.

export const MODULE02_ACCESS_OFF_COPY =
  "Read-only access allows CHIEF to view your Module 02 financial information. CHIEF cannot make changes.";

export const MODULE02_ACCESS_ON_COPY =
  "CHIEF can view Module 02 data. Read-only — CHIEF cannot modify your financial data.";

const NOT_MODULE_02 = new Set(["Freedom OS", "CHIEF", "Admin Usage"]);

export function isModule02Tab(tab) {
  return typeof tab === "string" && tab.length > 0 && !NOT_MODULE_02.has(tab);
}

export function module02AccessPayload(enabled) {
  return { module02Read: enabled === true };
}

export function module02AccessCopy(enabled) {
  return enabled === true ? MODULE02_ACCESS_ON_COPY : MODULE02_ACCESS_OFF_COPY;
}
