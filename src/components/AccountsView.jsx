import { useEffect, useState } from "react";
import { styles } from "../styles.js";
import { getCurrentTimestamp } from "../utils/date.js";
import { money } from "../utils/format.js";
import {
  ACCOUNT_GROUPS,
  ACCOUNT_TYPES,
  PRECIOUS_METAL_TYPES,
  PRECIOUS_METAL_UNITS,
  calculatePreciousMetalsBalance,
} from "../utils/accounts.js";
import {
  calculateCryptoBalance,
  fetchCryptoQuotes,
  normalizeCryptoQuantity,
  searchCryptoAssets,
} from "../utils/cryptoPricing.js";
import {
  fetchPreciousMetalsSpotPrices,
  normalizePreciousMetalsPricePerUnit,
} from "../utils/preciousMetalsPricing.js";
import { HouseholdProfilesControl } from "./Common.jsx";

const EMPTY_FORM = {
  name: "",
  type: "Checking",
  institution: "",
  balance: "",
  quantity: "",
  metalType: "Gold",
  metalCustomName: "",
  metalUnit: "oz",
  pricePerUnit: "",
  valuationSource: "Manual",
  propertyAddress: "",
  propertyType: "Primary Residence",
  propertyMarketValue: "",
  linkedLoanId: "",
  linkedPropertyId: "",
  loanCategory: "Mortgage",
  interestRate: "",
  monthlyPayment: "",
};

function parseBalance(raw) {
  const str = String(raw).trim();
  const isNeg = str.startsWith("-");
  const digits = str.replace(/[^0-9.]/g, "");
  const n = Number(digits);
  return isNeg ? -Math.abs(n) : n;
}

function formatCryptoSearchLabel(asset) {
  return `${asset.name} (${asset.symbol})`;
}

