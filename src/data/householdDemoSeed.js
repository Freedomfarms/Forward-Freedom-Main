/**
 * Realistic household demo seed: ~$500k net worth, ~$100k/yr income, ~$80k/yr expenses.
 * Transactions: 30 per month, Jan–Aug 2026 (240 total).
 */

const DEMO_YEAR = 2026;
const DEMO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const DEMO_MONTH_INDEX = Object.fromEntries(DEMO_MONTHS.map((month, index) => [month, index]));

const CHECKING = "Primary Checking";
const SAVINGS = "High Yield Savings";
const CARD = "Rewards Card";
const BROKERAGE = "Taxable Brokerage";

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function formatDemoDate(month, day) {
  return `${month} ${day}, ${DEMO_YEAR}`;
}

function monthJitter(monthIndex, salt, spread = 0.12) {
  const hash = (monthIndex * 37 + salt * 17) % 100;
  return 1 + ((hash - 50) / 50) * spread;
}

/** Target monthly gross income (~$100k/yr across 8 logged months). */
const MONTHLY_INCOME_TARGETS = {
  Jan: 8420,
  Feb: 7980,
  Mar: 8720,
  Apr: 8150,
  May: 8890,
  Jun: 8310,
  Jul: 9180,
  Aug: 8260,
};

/** Target monthly spending (~$80k/yr across 8 logged months). */
const MONTHLY_EXPENSE_TARGETS = {
  Jan: 6380,
  Feb: 7020,
  Mar: 6680,
  Apr: 6910,
  May: 7240,
  Jun: 6520,
  Jul: 7880,
  Aug: 6710,
};

export const householdDemoAccounts = [
  {
    id: "acct-checking-primary",
    name: CHECKING,
    type: "Checking",
    institution: "Chase",
    balance: 22418.62,
    status: "Synced",
  },
  {
    id: "acct-savings-hys",
    name: SAVINGS,
    type: "Savings",
    institution: "Marcus",
    balance: 38462.15,
    status: "Synced",
  },
  {
    id: "acct-cc-rewards",
    name: CARD,
    type: "Credit Card",
    institution: "Chase Sapphire",
    balance: -4186.44,
    status: "Synced",
  },
  {
    id: "acct-invest-brokerage",
    name: BROKERAGE,
    type: "Investment",
    institution: "Fidelity",
    balance: 88420.55,
    status: "Synced",
  },
  {
    id: "acct-retirement-401k",
    name: "401(k)",
    type: "Retirement",
    institution: "Fidelity",
    balance: 141860.32,
    status: "Synced",
  },
  {
    id: "acct-metal-gold",
    name: "Gold Holdings",
    type: "Precious Metals",
    institution: "Home Vault",
    metalType: "Gold",
    metalUnit: "oz",
    quantity: 6,
    pricePerUnit: 2985,
    balance: 17910,
    status: "Manual",
  },
  {
    id: "acct-home",
    name: "Primary Residence",
    type: "Real Estate",
    institution: "Manual",
    propertyAddress: "1842 Maple Ridge Dr, Austin, TX",
    propertyType: "Primary Home",
    propertyMarketValue: 425000,
    linkedLoanId: "acct-mortgage",
    balance: 157000,
    status: "Manual",
  },
  {
    id: "acct-mortgage",
    name: "Home Mortgage",
    type: "Mortgages / Loans",
    institution: "Wells Fargo",
    linkedPropertyId: "acct-home",
    loanCategory: "Mortgage",
    interestRate: "6.25%",
    monthlyPayment: "2845",
    balance: -268000,
    status: "Manual",
  },
  {
    id: "acct-cash-envelope",
    name: "Cash Envelope",
    type: "Manual Cash",
    institution: "Home",
    balance: 1450,
    status: "Manual",
  },
  {
    id: "acct-crypto-btc",
    name: "Bitcoin",
    type: "Crypto",
    institution: "Coinbase",
    cryptoAssetId: "bitcoin",
    cryptoName: "Bitcoin",
    cryptoSymbol: "BTC",
    quantity: 0.248,
    lastPriceUsd: 88420,
    lastPriceUpdatedAt: Date.now(),
    priceSource: "CoinGecko",
    status: "Manual",
  },
  {
    id: "acct-crypto-eth",
    name: "Ethereum",
    type: "Crypto",
    institution: "Coinbase",
    cryptoAssetId: "ethereum",
    cryptoName: "Ethereum",
    cryptoSymbol: "ETH",
    quantity: 2.75,
    lastPriceUsd: 3200,
    lastPriceUpdatedAt: Date.now(),
    priceSource: "CoinGecko",
    status: "Manual",
  },
  {
    id: "acct-crypto-sol",
    name: "Solana",
    type: "Crypto",
    institution: "Kraken",
    cryptoAssetId: "solana",
    cryptoName: "Solana",
    cryptoSymbol: "SOL",
    quantity: 42,
    lastPriceUsd: 175,
    lastPriceUpdatedAt: Date.now(),
    priceSource: "CoinGecko",
    status: "Manual",
  },
  {
    id: "acct-crypto-link",
    name: "Chainlink",
    type: "Crypto",
    institution: "Kraken",
    cryptoAssetId: "chainlink",
    cryptoName: "Chainlink",
    cryptoSymbol: "LINK",
    quantity: 200,
    lastPriceUsd: 18.5,
    lastPriceUpdatedAt: Date.now(),
    priceSource: "CoinGecko",
    status: "Manual",
  },
];

