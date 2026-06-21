import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

async function loadReservesModule() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });

  try {
    return await server.ssrLoadModule("/src/utils/reserves.js");
  } finally {
    await server.close();
  }
}

const ALL_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function homeReserve(overrides = {}) {
  return {
    id: "home",
    name: "Home Reserve",
    type: "R",
    budget: 200,
    reserveTargetMonths: 12,
    months: ALL_MONTHS,
    transactionCategories: ["Home Reserve"],
    reserveAnchor: { month: "Jan", year: 2025 },
    ...overrides,
  };
}

test("True Cash subtracts committed reserves from gross cash", async () => {
  const { computeTrueCash } = await loadReservesModule();
  assert.equal(
    computeTrueCash({ liquidCash: 10000, creditCardDebt: 0, reservesBalance: 300 }),
    9700
  );
});

test("a fully-covered reserve deployment leaves True Cash unchanged", async () => {
  const { buildReserveReadiness, computeTrueCash } = await loadReservesModule();
  const reserve = homeReserve(); // anchor Jan 2025

  // Before any spend, as of Mar 2026: 15 contributions x $200 = $3,000 reserve.
  const before = buildReserveReadiness([reserve], [], { asOfMonth: "Mar", asOfYear: 2026 });
  assert.equal(before.totalBalance, 3000);

  // A $600 home-repair transaction: it leaves the bank (gross drops) and draws
  // the reserve down by the same $600 (fully covered).
  const transactions = [{ date: "March 12, 2026", amount: -600, category: "Home Reserve" }];
  const after = buildReserveReadiness([reserve], transactions, { asOfMonth: "Mar", asOfYear: 2026 });
  assert.equal(after.totalBalance, 2400);

  const trueCashBefore = computeTrueCash({ liquidCash: 10000, reservesBalance: before.totalBalance });
  const trueCashAfter = computeTrueCash({ liquidCash: 9400, reservesBalance: after.totalBalance });
  assert.equal(trueCashBefore, 7000);
  assert.equal(trueCashAfter, 7000); // unchanged: committed money did its job
});

test("over-reserve spending reduces True Cash only by the uncovered remainder", async () => {
  const { buildReserveReadiness, computeTrueCash } = await loadReservesModule();
  // Anchor Mar 2026, as of Mar 2026 -> only $200 available in the reserve.
  const reserve = homeReserve({ reserveAnchor: { month: "Mar", year: 2026 } });

  const before = buildReserveReadiness([reserve], [], { asOfMonth: "Mar", asOfYear: 2026 });
  assert.equal(before.totalBalance, 200);

  const transactions = [{ date: "March 12, 2026", amount: -600, category: "Home Reserve" }];
  const after = buildReserveReadiness([reserve], transactions, { asOfMonth: "Mar", asOfYear: 2026 });
  assert.equal(after.totalBalance, 0); // floored, no borrowing from other funds

  const trueCashBefore = computeTrueCash({ liquidCash: 10000, reservesBalance: before.totalBalance });
  const trueCashAfter = computeTrueCash({ liquidCash: 9400, reservesBalance: after.totalBalance });
  // $600 spend, only $200 covered by reserve -> True Cash falls by the $400 remainder.
  assert.equal(trueCashBefore - trueCashAfter, 400);
});

test("True Cash is allowed to go negative when overcommitted", async () => {
  const { computeTrueCash } = await loadReservesModule();
  assert.equal(
    computeTrueCash({ liquidCash: 5000, creditCardDebt: 0, reservesBalance: 6000 }),
    -1000
  );
});

test("credit card debt and reserves both reduce True Cash", async () => {
  const { computeTrueCash } = await loadReservesModule();
  assert.equal(
    computeTrueCash({ liquidCash: 10000, creditCardDebt: 1500, reservesBalance: 3600 }),
    4900
  );
});