function formatCryptoQuantity(quantity) {
  return Number(quantity || 0).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatCryptoPrice(value) {
  const price = Number(value) || 0;
  if (price >= 1) {
    return `$${price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  return `$${price.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  })}`;
}

function formatLastUpdated(value) {
  if (!value) return "Awaiting quote";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatEditableNumber(value) {
  return value === null || value === undefined || value === "" ? "" : String(value);
}

/** UI: bank-linked vs manual. Demo accounts use status "Synced" without plaidItemId; live Plaid sets plaidItemId + syncSource. */
function accountBankLinkPresentation(account) {
  const isLivePlaid = Boolean(account.plaidItemId || account.syncSource === "Plaid");
  const isSyncedDemoStyle = account.status === "Synced";
  const isBankLinked = isLivePlaid || isSyncedDemoStyle;
  return { isBankLinked, badgeLabel: isBankLinked ? "Plaid" : "Manual" };
}

function sourceBadgeStyle(isBankLinked) {
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 8,
    fontWeight: 800,
    letterSpacing: 0.75,
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 4,
    border: isBankLinked ? "1px solid rgba(0,216,255,.38)" : "1px solid rgba(168,120,255,.4)",
    background: isBankLinked ? "rgba(0,216,255,.1)" : "rgba(120,72,200,.15)",
    color: isBankLinked ? "#88f0ff" : "#e8d8ff",
    flexShrink: 0,
  };
}

const ACCOUNT_GROUP_THEME = {
  Checking: { rail: "#00d4aa", tint: "rgba(0,212,170,.1)", line: "rgba(0,212,170,.28)" },
  Savings: { rail: "#00b8ff", tint: "rgba(0,184,255,.1)", line: "rgba(0,184,255,.28)" },
  Investments: { rail: "#a78bfa", tint: "rgba(167,139,250,.12)", line: "rgba(167,139,250,.32)" },
  Crypto: { rail: "#f59e0b", tint: "rgba(245,158,11,.12)", line: "rgba(245,158,11,.3)" },
  "Precious Metals": { rail: "#eab308", tint: "rgba(234,179,8,.11)", line: "rgba(234,179,8,.28)" },
  "Real Estate": { rail: "#34d399", tint: "rgba(52,211,153,.1)", line: "rgba(52,211,153,.28)" },
  Retirement: { rail: "#818cf8", tint: "rgba(129,140,248,.12)", line: "rgba(129,140,248,.3)" },
  "Credit Cards": { rail: "#fb7185", tint: "rgba(251,113,133,.11)", line: "rgba(251,113,133,.3)" },
  "Mortgages / Loans": { rail: "#f472b6", tint: "rgba(244,114,182,.1)", line: "rgba(244,114,182,.28)" },
  "Other / Cash": { rail: "#94a3b8", tint: "rgba(148,163,184,.1)", line: "rgba(148,163,184,.25)" },
};

function accountGroupTheme(title) {
  return ACCOUNT_GROUP_THEME[title] || {
    rail: "#38bdf8",
    tint: "rgba(56,189,248,.1)",
    line: "rgba(56,189,248,.28)",
  };
}

function buildFormFromAccount(account) {
  return {
    ...EMPTY_FORM,
    name: account.name || "",
    type: account.type || EMPTY_FORM.type,
    institution: account.institution || "",
    balance: formatEditableNumber(account.balance),
    quantity: formatEditableNumber(account.quantity),
    metalType: account.metalType || EMPTY_FORM.metalType,
    metalCustomName: account.metalCustomName || "",
    metalUnit: account.metalUnit || EMPTY_FORM.metalUnit,
    pricePerUnit: formatEditableNumber(account.pricePerUnit),
    valuationSource: account.valuationSource || EMPTY_FORM.valuationSource,
    propertyAddress: account.propertyAddress || "",
    propertyType: account.propertyType || EMPTY_FORM.propertyType,
    propertyMarketValue: formatEditableNumber(account.propertyMarketValue),
    linkedLoanId: account.linkedLoanId || "",
    linkedPropertyId: account.linkedPropertyId || "",
    loanCategory: account.loanCategory || EMPTY_FORM.loanCategory,
    interestRate: account.interestRate || "",
    monthlyPayment: account.monthlyPayment || "",
  };
}

const QUICK_START_TEMPLATES = [
  {
    title: "Start with cash",
    description:
      "Add a checking, savings, or manual cash account so True Cash can anchor the dashboard.",
    type: "Checking",
    accent: "#00d8ff",
  },
  {
    title: "Track what you owe",
    description:
      "Add credit cards and mortgages/loans so liabilities flow into debt and equity calculations.",
    type: "Mortgages / Loans",
    accent: "#ff8fa3",
  },
  {
    title: "Track what grows",
    description:
      "Add investments, crypto, metals, and retirement accounts to build a true net worth view.",
    type: "Investment",
    accent: "#8feaff",
  },
];

function shouldFetchMetalsQuoteForForm(form) {
  return (
    form.type === "Precious Metals" &&
    form.valuationSource === "Live Spot" &&
    form.metalType !== "Custom"
  );
}

export function AccountsView({
  accounts,
  addManualAccount,
  connectMockPlaidAccount,
  deleteAccount,
  openAccountTransactions,
  updateManualAccount,
  householdProfilesProps,
  plaidIntegration,
  subscriptions,
  transactions,
}) {
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [cryptoSearchQuery, setCryptoSearchQuery] = useState("");
  const [cryptoResults, setCryptoResults] = useState([]);
  const [selectedCrypto, setSelectedCrypto] = useState(null);
  const [selectedCryptoQuote, setSelectedCryptoQuote] = useState(null);
  const [cryptoSearchError, setCryptoSearchError] = useState("");
  const [cryptoQuoteError, setCryptoQuoteError] = useState("");
  const [isSearchingCrypto, setIsSearchingCrypto] = useState(false);
  const [isLoadingCryptoQuote, setIsLoadingCryptoQuote] = useState(false);
  const [metalsQuote, setMetalsQuote] = useState(null);
  const [metalsQuoteError, setMetalsQuoteError] = useState("");
  const [isLoadingMetalsQuote, setIsLoadingMetalsQuote] = useState(false);
  const [accountActionsMenuId, setAccountActionsMenuId] = useState(null);

  useEffect(() => {
    if (!accountActionsMenuId) return undefined;
    const handle = (e) => {
      const host = e.target.closest("[data-account-actions-root]");
      if (!host || host.getAttribute("data-account-actions-root") !== accountActionsMenuId) {
        setAccountActionsMenuId(null);
      }
    };
    document.addEventListener("click", handle, true);
    return () => document.removeEventListener("click", handle, true);
  }, [accountActionsMenuId]);

  const linkedBalance = accounts.reduce((sum, a) => sum + a.balance, 0);
  const isCryptoAccount = form.type === "Crypto";
  const isPreciousMetalsAccount = form.type === "Precious Metals";
  const isRealEstateAccount = form.type === "Real Estate";
  const isLoanAccount = form.type === "Mortgages / Loans";
  const realEstateAccounts = accounts.filter((account) => account.type === "Real Estate");
  const loanAccounts = accounts.filter((account) => account.type === "Mortgages / Loans");
  const { metalType, metalUnit, type, valuationSource } = form;
  const linkedPlaidItems = plaidIntegration?.items || [];
  const resetCryptoState = () => {
    setCryptoSearchQuery("");
    setCryptoResults([]);
    setSelectedCrypto(null);
    setSelectedCryptoQuote(null);
    setCryptoSearchError("");
    setCryptoQuoteError("");
    setIsSearchingCrypto(false);
    setIsLoadingCryptoQuote(false);
  };
  const resetMetalsState = () => {
    setMetalsQuote(null);
    setMetalsQuoteError("");
    setIsLoadingMetalsQuote(false);
  };
  const update = (field, value) => {
    const nextForm = { ...form, [field]: value };

    if (field === "type" && value !== "Crypto") {
      resetCryptoState();
    }

    if (field === "type" && value === "Crypto") {
      resetCryptoState();
    }

    if (field === "type" && value !== "Precious Metals") {
      resetMetalsState();
    }

    if (field === "metalType" && value === "Custom" && nextForm.valuationSource === "Live Spot") {
      nextForm.valuationSource = "Manual";
    }

    if (field === "valuationSource" && value === "Live Spot" && nextForm.metalType === "Custom") {
      nextForm.valuationSource = "Manual";
    }

    if (["type", "metalType", "metalUnit", "valuationSource"].includes(field)) {
      resetMetalsState();
      if (shouldFetchMetalsQuoteForForm(nextForm)) {
        setIsLoadingMetalsQuote(true);
      }
    }

    setForm(nextForm);
  };

  const parsedBalance = parseBalance(form.balance);
  const parsedQuantity = normalizeCryptoQuantity(form.quantity);
  const parsedPricePerUnit = parseBalance(form.pricePerUnit);
  const parsedPropertyMarketValue = parseBalance(form.propertyMarketValue);
  const linkedLoanBalance =
    loanAccounts.find((account) => account.id === form.linkedLoanId)?.balance || 0;
  const effectiveCryptoQuote =
    selectedCryptoQuote ||
    (editingAccount &&
    editingAccount.type === "Crypto" &&
    selectedCrypto?.id === editingAccount.cryptoAssetId &&
    Number.isFinite(Number(editingAccount.lastPriceUsd)) &&
    Number(editingAccount.lastPriceUsd) > 0
      ? {
          priceUsd: editingAccount.lastPriceUsd,
          lastUpdatedAt: editingAccount.lastPriceUpdatedAt,
        }
      : null);
  const derivedCryptoBalance = effectiveCryptoQuote
    ? calculateCryptoBalance(parsedQuantity, effectiveCryptoQuote.priceUsd)
    : 0;
  const effectiveMetalsQuote =
    metalsQuote ||
    (editingAccount &&
    editingAccount.type === "Precious Metals" &&
    form.valuationSource === "Live Spot" &&
    form.metalType === editingAccount.metalType &&
    form.metalUnit === editingAccount.metalUnit &&
    Number.isFinite(Number(editingAccount.pricePerUnit)) &&
    Number(editingAccount.pricePerUnit) > 0
      ? {
          pricePerUnit: editingAccount.pricePerUnit,
          updatedAt: editingAccount.lastValuedAt,
          source: editingAccount.valuationSource || "Saved quote",
        }
      : null);
  const derivedPreciousMetalsBalance = calculatePreciousMetalsBalance(
    parsedQuantity,
    form.valuationSource === "Live Spot" && effectiveMetalsQuote
      ? effectiveMetalsQuote.pricePerUnit
      : parsedPricePerUnit
  );
  const canDeriveRealEstateEquity = Boolean(form.linkedLoanId) && parsedPropertyMarketValue > 0;
  const derivedRealEstateBalance = canDeriveRealEstateEquity
    ? parsedPropertyMarketValue - Math.abs(linkedLoanBalance)
    : 0;
  const canSubmit =
    form.name.trim().length > 0 &&
    form.type.length > 0 &&
    (isCryptoAccount
      ? selectedCrypto &&
        form.quantity.trim().length > 0 &&
        Number.isFinite(parsedQuantity) &&
        parsedQuantity > 0 &&
        effectiveCryptoQuote
      : isPreciousMetalsAccount
        ? form.quantity.trim().length > 0 &&
          Number.isFinite(parsedQuantity) &&
          parsedQuantity > 0 &&
          (form.valuationSource === "Live Spot"
            ? Boolean(effectiveMetalsQuote)
            : form.pricePerUnit.trim().length > 0 &&
              Number.isFinite(parsedPricePerUnit) &&
              parsedPricePerUnit > 0)
        : isRealEstateAccount
          ? canDeriveRealEstateEquity ||
            (form.balance.trim().length > 0 && Number.isFinite(parsedBalance))
          : form.balance.trim().length > 0 && Number.isFinite(parsedBalance));

  useEffect(() => {
    if (type !== "Precious Metals" || valuationSource !== "Live Spot" || metalType === "Custom") {
      return;
    }

    const controller = new AbortController();
    fetchPreciousMetalsSpotPrices({ signal: controller.signal })
      .then((quotes) => {
        const quote = quotes[metalType];
        if (!quote) {
          setMetalsQuote(null);
          setMetalsQuoteError("Live spot pricing is unavailable for the selected metal.");
          return;
        }

        setMetalsQuote({
          ...quote,
          pricePerUnit: normalizePreciousMetalsPricePerUnit(quote.pricePerTroyOunce, metalUnit),
        });
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setMetalsQuote(null);
        setMetalsQuoteError("Unable to load live precious metals pricing right now.");
      })
      .finally(() => {
        setIsLoadingMetalsQuote(false);
      });

    return () => controller.abort();
  }, [metalType, metalUnit, type, valuationSource]);

  useEffect(() => {
    if (!isCryptoAccount) return;
    const trimmedQuery = cryptoSearchQuery.trim();
    const selectedLabel = selectedCrypto ? formatCryptoSearchLabel(selectedCrypto) : "";

    if (selectedCrypto && trimmedQuery === selectedLabel) {
      return;
    }

    if (trimmedQuery.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      try {
        const results = await searchCryptoAssets(trimmedQuery, { signal: controller.signal });
        setCryptoResults(results);
        if (results.length === 0) {
          setCryptoSearchError("No matching crypto assets were found.");
        }
      } catch (error) {
        if (error.name === "AbortError") return;
        setCryptoSearchError("Unable to search crypto assets right now.");
        setCryptoResults([]);
      } finally {
        setIsSearchingCrypto(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [cryptoSearchQuery, isCryptoAccount, selectedCrypto]);

  useEffect(() => {
    if (!selectedCrypto?.id) return;

    const controller = new AbortController();
    fetchCryptoQuotes([selectedCrypto.id], { signal: controller.signal })
      .then((quotes) => {
        const nextQuote = quotes[selectedCrypto.id];
        if (!nextQuote) {
          setSelectedCryptoQuote(null);
          setCryptoQuoteError("Price feed unavailable for the selected asset.");
          return;
        }

        setSelectedCryptoQuote(nextQuote);
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setSelectedCryptoQuote(null);
        setCryptoQuoteError("Unable to load the latest crypto price right now.");
      })
      .finally(() => {
        setIsLoadingCryptoQuote(false);
      });

    return () => controller.abort();
  }, [selectedCrypto]);

  const openModal = (overrides = {}) => {
    const nextForm = { ...EMPTY_FORM, ...overrides };
    setEditingAccount(null);
    setForm(nextForm);
    resetCryptoState();
    resetMetalsState();
    if (shouldFetchMetalsQuoteForForm(nextForm)) {
      setIsLoadingMetalsQuote(true);
    }
    setShowModal(true);
  };

  const closeModal = () => {
    setForm(EMPTY_FORM);
    setEditingAccount(null);
    resetCryptoState();
    resetMetalsState();
    setShowModal(false);
  };
  const closeDeleteModal = () => {
    if (isDeletingAccount) return;
    setDeleteTarget(null);
    setDeleteError("");
    setAccountActionsMenuId(null);
  };

  const launchQuickStart = (type) => {
    openModal({
      type,
      institution:
        type === "Checking"
          ? "Primary Bank"
          : type === "Mortgages / Loans"
            ? "Lender"
            : type === "Investment"
              ? "Brokerage"
              : "",
    });
  };

  const openEditModal = (account) => {
    if (!account || account.plaidItemId || account.status !== "Manual") return;

    setAccountActionsMenuId(null);
    setEditingAccount(account);
    setForm(buildFormFromAccount(account));
    resetCryptoState();
    resetMetalsState();

    if (account.type === "Crypto" && account.cryptoAssetId) {
      const asset = {
        id: account.cryptoAssetId,
        name: account.cryptoName || account.name,
        symbol: account.cryptoSymbol || "",
        thumb: account.cryptoThumb || "",
      };
      setSelectedCrypto(asset);
      setCryptoSearchQuery(formatCryptoSearchLabel(asset));
      if (account.lastPriceUsd !== null && account.lastPriceUsd !== undefined) {
        setSelectedCryptoQuote({
          priceUsd: account.lastPriceUsd,
          lastUpdatedAt: account.lastPriceUpdatedAt,
        });
      }
    }

    if (shouldFetchMetalsQuoteForForm(account)) {
      setIsLoadingMetalsQuote(true);
    }

    setShowModal(true);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    if (isCryptoAccount) {
      const accountPayload = {
        name: form.name.trim(),
        type: form.type,
        institution: form.institution.trim() || "Crypto Wallet",
        balance: derivedCryptoBalance,
        quantity: parsedQuantity,
        cryptoAssetId: selectedCrypto.id,
        cryptoName: selectedCrypto.name,
        cryptoSymbol: selectedCrypto.symbol,
        cryptoThumb: selectedCrypto.thumb,
        lastPriceUsd: effectiveCryptoQuote.priceUsd,
        lastPriceUpdatedAt: effectiveCryptoQuote.lastUpdatedAt,
        priceSource: "CoinGecko",
      };
      if (editingAccount) {
        updateManualAccount?.(editingAccount.id, accountPayload);
      } else {
        addManualAccount(accountPayload);
      }
      closeModal();
      return;
    }

    if (isPreciousMetalsAccount) {
      const currentTimestamp = getCurrentTimestamp();
      const accountPayload = {
        name: form.name.trim(),
        type: form.type,
        institution: form.institution.trim() || "Manual Valuation",
        balance: derivedPreciousMetalsBalance,
        metalType: form.metalType,
        metalCustomName: form.metalCustomName.trim(),
        metalUnit: form.metalUnit,
        quantity: parsedQuantity,
        pricePerUnit:
          form.valuationSource === "Live Spot" && effectiveMetalsQuote
            ? effectiveMetalsQuote.pricePerUnit
            : parsedPricePerUnit,
        valuationSource: form.valuationSource,
        lastValuedAt: effectiveMetalsQuote?.updatedAt || currentTimestamp,
      };
      if (editingAccount) {
        updateManualAccount?.(editingAccount.id, accountPayload);
      } else {
        addManualAccount(accountPayload);
      }
      closeModal();
      return;
    }

    const accountPayload = {
      name: form.name.trim(),
      type: form.type,
      institution: form.institution.trim() || form.type,
      balance:
        isRealEstateAccount && canDeriveRealEstateEquity ? derivedRealEstateBalance : parsedBalance,
      propertyAddress: form.propertyAddress.trim(),
      propertyType: form.propertyType,
      propertyMarketValue: parsedPropertyMarketValue,
      equitySource: isRealEstateAccount && canDeriveRealEstateEquity ? "Derived" : "Manual",
      linkedLoanId: form.linkedLoanId,
      linkedPropertyId: form.linkedPropertyId,
      loanCategory: form.loanCategory,
      interestRate: form.interestRate.trim(),
      monthlyPayment: form.monthlyPayment.trim(),
    };
    if (editingAccount) {
      updateManualAccount?.(editingAccount.id, accountPayload);
    } else {
      addManualAccount(accountPayload);
    }
    closeModal();
  };

  const deleteTargetPlaidItem = deleteTarget?.plaidItemId
    ? linkedPlaidItems.find((item) => item.itemId === deleteTarget.plaidItemId) || null
    : null;
  const deleteTargetLinkedAccounts = deleteTargetPlaidItem
    ? accounts.filter((account) => account.plaidItemId === deleteTargetPlaidItem.itemId)
    : deleteTarget
      ? [deleteTarget]
      : [];
  const deleteTargetLinkedAccountNames = new Set(
    deleteTargetLinkedAccounts.map((account) => account.name)
  );
  const deleteTargetTransactionCount = deleteTarget
    ? transactions.filter((transaction) =>
        deleteTarget.plaidItemId
          ? transaction.source === "plaid" && deleteTargetLinkedAccountNames.has(transaction.account)
          : transaction.account === deleteTarget.name
      ).length
    : 0;
  const deleteTargetSubscriptionCount = deleteTarget
    ? subscriptions.filter((subscription) =>
        deleteTarget.plaidItemId
          ? deleteTargetLinkedAccountNames.has(subscription.account)
          : subscription.account === deleteTarget.name || subscription.accountId === deleteTarget.id
      ).length
    : 0;
  const confirmDeleteAccount = async () => {
    if (!deleteTarget || typeof deleteAccount !== "function" || isDeletingAccount) return;

    setDeleteError("");
    setIsDeletingAccount(true);

    try {
      await deleteAccount(deleteTarget);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error?.message || "Unable to remove this account right now.");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleCryptoSearchChange = (value) => {
    setCryptoSearchQuery(value);
    setCryptoSearchError("");
    setCryptoResults([]);

    if (selectedCrypto && value.trim() !== formatCryptoSearchLabel(selectedCrypto)) {
      setSelectedCrypto(null);
      setSelectedCryptoQuote(null);
      setCryptoQuoteError("");
      setIsLoadingCryptoQuote(false);
    }

    if (!isCryptoAccount || value.trim().length < 2) {
      setIsSearchingCrypto(false);
      return;
    }

    if (selectedCrypto && value.trim() === formatCryptoSearchLabel(selectedCrypto)) {
      setIsSearchingCrypto(false);
      return;
    }

    setIsSearchingCrypto(true);
  };

  const chooseCryptoAsset = (asset) => {
    setSelectedCrypto(asset);
    setSelectedCryptoQuote(null);
    setCryptoQuoteError("");
    setCryptoResults([]);
    setCryptoSearchQuery(formatCryptoSearchLabel(asset));
    setIsSearchingCrypto(false);
    setIsLoadingCryptoQuote(true);
    setForm((current) => ({
      ...current,
      name: current.name.trim() ? current.name : `${asset.symbol} Holdings`,
      institution: current.institution.trim() ? current.institution : "Crypto Wallet",
    }));
  };

  const inputStyle = {
    color: "#eaf3ff",
    background: "rgba(0,136,255,.09)",
    border: "1px solid rgba(0,216,255,.22)",
    borderRadius: 8,
    padding: "9px 12px",
    outline: "none",
    fontWeight: 600,
    colorScheme: "dark",
    fontSize: 14,
    width: "100%",
  };

  const labelStyle = { display: "grid", gap: 6 };
  const labelCapStyle = {
    color: "#8fb1d9",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: 700,
  };

  return (
    <div>
      {/* Header */}
      <header style={{ ...styles.pageHeader, marginBottom: 16, gap: 14 }}>
        <div>
          <h1
            style={{
              ...styles.pageTitle,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            Accounts
          </h1>
          <p style={{ ...styles.pageSubtitle, fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>
            Connect bank accounts, credit cards, investments, crypto, metals, real estate, and
            loans.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <button
            onClick={openModal}
            style={{
              background: "rgba(0,136,255,.12)",
              border: "1px solid rgba(0,216,255,.38)",
              borderRadius: 8,
              color: "#eaf3ff",
              padding: "10px 16px",
              fontWeight: 700,
              boxShadow: "0 0 16px rgba(0,136,255,.14)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            ✎ Add Manually
          </button>
          <button
            onClick={connectMockPlaidAccount}
            disabled={isSearchingCrypto || plaidIntegration?.isSyncing}
            style={{
              background: "linear-gradient(90deg,#00aaff,#0077ff)",
              border: "1px solid rgba(120,220,255,.45)",
              borderRadius: 8,
              color: "white",
              padding: "10px 18px",
              fontWeight: 700,
              boxShadow: "0 0 20px rgba(0,136,255,.28)",
              cursor: "pointer",
              fontSize: 13,
              opacity: plaidIntegration?.isSyncing ? 0.72 : 1,
            }}
          >
            {plaidIntegration?.isSyncing ? "Connecting Plaid..." : "⊕ Connect with Plaid"}
          </button>
        </div>
      </header>

      {/* Hero */}
      <section
        style={{
          ...styles.panel,
          padding: "18px 20px",
          marginBottom: 16,
          position: "relative",
          overflow: "hidden",
          borderRadius: 14,
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at top right, rgba(0,216,255,.12), transparent 40%)",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <div
              style={{
                color: "#6eb8d4",
                textTransform: "uppercase",
                letterSpacing: 1.25,
                fontSize: 10,
                marginBottom: 8,
                fontWeight: 700,
              }}
            >
              Connection hub
            </div>
            <div style={{ color: "white", fontSize: 21, fontWeight: 700, lineHeight: 1.2 }}>
              Link with Plaid or add manually.{" "}
              <span style={{ color: "#00aaff" }}>One ledger for everything.</span>
            </div>
            <p style={{ color: "#8aa3bf", fontSize: 13, lineHeight: 1.5, marginTop: 12 }}>
              Plaid syncs names, balances, transactions, and payment details—no routing or account
              numbers. Manual entries cover cash, private assets, and anything off-sync.
            </p>
            <div
              style={{
                color: plaidIntegration?.configured ? "#7ec9e0" : "#e0a878",
                marginTop: 8,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {plaidIntegration?.configured
                ? `Live Plaid · ${plaidIntegration.environment}`
                : "Plaid not configured — add credentials to link real institutions."}
            </div>
            {plaidIntegration?.lastSyncAt ? (
              <div style={{ color: "#5a7a9a", fontSize: 11, marginTop: 6 }}>
                Last sync {new Date(plaidIntegration.lastSyncAt).toLocaleString()}
              </div>
            ) : null}
            {plaidIntegration?.error ? (
              <div style={{ color: "#ff9a76", fontSize: 11, marginTop: 6 }}>{plaidIntegration.error}</div>
            ) : null}
          </div>
          <div
            style={{
              flex: "0 1 200px",
              border: "1px solid rgba(0,136,255,.2)",
              borderRadius: 10,
              background: "rgba(0,24,52,.45)",
              padding: "12px 14px",
              alignSelf: "stretch",
            }}
          >
            <div
              style={{
                color: "#6b8aaf",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 1.1,
                fontWeight: 700,
                marginBottom: 8,
              }}
            >
              Combined balance
            </div>
            <div style={{ color: "white", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {money(linkedBalance)}
            </div>
            <div style={{ color: "#5ad4a8", marginTop: 8, fontWeight: 600, fontSize: 12 }}>
              {accounts.length} account{accounts.length !== 1 ? "s" : ""} tracked
            </div>
          </div>
        </div>
      </section>

      {/* Account list */}
      <section style={{ ...styles.panel, padding: "16px 18px 18px", borderRadius: 14 }}>
        {accounts.length === 0 ? (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ textAlign: "center", padding: "12px 8px 2px" }}>
              <div style={{ color: "white", fontSize: 19, fontWeight: 700 }}>
                Start your financial system
              </div>
              <div style={{ color: "#7a93b5", marginTop: 8, fontSize: 13, lineHeight: 1.55 }}>
                Add your core accounts first so Command Center, Budget Strategy Lab, Forecast, and Transactions all
                have a real source of truth to work from.
              </div>
            </div>

            <div
              style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}
            >
              {QUICK_START_TEMPLATES.map((template) => (
                <button
                  key={template.title}
                  onClick={() => launchQuickStart(template.type)}
                  style={{
                    border: "1px solid rgba(0,136,255,.18)",
                    background: "rgba(3,17,32,.55)",
                    borderRadius: 12,
                    padding: "14px 16px",
                    textAlign: "left",
                    cursor: "pointer",
                    boxShadow: "inset 0 0 20px rgba(0,80,160,.06)",
                  }}
                >
                  <div
                    style={{
                      color: template.accent,
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: 0.9,
                      fontWeight: 700,
                    }}
                  >
                    {template.type}
                  </div>
                  <div style={{ color: "white", fontSize: 16, fontWeight: 700, marginTop: 8 }}>
                    {template.title}
                  </div>
                  <div style={{ color: "#7a93b5", marginTop: 8, lineHeight: 1.5, fontSize: 12 }}>
                    {template.description}
                  </div>
                  <div style={{ color: "#7ec9e0", marginTop: 12, fontWeight: 700, fontSize: 12 }}>
                    Open setup →
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          ACCOUNT_GROUPS.map((group) => {
            const grouped = accounts.filter(group.filter);
            if (grouped.length === 0) return null;
            const gt = accountGroupTheme(group.title);
            return (
              <div
                key={group.title}
                style={{
                  marginBottom: 30,
                  padding: "10px 12px 11px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(0,70,120,.22)",
                  borderLeft: `4px solid ${gt.rail}`,
                  background: `linear-gradient(105deg, ${gt.tint}, rgba(4,14,28,.42) 48%, rgba(3,12,24,.35))`,
                  boxShadow: `inset 0 -1px 0 ${gt.line}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 8,
                    paddingBottom: 6,
                    borderBottom: `1px solid ${gt.line}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: 1.1,
                        textTransform: "uppercase",
                        color: gt.rail,
                      }}
                    >
                      {group.title}
                    </span>
                    <span style={{ fontSize: 11, color: "#5f7394", fontWeight: 600 }}>
                      {grouped.length} account{grouped.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(228px, 1fr))",
                    gap: 8,
                  }}
                >
                  {grouped.map((account) => {
                    const { isBankLinked, badgeLabel } = accountBankLinkPresentation(account);
                    const metaLine = [account.institution || "—", account.type, account.status].join(" · ");
                    return (
                      <div
                        key={account.id}
                        onClick={() => openAccountTransactions(account.name)}
                        style={{
                          border: "1px solid rgba(0,136,255,.11)",
                          borderLeft: `2px solid ${
                            isBankLinked ? "rgba(0,200,255,.68)" : "rgba(176,132,255,.72)"
                          }`,
                          background: "rgba(4,14,28,.82)",
                          borderRadius: 8,
                          padding: "7px 9px 8px",
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                flexWrap: "wrap",
                              }}
                            >
                              <span
                                style={{
                                  color: "#f0f6ff",
                                  fontSize: 13,
                                  fontWeight: 700,
                                  lineHeight: 1.2,
                                  letterSpacing: "-0.02em",
                                }}
                              >
                                {account.name}
                              </span>
                              <span style={sourceBadgeStyle(isBankLinked)}>{badgeLabel}</span>
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                color: "#6a829e",
                                marginTop: 2,
                                lineHeight: 1.35,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={metaLine}
                            >
                              {metaLine}
                            </div>
                          </div>
                          <div
                            style={{
                              flexShrink: 0,
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-end",
                              gap: 6,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 700,
                                color: account.balance < 0 ? "#ff6b8a" : "#eaf3ff",
                                letterSpacing: "-0.02em",
                                lineHeight: 1.1,
                              }}
                            >
                              {account.balance < 0 ? "−" : ""}
                              {money(Math.abs(account.balance))}
                            </div>
                            <div
                              data-account-actions-root={account.id}
                              style={{ position: "relative" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                aria-label="Account actions"
                                aria-expanded={accountActionsMenuId === account.id}
                                aria-haspopup="menu"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAccountActionsMenuId((id) => (id === account.id ? null : account.id));
                                }}
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  border: "1px solid rgba(0,136,255,.22)",
                                  background: "rgba(0,40,80,.32)",
                                  color: "#8fb1d9",
                                  cursor: "pointer",
                                  fontSize: 17,
                                  lineHeight: 1,
                                  padding: 0,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  flexShrink: 0,
                                }}
                              >
                                ⋮
                              </button>
                              {accountActionsMenuId === account.id ? (
                                <div
                                  role="menu"
                                  style={{
                                    position: "absolute",
                                    right: 0,
                                    top: "calc(100% + 4px)",
                                    minWidth: 148,
                                    zIndex: 30,
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,216,255,.22)",
                                    background: "rgba(4,16,32,.98)",
                                    boxShadow: "0 10px 32px rgba(0,0,0,.5)",
                                    padding: "6px 0",
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {!account.plaidItemId && account.status === "Manual" ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openEditModal(account);
                                      }}
                                      style={{
                                        display: "block",
                                        width: "100%",
                                        textAlign: "left",
                                        border: "none",
                                        background: "transparent",
                                        color: "#dcecff",
                                        fontSize: 13,
                                        fontWeight: 600,
                                        padding: "9px 14px",
                                        cursor: "pointer",
                                      }}
                                    >
                                      Edit account
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setAccountActionsMenuId(null);
                                      setDeleteError("");
                                      setDeleteTarget(account);
                                    }}
                                    style={{
                                      display: "block",
                                      width: "100%",
                                      textAlign: "left",
                                      border: "none",
                                      background: "transparent",
                                      color: "#ffc9c9",
                                      fontSize: 13,
                                      fontWeight: 600,
                                      padding: "9px 14px",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {account.plaidItemId ? "Disconnect…" : "Remove…"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {account.type === "Crypto" && account.cryptoSymbol ? (
                          <div style={{ color: "#52cfe8", marginTop: 4, fontSize: 10, lineHeight: 1.35 }}>
                            {formatCryptoQuantity(account.quantity)} {account.cryptoSymbol} @{" "}
                            {formatCryptoPrice(account.lastPriceUsd || 0)} ·{" "}
                            {formatLastUpdated(account.lastPriceUpdatedAt)}
                          </div>
                        ) : null}
                        {account.type === "Precious Metals" ? (
                          <div style={{ color: "#d9be6e", marginTop: 4, fontSize: 10, lineHeight: 1.35 }}>
                            {formatCryptoQuantity(account.quantity)} {account.metalUnit}{" "}
                            {account.metalType === "Custom" && account.metalCustomName
                              ? account.metalCustomName
                              : account.metalType}{" "}
                            @ {money(account.pricePerUnit || 0)} / {account.metalUnit} ·{" "}
                            {account.valuationSource || "Manual"} · {formatLastUpdated(account.lastValuedAt)}
                          </div>
                        ) : null}
                        {account.type === "Real Estate" && account.propertyAddress ? (
                          <div style={{ color: "#7dcee8", marginTop: 4, fontSize: 10, lineHeight: 1.35 }}>
                            {account.propertyType} · {account.propertyAddress}
                          </div>
                        ) : null}
                        {account.type === "Real Estate" && account.propertyMarketValue ? (
                          <div style={{ color: "#6eb8e8", marginTop: 2, fontSize: 10 }}>
                            {account.equitySource === "Derived" ? "Derived" : "Manual"} equity · Market{" "}
                            {money(account.propertyMarketValue)}
                          </div>
                        ) : null}
                        {account.type === "Real Estate" && account.linkedLoanId ? (
                          <div style={{ color: "#6eb8e8", marginTop: 2, fontSize: 10 }}>
                            Loan:{" "}
                            {loanAccounts.find((loanAccount) => loanAccount.id === account.linkedLoanId)?.name ||
                              "Saved link"}
                          </div>
                        ) : null}
                        {account.type === "Mortgages / Loans" ? (
                          <div style={{ color: "#f0a090", marginTop: 4, fontSize: 10, lineHeight: 1.35 }}>
                            {account.loanCategory}
                            {account.interestRate ? ` · ${account.interestRate}% APR` : ""}
                            {account.monthlyPayment ? ` · ${account.monthlyPayment}/mo` : ""}
                          </div>
                        ) : null}
                        {account.type === "Mortgages / Loans" && account.linkedPropertyId ? (
                          <div style={{ color: "#e8b0a4", marginTop: 2, fontSize: 10 }}>
                            Property:{" "}
                            {realEstateAccounts.find(
                              (propertyAccount) => propertyAccount.id === account.linkedPropertyId
                            )?.name || "Saved link"}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </section>

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
            padding: 24,
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDeleteModal();
          }}
        >
          <div
            style={{
              ...styles.panel,
              width: "min(520px, 100%)",
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
              Confirm Remove
            </div>
            <div style={{ color: "white", fontSize: 20, fontWeight: 800, lineHeight: 1.15 }}>
              {deleteTarget.plaidItemId
                ? `Disconnect ${deleteTargetPlaidItem?.institutionName || deleteTarget.institution}?`
                : `Delete ${deleteTarget.name}?`}
            </div>
            <p style={{ color: "#8aa3bf", lineHeight: 1.55, marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              {deleteTarget.plaidItemId
                ? "Plaid-linked accounts are removed one institution at a time so they do not reappear on the next sync."
                : "This permanently removes the manual account and clears any related local entries from this workspace."}
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 10,
                marginTop: 18,
              }}
            >
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(0,216,255,.16)",
                  background: "rgba(4,18,33,.72)",
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    color: "#7ea6d8",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.7,
                  }}
                >
                  Accounts Removed
                </div>
                <div style={{ color: "white", fontSize: 17, fontWeight: 700, marginTop: 5 }}>
                  {deleteTargetLinkedAccounts.length}
                </div>
              </div>
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(0,216,255,.16)",
                  background: "rgba(4,18,33,.72)",
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    color: "#7ea6d8",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.7,
                  }}
                >
                  Transactions Removed
                </div>
                <div style={{ color: "white", fontSize: 17, fontWeight: 700, marginTop: 5 }}>
                  {deleteTargetTransactionCount}
                </div>
              </div>
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(0,216,255,.16)",
                  background: "rgba(4,18,33,.72)",
                  padding: "12px 14px",
                }}
              >
                <div
                  style={{
                    color: "#7ea6d8",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.7,
                  }}
                >
                  Subscriptions Removed
                </div>
                <div style={{ color: "white", fontSize: 17, fontWeight: 700, marginTop: 5 }}>
                  {deleteTargetSubscriptionCount}
                </div>
              </div>
            </div>
            {deleteError ? (
              <div
                style={{
                  marginTop: 16,
                  color: "#ffd9df",
                  background: "rgba(255,36,77,.08)",
                  border: "1px solid rgba(255,93,122,.24)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  lineHeight: 1.5,
                }}
              >
                {deleteError}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
              <button
                type="button"
                disabled={isDeletingAccount}
                onClick={closeDeleteModal}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: isDeletingAccount ? "wait" : "pointer",
                  fontWeight: 800,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingAccount}
                onClick={() => {
                  void confirmDeleteAccount();
                }}
                style={{
                  background: "linear-gradient(90deg,#ff244d,#ff5d7a)",
                  border: "1px solid rgba(255,93,122,.55)",
                  color: "white",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: isDeletingAccount ? "wait" : "pointer",
                  fontWeight: 900,
                  boxShadow: "0 0 22px rgba(255,36,77,.32)",
                }}
              >
                {isDeletingAccount
                  ? "Removing..."
                  : deleteTarget.plaidItemId
                    ? "Disconnect Institution"
                    : "Delete Account"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Add Account Modal ── */}
      {showModal ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,5,14,.78)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <form
            onSubmit={handleSubmit}
            style={{
              ...styles.panel,
              width: "min(560px, 94vw)",
              padding: 28,
              boxShadow: "0 0 60px rgba(0,136,255,.38)",
              border: "1px solid rgba(0,216,255,.32)",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 24,
              }}
            >
              <div>
                <div
                  style={{
                    color: "#8feaff",
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: 1.2,
                    marginBottom: 8,
                  }}
                >
                  {editingAccount ? "Edit Manual Account" : "Manual Account"}
                </div>
                <div style={{ color: "white", fontSize: 18, fontWeight: 700 }}>
                  {editingAccount ? `Edit ${editingAccount.name}` : "Add a New Account"}
                </div>
              </div>
              <button
                type="button"
                onClick={closeModal}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.25)",
                  borderRadius: 8,
                  color: "#8fb1d9",
                  width: 36,
                  height: 36,
                  cursor: "pointer",
                  fontSize: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>

            {/* Fields */}
            <div style={{ display: "grid", gap: 16 }}>
              {/* Account Name */}
              <label style={labelStyle}>
                <span style={labelCapStyle}>Account Name</span>
                <input
                  type="text"
                  value={form.name}
                  placeholder={
                    isCryptoAccount
                      ? "e.g. XRP Wallet, Coinbase XRP, Cold Storage"
                      : isPreciousMetalsAccount
                        ? "e.g. Gold Stack, Silver Vault, Family Bullion"
                        : isRealEstateAccount
                          ? "e.g. Main Home Equity, Lake House Equity"
                          : isLoanAccount
                            ? "e.g. Home Mortgage, Rental Loan, HELOC"
                            : "e.g. Chase Checking, Home Safe, Cash Envelope"
                  }
                  onChange={(e) => update("name", e.target.value)}
                  style={inputStyle}
                  autoFocus
                />
              </label>

              {/* Type + Institution side by side */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={labelStyle}>
                  <span style={labelCapStyle}>Account Type</span>
                  <select
                    value={form.type}
                    onChange={(e) => update("type", e.target.value)}
                    disabled={Boolean(editingAccount)}
                    style={{
                      ...inputStyle,
                      opacity: editingAccount ? 0.8 : 1,
                      cursor: editingAccount ? "not-allowed" : "pointer",
                    }}
                  >
                    {ACCOUNT_TYPES.map((t) => (
                      <option key={t} value={t} style={{ background: "#061224" }}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={labelStyle}>
                  <span style={labelCapStyle}>
                    {isCryptoAccount
                      ? "Wallet / Exchange"
                      : isRealEstateAccount
                        ? "Property Label"
                        : isLoanAccount
                          ? "Lender / Institution"
                          : "Bank / Institution"}
                  </span>
                  <input
                    type="text"
                    value={form.institution}
                    placeholder={
                      isCryptoAccount
                        ? "e.g. Coinbase, Ledger, Kraken"
                        : isRealEstateAccount
                          ? "e.g. Personal Portfolio, Family Holdings"
                          : isLoanAccount
                            ? "e.g. Wells Fargo, Rocket Mortgage"
                            : "Bank name or label"
                    }
                    onChange={(e) => update("institution", e.target.value)}
                    style={inputStyle}
                  />
                </label>
              </div>

              {isCryptoAccount ? (
                <>
                  <label style={labelStyle}>
                    <span style={labelCapStyle}>Crypto Asset Search</span>
                    <input
                      type="text"
                      value={cryptoSearchQuery}
                      placeholder="Search by coin name or ticker, e.g. XRP or Ethereum"
                      onChange={(e) => handleCryptoSearchChange(e.target.value)}
                      style={inputStyle}
                    />
                    <span style={{ color: "#7294bb", fontSize: 12 }}>
                      Select the exact asset so the account can refresh against the correct price
                      feed.
                    </span>
                  </label>

                  {cryptoSearchError ? (
                    <div style={{ color: "#ff9a76", fontSize: 12 }}>{cryptoSearchError}</div>
                  ) : null}

                  {isSearchingCrypto ? (
                    <div style={{ color: "#8feaff", fontSize: 12 }}>
                      Searching live crypto market data…
                    </div>
                  ) : null}

                  {cryptoResults.length > 0 ? (
                    <div
                      style={{
                        border: "1px solid rgba(0,216,255,.18)",
                        borderRadius: 12,
                        background: "rgba(0,22,48,.4)",
                        overflow: "hidden",
                      }}
                    >
                      {cryptoResults.map((asset) => (
                        <button
                          key={asset.id}
                          type="button"
                          onClick={() => chooseCryptoAsset(asset)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "12px 14px",
                            background: "transparent",
                            border: "none",
                            borderBottom: "1px solid rgba(0,216,255,.08)",
                            color: "#eaf3ff",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            {asset.thumb ? (
                              <img
                                src={asset.thumb}
                                alt=""
                                style={{ width: 22, height: 22, borderRadius: 999, flexShrink: 0 }}
                              />
                            ) : null}
                            <span>
                              <span style={{ fontWeight: 800 }}>{asset.name}</span>
                              <span style={{ color: "#8fb1d9", marginLeft: 8 }}>
                                {asset.symbol}
                              </span>
                            </span>
                          </span>
                          <span style={{ color: "#7294bb", fontSize: 12 }}>
                            {asset.marketCapRank ? `Rank #${asset.marketCapRank}` : "Unranked"}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {selectedCrypto ? (
                    <div
                      style={{
                        border: "1px solid rgba(0,216,255,.26)",
                        borderRadius: 14,
                        background: "rgba(0,30,70,.22)",
                        padding: 16,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
                        <div>
                          <div
                            style={{ color: "#8feaff", fontSize: 12, textTransform: "uppercase" }}
                          >
                            Selected Asset
                          </div>
                          <div
                            style={{ color: "white", fontSize: 20, fontWeight: 900, marginTop: 6 }}
                          >
                            {selectedCrypto.name} ({selectedCrypto.symbol})
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCrypto(null);
                            setSelectedCryptoQuote(null);
                            setCryptoQuoteError("");
                            setCryptoSearchQuery("");
                          }}
                          style={{
                            background: "rgba(0,136,255,.10)",
                            border: "1px solid rgba(0,216,255,.24)",
                            borderRadius: 8,
                            color: "#8fb1d9",
                            padding: "8px 12px",
                            cursor: "pointer",
                            fontWeight: 800,
                          }}
                        >
                          Change
                        </button>
                      </div>

                      <label style={labelStyle}>
                        <span style={labelCapStyle}>Quantity Owned</span>
                        <input
                          type="text"
                          value={form.quantity}
                          placeholder="e.g. 5000"
                          onChange={(e) => update("quantity", e.target.value)}
                          style={inputStyle}
                        />
                      </label>

                      <div style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.55 }}>
                        {isLoadingCryptoQuote ? (
                          <span style={{ color: "#8feaff" }}>Loading latest price…</span>
                        ) : selectedCryptoQuote ? (
                          <>
                            Live price: <b>{formatCryptoPrice(selectedCryptoQuote.priceUsd)}</b> per{" "}
                            {selectedCrypto.symbol}
                            <br />
                            Current account value: <b>{money(derivedCryptoBalance)}</b>
                            <br />
                            Last updated:{" "}
                            <b>{formatLastUpdated(selectedCryptoQuote.lastUpdatedAt)}</b>
                          </>
                        ) : (
                          <span style={{ color: "#7294bb" }}>
                            Pick an asset to load its current price.
                          </span>
                        )}
                      </div>

                      {cryptoQuoteError ? (
                        <div style={{ color: "#ff9a76", fontSize: 12 }}>{cryptoQuoteError}</div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : isPreciousMetalsAccount ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Metal Type</span>
                      <select
                        value={form.metalType}
                        onChange={(e) => update("metalType", e.target.value)}
                        style={inputStyle}
                      >
                        {PRECIOUS_METAL_TYPES.map((metal) => (
                          <option key={metal} value={metal} style={{ background: "#061224" }}>
                            {metal}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Unit</span>
                      <select
                        value={form.metalUnit}
                        onChange={(e) => update("metalUnit", e.target.value)}
                        style={inputStyle}
                      >
                        {PRECIOUS_METAL_UNITS.map((unit) => (
                          <option key={unit} value={unit} style={{ background: "#061224" }}>
                            {unit}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label style={labelStyle}>
                    <span style={labelCapStyle}>Valuation Source</span>
                    <select
                      value={form.valuationSource}
                      onChange={(e) => update("valuationSource", e.target.value)}
                      style={inputStyle}
                    >
                      <option value="Manual" style={{ background: "#061224" }}>
                        Manual
                      </option>
                      {form.metalType !== "Custom" ? (
                        <option value="Live Spot" style={{ background: "#061224" }}>
                          Live Spot
                        </option>
                      ) : null}
                    </select>
                  </label>

                  {form.metalType === "Custom" ? (
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Custom Metal Name</span>
                      <input
                        type="text"
                        value={form.metalCustomName}
                        placeholder="e.g. Rhodium"
                        onChange={(e) => update("metalCustomName", e.target.value)}
                        style={inputStyle}
                      />
                    </label>
                  ) : null}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Quantity</span>
                      <input
                        type="text"
                        value={form.quantity}
                        placeholder={`e.g. 12 ${form.metalUnit}`}
                        onChange={(e) => update("quantity", e.target.value)}
                        style={inputStyle}
                      />
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Price Per {form.metalUnit.toUpperCase()}</span>
                      <input
                        type="text"
                        value={
                          form.valuationSource === "Live Spot" && metalsQuote
                            ? money(metalsQuote.pricePerUnit)
                            : form.pricePerUnit
                        }
                        placeholder="e.g. 2350"
                        onChange={(e) => update("pricePerUnit", e.target.value)}
                        disabled={form.valuationSource === "Live Spot"}
                        style={{
                          ...inputStyle,
                          opacity: form.valuationSource === "Live Spot" ? 0.82 : 1,
                        }}
                      />
                    </label>
                  </div>

                  <div style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.55 }}>
                    {isLoadingMetalsQuote ? (
                      <span style={{ color: "#8feaff" }}>Loading live spot price…</span>
                    ) : (
                      <>
                        {form.valuationSource === "Live Spot"
                          ? "Live spot valuation"
                          : "Manual valuation"}
                        : <b>{money(derivedPreciousMetalsBalance)}</b>
                        {metalsQuote ? (
                          <>
                            <br />
                            Spot source: <b>{metalsQuote.source}</b> • Updated{" "}
                            <b>{formatLastUpdated(metalsQuote.updatedAt)}</b>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                  {metalsQuoteError ? (
                    <div style={{ color: "#ff9a76", fontSize: 12 }}>{metalsQuoteError}</div>
                  ) : null}
                </>
              ) : isRealEstateAccount ? (
                <>
                  <label style={labelStyle}>
                    <span style={labelCapStyle}>Property Address / Label</span>
                    <input
                      type="text"
                      value={form.propertyAddress}
                      placeholder="e.g. 122 Oak Street, Lake House, Rental #2"
                      onChange={(e) => update("propertyAddress", e.target.value)}
                      style={inputStyle}
                    />
                  </label>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Property Type</span>
                      <input
                        type="text"
                        value={form.propertyType}
                        placeholder="e.g. Primary Residence, Rental, Vacation Home"
                        onChange={(e) => update("propertyType", e.target.value)}
                        style={inputStyle}
                      />
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Linked Mortgage / Loan</span>
                      <select
                        value={form.linkedLoanId}
                        onChange={(e) => update("linkedLoanId", e.target.value)}
                        style={inputStyle}
                      >
                        <option value="" style={{ background: "#061224" }}>
                          Not linked yet
                        </option>
                        {loanAccounts.map((account) => (
                          <option
                            key={account.id}
                            value={account.id}
                            style={{ background: "#061224" }}
                          >
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Property Market Value</span>
                      <input
                        type="text"
                        value={form.propertyMarketValue}
                        placeholder="e.g. 540000"
                        onChange={(e) => update("propertyMarketValue", e.target.value)}
                        style={inputStyle}
                      />
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Equity Mode</span>
                      <div
                        style={{
                          ...inputStyle,
                          display: "flex",
                          alignItems: "center",
                          color: canDeriveRealEstateEquity ? "#00f59b" : "#8fb1d9",
                        }}
                      >
                        {canDeriveRealEstateEquity ? "Derived from linked loan" : "Manual equity"}
                      </div>
                    </label>
                  </div>

                  <label style={labelStyle}>
                    <span style={labelCapStyle}>Current Equity</span>
                    <input
                      type="text"
                      value={
                        canDeriveRealEstateEquity ? money(derivedRealEstateBalance) : form.balance
                      }
                      placeholder="e.g. 185000"
                      onChange={(e) => update("balance", e.target.value)}
                      disabled={canDeriveRealEstateEquity}
                      style={{
                        ...inputStyle,
                        opacity: canDeriveRealEstateEquity ? 0.8 : 1,
                      }}
                    />
                    <span style={{ color: "#7294bb", fontSize: 12 }}>
                      {canDeriveRealEstateEquity
                        ? "This equity is auto-derived from market value minus the linked loan balance."
                        : "Enter the current equity only, not the full market value of the property."}
                    </span>
                  </label>
                </>
              ) : isLoanAccount ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Loan Category</span>
                      <input
                        type="text"
                        value={form.loanCategory}
                        placeholder="e.g. Mortgage, HELOC, Personal Loan"
                        onChange={(e) => update("loanCategory", e.target.value)}
                        style={inputStyle}
                      />
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Linked Property</span>
                      <select
                        value={form.linkedPropertyId}
                        onChange={(e) => update("linkedPropertyId", e.target.value)}
                        style={inputStyle}
                      >
                        <option value="" style={{ background: "#061224" }}>
                          Not linked yet
                        </option>
                        {realEstateAccounts.map((account) => (
                          <option
                            key={account.id}
                            value={account.id}
                            style={{ background: "#061224" }}
                          >
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Interest Rate (%)</span>
                      <input
                        type="text"
                        value={form.interestRate}
                        placeholder="e.g. 6.25"
                        onChange={(e) => update("interestRate", e.target.value)}
                        style={inputStyle}
                      />
                    </label>

                    <label style={labelStyle}>
                      <span style={labelCapStyle}>Monthly Payment</span>
                      <input
                        type="text"
                        value={form.monthlyPayment}
                        placeholder="e.g. 1850"
                        onChange={(e) => update("monthlyPayment", e.target.value)}
                        style={inputStyle}
                      />
                    </label>
                  </div>

                  <label style={labelStyle}>
                    <span style={labelCapStyle}>Current Balance</span>
                    <input
                      type="text"
                      value={form.balance}
                      placeholder="e.g. -225000"
                      onChange={(e) => update("balance", e.target.value)}
                      style={{
                        ...inputStyle,
                        color: form.balance.trim().startsWith("-") ? "#ff8fa3" : "#eaf3ff",
                      }}
                    />
                    <span style={{ color: "#7294bb", fontSize: 12 }}>
                      Use a negative value for what is still owed on the loan.
                    </span>
                  </label>
                </>
              ) : (
                <label style={labelStyle}>
                  <span style={labelCapStyle}>Current Balance</span>
                  <input
                    type="text"
                    value={form.balance}
                    placeholder="e.g. 5000 or -1250 for debt"
                    onChange={(e) => update("balance", e.target.value)}
                    style={{
                      ...inputStyle,
                      color: form.balance.trim().startsWith("-")
                        ? "#ff8fa3"
                        : form.balance.trim().length > 0
                          ? "#00f59b"
                          : "#eaf3ff",
                    }}
                  />
                  <span style={{ color: "#7294bb", fontSize: 12 }}>
                    Enter a negative number for debt / credit card balances (e.g. -2400).
                  </span>
                </label>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 26 }}>
              <button
                type="button"
                onClick={closeModal}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 9,
                  padding: "12px 20px",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 14,
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                style={{
                  background: canSubmit
                    ? "linear-gradient(90deg,#0077ff,#00d8ff)"
                    : "rgba(120,130,150,.18)",
                  border: canSubmit
                    ? "1px solid rgba(0,216,255,.45)"
                    : "1px solid rgba(160,175,200,.16)",
                  borderRadius: 9,
                  color: canSubmit ? "white" : "#7f93ad",
                  padding: "12px 28px",
                  fontWeight: 900,
                  cursor: canSubmit ? "pointer" : "not-allowed",
                  boxShadow: canSubmit ? "0 0 22px rgba(0,136,255,.32)" : "none",
                  fontSize: 15,
                }}
              >
                {editingAccount ? "Save Changes" : "Add Account →"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
