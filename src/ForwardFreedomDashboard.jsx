import { useEffect, useState } from "react";
import { APP_TABS, budgetMonths } from "./data/constants.jsx";
import { styles } from "./styles.js";
import { getBudgetPeriodAtOffset, getCurrentTimestamp } from "./utils/date.js";
import { money, parseMoney } from "./utils/format.js";
import {
  accountSupportsTransactions,
  calculateRealEstateEquity,
  normalizeAccount,
} from "./utils/accounts.js";
import {
  createEmptyUserProfile,
  loadPersistedAppState,
  persistAppState,
} from "./utils/appState.js";
import {
  calculateCryptoBalance,
  fetchCryptoQuotes,
  isCryptoPriceStale,
} from "./utils/cryptoPricing.js";
import {
  fetchPreciousMetalsSpotPrices,
  isPreciousMetalsPriceStale,
  normalizePreciousMetalsPricePerUnit,
} from "./utils/preciousMetalsPricing.js";
import { AccountsView } from "./components/AccountsView.jsx";
import { BudgetCommandCenter } from "./components/BudgetCommandCenter.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { ForecastLab } from "./components/ForecastLab.jsx";
import { LandingPage } from "./components/LandingPage.jsx";
import { AppSidebar, ModulePlaceholder } from "./components/Layout.jsx";
import { OperationsBoard } from "./components/OperationsBoard.jsx";
import { RecurringSubscriptions } from "./components/RecurringSubscriptions.jsx";
import { TransactionsView } from "./components/TransactionsView.jsx";

function roundCurrency(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function normalizeCryptoPrice(value) {
  return Number((Number(value) || 0).toFixed(8));
}

const LIQUID_ACCOUNT_TYPES = new Set(["Checking", "Savings", "Manual Cash"]);
const CRYPTO_PRICE_SOURCE = "CoinGecko";
const THIRTY_DAY_WINDOW = 30;
const SNAPSHOT_RETENTION_DAYS = 400;
const EMPTY_USER_STATE = Object.freeze({
  id: null,
  name: "",
  selectedAccount: null,
  accounts: [],
  transactions: [],
  budgetRows: [],
  incomeStreams: [],
  projectionAdjustments: {},
  subscriptions: [],
  activeTab: APP_TABS.DASHBOARD,
  activeRange: "ALL",
  metricSnapshots: {},
});

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trimMetricSnapshots(snapshots) {
  const sortedEntries = Object.entries(snapshots).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sortedEntries.slice(-SNAPSHOT_RETENTION_DAYS));
}

function buildTrackedMetricMeta(snapshots, metricKey, currentValue, increaseIsGood = true) {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - THIRTY_DAY_WINDOW);
  const thresholdKey = getLocalDateKey(thresholdDate);
  const comparisonKey = Object.keys(snapshots)
    .sort()
    .reverse()
    .find(
      (key) =>
        key <= thresholdKey && snapshots[key] && typeof snapshots[key][metricKey] === "number"
    );

  if (!comparisonKey) {
    return {
      change: "Tracking 30-day baseline",
      changeColor: "#8fb1d9",
      changeIcon: "•",
      subLabel: "daily tracking in progress",
    };
  }

  const previousValue = Number(snapshots[comparisonKey][metricKey]) || 0;
  const delta = roundCurrency(currentValue - previousValue);
  const changeIcon = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";

  if (previousValue === 0) {
    return {
      change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))}`,
      changeColor: "#8fb1d9",
      changeIcon,
      subLabel: `since ${comparisonKey}`,
    };
  }

  const percentChange = Math.abs((delta / Math.abs(previousValue)) * 100);
  const isGood = delta === 0 ? true : increaseIsGood ? delta >= 0 : delta <= 0;

  return {
    change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))} (${percentChange.toFixed(2)}%)`,
    changeColor: isGood ? "#00f59b" : "#ff355d",
    changeIcon,
    subLabel: "vs last 30 days",
  };
}

function syncDerivedAccountValues(accounts) {
  return accounts.map((account) => {
    if (account.type !== "Real Estate") return account;
    if (!account.linkedLoanId || !account.propertyMarketValue) return account;

    const linkedLoan = accounts.find((candidate) => candidate.id === account.linkedLoanId);
    if (!linkedLoan) return account;

    const nextEquity = calculateRealEstateEquity(account.propertyMarketValue, linkedLoan.balance);
    if (account.balance === nextEquity && account.equitySource === "Derived") {
      return account;
    }

    return {
      ...account,
      balance: nextEquity,
      equitySource: "Derived",
      lastValuedAt: account.lastValuedAt || null,
    };
  });
}

function buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth) {
  return {
    liquidCash: roundCurrency(liquidCash),
    creditCardDebt: roundCurrency(creditCardDebt),
    totalNetWorth: roundCurrency(totalNetWorth),
  };
}

function ensureTodayMetricSnapshot(metricSnapshots, nextSnapshot) {
  const todayKey = getLocalDateKey();
  const existing = metricSnapshots[todayKey];

  if (
    existing &&
    existing.liquidCash === nextSnapshot.liquidCash &&
    existing.creditCardDebt === nextSnapshot.creditCardDebt &&
    existing.totalNetWorth === nextSnapshot.totalNetWorth
  ) {
    return metricSnapshots;
  }

  return trimMetricSnapshots({
    ...metricSnapshots,
    [todayKey]: nextSnapshot,
  });
}

function getDisplayUserName(user, index = 0) {
  return user?.name?.trim() || `User ${index + 1}`;
}

function ForwardFreedomDashboard() {
  const [initialAppState] = useState(() => loadPersistedAppState());
  const [currentView, setCurrentView] = useState("landing");
  const [users, setUsers] = useState(initialAppState.users);
  const [activeUserId, setActiveUserId] = useState(initialAppState.activeUserId);
  const [editingUserId, setEditingUserId] = useState(null);
  const [draftUserName, setDraftUserName] = useState("");
  const activeUser = users.find((user) => user.id === activeUserId) || users[0] || EMPTY_USER_STATE;
  const activeUserIndex = users.findIndex((user) => user.id === activeUser?.id);
  const activeUserName = getDisplayUserName(activeUser, activeUserIndex >= 0 ? activeUserIndex : 0);
  const accounts = activeUser.accounts;
  const transactions = activeUser.transactions;
  const selectedAccount = activeUser.selectedAccount;
  const budgetRows = activeUser.budgetRows;
  const incomeStreams = activeUser.incomeStreams;
  const projectionAdjustments = activeUser.projectionAdjustments;
  const subscriptions = activeUser.subscriptions;
  const activeTab = activeUser.activeTab;
  const activeRange = activeUser.activeRange;
  const metricSnapshots = activeUser.metricSnapshots;
  const setActiveUserField = (field, valueOrUpdater) => {
    if (!activeUser?.id) return;

    setUsers((currentUsers) =>
      currentUsers.map((user) => {
        if (user.id !== activeUser.id) return user;

        const nextValue =
          typeof valueOrUpdater === "function" ? valueOrUpdater(user[field]) : valueOrUpdater;
        return user[field] === nextValue ? user : { ...user, [field]: nextValue };
      })
    );
  };
  const setAccounts = (valueOrUpdater) => setActiveUserField("accounts", valueOrUpdater);
  const setTransactions = (valueOrUpdater) => setActiveUserField("transactions", valueOrUpdater);
  const setSelectedAccount = (valueOrUpdater) =>
    setActiveUserField("selectedAccount", valueOrUpdater);
  const setBudgetRows = (valueOrUpdater) => setActiveUserField("budgetRows", valueOrUpdater);
  const setIncomeStreams = (valueOrUpdater) => setActiveUserField("incomeStreams", valueOrUpdater);
  const setProjectionAdjustments = (valueOrUpdater) =>
    setActiveUserField("projectionAdjustments", valueOrUpdater);
  const setSubscriptions = (valueOrUpdater) => setActiveUserField("subscriptions", valueOrUpdater);
  const setActiveTab = (valueOrUpdater) => setActiveUserField("activeTab", valueOrUpdater);
  const setActiveRange = (valueOrUpdater) => setActiveUserField("activeRange", valueOrUpdater);
  const syncedAccounts = syncDerivedAccountValues(accounts);

  const liquidCash = syncedAccounts
    .filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type))
    .reduce((sum, account) => sum + account.balance, 0);

  const creditCardDebt = Math.abs(
    syncedAccounts
      .filter((account) => account.type === "Credit Card")
      .reduce((sum, account) => sum + account.balance, 0)
  );

  const trueCash = liquidCash - creditCardDebt;

  const investmentTotal = syncedAccounts
    .filter((account) => account.type === "Investment")
    .reduce((sum, account) => sum + account.balance, 0);

  const cryptoTotal = syncedAccounts
    .filter((account) => account.type === "Crypto")
    .reduce((sum, account) => sum + account.balance, 0);

  const preciousMetalsTotal = syncedAccounts
    .filter((account) => account.type === "Precious Metals")
    .reduce((sum, account) => sum + account.balance, 0);

  const realEstateTotal = syncedAccounts
    .filter((account) => account.type === "Real Estate")
    .reduce((sum, account) => sum + account.balance, 0);

  const retirementTotal = syncedAccounts
    .filter((account) => account.type === "Retirement")
    .reduce((sum, account) => sum + account.balance, 0);

  const currentMonth = getBudgetPeriodAtOffset(0).month;
  const nextMonth = getBudgetPeriodAtOffset(1).month;
  const currentMonthIncome = incomeStreams
    .filter((s) => (s.months || budgetMonths).includes(currentMonth))
    .reduce((sum, s) => sum + parseMoney(s.amount), 0);
  const currentMonthBudget = budgetRows
    .filter((r) => (r.months || budgetMonths).includes(currentMonth))
    .reduce((sum, r) => sum + Number(r.budget || 0), 0);
  const monthlyFlow = currentMonthIncome - currentMonthBudget;
  const nextMonthIncome = incomeStreams
    .filter((s) => (s.months || budgetMonths).includes(nextMonth))
    .reduce((sum, s) => sum + parseMoney(s.amount), 0);
  const nextMonthBudget = budgetRows
    .filter((r) => (r.months || budgetMonths).includes(nextMonth))
    .reduce((sum, r) => sum + Number(r.budget || 0), 0);
  const nextMonthFlow = nextMonthIncome - nextMonthBudget;

  const totalNetWorth = Math.max(
    trueCash +
      investmentTotal +
      cryptoTotal +
      preciousMetalsTotal +
      realEstateTotal +
      retirementTotal,
    1
  );
  const pct = (v) => `${((v / totalNetWorth) * 100).toFixed(1)}%`;
  const trackedMetricSnapshots = ensureTodayMetricSnapshot(
    metricSnapshots,
    buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth)
  );
  const persistedUsers = users.map((user, index) =>
    user.id === activeUser?.id
      ? {
          ...user,
          name: getDisplayUserName(user, index),
          accounts: syncedAccounts,
          metricSnapshots: trackedMetricSnapshots,
        }
      : {
          ...user,
          name: getDisplayUserName(user, index),
        }
  );

  const dynamicAllocations = [
    {
      name: "True Cash",
      amount: money(trueCash),
      percent: pct(trueCash),
      color: "#8b34ff",
      valueNumber: trueCash,
    },
    {
      name: "Investments",
      amount: money(investmentTotal),
      percent: pct(investmentTotal),
      color: "#168bff",
      valueNumber: investmentTotal,
    },
    {
      name: "Crypto",
      amount: money(cryptoTotal),
      percent: pct(cryptoTotal),
      color: "#00d8ff",
      valueNumber: cryptoTotal,
    },
    {
      name: "Precious Metals",
      amount: money(preciousMetalsTotal),
      percent: pct(preciousMetalsTotal),
      color: "#f6c453",
      valueNumber: preciousMetalsTotal,
    },
    {
      name: "Real Estate",
      amount: money(realEstateTotal),
      percent: pct(realEstateTotal),
      color: "#18d3ff",
      valueNumber: realEstateTotal,
    },
    {
      name: "Retirement",
      amount: money(retirementTotal),
      percent: pct(retirementTotal),
      color: "#ffb65d",
      valueNumber: retirementTotal,
    },
  ];

  useEffect(() => {
    persistAppState({
      users: persistedUsers,
      activeUserId: activeUser?.id || persistedUsers[0]?.id || null,
    });
  }, [activeUser?.id, persistedUsers]);

  const dynamicMetrics = [
    {
      icon: "▱",
      title: "LIQUID CASH",
      value: money(liquidCash),
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "liquidCash", liquidCash, true),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: "▭",
      title: "CREDIT CARD DEBT",
      value: money(creditCardDebt),
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "creditCardDebt", creditCardDebt, false),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: "⌁",
      title: "MONTHLY CASH FLOW",
      value: money(monthlyFlow),
      change: monthlyFlow >= 0 ? "Projected surplus" : "Projected deficit",
      changeColor: monthlyFlow >= 0 ? "#00f59b" : "#ff355d",
      changeIcon: monthlyFlow >= 0 ? "↑" : "↓",
      subLabel: "current month plan",
      onClick: () => setActiveTab(APP_TABS.BUDGET_COMMAND_CENTER),
    },
    {
      icon: "▰",
      title: "NEXT MONTH CASH FLOW",
      value: money(nextMonthFlow),
      change: nextMonthFlow >= 0 ? "Projected surplus" : "Projected deficit",
      changeColor: nextMonthFlow >= 0 ? "#00f59b" : "#ff355d",
      changeIcon: nextMonthFlow >= 0 ? "↑" : "↓",
      subLabel: `${nextMonth} plan`,
      onClick: () => setActiveTab(APP_TABS.BUDGET_COMMAND_CENTER),
    },
  ];

  useEffect(() => {
    const liveMetalsAccounts = accounts.filter(
      (account) =>
        account.type === "Precious Metals" &&
        account.valuationSource === "Live Spot" &&
        account.metalType !== "Custom" &&
        isPreciousMetalsPriceStale(account.lastValuedAt)
    );

    if (liveMetalsAccounts.length === 0) return;

    let cancelled = false;
    fetchPreciousMetalsSpotPrices()
      .then((quotes) => {
        if (cancelled || Object.keys(quotes).length === 0) return;

        setUsers((currentUsers) =>
          currentUsers.map((user) => {
            if (user.id !== activeUser.id) return user;

            let changed = false;
            const nextAccounts = user.accounts.map((account) => {
              if (
                account.type !== "Precious Metals" ||
                account.valuationSource !== "Live Spot" ||
                account.metalType === "Custom"
              ) {
                return account;
              }

              const quote = quotes[account.metalType];
              if (!quote) return account;

              const pricePerUnit = normalizePreciousMetalsPricePerUnit(
                quote.pricePerTroyOunce,
                account.metalUnit
              );
              const nextBalance = roundCurrency((Number(account.quantity) || 0) * pricePerUnit);
              if (
                account.pricePerUnit === pricePerUnit &&
                account.balance === nextBalance &&
                account.lastValuedAt === quote.updatedAt
              ) {
                return account;
              }

              changed = true;
              return {
                ...account,
                pricePerUnit,
                balance: nextBalance,
                lastValuedAt: quote.updatedAt,
              };
            });

            return changed ? { ...user, accounts: nextAccounts } : user;
          })
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id]);

  useEffect(() => {
    const staleCryptoAccounts = accounts.filter(
      (account) =>
        account.type === "Crypto" &&
        account.cryptoAssetId &&
        isCryptoPriceStale(account.lastPriceUpdatedAt)
    );

    if (staleCryptoAccounts.length === 0) return;

    let cancelled = false;
    const uniqueAssetIds = [
      ...new Set(staleCryptoAccounts.map((account) => account.cryptoAssetId)),
    ];

    fetchCryptoQuotes(uniqueAssetIds)
      .then((quotes) => {
        if (cancelled || Object.keys(quotes).length === 0) return;

        setUsers((currentUsers) =>
          currentUsers.map((user) => {
            if (user.id !== activeUser.id) return user;

            let changed = false;
            const nextAccounts = user.accounts.map((account) => {
              if (account.type !== "Crypto" || !account.cryptoAssetId) return account;

              const quote = quotes[account.cryptoAssetId];
              if (!quote) return account;

              const nextPriceUsd = normalizeCryptoPrice(quote.priceUsd);
              const nextBalance = calculateCryptoBalance(account.quantity, nextPriceUsd);
              const nextUpdatedAt = quote.lastUpdatedAt;

              if (
                account.lastPriceUsd === nextPriceUsd &&
                account.balance === nextBalance &&
                account.lastPriceUpdatedAt === nextUpdatedAt
              ) {
                return account;
              }

              changed = true;
              return {
                ...account,
                lastPriceUsd: nextPriceUsd,
                lastPriceUpdatedAt: nextUpdatedAt,
                balance: nextBalance,
                priceSource: CRYPTO_PRICE_SOURCE,
              };
            });

            return changed ? { ...user, accounts: nextAccounts } : user;
          })
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id]);

  const connectMockPlaidAccount = () => {
    const newAccountNumber = accounts.length + 1;
    const newAccount = {
      name: `Plaid Linked Account ${newAccountNumber}`,
      type: "Checking",
      institution: "Plaid Secure Link",
      balance: 6250 + newAccountNumber * 725,
      status: "Synced",
    };
    const newTransactions = [
      {
        date: "May 13, 2026",
        merchant: "Plaid Sync Deposit",
        category: "Income",
        account: newAccount.name,
        amount: 1250.0,
      },
      {
        date: "May 13, 2026",
        merchant: "Whole Foods",
        category: "Groceries",
        account: newAccount.name,
        amount: -86.42,
      },
      {
        date: "May 13, 2026",
        merchant: "Electric Utility",
        category: "Utilities",
        account: newAccount.name,
        amount: -142.18,
      },
    ];

    setAccounts((current) => [...current, normalizeAccount(newAccount, current.length)]);
    setTransactions((current) => [...newTransactions, ...current]);
    setActiveTab(APP_TABS.TRANSACTIONS);
  };

  const addManualAccount = ({
    name,
    type,
    institution,
    balance,
    quantity,
    metalType,
    metalCustomName,
    metalUnit,
    pricePerUnit,
    valuationSource,
    lastValuedAt,
    propertyAddress,
    propertyType,
    propertyMarketValue,
    equitySource,
    linkedLoanId,
    linkedPropertyId,
    loanCategory,
    interestRate,
    monthlyPayment,
    cryptoAssetId,
    cryptoName,
    cryptoSymbol,
    cryptoThumb,
    lastPriceUsd,
    lastPriceUpdatedAt,
    priceSource,
  }) => {
    const currentTimestamp = getCurrentTimestamp();
    const newAccount = {
      name,
      type,
      institution: institution || "Manual",
      balance: roundCurrency(balance),
      status: "Manual",
      propertyAddress: propertyAddress || "",
      propertyType: propertyType || "",
      propertyMarketValue: Number(propertyMarketValue) || 0,
      equitySource: equitySource || "Manual",
      lastValuedAt: currentTimestamp,
      linkedLoanId: linkedLoanId || "",
      linkedPropertyId: linkedPropertyId || "",
      loanCategory: loanCategory || "",
      interestRate: interestRate || "",
      monthlyPayment: monthlyPayment || "",
    };

    if (type === "Crypto" && cryptoAssetId) {
      Object.assign(newAccount, {
        quantity: Number(quantity) || 0,
        cryptoAssetId,
        cryptoName,
        cryptoSymbol,
        cryptoThumb,
        lastPriceUsd: normalizeCryptoPrice(lastPriceUsd),
        lastPriceUpdatedAt: Number(lastPriceUpdatedAt) || currentTimestamp,
        priceSource: priceSource || CRYPTO_PRICE_SOURCE,
      });
    }

    if (type === "Precious Metals") {
      Object.assign(newAccount, {
        quantity: Number(quantity) || 0,
        metalType: metalType || "Gold",
        metalCustomName: metalCustomName || "",
        metalUnit: metalUnit || "oz",
        pricePerUnit: Number(pricePerUnit) || 0,
        valuationSource: valuationSource || "Manual",
        lastValuedAt: Number(lastValuedAt) || currentTimestamp,
      });
    }

    setAccounts((current) => [...current, normalizeAccount(newAccount, current.length)]);
    openAccountTransactions(name);
  };

  const selectedTransactions = selectedAccount
    ? transactions.filter((tx) => tx.account === selectedAccount)
    : [];

  const visibleTransactions = selectedAccount ? selectedTransactions : transactions;

  const openAccountTransactions = (accountName) => {
    setSelectedAccount(accountName);
    setActiveTab(APP_TABS.TRANSACTIONS);
  };

  const addManualTransaction = (transaction) => {
    const targetAccountName = transaction.account.trim();
    const targetAccount = accounts.find((account) => account.name === targetAccountName);
    const amount = roundCurrency(transaction.amount);

    if (!targetAccount || !Number.isFinite(amount) || amount === 0) return false;
    if (!accountSupportsTransactions(targetAccount)) return false;

    setTransactions((current) => [
      {
        ...transaction,
        account: targetAccountName,
        amount,
        id: `manual-tx-${getCurrentTimestamp()}-${current.length + 1}`,
        source: "manual",
      },
      ...current,
    ]);
    setAccounts((current) =>
      current.map((account) =>
        account.name === targetAccountName
          ? { ...account, balance: roundCurrency(account.balance + amount) }
          : account
      )
    );
    return true;
  };

  const deleteManualTransaction = (transactionId) => {
    const transactionToDelete = transactions.find(
      (transaction) => transaction.id === transactionId && transaction.source === "manual"
    );

    if (!transactionToDelete) return;

    setTransactions((current) =>
      current.filter(
        (transaction) => transaction.id !== transactionId || transaction.source !== "manual"
      )
    );
    setAccounts((current) =>
      current.map((account) =>
        account.name === transactionToDelete.account
          ? {
              ...account,
              balance: roundCurrency(account.balance - transactionToDelete.amount),
            }
          : account
      )
    );
  };

  const updateTransactionCategory = (transactionToUpdate, nextCategory) => {
    if (!transactionToUpdate) return;

    setTransactions((current) => {
      if (transactionToUpdate.id) {
        return current.map((tx) =>
          tx.id === transactionToUpdate.id ? { ...tx, category: nextCategory } : tx
        );
      }

      const existingIndex = current.findIndex(
        (tx) =>
          tx.date === transactionToUpdate.date &&
          tx.merchant === transactionToUpdate.merchant &&
          tx.account === transactionToUpdate.account &&
          tx.amount === transactionToUpdate.amount
      );

      if (existingIndex >= 0) {
        return current.map((tx, index) =>
          index === existingIndex ? { ...tx, category: nextCategory } : tx
        );
      }

      return current;
    });
  };

  const startEditingActiveUser = () => {
    if (!activeUser?.id) return;
    setEditingUserId(activeUser.id);
    setDraftUserName(activeUserName);
  };

  const saveUserName = (userId) => {
    const targetIndex = users.findIndex((user) => user.id === userId);
    if (targetIndex < 0) {
      setEditingUserId(null);
      setDraftUserName("");
      return;
    }

    const nextName = draftUserName.trim() || `User ${targetIndex + 1}`;
    setUsers((currentUsers) =>
      currentUsers.map((user, index) =>
        user.id === userId ? { ...user, name: nextName || `User ${index + 1}` } : user
      )
    );
    setEditingUserId(null);
    setDraftUserName("");
  };

  const cancelUserRename = () => {
    setEditingUserId(null);
    setDraftUserName("");
  };

  const addUserProfile = () => {
    const nextNumber = users.length + 1;
    const newUser = createEmptyUserProfile({
      name: `User ${nextNumber}`,
    });

    setUsers((currentUsers) => [...currentUsers, newUser]);
    setActiveUserId(newUser.id);
    setEditingUserId(newUser.id);
    setDraftUserName(newUser.name);
  };

  if (currentView === "landing") {
    return <LandingPage enterApp={() => setCurrentView("app")} />;
  }

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onBackHome={() => setCurrentView("landing")}
        />

        <main style={styles.main}>
          <div
            style={{
              ...styles.panel,
              padding: 18,
              marginBottom: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: 1.1,
                }}
              >
                Household Profiles
              </div>
              <div style={{ color: "#c8d7ea", fontSize: 13, marginTop: 6 }}>
                Each user keeps separate accounts, transactions, budgets, subscriptions, and
                forecasts.
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                {users.map((user, index) => {
                  const isActive = user.id === activeUser?.id;
                  const isEditing = editingUserId === user.id && isActive;

                  if (isEditing) {
                    return (
                      <input
                        key={user.id}
                        value={draftUserName}
                        onChange={(event) => setDraftUserName(event.target.value)}
                        onBlur={() => saveUserName(user.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveUserName(user.id);
                          if (event.key === "Escape") cancelUserRename();
                        }}
                        autoFocus
                        style={{
                          color: "#eaf3ff",
                          background: "rgba(0,136,255,.14)",
                          border: "1px solid rgba(0,216,255,.38)",
                          borderRadius: 999,
                          padding: "10px 16px",
                          minWidth: 140,
                          outline: "none",
                          fontWeight: 800,
                        }}
                      />
                    );
                  }

                  return (
                    <button
                      key={user.id}
                      onClick={() => {
                        setActiveUserId(user.id);
                        cancelUserRename();
                      }}
                      style={{
                        color: isActive ? "#f4fbff" : "#9fb0c9",
                        background: isActive ? "rgba(0,136,255,.18)" : "rgba(0,136,255,.06)",
                        border: isActive
                          ? "1px solid rgba(0,216,255,.42)"
                          : "1px solid rgba(0,216,255,.18)",
                        borderRadius: 999,
                        padding: "10px 16px",
                        cursor: "pointer",
                        fontWeight: 800,
                        boxShadow: isActive ? "0 0 18px rgba(0,136,255,.18)" : "none",
                      }}
                    >
                      {getDisplayUserName(user, index)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={() =>
                  editingUserId === activeUser?.id
                    ? saveUserName(activeUser.id)
                    : startEditingActiveUser()
                }
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.24)",
                  borderRadius: 10,
                  color: "#d7ebff",
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                {editingUserId === activeUser?.id ? "Save" : "Edit"}
              </button>
              <button
                onClick={addUserProfile}
                style={{
                  background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                  border: "1px solid rgba(120,220,255,.45)",
                  borderRadius: 10,
                  color: "white",
                  padding: "11px 18px",
                  cursor: "pointer",
                  fontWeight: 800,
                  boxShadow: "0 0 22px rgba(0,136,255,.24)",
                }}
              >
                + Add User
              </button>
            </div>
          </div>

          {activeTab === APP_TABS.DASHBOARD ? (
            <DashboardView
              activeRange={activeRange}
              setActiveRange={setActiveRange}
              setActiveTab={setActiveTab}
              trueCash={trueCash}
              transactions={transactions}
              subscriptions={subscriptions}
              incomeStreams={incomeStreams}
              budgetRows={budgetRows}
              projectionAdjustments={projectionAdjustments}
              dynamicMetrics={dynamicMetrics}
              dynamicAllocations={dynamicAllocations}
              metricSnapshots={trackedMetricSnapshots}
            />
          ) : activeTab === APP_TABS.BUDGET_COMMAND_CENTER ? (
            <BudgetCommandCenter
              transactions={transactions}
              budgetRows={budgetRows}
              setBudgetRows={setBudgetRows}
            />
          ) : activeTab === APP_TABS.OPERATIONS_BOARD ? (
            <OperationsBoard
              budgetRows={budgetRows}
              subscriptions={subscriptions}
              incomeStreams={incomeStreams}
              setIncomeStreams={setIncomeStreams}
              transactions={transactions}
              trueCash={trueCash}
              projectionAdjustments={projectionAdjustments}
              setProjectionAdjustments={setProjectionAdjustments}
            />
          ) : activeTab === APP_TABS.ADD_ACCOUNTS ? (
            <AccountsView
              accounts={syncedAccounts}
              addManualAccount={addManualAccount}
              connectMockPlaidAccount={connectMockPlaidAccount}
              openAccountTransactions={openAccountTransactions}
            />
          ) : activeTab === APP_TABS.TRANSACTIONS ? (
            <TransactionsView
              accounts={syncedAccounts}
              budgetRows={budgetRows}
              selectedAccount={selectedAccount}
              visibleTransactions={visibleTransactions}
              setActiveTab={setActiveTab}
              setSelectedAccount={setSelectedAccount}
              connectMockPlaidAccount={connectMockPlaidAccount}
              addManualTransaction={addManualTransaction}
              deleteManualTransaction={deleteManualTransaction}
              updateTransactionCategory={updateTransactionCategory}
            />
          ) : activeTab === APP_TABS.FORECAST_LAB ? (
            <ForecastLab
              trueCash={trueCash}
              subscriptions={subscriptions}
              incomeStreams={incomeStreams}
              budgetRows={budgetRows}
              projectionAdjustments={projectionAdjustments}
            />
          ) : activeTab === APP_TABS.RECURRING_SUBSCRIPTIONS ? (
            <RecurringSubscriptions
              accounts={syncedAccounts}
              subscriptions={subscriptions}
              setSubscriptions={setSubscriptions}
            />
          ) : (
            <ModulePlaceholder activeTab={activeTab} />
          )}
        </main>
      </div>
    </div>
  );
}

export default ForwardFreedomDashboard;