const RECURRING_EXPENSE_TEMPLATES = [
  { day: 4, merchant: "Mortgage Payment", category: "Housing", account: CHECKING, base: 2845 },
  { day: 6, merchant: "AT&T Wireless", category: "Utilities", account: CHECKING, base: 142.18 },
  { day: 8, merchant: "Netflix", category: "Subscriptions", account: CARD, base: 18.99 },
  { day: 9, merchant: "Spotify", category: "Subscriptions", account: CARD, base: 11.99 },
  { day: 10, merchant: "Planet Fitness", category: "Fitness & Wellness", account: CARD, base: 49 },
  { day: 12, merchant: "Comcast Internet", category: "Utilities", account: CHECKING, base: 89.99 },
  { day: 14, merchant: "State Farm Auto", category: "Insurance", account: CHECKING, base: 218 },
  { day: 18, merchant: "Apple One", category: "Subscriptions", account: CARD, base: 19.95 },
  { day: 20, merchant: "Austin Energy", category: "Utilities", account: CHECKING, base: 156.4 },
  { day: 22, merchant: "Amazon Prime", category: "Subscriptions", account: CARD, base: 14.99 },
];

const VARIABLE_EXPENSE_POOL = [
  { merchant: "H-E-B", category: "Groceries", account: CARD, base: 118, weight: 5 },
  { merchant: "Whole Foods", category: "Groceries", account: CARD, base: 86, weight: 3 },
  { merchant: "Costco", category: "Groceries", account: CARD, base: 214, weight: 2 },
  { merchant: "Shell", category: "Fuel", account: CARD, base: 58, weight: 4 },
  { merchant: "Chevron", category: "Fuel", account: CARD, base: 62, weight: 3 },
  { merchant: "Chipotle", category: "Restaurants", account: CARD, base: 22, weight: 4 },
  { merchant: "Starbucks", category: "Food & Drink", account: CARD, base: 12, weight: 5 },
  { merchant: "Uber", category: "Transportation", account: CARD, base: 28, weight: 3 },
  { merchant: "Target", category: "Shopping", account: CARD, base: 74, weight: 3 },
  { merchant: "Amazon", category: "Shopping", account: CARD, base: 96, weight: 4 },
  { merchant: "Home Depot", category: "Home", account: CARD, base: 142, weight: 2 },
  { merchant: "CVS Pharmacy", category: "Health", account: CARD, base: 34, weight: 2 },
  { merchant: "Kyle Animal Clinic", category: "Health", account: CARD, base: 88, weight: 1 },
  { merchant: "Southwest Airlines", category: "Travel", account: CARD, base: 318, weight: 1 },
  { merchant: "Marriott", category: "Travel", account: CARD, base: 412, weight: 1 },
  { merchant: "Lowe's", category: "Home", account: CARD, base: 128, weight: 2 },
  { merchant: "REI", category: "Shopping", account: CARD, base: 156, weight: 1 },
  { merchant: "DraftKings", category: "Entertainment", account: CARD, base: 40, weight: 1 },
  { merchant: "AMC Theatres", category: "Entertainment", account: CARD, base: 36, weight: 2 },
];

function buildWeightedPool() {
  const pool = [];
  VARIABLE_EXPENSE_POOL.forEach((entry, entryIndex) => {
    for (let count = 0; count < entry.weight; count += 1) {
      pool.push({ ...entry, entryIndex });
    }
  });
  return pool;
}

const WEIGHTED_VARIABLE_POOL = buildWeightedPool();

function reserveDay(usedDays, preferredDay) {
  if (!usedDays.has(preferredDay)) {
    usedDays.add(preferredDay);
    return preferredDay;
  }

  for (let day = 2; day <= 28; day += 1) {
    if (!usedDays.has(day)) {
      usedDays.add(day);
      return day;
    }
  }

  // More than 27 rows in one month — reuse a day (valid for busy months).
  return preferredDay;
}

