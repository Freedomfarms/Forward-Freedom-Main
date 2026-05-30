import { useMemo, useState } from "react";
import { APP_TABS, transactionCategoryOptions } from "../data/constants.jsx";
import { styles } from "../styles.js";
import { getIsoDateInputValue } from "../utils/date.js";
import { money } from "../utils/format.js";
import { accountSupportsTransactions } from "../utils/accounts.js";
import { AccountRemoveConfirmModal } from "./AccountRemoveConfirmModal.jsx";
import { HouseholdProfilesControl } from "./Common.jsx";

const TRANSACTION_FEED_GRID_COLUMNS = "140px 1.4fr minmax(270px,1.1fr) minmax(180px,0.9fr) 160px";

function formatManualDate(value) {
  if (!value) return "";

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function parseManualAmount(value) {
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeCsvValue(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function formatDateTime(value) {
  if (!value) return "Awaiting update";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMoneyPerUnit(value, unitLabel) {
  return `${money(value)}${unitLabel ? ` / ${unitLabel}` : ""}`;
}

function formatCategorySourceLabel(transaction) {
  const source = transaction.categorySource || transaction.source || "ai";
  const confidence =
    typeof transaction.categoryConfidence === "number"
      ? `${transaction.categoryConfidence}%`
      : null;

  const label =
    source === "user"
      ? "User confirmed"
      : source === "manual"
        ? "Manual category"
        : source === "learned"
          ? "Learned merchant"
          : source === "plaid"
            ? "Plaid category"
            : "AI guess";

  return confidence ? `${label} · ${confidence}` : label;
}

function buildAccountProfile(account, accounts) {
  if (!account) return null;

  const linkedLoan = accounts.find((candidate) => candidate.id === account.linkedLoanId);
  const linkedProperty = accounts.find((candidate) => candidate.id === account.linkedPropertyId);

  const baseProfile = {
    eyebrow: "Account Profile",
    title: account.nickname || account.name,
    subtitle: `${account.institution} • ${account.type}`,
    highlights: [
      { label: "Current Balance", value: money(account.balance) },
      { label: "Status", value: account.status || "Manual" },
    ],
  };

  if (account.type === "Crypto") {
    return {
      ...baseProfile,
      highlights: [
        ...baseProfile.highlights,
        { label: "Asset", value: `${account.cryptoName} (${account.cryptoSymbol})` },
        { label: "Quantity", value: `${account.quantity || 0}` },
        {
          label: "Live Price",
          value: formatMoneyPerUnit(account.lastPriceUsd, account.cryptoSymbol),
        },
        { label: "Updated", value: formatDateTime(account.lastPriceUpdatedAt) },
      ],
      note: "Quantity-based account. Value is derived from holdings x live market price.",
    };
  }

  if (account.type === "Precious Metals") {
    return {
      ...baseProfile,
      highlights: [
        ...baseProfile.highlights,
        {
          label: "Metal",
          value:
            account.metalType === "Custom" && account.metalCustomName
              ? account.metalCustomName
              : account.metalType,
        },
        { label: "Quantity", value: `${account.quantity || 0} ${account.metalUnit}` },
        {
          label: "Valuation",
          value: formatMoneyPerUnit(account.pricePerUnit, account.metalUnit),
        },
        { label: "Source", value: account.valuationSource || "Manual" },
        { label: "Updated", value: formatDateTime(account.lastValuedAt) },
      ],
      note: "Metals accounts are valuation-based and don’t post transaction ledger activity.",
    };
  }

  if (account.type === "Real Estate") {
    return {
      ...baseProfile,
      highlights: [
        ...baseProfile.highlights,
        { label: "Property Type", value: account.propertyType || "Property" },
        { label: "Address", value: account.propertyAddress || "Not set" },
        {
          label: "Market Value",
          value: account.propertyMarketValue ? money(account.propertyMarketValue) : "Not set",
        },
        { label: "Equity Mode", value: account.equitySource || "Manual" },
        { label: "Linked Loan", value: linkedLoan?.name || "Not linked" },
        { label: "Updated", value: formatDateTime(account.lastValuedAt) },
      ],
      note: "Real estate accounts track equity, not cashflow. Link a loan and market value to derive equity automatically.",
    };
  }

  if (account.type === "Mortgages / Loans") {
    return {
      ...baseProfile,
      highlights: [
        ...baseProfile.highlights,
        { label: "Loan Type", value: account.loanCategory || "Loan" },
        { label: "APR", value: account.interestRate ? `${account.interestRate}%` : "Not set" },
        { label: "Monthly Payment", value: account.monthlyPayment || "Not set" },
        { label: "Linked Property", value: linkedProperty?.name || "Not linked" },
      ],
      note: "Loans are liability records. Use the linked property field to automate real-estate equity.",
    };
  }

  if (account.type === "Credit Card") {
    return {
      ...baseProfile,
      highlights: [
        ...baseProfile.highlights,
        { label: "Posting Mode", value: "Transactional" },
        { label: "Debt Treatment", value: "Included in True Cash" },
      ],
      note: "Credit cards post transactions and automatically reduce True Cash through the shared debt model.",
    };
  }

  return {
    ...baseProfile,
    highlights: [
      ...baseProfile.highlights,
      { label: "Posting Mode", value: "Transactional" },
      { label: "Ledger", value: "Supports manual and synced transactions" },
    ],
    note: "Cash and bank accounts feed the live transaction ledger and the shared True Cash calculation.",
  };
}

export function TransactionsView({
  accounts,
  budgetRows,
  selectedAccount,
  visibleTransactions,
  setActiveTab,
  setSelectedAccount,
  connectPlaidAccount,
  addManualTransaction,
  deleteManualTransaction,
  updateTransactionCategory,
  householdProfilesProps,
  plaidIntegration,
  deleteAccount,
  subscriptions,
  transactions,
  onNavigateToEditManualAccount,
}) {
  const selectedAccountRecord = selectedAccount
    ? accounts.find((account) => account.name === selectedAccount) || null
    : null;
  const transactionCapableAccounts = accounts.filter((account) =>
    accountSupportsTransactions(account)
  );
  const defaultTransactionalAccount = accountSupportsTransactions(selectedAccountRecord)
    ? selectedAccount || transactionCapableAccounts[0]?.name || ""
    : transactionCapableAccounts[0]?.name || "";
  const [manualForm, setManualForm] = useState({
    date: getIsoDateInputValue(),
    merchant: "",
    account: defaultTransactionalAccount,
    amount: "",
    category: "",
  });
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTransactionKey, setSelectedTransactionKey] = useState(null);
  const [accountRemoveTarget, setAccountRemoveTarget] = useState(null);
  const [accountRemoveError, setAccountRemoveError] = useState("");
  const [isRemovingAccount, setIsRemovingAccount] = useState(false);
  const [filters, setFilters] = useState({
    search: "",
    category: "All",
    account: selectedAccount || "All",
    direction: "All",
    source: "All",
    review: "All",
  });

  const closeAccountRemoveModal = () => {
    if (isRemovingAccount) return;
    setAccountRemoveTarget(null);
    setAccountRemoveError("");
  };

  const confirmAccountRemoval = async () => {
    if (!accountRemoveTarget || typeof deleteAccount !== "function" || isRemovingAccount) return;

    setAccountRemoveError("");
    setIsRemovingAccount(true);

    try {
      await deleteAccount(accountRemoveTarget);
      setAccountRemoveTarget(null);
    } catch (error) {
      setAccountRemoveError(error?.message || "Unable to remove this account right now.");
    } finally {
      setIsRemovingAccount(false);
    }
  };

  const manualAccountValue = selectedAccount ? defaultTransactionalAccount : manualForm.account;
  const accountOptions = transactionCapableAccounts.map((account) => account.name);
  const accountDisplayNames = Object.fromEntries(
    transactionCapableAccounts.map((account) => [account.name, account.nickname || account.name])
  );
  const categoryOptions = Array.from(
    new Set([
      ...transactionCategoryOptions,
      ...budgetRows.map((row) => row.name).filter(Boolean),
    ])
  ).sort();
  const filterAccountOptions = Array.from(
    new Set(visibleTransactions.map((tx) => tx.account).filter(Boolean))
  ).sort();
  const filteredTransactions = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    const activeFilterAccount = selectedAccount || filters.account;
    return visibleTransactions.filter((tx) => {
      if (filters.category !== "All" && tx.category !== filters.category) return false;
      if (activeFilterAccount !== "All" && tx.account !== activeFilterAccount) return false;
      if (filters.direction === "Outflow" && tx.amount >= 0) return false;
      if (filters.direction === "Inflow" && tx.amount <= 0) return false;
      if (filters.source === "Manual" && tx.source !== "manual") return false;
      if (filters.source === "Synced" && tx.source === "manual") return false;
      if (filters.review === "Needs Review" && !tx.needsReview) return false;
      if (filters.review === "Reviewed" && tx.needsReview) return false;
      if (
        search &&
        !`${tx.date} ${tx.merchant} ${tx.category} ${tx.account}`.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
  }, [filters, selectedAccount, visibleTransactions]);
  const selectedCategory = manualForm.category;
  const accountProfile = buildAccountProfile(selectedAccountRecord, accounts);
  const isSelectedNonTransactionalAccount = selectedAccountRecord
    ? !accountSupportsTransactions(selectedAccountRecord)
    : false;
  const canAddManualTransaction =
    manualForm.date &&
    manualForm.merchant.trim() &&
    manualAccountValue.trim() &&
    accountOptions.includes(manualAccountValue) &&
    Number.isFinite(parseManualAmount(manualForm.amount)) &&
    parseManualAmount(manualForm.amount) !== 0;
  const canOpenManualEntry = accountOptions.length > 0;

  const updateManualForm = (field, value) => {
    setManualForm((current) => ({ ...current, [field]: value }));
  };

  const updateFilters = (field, value) => {
    setFilters((current) => ({ ...current, [field]: value }));
  };

  const clearFilters = () => {
    setFilters({
      search: "",
      category: "All",
      account: selectedAccount || "All",
      direction: "All",
      source: "All",
      review: "All",
    });
  };

  const submitManualTransaction = (event) => {
    event.preventDefault();
    if (!canAddManualTransaction) return;

    const didAddTransaction = addManualTransaction({
      date: formatManualDate(manualForm.date),
      merchant: manualForm.merchant.trim(),
      category: selectedCategory || undefined,
      account: manualAccountValue.trim(),
      amount: parseManualAmount(manualForm.amount),
    });
    if (!didAddTransaction) return;

    setManualForm((current) => ({
      date: current.date,
      merchant: "",
      account: selectedAccount ? defaultTransactionalAccount : current.account,
      amount: "",
      category: current.category,
    }));
    setShowManualEntry(false);
  };

  const exportFilteredTransactions = () => {
    const rows = [
      ["Date", "Merchant", "Category", "Account", "Amount", "Source"],
      ...filteredTransactions.map((tx) => [
        tx.date,
        tx.merchant,
        tx.category,
        tx.account,
        tx.amount,
        tx.source === "manual" ? "Manual" : "Synced",
      ]),
    ];
    const csv = rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const accountSlug = selectedAccount
      ? selectedAccount.replace(/\s+/g, "-").toLowerCase()
      : "all-accounts";
    link.href = url;
    link.download = `transactions-${accountSlug}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <header style={styles.pageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Transactions</h1>
          <p style={styles.pageSubtitle}>
            Connected accounts, live spending intelligence, and synced Plaid transaction feeds.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <button
            onClick={connectPlaidAccount}
            disabled={plaidIntegration?.isSyncing}
            style={{
              background: "linear-gradient(90deg,#00aaff,#0077ff)",
              border: "1px solid rgba(120,220,255,.45)",
              borderRadius: 10,
              color: "white",
              padding: "14px 24px",
              fontWeight: 800,
              boxShadow: "0 0 28px rgba(0,136,255,.35)",
              cursor: "pointer",
              opacity: plaidIntegration?.isSyncing ? 0.72 : 1,
            }}
          >
            {plaidIntegration?.isSyncing ? "Syncing Plaid..." : "⊕ Connect with Plaid"}
          </button>
        </div>
      </header>

      {showManualEntry ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,5,14,.72)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            zIndex: 9998,
            padding: "24px 24px 18px",
          }}
        >
          <form
            onSubmit={submitManualTransaction}
            style={{
              ...styles.panel,
              width: "min(1180px, 100%)",
              padding: 24,
              border: "1px solid rgba(255,159,28,.26)",
              boxShadow: "0 0 40px rgba(255,159,28,.12), inset 0 0 22px rgba(255,159,28,.06)",
              borderRadius: 22,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 18,
                marginBottom: 18,
              }}
            >
              <div>
                <div style={{ color: "white", fontSize: 20, fontWeight: 900 }}>
                  Manual Transaction Entry
                </div>
                <div style={{ color: "#8ea8ca", fontSize: 13, marginTop: 6 }}>
                  Add cash buys, offline credit cards, future payments, or backfilled transactions.
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => setShowManualEntry(false)}
                  style={{
                    background: "rgba(0,136,255,.10)",
                    border: "1px solid rgba(0,216,255,.24)",
                    borderRadius: 10,
                    color: "#d7ebff",
                    padding: "12px 18px",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Done
                </button>
                <button
                  type="submit"
                  disabled={!canAddManualTransaction}
                  style={{
                    background: canAddManualTransaction
                      ? "linear-gradient(90deg,#ff9f1c,#ff6b1c)"
                      : "rgba(120,130,150,.18)",
                    border: canAddManualTransaction
                      ? "1px solid rgba(255,208,138,.55)"
                      : "1px solid rgba(160,175,200,.16)",
                    borderRadius: 10,
                    color: canAddManualTransaction ? "white" : "#7f93ad",
                    padding: "12px 18px",
                    fontWeight: 900,
                    cursor: canAddManualTransaction ? "pointer" : "not-allowed",
                    boxShadow: canAddManualTransaction ? "0 0 24px rgba(255,159,28,.28)" : "none",
                  }}
                >
                  + Add Manual Transaction
                </button>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "140px minmax(105px,.7fr) minmax(115px,.7fr) 88px 118px",
                gap: 10,
                alignItems: "center",
              }}
            >
              {[
                ["date", "Date", "date"],
                ["merchant", "Merchant", "text"],
                ["amount", "Amount", "text"],
              ].map(([field, label, type]) => (
                <label key={field} style={{ display: "grid", gap: 7, minWidth: 0 }}>
                  <span
                    style={{
                      color: "#8fb1d9",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      fontWeight: 900,
                    }}
                  >
                    {label}
                  </span>
                  <input
                    type={type}
                    value={manualForm[field]}
                    placeholder={
                      field === "amount"
                        ? "-45.00"
                        : field === "merchant"
                          ? "Merchant name"
                          : undefined
                    }
                    onChange={(event) => updateManualForm(field, event.target.value)}
                    style={{
                      color: "#eaf3ff",
                      background: "rgba(0,136,255,.08)",
                      border: "1px solid rgba(0,216,255,.18)",
                      borderRadius: 8,
                      padding: "10px 11px",
                      outline: "none",
                      fontWeight: 800,
                      colorScheme: "dark",
                      minWidth: 0,
                    }}
                  />
                </label>
              ))}

              <label style={{ display: "grid", gap: 7, minWidth: 0 }}>
                <span
                  style={{
                    color: "#8fb1d9",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    fontWeight: 900,
                  }}
                >
                  Account
                </span>
                <select
                  value={manualAccountValue}
                  onChange={(event) => updateManualForm("account", event.target.value)}
                  disabled={Boolean(selectedAccount)}
                  style={{
                    color: "#eaf3ff",
                    background: selectedAccount ? "rgba(0,136,255,.04)" : "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.18)",
                    borderRadius: 8,
                    padding: "10px 11px",
                    outline: "none",
                    fontWeight: 800,
                    minWidth: 0,
                    opacity: selectedAccount ? 0.88 : 1,
                  }}
                >
                  {accountOptions.map((accountName) => (
                    <option key={accountName} value={accountName} style={{ background: "#061224" }}>
                      {accountDisplayNames[accountName] || accountName}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: "grid", gap: 7, minWidth: 0 }}>
                <span
                  style={{
                    color: "#8fb1d9",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    fontWeight: 900,
                  }}
                >
                  Category
                </span>
                <select
                  value={selectedCategory}
                  onChange={(event) => updateManualForm("category", event.target.value)}
                  style={{
                    color: "#eaf3ff",
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.18)",
                    borderRadius: 8,
                    padding: "10px 11px",
                    outline: "none",
                    fontWeight: 800,
                    minWidth: 0,
                  }}
                >
                  <option value="" style={{ background: "#061224" }}>
                    AI Best Guess
                  </option>
                  {categoryOptions.map((category) => (
                    <option key={category} value={category} style={{ background: "#061224" }}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ color: "#8ea8ca", fontSize: 12, marginTop: 12 }}>
              Use negative amounts for purchases/outflows and positive amounts for deposits, credits,
              or reimbursements. Leave category on AI Best Guess to let the app auto-categorize and
              learn from later edits.
            </div>
          </form>
        </div>
      ) : null}

      <div style={{ ...styles.panel, padding: 24 }}>
        {selectedAccount ? (
          <>
            <div
              style={{
                marginBottom: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid rgba(0,136,255,.12)",
                paddingBottom: 16,
              }}
            >
              <div>
                <div
                  style={{
                    color: "#8feaff",
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: 1.2,
                  }}
                >
                  Selected Account
                </div>
                <div style={{ color: "white", fontSize: 26, fontWeight: 800, marginTop: 6 }}>
                  {selectedAccount}
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedAccount(null);
                  setActiveTab(APP_TABS.ADD_ACCOUNTS);
                }}
                style={{
                  background: "rgba(0,136,255,.12)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                ← Back to Accounts
              </button>
            </div>

            {accountProfile ? (
              <div
                style={{
                  border: "1px solid rgba(0,136,255,.22)",
                  borderRadius: 16,
                  background: "rgba(3,17,32,.72)",
                  padding: 20,
                  marginBottom: 18,
                  boxShadow: "inset 0 0 24px rgba(0,80,160,.08)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                  <div>
                    <div
                      style={{
                        color: "#8feaff",
                        fontSize: 12,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontWeight: 800,
                      }}
                    >
                      {accountProfile.eyebrow}
                    </div>
                    <div style={{ color: "white", fontSize: 26, fontWeight: 900, marginTop: 8 }}>
                      {accountProfile.title}
                    </div>
                    <div style={{ color: "#8fb1d9", fontSize: 14, marginTop: 8 }}>
                      {accountProfile.subtitle}
                    </div>
                  </div>
                  <div
                    style={{
                      color: selectedAccountRecord.balance < 0 ? "#ff8fa3" : "#eaf3ff",
                      fontSize: 28,
                      fontWeight: 900,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {money(selectedAccountRecord.balance)}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: 14,
                    marginTop: 18,
                  }}
                >
                  {accountProfile.highlights.map((item) => (
                    <div
                      key={item.label}
                      style={{
                        border: "1px solid rgba(0,136,255,.14)",
                        borderRadius: 12,
                        background: "rgba(0,22,48,.36)",
                        padding: "14px 16px",
                      }}
                    >
                      <div
                        style={{
                          color: "#8fb1d9",
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: 0.8,
                          marginBottom: 8,
                        }}
                      >
                        {item.label}
                      </div>
                      <div style={{ color: "white", fontSize: 15, fontWeight: 800 }}>
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ color: "#8ea8ca", fontSize: 13, lineHeight: 1.6, marginTop: 16 }}>
                  {accountProfile.note}
                </div>
              </div>
            ) : null}

            {selectedAccountRecord ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  marginBottom: 18,
                }}
              >
                {selectedAccountRecord.plaidItemId ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAccountRemoveError("");
                      setAccountRemoveTarget(selectedAccountRecord);
                    }}
                    style={{
                      background: "rgba(255,36,77,.1)",
                      border: "1px solid rgba(255,93,122,.32)",
                      borderRadius: 8,
                      color: "#ffd9df",
                      padding: "8px 14px",
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Disconnect institution
                  </button>
                ) : (
                  <>
                    {selectedAccountRecord.status === "Manual" ? (
                      <button
                        type="button"
                        onClick={() => onNavigateToEditManualAccount?.(selectedAccountRecord.id)}
                        style={{
                          background: "rgba(0,136,255,.12)",
                          border: "1px solid rgba(0,216,255,.32)",
                          borderRadius: 8,
                          color: "#eaf3ff",
                          padding: "8px 14px",
                          fontWeight: 700,
                          fontSize: 12,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Edit account
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setAccountRemoveError("");
                        setAccountRemoveTarget(selectedAccountRecord);
                      }}
                      style={{
                        background: "rgba(255,36,77,.1)",
                        border: "1px solid rgba(255,93,122,.32)",
                        borderRadius: 8,
                        color: "#ffd9df",
                        padding: "8px 14px",
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Delete account
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 22,
          }}
        >
          <div style={{ color: "white", fontSize: 22, fontWeight: 700 }}>
            {selectedAccount ? `${selectedAccount} Transactions` : "Live Transaction Feed"}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setShowManualEntry(true)}
              disabled={!canOpenManualEntry}
              style={{
                background: canOpenManualEntry
                  ? "rgba(255,159,28,.12)"
                  : "rgba(120,130,150,.12)",
                border: canOpenManualEntry
                  ? "1px solid rgba(255,159,28,.28)"
                  : "1px solid rgba(160,175,200,.16)",
                color: canOpenManualEntry ? "#fff2db" : "#7f93ad",
                borderRadius: 8,
                padding: "10px 14px",
                cursor: canOpenManualEntry ? "pointer" : "not-allowed",
                fontWeight: 800,
              }}
            >
              + Manual Transaction
            </button>
            <button
              onClick={() => setShowFilters((current) => !current)}
              style={{
                background: "rgba(0,136,255,.12)",
                border: "1px solid rgba(0,136,255,.28)",
                color: "#d7ebff",
                borderRadius: 8,
                padding: "10px 14px",
                cursor: "pointer",
              }}
            >
              {showFilters ? "Hide Filters" : "Filter"}
            </button>
            <button
              onClick={exportFilteredTransactions}
              style={{
                background: "rgba(0,136,255,.12)",
                border: "1px solid rgba(0,136,255,.28)",
                color: "#d7ebff",
                borderRadius: 8,
                padding: "10px 14px",
                cursor: "pointer",
              }}
            >
              Export
            </button>
          </div>
        </div>

        {showFilters ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr 1fr auto",
              gap: 10,
              marginBottom: 18,
              padding: 16,
              borderRadius: 14,
              border: "1px solid rgba(0,136,255,.18)",
              background: "rgba(0,22,48,.36)",
              alignItems: "end",
            }}
          >
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Search
              </span>
              <input
                type="text"
                value={filters.search}
                onChange={(event) => updateFilters("search", event.target.value)}
                placeholder="Merchant, category, account..."
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Category
              </span>
              <select
                value={filters.category}
                onChange={(event) => updateFilters("category", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                }}
              >
                <option value="All" style={{ background: "#061224" }}>
                  All
                </option>
                {categoryOptions.map((category) => (
                  <option key={category} value={category} style={{ background: "#061224" }}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Account
              </span>
              <select
                value={selectedAccount || filters.account}
                onChange={(event) => updateFilters("account", event.target.value)}
                disabled={Boolean(selectedAccount)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                  opacity: selectedAccount ? 0.82 : 1,
                }}
              >
                <option value="All" style={{ background: "#061224" }}>
                  All
                </option>
                {filterAccountOptions.map((accountName) => (
                  <option key={accountName} value={accountName} style={{ background: "#061224" }}>
                    {accountDisplayNames[accountName] || accountName}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Direction
              </span>
              <select
                value={filters.direction}
                onChange={(event) => updateFilters("direction", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                }}
              >
                {["All", "Inflow", "Outflow"].map((option) => (
                  <option key={option} value={option} style={{ background: "#061224" }}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Source
              </span>
              <select
                value={filters.source}
                onChange={(event) => updateFilters("source", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                }}
              >
                {["All", "Synced", "Manual"].map((option) => (
                  <option key={option} value={option} style={{ background: "#061224" }}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Review
              </span>
              <select
                value={filters.review}
                onChange={(event) => updateFilters("review", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 8,
                  padding: "10px 11px",
                  outline: "none",
                  fontWeight: 700,
                }}
              >
                {["All", "Needs Review", "Reviewed"].map((option) => (
                  <option key={option} value={option} style={{ background: "#061224" }}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={clearFilters}
              style={{
                background: "rgba(0,136,255,.10)",
                border: "1px solid rgba(0,216,255,.20)",
                borderRadius: 8,
                color: "#d7ebff",
                padding: "10px 14px",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Clear
            </button>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: TRANSACTION_FEED_GRID_COLUMNS,
            padding: "0 16px 12px",
            color: "#7294bb",
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: 1,
            borderBottom: "1px solid rgba(0,136,255,.14)",
            columnGap: 10,
          }}
        >
          <div>Date</div>
          <div>Merchant</div>
          <div style={{ paddingLeft: 6 }}>Category</div>
          <div style={{ paddingLeft: 14 }}>Account</div>
          <div style={{ textAlign: "right" }}>Amount</div>
        </div>

        <div style={{ maxHeight: "62vh", overflowY: "auto", paddingRight: 4 }}>
          {visibleTransactions.length > 0 ? (
            filteredTransactions.map((tx, index) => {
              const rowKey = `${tx.id || tx.date}-${tx.merchant}-${tx.account}-${tx.amount}`;
              const isSelectedRow = selectedTransactionKey === rowKey;
              const defaultRowBackground = tx.needsReview
                ? "rgba(255,159,28,.06)"
                : index % 2 === 0
                  ? "rgba(255,255,255,.01)"
                  : "transparent";
              return (
                <div
                  key={rowKey}
                  onClick={() => setSelectedTransactionKey(rowKey)}
                  onFocusCapture={() => setSelectedTransactionKey(rowKey)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: TRANSACTION_FEED_GRID_COLUMNS,
                    alignItems: "center",
                    padding: "9px 16px",
                    margin: "2px 8px",
                    borderRadius: 10,
                    borderBottom: "1px solid rgba(0,136,255,.08)",
                    border: isSelectedRow
                      ? "1px solid rgba(0,216,255,.9)"
                      : "1px solid transparent",
                    background: isSelectedRow
                      ? "linear-gradient(96deg, rgba(0,136,255,.32), rgba(0,216,255,.20) 52%, rgba(4,18,36,.9))"
                      : defaultRowBackground,
                    borderLeft: isSelectedRow
                      ? "3px solid rgba(0,216,255,1)"
                      : tx.needsReview
                        ? "2px solid rgba(255,159,28,.45)"
                        : "2px solid transparent",
                    boxShadow: isSelectedRow
                      ? "0 0 32px rgba(0,136,255,.45), inset 0 0 30px rgba(0,216,255,.24)"
                      : "none",
                    cursor: "pointer",
                    transition: "border-color 120ms ease, box-shadow 160ms ease, background 160ms ease",
                    columnGap: 10,
                  }}
                >
                <div
                  onDoubleClick={(event) => {
                    if (tx.source !== "manual") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget(tx);
                  }}
                  title={tx.source === "manual" ? "Double click to delete manual transaction" : ""}
                  style={{
                    color: tx.source === "manual" ? "#ffd08a" : "#8fb1d9",
                    fontSize: 14,
                    cursor: tx.source === "manual" ? "pointer" : "default",
                  }}
                >
                  {tx.date}
                </div>
                <div style={{ color: "white", fontWeight: 700 }}>{tx.merchant}</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minWidth: 0,
                    paddingLeft: 6,
                  }}
                >
                  <select
                    value={tx.category}
                    onChange={(event) => updateTransactionCategory(tx, event.target.value)}
                    style={{
                      color: "#b8d3f3",
                      background: "rgba(0,136,255,.08)",
                      border: "1px solid rgba(0,216,255,.18)",
                      borderRadius: 8,
                      padding: "7px 10px",
                      outline: "none",
                      width: "100%",
                      cursor: "pointer",
                      boxShadow: "inset 0 0 14px rgba(0,136,255,.08)",
                      minWidth: 0,
                    }}
                  >
                    {categoryOptions.map((category) => (
                      <option
                        key={category}
                        value={category}
                        style={{ background: "#061224", color: "#eaf3ff" }}
                      >
                        {category}
                      </option>
                    ))}
                    {!categoryOptions.includes(tx.category) ? (
                      <option
                        value={tx.category}
                        style={{ background: "#061224", color: "#eaf3ff" }}
                      >
                        {tx.category}
                      </option>
                    ) : null}
                  </select>
                  <div
                    style={{
                      color: tx.needsReview ? "#ffb65d" : "#7294bb",
                      fontSize: 11,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {formatCategorySourceLabel(tx)}
                    {tx.needsReview ? " • Needs review" : ""}
                  </div>
                </div>
                <div style={{ color: "#7ebeff", paddingLeft: 14 }}>
                  {accountDisplayNames[tx.account] || tx.account}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    color: tx.amount > 0 ? "#00f59b" : "#ff5d7a",
                    fontWeight: 800,
                    fontSize: 15,
                  }}
                >
                  {tx.amount > 0 ? "+" : ""}$
                  {Math.abs(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </div>
              );
            })
          ) : (
            <div
              style={{
                padding: "34px 16px",
                color: "#8ea8ca",
                textAlign: "center",
                fontSize: 14,
              }}
            >
              {selectedAccount
                ? isSelectedNonTransactionalAccount
                  ? `${selectedAccount} is a valuation-based account, so it does not keep a spending ledger here. For manual entries use Edit account above; for Plaid-linked institutions use Disconnect above.`
                  : filters.search ||
                      filters.category !== "All" ||
                      filters.account !== (selectedAccount || "All") ||
                      filters.direction !== "All" ||
                      filters.source !== "All" ||
                      filters.review !== "All"
                    ? `No transactions in ${selectedAccount} match the current filters.`
                    : `No transactions have posted to ${selectedAccount} yet. Add one manually or sync the account to keep balances and budgets in sync.`
                : filters.search ||
                    filters.category !== "All" ||
                    filters.account !== "All" ||
                    filters.direction !== "All" ||
                    filters.source !== "All" ||
                    filters.review !== "All"
                  ? "No transactions match the current filters."
                  : "No transactions are available yet. Add a transactional account or connect Plaid to begin building the live ledger."}
            </div>
          )}
        </div>
      </div>

      {deleteTarget ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,5,14,.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              ...styles.panel,
              width: 420,
              padding: 26,
              boxShadow: "0 0 55px rgba(0,136,255,.34)",
            }}
          >
            <div
              style={{
                color: "#8feaff",
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: 1.2,
                marginBottom: 10,
              }}
            >
              Confirm Delete
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900, lineHeight: 1.15 }}>
              Delete manual transaction?
            </div>
            <p style={{ color: "#a8bfdc", lineHeight: 1.55, marginTop: 14 }}>
              This removes {deleteTarget.merchant} on {deleteTarget.date}. Connected transactions
              are not affected.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
              <button
                onClick={() => setDeleteTarget(null)}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteManualTransaction(deleteTarget.id);
                  setDeleteTarget(null);
                }}
                style={{
                  background: "linear-gradient(90deg,#ff244d,#ff5d7a)",
                  border: "1px solid rgba(255,93,122,.55)",
                  color: "white",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 0 22px rgba(255,36,77,.32)",
                }}
              >
                Delete Transaction
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AccountRemoveConfirmModal
        deleteTarget={accountRemoveTarget}
        accounts={accounts}
        transactions={transactions}
        subscriptions={subscriptions}
        plaidItems={plaidIntegration?.items}
        onBackdropClick={closeAccountRemoveModal}
        onCancel={closeAccountRemoveModal}
        onConfirm={confirmAccountRemoval}
        isDeleting={isRemovingAccount}
        deleteError={accountRemoveError}
      />
    </div>
  );
}
