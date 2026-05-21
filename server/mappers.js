const RETIREMENT_SUBTYPES = new Set([
  "401a",
  "401k",
  "403b",
  "457b",
  "ira",
  "pension",
  "retirement",
  "roth",
  "roth 401k",
  "roth 403b",
  "roth 457b",
  "roth pension",
  "rrif",
  "rrsp",
  "sep ira",
  "simple ira",
  "thrift savings plan",
  "tfsa",
]);

const SAVINGS_SUBTYPES = new Set(["savings", "cd", "money market", "hsa"]);
const CHECKING_SUBTYPES = new Set([
  "checking",
  "cash management",
  "limited purpose checking",
  "payroll",
  "business",
]);

const CATEGORY_MAPPINGS = [
  [/INCOME/, "Income"],
  [/GROCER/, "Groceries"],
  [/RESTAURANT|FOOD_AND_DRINK/, "Restaurants"],
  [/TRAVEL/, "Travel"],
  [/TRANSPORT.*GAS|GAS/, "Fuel"],
  [/TRANSPORT/, "Transportation"],
  [/GENERAL_MERCHANDISE|SHOPPING|CLOTHING|ELECTRONICS/, "Shopping"],
  [/UTILITY/, "Utilities"],
  [/HOUSING|MORTGAGE|RENT/, "Housing"],
  [/HEALTH/, "Health"],
  [/INSURANCE/, "Insurance"],
  [/ENTERTAINMENT/, "Entertainment"],
  [/INVESTMENT/, "Investments"],
  [/TRANSFER/, "Transfers"],
];

function titleize(value) {
  return String(value || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatAppDate(dateString) {
  if (!dateString) return "";

  return new Date(`${dateString}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function mapPlaidAccountType(type, subtype) {
  const normalizedSubtype = String(subtype || "").toLowerCase();

  if (type === "depository") {
    if (SAVINGS_SUBTYPES.has(normalizedSubtype)) return "Savings";
    if (CHECKING_SUBTYPES.has(normalizedSubtype)) return "Checking";
    return "Checking";
  }

  if (type === "credit") return "Credit Card";
  if (type === "investment") {
    return RETIREMENT_SUBTYPES.has(normalizedSubtype) ? "Retirement" : "Investment";
  }
  if (type === "loan") return "Mortgages / Loans";

  return null;
}

function mapLoanCategory(subtype) {
  const normalizedSubtype = String(subtype || "").toLowerCase();
  if (!normalizedSubtype) return "Loan";
  if (normalizedSubtype === "mortgage") return "Mortgage";
  if (normalizedSubtype === "student") return "Student Loan";
  if (normalizedSubtype === "home equity") return "Home Equity";
  if (normalizedSubtype === "line of credit") return "Line of Credit";
  return titleize(normalizedSubtype);
}

function mapPlaidTransactionCategory(category) {
  const normalized = String(category || "").toUpperCase();

  for (const [pattern, label] of CATEGORY_MAPPINGS) {
    if (pattern.test(normalized)) return label;
  }

  return titleize(category || "Other");
}

export function buildLiabilityLookup(liabilities) {
  const lookup = new Map();

  Object.values(liabilities || {}).forEach((entries) => {
    if (!Array.isArray(entries)) return;

    entries.forEach((entry) => {
      if (entry?.account_id) {
        lookup.set(entry.account_id, entry);
      }
    });
  });

  return lookup;
}

export function mapPlaidAccountsToAppAccounts({
  accounts,
  itemId,
  institutionName,
  liabilityLookup,
}) {
  const syncedAt = new Date().toISOString();

  return accounts
    .map((account) => {
      const appType = mapPlaidAccountType(account.type, account.subtype);
      if (!appType) return null;

      const balanceSource =
        Number(account.balances?.current ?? account.balances?.available ?? 0) || 0;
      const balance =
        appType === "Credit Card" || appType === "Mortgages / Loans"
          ? -Math.abs(balanceSource)
          : balanceSource;

      const liability = liabilityLookup.get(account.account_id);
      const mapped = {
        id: `plaid-${account.account_id}`,
        name:
          account.name ||
          account.official_name ||
          `${institutionName} ${titleize(account.subtype)}`,
        type: appType,
        institution: institutionName || "Plaid",
        status: "Synced",
        balance,
        syncSource: "Plaid",
        plaidAccountId: account.account_id,
        plaidItemId: itemId,
        plaidType: account.type || "",
        plaidSubtype: account.subtype || "",
        plaidLastSyncAt: syncedAt,
      };

      if (appType === "Mortgages / Loans") {
        mapped.loanCategory = mapLoanCategory(account.subtype);
        mapped.interestRate =
          liability?.interest_rate?.percentage != null
            ? String(liability.interest_rate.percentage)
            : "";
        mapped.monthlyPayment =
          liability?.minimum_payment_amount != null
            ? String(liability.minimum_payment_amount)
            : liability?.last_payment_amount != null
              ? String(liability.last_payment_amount)
              : "";
      }

      return mapped;
    })
    .filter(Boolean);
}

export function mapPlaidTransactionsToAppTransactions(rawTransactions, accountsById) {
  return rawTransactions
    .map((transaction) => {
      const mappedAccount = accountsById[transaction.account_id];
      if (!mappedAccount) return null;

      const date = formatAppDate(transaction.authorized_date || transaction.date);
      if (!date) return null;

      return {
        id: `plaid-${transaction.transaction_id}`,
        plaidTransactionId: transaction.transaction_id,
        source: "plaid",
        syncSource: "Plaid",
        date,
        merchant: transaction.merchant_name || transaction.name || "Plaid Transaction",
        category: mapPlaidTransactionCategory(transaction.personal_finance_category?.primary),
        account: mappedAccount.name,
        amount: Number((-(Number(transaction.amount) || 0)).toFixed(2)),
        pending: Boolean(transaction.pending),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
