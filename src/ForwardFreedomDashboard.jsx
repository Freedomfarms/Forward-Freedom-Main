import { useEffect, useMemo, useState } from "react";
import { APP_TABS, budgetMonths } from "./data/constants.jsx";
import { styles } from "./styles.js";
import { getBudgetPeriodAtOffset, getCurrentTimestamp } from "./utils/date.js";
import { money, parseMoney } from "./utils/format.js";
import {
  accountSupportsTransactions,
  calculateRealEstateEquity,
  normalizeAccount,
} from "./utils/accounts.js";
import { loadPersistedAppState, persistAppState } from "./utils/appState.js";
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

function ForwardFreedomDashboard() {
  const [initialAppState] = useState(() => loadPersistedAppState());
  const [currentView, setCurrentView] = useState("landing");
  const [accounts, setAccounts] = useState(initialAppState.accounts);
  const [transactions, setTransactions] = useState(initialAppState.transactions);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [budgetRows, setBudgetRows] = useState(initialAppState.budgetRows);
  const [incomeStreams, setIncomeStreams] = useState(initialAppState.incomeStreams);
  const [projectionAdjustments, setProjectionAdjustments] = useState(
    initialAppState.projectionAdjustments
  );
  const [subscriptions, setSubscriptions] = useState(initialAppState.subscriptions);
  const [activeTab, setActiveTab] = useState(initialAppState.activeTab);
  const [activeRange, setActiveRange] = useState(initialAppState.activeRange);
  const [metricSnapshots] = useState(initialAppState.metricSnapshots);
  const syncedAccounts = useMemo(() => syncDerivedAccountValues(accounts), [accounts]);

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
  const trackedMetricSnapshots = useMemo(
    () =>
      ensureTodayMetricSnapshot(
        metricSnapshots,
        buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth)
      ),
    [creditCardDebt, liquidCash, metricSnapshots, totalNetWorth]
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
      accounts: syncedAccounts,
      transactions,
      budgetRows,
      incomeStreams,
      projectionAdjustments,
      subscriptions,
      activeTab,
      activeRange,
      metricSnapshots: trackedMetricSnapshots,
    });
  }, [
    transactions,
    budgetRows,
    incomeStreams,
    projectionAdjustments,
    subscriptions,
    activeTab,
    activeRange,
    syncedAccounts,
    trackedMetricSnapshots,
  ]);

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

        setAccounts((current) => {
          let changed = false;

          const nextAccounts = current.map((account) => {
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

          return changed ? nextAccounts : current;
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts]);

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

        setAccounts((current) => {
          let changed = false;

          const nextAccounts = current.map((account) => {
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

          return changed ? nextAccounts : current;
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts]);

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
