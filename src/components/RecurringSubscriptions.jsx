import { useState } from "react";
import { styles } from "../styles.js";
import { money } from "../utils/format.js";
import { accountSupportsTransactions } from "../utils/accounts.js";
import {
  monthlyEquivalent,
  nextBillingDate,
  SUBSCRIPTION_FREQUENCIES,
  SUBSCRIPTION_STATUSES,
} from "../utils/subscriptions.js";

const STATUS_COLORS = {
  Active: "#00f59b",
  Paused: "#ffb65d",
  Cancelled: "#ff5d7a",
};

const STATUS_BG = {
  Active: "rgba(0,245,155,.12)",
  Paused: "rgba(255,182,93,.12)",
  Cancelled: "rgba(255,93,122,.12)",
};

const CATEGORY_OPTIONS = [
  "Housing",
  "Utilities",
  "Subscriptions",
  "Fitness & Wellness",
  "Insurance",
  "Technology",
  "Entertainment",
  "Shopping",
  "Transportation",
  "Health",
  "Other",
];

const ICON_OPTIONS = [
  "🎬",
  "🎵",
  "📺",
  "📦",
  "🏠",
  "📱",
  "🍎",
  "🏋️",
  "🚗",
  "⚡",
  "💳",
  "🎮",
  "📰",
  "🎓",
  "☁️",
  "🔒",
  "🛒",
  "🤖",
  "✈️",
  "⚕️",
];

const EMPTY_FORM = {
  name: "",
  amount: "",
  frequency: "Monthly",
  category: "Subscriptions",
  billing: 1,
  account: "",
  icon: "💳",
  status: "Active",
};