function buildMonthExpenseSchedule(month, monthIndex, variableSlots) {
  const schedule = RECURRING_EXPENSE_TEMPLATES.map((template, templateIndex) => ({
    ...template,
    amount: -roundMoney(template.base * monthJitter(monthIndex, templateIndex, 0.04)),
    kind: "recurring",
  }));

  const variableTarget =
    MONTHLY_EXPENSE_TARGETS[month] -
    schedule.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const perSlot = variableTarget / Math.max(variableSlots, 1);

  let poolCursor = (monthIndex * 7) % WEIGHTED_VARIABLE_POOL.length;
  const usedDays = new Set(schedule.map((row) => row.day));

  for (let slot = 0; slot < variableSlots; slot += 1) {
    const poolEntry = WEIGHTED_VARIABLE_POOL[poolCursor % WEIGHTED_VARIABLE_POOL.length];
    poolCursor += 1;

    const preferredDay = 2 + ((slot * 5 + monthIndex * 3) % 26);
    const day = reserveDay(usedDays, preferredDay);

    const amount = -roundMoney(
      (perSlot * 0.55 + poolEntry.base * 0.45) * monthJitter(monthIndex, poolEntry.entryIndex + slot, 0.22)
    );

    schedule.push({
      day,
      merchant: poolEntry.merchant,
      category: poolEntry.category,
      account: poolEntry.account,
      amount,
      kind: "variable",
    });
  }

  return schedule;
}

function buildMonthIncomeTransactions(month, monthIndex) {
  const target = MONTHLY_INCOME_TARGETS[month];
  const first = roundMoney(target * 0.52 * monthJitter(monthIndex, 1, 0.03));
  const second = roundMoney(target - first);

  return [
    {
      day: 2,
      merchant: "Payroll Deposit",
      category: "Income",
      account: CHECKING,
      amount: first,
      kind: "income",
    },
    {
      day: 16,
      merchant: "Payroll Deposit",
      category: "Income",
      account: CHECKING,
      amount: second,
      kind: "income",
    },
  ];
}

function addBonusIncome(month, monthIndex, transactions) {
  if (!["Mar", "Jun", "Aug"].includes(month)) return;

  transactions.push({
    day: 24,
    merchant: "Consulting Deposit",
    category: "Income",
    account: CHECKING,
    amount: roundMoney(520 * monthJitter(monthIndex, 9, 0.18)),
    kind: "income-bonus",
  });
}

function addQuarterlyDividend(month, monthIndex, transactions) {
  if (!["Feb", "May", "Aug"].includes(month)) return;

  transactions.push({
    day: 27,
    merchant: "Dividend Deposit",
    category: "Investments",
    account: BROKERAGE,
    amount: roundMoney(380 * monthJitter(monthIndex, 11, 0.1)),
    kind: "income-invest",
  });
}

function addSavingsTransfer(month, monthIndex, transactions) {
  if (!["Jan", "Apr", "Jul"].includes(month)) return;

  transactions.push({
    day: 28,
    merchant: "Transfer to Savings",
    category: "Transfers",
    account: SAVINGS,
    amount: -roundMoney(450 * monthJitter(monthIndex, 13, 0.08)),
    kind: "transfer-out",
  });
  transactions.push({
    day: 28,
    merchant: "Transfer to Savings",
    category: "Transfers",
    account: CHECKING,
    amount: roundMoney(450 * monthJitter(monthIndex, 13, 0.08)),
    kind: "transfer-in",
  });
}

export function generateHouseholdDemoTransactions() {
  const transactions = [];
  let sequence = 1;

  DEMO_MONTHS.forEach((month) => {
    const monthIndex = DEMO_MONTH_INDEX[month];
    const monthRows = [...buildMonthIncomeTransactions(month, monthIndex)];

    addBonusIncome(month, monthIndex, monthRows);
    addQuarterlyDividend(month, monthIndex, monthRows);
    addSavingsTransfer(month, monthIndex, monthRows);

    const variableSlots = Math.max(0, 30 - monthRows.length - RECURRING_EXPENSE_TEMPLATES.length);
    monthRows.push(...buildMonthExpenseSchedule(month, monthIndex, variableSlots));

    monthRows
      .sort((left, right) => right.day - left.day || right.amount - left.amount)
      .forEach((row) => {
        transactions.push({
          id: `tx-demo-${DEMO_YEAR}-${month.toLowerCase()}-${String(sequence).padStart(3, "0")}`,
          date: formatDemoDate(month, row.day),
          merchant: row.merchant,
          category: row.category,
          account: row.account,
          amount: row.amount,
          source: "manual",
        });
        sequence += 1;
      });
  });

  return transactions.sort((left, right) => new Date(right.date) - new Date(left.date));
}

