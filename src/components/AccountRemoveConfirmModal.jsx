import { styles } from "../styles.js";
import { buildAccountRemovalSummary } from "../utils/accountRemovalSummary.js";

export function AccountRemoveConfirmModal({
  deleteTarget,
  accounts,
  transactions,
  subscriptions,
  plaidItems,
  onBackdropClick,
  onCancel,
  onConfirm,
  isDeleting,
  deleteError,
}) {
  if (!deleteTarget) return null;

  const { deleteTargetPlaidItem, deleteTargetLinkedAccounts, deleteTargetTransactionCount, deleteTargetSubscriptionCount } =
    buildAccountRemovalSummary(deleteTarget, accounts, transactions, subscriptions, plaidItems);

  return (
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
        if (event.target === event.currentTarget) onBackdropClick?.();
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
            disabled={isDeleting}
            onClick={onCancel}
            style={{
              background: "rgba(0,136,255,.10)",
              border: "1px solid rgba(0,216,255,.28)",
              color: "#d7ebff",
              borderRadius: 8,
              padding: "11px 16px",
              cursor: isDeleting ? "wait" : "pointer",
              fontWeight: 800,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isDeleting}
            onClick={() => {
              void onConfirm?.();
            }}
            style={{
              background: "linear-gradient(90deg,#ff244d,#ff5d7a)",
              border: "1px solid rgba(255,93,122,.55)",
              color: "white",
              borderRadius: 8,
              padding: "11px 16px",
              cursor: isDeleting ? "wait" : "pointer",
              fontWeight: 900,
              boxShadow: "0 0 22px rgba(255,36,77,.32)",
            }}
          >
            {isDeleting
              ? "Removing..."
              : deleteTarget.plaidItemId
                ? "Disconnect Institution"
                : "Delete Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
