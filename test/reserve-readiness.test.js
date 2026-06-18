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
    reserveAnchor: { month: "Jan", year: 2026 },
    ...overrides,
  };
}

test("reserve accrues one contribution per active month from the anchor", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  const transactions = [];

  const jan = buildReserveSnapshot(homeReserve(), transactions, {
    asOfMonth: "Jan",
    asOfYear: 2026,
  });
  const feb = buildReserveSnapshot(homeReserve(), transactions, {
    asOfMonth: "Feb",
    asOfYear: 2026,
  });

  assert.equal(jan.balance, 200);
  assert.equal(jan.target, 2400);
  assert.equal(jan.readinessPercent, 8);
  assert.equal(feb.balance, 400);
});

test("spending a reserve reduces balance without going negative (water heater example)", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  const transactions = [
    { date: "March 12, 2026", amount: -600, category: "Home Reserve" },
  ];

  const mar = buildReserveSnapshot(homeReserve(), transactions, {
    asOfMonth: "Mar",
    asOfYear: 2026,
  });

  assert.equal(mar.balance, 0);
  assert.equal(mar.readinessPercent, 0);
  assert.equal(mar.status.label, "Critical");
  assert.equal(mar.deployedThisMonth, 600);
});

test("balance is floored at zero even when spending exceeds contributions", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  const transactions = [
    { date: "February 12, 2026", amount: -5000, category: "Home Reserve" },
  ];

  const feb = buildReserveSnapshot(homeReserve(), transactions, {
    asOfMonth: "Feb",
    asOfYear: 2026,
  });

  assert.equal(feb.balance, 0);
});

test("overfunding keeps readiness at 100% and marks the reserve Fully Funded", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  // 15 contributions of $200 = $3,000 against a $2,400 target.
  const reserve = homeReserve({ reserveAnchor: { month: "Jan", year: 2025 } });

  const snapshot = buildReserveSnapshot(reserve, [], {
    asOfMonth: "Mar",
    asOfYear: 2026,
  });

  assert.equal(snapshot.balance, 3000);
  assert.equal(snapshot.target, 2400);
  assert.equal(snapshot.readinessPercent, 100);
  assert.equal(snapshot.fullyFunded, true);
  assert.equal(snapshot.status.label, "Fully Funded");
});

test("refund inflows restore the reserve balance", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  const transactions = [
    { date: "February 10, 2026", amount: -600, category: "Home Reserve" },
    { date: "March 5, 2026", amount: 100, category: "Home Reserve" },
  ];

  const mar = buildReserveSnapshot(homeReserve(), transactions, {
    asOfMonth: "Mar",
    asOfYear: 2026,
  });

  // 3 contributions ($600) - $600 spend + $100 refund = $100.
  assert.equal(mar.balance, 100);
});

test("contributions are not backfilled before the anchor", async () => {
  const { buildReserveSnapshot } = await loadReservesModule();
  // No explicit anchor -> defaults to the as-of period (fresh start), and a
  // pre-anchor transaction must be ignored.
  const reserve = homeReserve({ reserveAnchor: null });
  const transactions = [
    { date: "January 5, 2026", amount: -50, category: "Home Reserve" },
  ];

  const mar = buildReserveSnapshot(reserve, transactions, {
    asOfMonth: "Mar",
    asOfYear: 2026,
  });

  // Anchor defaults to Mar 2026 -> only one contribution, January spend ignored.
  assert.equal(mar.balance, 200);
});

test("seasonal reserves only accrue in their active months", async () => {
  const { countActiveContributions } = await loadReservesModule();
  const count = countActiveContributions(
    { month: "Jan", year: 2026 },
    { month: "Mar", year: 2026 },
    ["Jan"]
  );
  assert.equal(count, 1);
});

test("FRC is dollar-weighted across all reserves", async () => {
  const { buildReserveReadiness } = await loadReservesModule();
  const reserves = [
    {
      id: "emergency",
      name: "Emergency Reserve",
      type: "R",
      budget: 1500,
      reserveTargetMonths: 12,
      months: ALL_MONTHS,
      transactionCategories: ["Emergency Reserve"],
      reserveAnchor: { month: "Mar", year: 2025 }, // 10 contributions -> $15,000
    },
    {
      id: "vehicle",
      name: "Vehicle Reserve",
      type: "R",
      budget: 100,
      reserveTargetMonths: 12,
      months: ALL_MONTHS,
      transactionCategories: ["Vehicle Reserve"],
      reserveAnchor: { month: "Apr", year: 2025 }, // 9 contributions -> $900
    },
    {
      id: "home",
      name: "Home Reserve",
      type: "R",
      budget: 200,
      reserveTargetMonths: 12,
      months: ALL_MONTHS,
      transactionCategories: ["Home Reserve"],
      reserveAnchor: { month: "Apr", year: 2025 }, // 9 contributions -> $1,800
    },
  ];

  const frc = buildReserveReadiness(reserves, [], { asOfMonth: "Dec", asOfYear: 2025 });

  assert.equal(frc.totalBalance, 17700);
  assert.equal(frc.totalTarget, 21600);
  assert.equal(frc.overallPercent, 82);
  assert.equal(frc.band.label, "Blue");
  assert.equal(frc.count, 3);
});

test("reserve status bands map readiness ratios correctly", async () => {
  const { getReserveStatus } = await loadReservesModule();
  assert.equal(getReserveStatus(0.49).label, "Critical");
  assert.equal(getReserveStatus(0.5).label, "Building");
  assert.equal(getReserveStatus(0.74).label, "Building");
  assert.equal(getReserveStatus(0.75).label, "Strong");
  assert.equal(getReserveStatus(0.99).label, "Strong");
  assert.equal(getReserveStatus(1).label, "Fully Funded");
  assert.equal(getReserveStatus(1.5).label, "Fully Funded");
});

test("FRC color bands match the locked thresholds", async () => {
  const { getFrcBand } = await loadReservesModule();
  assert.equal(getFrcBand(90).label, "Green");
  assert.equal(getFrcBand(89).label, "Blue");
  assert.equal(getFrcBand(75).label, "Blue");
  assert.equal(getFrcBand(50).label, "Yellow");
  assert.equal(getFrcBand(49).label, "Red");
});