export const householdDemoSubscriptions = [
  {
    id: "sub-mortgage",
    name: "Mortgage",
    amount: 2845,
    frequency: "Monthly",
    category: "Housing",
    billing: 4,
    status: "Active",
    icon: "🏠",
    account: CHECKING,
  },
  {
    id: "sub-att",
    name: "AT&T Wireless",
    amount: 142.18,
    frequency: "Monthly",
    category: "Utilities",
    billing: 6,
    status: "Active",
    icon: "📱",
    account: CHECKING,
  },
  {
    id: "sub-netflix",
    name: "Netflix",
    amount: 18.99,
    frequency: "Monthly",
    category: "Subscriptions",
    billing: 8,
    status: "Active",
    icon: "🎬",
    account: CARD,
  },
  {
    id: "sub-spotify",
    name: "Spotify",
    amount: 11.99,
    frequency: "Monthly",
    category: "Subscriptions",
    billing: 9,
    status: "Active",
    icon: "🎵",
    account: CARD,
  },
  {
    id: "sub-gym",
    name: "Planet Fitness",
    amount: 49,
    frequency: "Monthly",
    category: "Fitness & Wellness",
    billing: 10,
    status: "Active",
    icon: "🏋️",
    account: CARD,
  },
  {
    id: "sub-internet",
    name: "Comcast Internet",
    amount: 89.99,
    frequency: "Monthly",
    category: "Utilities",
    billing: 12,
    status: "Active",
    icon: "📡",
    account: CHECKING,
  },
  {
    id: "sub-insurance",
    name: "State Farm Auto",
    amount: 218,
    frequency: "Monthly",
    category: "Insurance",
    billing: 14,
    status: "Active",
    icon: "🚗",
    account: CHECKING,
  },
  {
    id: "sub-electric",
    name: "Austin Energy",
    amount: 156.4,
    frequency: "Monthly",
    category: "Utilities",
    billing: 20,
    status: "Active",
    icon: "⚡",
    account: CHECKING,
  },
];

export const householdDemoIncomeStreams = [
  {
    id: "income-primary-salary",
    name: "Primary Salary",
    description: "Biweekly W-2 payroll",
    amount: "$8,350",
    type: "Recurring",
    color: "#00f59b",
    icon: "💼",
    months: [
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
    ],
    transactionMerchants: ["Payroll", "Salary", "ADP", "Gusto"],
  },
  {
    id: "income-consulting",
    name: "Consulting Deposits",
    description: "Irregular project income",
    amount: "$520",
    type: "One-Time",
    color: "#8feaff",
    icon: "🧾",
    months: ["Mar", "Jun", "Aug", "Nov"],
    transactionMerchants: ["Consulting"],
  },
];

/** Fallback ops-board seed; live Jan–Aug values come from transactions when configured. */
export const householdDemoYearlyOps = [
  { month: "Jan", income: 8420, recurringIncome: 8420, oneTimeIncome: 0, budget: 7100, spent: 6380 },
  { month: "Feb", income: 7980, recurringIncome: 7600, oneTimeIncome: 380, budget: 7200, spent: 7020 },
  { month: "Mar", income: 9240, recurringIncome: 8720, oneTimeIncome: 520, budget: 7050, spent: 6680 },
  { month: "Apr", income: 8150, recurringIncome: 8150, oneTimeIncome: 0, budget: 7150, spent: 6910 },
  { month: "May", income: 9270, recurringIncome: 8890, oneTimeIncome: 380, budget: 7300, spent: 7240 },
  { month: "Jun", income: 8830, recurringIncome: 8310, oneTimeIncome: 520, budget: 7000, spent: 6520 },
  { month: "Jul", income: 9180, recurringIncome: 9180, oneTimeIncome: 0, budget: 7600, spent: 7880 },
  { month: "Aug", income: 8780, recurringIncome: 8260, oneTimeIncome: 520, budget: 7050, spent: 6710 },
  { month: "Sep", income: 8350, recurringIncome: 8350, oneTimeIncome: 0, budget: 7100, spent: 0 },
  { month: "Oct", income: 8500, recurringIncome: 8500, oneTimeIncome: 0, budget: 7150, spent: 0 },
  { month: "Nov", income: 8870, recurringIncome: 8350, oneTimeIncome: 520, budget: 7200, spent: 0 },
  { month: "Dec", income: 9100, recurringIncome: 8580, oneTimeIncome: 520, budget: 7400, spent: 0 },
];

export const householdDemoTransactions = generateHouseholdDemoTransactions();