export function RecurringSubscriptions({ accounts, subscriptions, setSubscriptions }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [filterStatus, setFilterStatus] = useState("All");
  const accountOptions = accounts.filter((account) => accountSupportsTransactions(account));

  const updateForm = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const canAdd =
    form.name.trim() &&
    Number.isFinite(Number(String(form.amount).replace(/[^0-9.]/g, ""))) &&
    Number(String(form.amount).replace(/[^0-9.]/g, "")) > 0;

  const addSubscription = () => {
    if (!canAdd) return;
    setSubscriptions((current) => [
      ...current,
      {
        ...form,
        id: `sub-custom-${Date.now()}`,
        amount: Number(String(form.amount).replace(/[^0-9.]/g, "")),
        billing: Number(form.billing) || 1,
      },
    ]);
    setForm(EMPTY_FORM);
    setShowAddForm(false);
  };

  const cycleStatus = (id) => {
    setSubscriptions((current) =>
      current.map((sub) => {
        if (sub.id !== id) return sub;
        const next =
          SUBSCRIPTION_STATUSES[
            (SUBSCRIPTION_STATUSES.indexOf(sub.status) + 1) % SUBSCRIPTION_STATUSES.length
          ];
        return { ...sub, status: next };
      })
    );
  };

  const confirmDelete = () => {
    setSubscriptions((current) => current.filter((sub) => sub.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  const filtered =
    filterStatus === "All" ? subscriptions : subscriptions.filter((s) => s.status === filterStatus);

  const activeMonthly = subscriptions
    .filter((s) => s.status === "Active")
    .reduce((sum, s) => sum + monthlyEquivalent(s.amount, s.frequency), 0);

  const pausedMonthly = subscriptions
    .filter((s) => s.status === "Paused")
    .reduce((sum, s) => sum + monthlyEquivalent(s.amount, s.frequency), 0);

  const totalCount = subscriptions.length;
  const activeCount = subscriptions.filter((s) => s.status === "Active").length;

  const inputStyle = {
    color: "#eaf3ff",
    background: "rgba(0,136,255,.08)",
    border: "1px solid rgba(0,216,255,.18)",
    borderRadius: 8,
    padding: "10px 11px",
    outline: "none",
    fontWeight: 700,
    colorScheme: "dark",
    width: "100%",
  };

  const selectStyle = { ...inputStyle };

  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 32, color: "white", fontWeight: 800 }}>
            Recurring Subscriptions
          </h1>
          <p style={{ marginTop: 8, color: "#8ea8ca" }}>
            Track recurring bills, subscriptions, and auto-pay commitments.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          style={{
            background: showAddForm
              ? "rgba(0,136,255,.14)"
              : "linear-gradient(90deg,#0077ff,#00d8ff)",
            border: "1px solid rgba(0,216,255,.45)",
            borderRadius: 10,
            color: "white",
            padding: "14px 24px",
            fontWeight: 800,
            boxShadow: showAddForm ? "none" : "0 0 28px rgba(0,136,255,.35)",
            cursor: "pointer",
          }}
        >
          {showAddForm ? "✕ Cancel" : "+ Add Subscription"}
        </button>
      </header>

      {/* Summary Tiles */}
      <div
        style={{
          ...styles.panel,
          padding: 24,
          marginBottom: 18,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at top right, rgba(0,216,255,.14), transparent 35%)",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: "repeat(4,1fr)",
            gap: 18,
          }}
        >
          {[
            ["Active Monthly Cost", money(activeMonthly)],
            ["Annual Commitment", money(activeMonthly * 12)],
            ["Active / Total", `${activeCount} / ${totalCount}`],
            ["Paused Savings", money(pausedMonthly)],
          ].map(([label, val]) => (
            <div
              key={label}
              style={{
                border: "1px solid rgba(0,136,255,.22)",
                borderRadius: 14,
                background: "rgba(3,17,32,.72)",
                padding: 20,
              }}
            >
              <div
                style={{
                  color: "#8fb1d9",
                  fontSize: 13,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                {label}
              </div>
              <div style={{ color: "white", fontSize: 28, fontWeight: 800 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Form */}
      {showAddForm ? (
        <div
          style={{
            ...styles.panel,
            padding: 22,
            marginBottom: 18,
            border: "1px solid rgba(0,216,255,.22)",
            boxShadow: "inset 0 0 22px rgba(0,136,255,.06)",
          }}
        >
          <div style={{ color: "white", fontSize: 18, fontWeight: 900, marginBottom: 16 }}>
            New Subscription
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 110px 130px 140px 130px 110px 110px 80px",
              gap: 12,
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
                Name
              </span>
              <input
                type="text"
                value={form.name}
                placeholder="Netflix, Mortgage…"
                onChange={(e) => updateForm("name", e.target.value)}
                style={inputStyle}
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
                Amount
              </span>
              <input
                type="text"
                value={form.amount}
                placeholder="18.99"
                onChange={(e) => updateForm("amount", e.target.value)}
                style={inputStyle}
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
                Frequency
              </span>
              <select
                value={form.frequency}
                onChange={(e) => updateForm("frequency", e.target.value)}
                style={selectStyle}
              >
                {SUBSCRIPTION_FREQUENCIES.map((f) => (
                  <option key={f} value={f} style={{ background: "#061224" }}>
                    {f}
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
                Category
              </span>
              <select
                value={form.category}
                onChange={(e) => updateForm("category", e.target.value)}
                style={selectStyle}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c} style={{ background: "#061224" }}>
                    {c}
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
                value={form.account}
                onChange={(e) => updateForm("account", e.target.value)}
                style={selectStyle}
              >
                <option value="" style={{ background: "#061224" }}>
                  Select account
                </option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.name} style={{ background: "#061224" }}>
                    {account.name}
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
                Bill Day
              </span>
              <input
                type="number"
                min={1}
                max={31}
                value={form.billing}
                onChange={(e) => updateForm("billing", e.target.value)}
                style={inputStyle}
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
                Icon
              </span>
              <select
                value={form.icon}
                onChange={(e) => updateForm("icon", e.target.value)}
                style={selectStyle}
              >
                {ICON_OPTIONS.map((ic) => (
                  <option key={ic} value={ic} style={{ background: "#061224" }}>
                    {ic}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={addSubscription}
              disabled={!canAdd}
              style={{
                background: canAdd
                  ? "linear-gradient(90deg,#0077ff,#00d8ff)"
                  : "rgba(120,130,150,.18)",
                border: canAdd
                  ? "1px solid rgba(0,216,255,.45)"
                  : "1px solid rgba(160,175,200,.16)",
                borderRadius: 10,
                color: canAdd ? "white" : "#7f93ad",
                padding: "11px 0",
                fontWeight: 900,
                cursor: canAdd ? "pointer" : "not-allowed",
                boxShadow: canAdd ? "0 0 18px rgba(0,136,255,.28)" : "none",
              }}
            >
              Add
            </button>
          </div>
        </div>
      ) : null}

      {/* Filter Bar */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          alignItems: "center",
        }}
      >
        <span style={{ color: "#8fb1d9", fontSize: 13, marginRight: 4 }}>Filter:</span>
        {["All", ...SUBSCRIPTION_STATUSES].map((status) => (
          <button
            key={status}
            onClick={() => setFilterStatus(status)}
            style={{
              background:
                filterStatus === status
                  ? "linear-gradient(90deg,rgba(0,119,255,.32),rgba(0,216,255,.22))"
                  : "rgba(0,136,255,.08)",
              border:
                filterStatus === status
                  ? "1px solid rgba(0,216,255,.45)"
                  : "1px solid rgba(0,136,255,.2)",
              borderRadius: 8,
              color: filterStatus === status ? "#d7efff" : "#7294bb",
              padding: "8px 16px",
              cursor: "pointer",
              fontWeight: filterStatus === status ? 800 : 600,
              fontSize: 13,
            }}
          >
            {status}
          </button>
        ))}
        <span style={{ color: "#7294bb", fontSize: 13, marginLeft: "auto" }}>
          {filtered.length} subscription{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Subscription Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 14,
        }}
      >
        {filtered.map((sub) => {
          const monthly = monthlyEquivalent(sub.amount, sub.frequency);
          return (
            <div
              key={sub.id}
              style={{
                ...styles.panel,
                padding: 20,
                opacity: sub.status === "Cancelled" ? 0.55 : 1,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: 3,
                  height: "100%",
                  background: STATUS_COLORS[sub.status],
                  boxShadow: `0 0 12px ${STATUS_COLORS[sub.status]}`,
                  borderRadius: "4px 0 0 4px",
                }}
              />
              <div style={{ paddingLeft: 8, display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Header row */}
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 24 }}>{sub.icon}</span>
                    <div>
                      <div style={{ color: "white", fontWeight: 800, fontSize: 16 }}>
                        {sub.name}
                      </div>
                      <div style={{ color: "#7294bb", fontSize: 12, marginTop: 2 }}>
                        {sub.category}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ color: "white", fontWeight: 900, fontSize: 18 }}>
                      {money(sub.amount)}
                    </div>
                    <div style={{ color: "#7294bb", fontSize: 12 }}>
                      / {sub.frequency.toLowerCase()}
                    </div>
                  </div>
                </div>

                {/* Details row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    borderTop: "1px solid rgba(0,136,255,.12)",
                    paddingTop: 10,
                  }}
                >
                  <div>
                    <div style={{ color: "#8fb1d9", fontSize: 11, textTransform: "uppercase" }}>
                      Monthly Equiv.
                    </div>
                    <div style={{ color: "#b8d3f3", fontWeight: 700, marginTop: 3 }}>
                      {money(monthly)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "#8fb1d9", fontSize: 11, textTransform: "uppercase" }}>
                      Next Bill
                    </div>
                    <div style={{ color: "#b8d3f3", fontWeight: 700, marginTop: 3 }}>
                      {sub.status === "Cancelled"
                        ? "—"
                        : nextBillingDate(sub.billing, sub.frequency)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "#8fb1d9", fontSize: 11, textTransform: "uppercase" }}>
                      Account
                    </div>
                    <div
                      style={{
                        color: "#b8d3f3",
                        fontWeight: 700,
                        marginTop: 3,
                        maxWidth: 90,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                      }}
                    >
                      {sub.account || "—"}
                    </div>
                  </div>
                </div>

                {/* Actions row */}
                <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
                  <button
                    onClick={() => cycleStatus(sub.id)}
                    style={{
                      background: STATUS_BG[sub.status],
                      border: `1px solid ${STATUS_COLORS[sub.status]}44`,
                      borderRadius: 8,
                      color: STATUS_COLORS[sub.status],
                      padding: "7px 12px",
                      cursor: "pointer",
                      fontWeight: 800,
                      fontSize: 12,
                      flex: 1,
                    }}
                  >
                    ● {sub.status}
                  </button>
                  <button
                    onDoubleClick={() => setDeleteTarget(sub)}
                    title="Double-click to delete"
                    style={{
                      background: "rgba(255,36,77,.07)",
                      border: "1px solid rgba(255,36,77,.2)",
                      borderRadius: 8,
                      color: "#ff7a8a",
                      padding: "7px 12px",
                      cursor: "pointer",
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div
          style={{
            ...styles.panel,
            padding: 48,
            textAlign: "center",
            color: "#7294bb",
            marginTop: 14,
          }}
        >
          <div style={{ color: "white", fontSize: 24, fontWeight: 900 }}>
            No recurring commitments tracked yet
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.6 }}>
            Add your subscriptions, insurance, memberships, or mortgage payments so Operations,
            Forecast, and the Dashboard can see the fixed costs you carry every month.
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            style={{
              marginTop: 18,
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              border: "1px solid rgba(0,216,255,.45)",
              borderRadius: 10,
              color: "white",
              padding: "12px 18px",
              cursor: "pointer",
              fontWeight: 800,
              boxShadow: "0 0 18px rgba(0,136,255,.28)",
            }}
          >
            + Add First Subscription
          </button>
        </div>
      ) : null}

      {/* Delete confirmation modal */}
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
              Remove {deleteTarget.name}?
            </div>
            <p style={{ color: "#a8bfdc", lineHeight: 1.55, marginTop: 14 }}>
              This will permanently remove {deleteTarget.name} ({money(deleteTarget.amount)} /{" "}
              {deleteTarget.frequency.toLowerCase()}) from your subscription list.
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
                onClick={confirmDelete}
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
                Remove Subscription
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
