import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { styles } from "../styles.js";

export function InfoDot() {
  return (
    <span
      style={{
        color: "#8dbdff",
        border: "1px solid #5c97e8",
        borderRadius: 999,
        fontSize: 11,
        width: 16,
        height: 16,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      i
    </span>
  );
}

export function SideItem({ item, activeTab, setActiveTab }) {
  const isActive = activeTab === item.label;

  return (
    <button
      className={`sidebar-nav-button${isActive ? " sidebar-nav-button--active" : ""}`}
      onClick={() => setActiveTab(item.label)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        borderRadius: 8,
        padding: "12px 12px",
        fontSize: 14,
        marginBottom: 8,
        width: "100%",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ width: 18, color: isActive ? "#23d7ff" : "#c9d8ee", fontSize: 18 }}>
        {item.icon}
      </span>
      <span>{item.label}</span>
    </button>
  );
}

export function HouseholdProfilesControl({
  users,
  activeUserId,
  editingUserId,
  draftUserName,
  setDraftUserName,
  onSelectUser,
  onStartEditingUser,
  onSaveUserName,
  onCancelUserRename,
  onAddUser,
  onDeleteUser,
}) {
  const [menuUserId, setMenuUserId] = useState(null);
  const [deleteTargetUserId, setDeleteTargetUserId] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [isDeletingUser, setIsDeletingUser] = useState(false);
  const menuRef = useRef(null);
  const hasMultipleUsers = users.length > 1;
  const deleteTarget = users.find((user) => user.id === deleteTargetUserId) || null;
  const deleteTargetSummary = deleteTarget
    ? [
        { label: "Accounts", value: deleteTarget.accounts?.length || 0 },
        { label: "Transactions", value: deleteTarget.transactions?.length || 0 },
        { label: "Budget Rows", value: deleteTarget.budgetRows?.length || 0 },
        { label: "Income Streams", value: deleteTarget.incomeStreams?.length || 0 },
        { label: "Subscriptions", value: deleteTarget.subscriptions?.length || 0 },
        { label: "Plans", value: Object.keys(deleteTarget.plansByYear || {}).length },
        { label: "Linked Plaid Items", value: deleteTarget.plaidItems?.length || 0 },
      ]
    : [];

  useEffect(() => {
    if (!menuUserId && !deleteTargetUserId) return undefined;

    const handlePointerDown = (event) => {
      if (menuUserId && menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuUserId(null);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || isDeletingUser) return;
      setMenuUserId(null);
      setDeleteTargetUserId(null);
      setDeleteError("");
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteTargetUserId, isDeletingUser, menuUserId]);

  const closeDeleteDialog = () => {
    if (isDeletingUser) return;
    setDeleteTargetUserId(null);
    setDeleteError("");
  };

  const confirmDeleteUser = async () => {
    if (!deleteTarget || !onDeleteUser || isDeletingUser) return;

    setDeleteError("");
    setIsDeletingUser(true);

    try {
      await onDeleteUser(deleteTarget.id);
      setDeleteTargetUserId(null);
      setMenuUserId(null);
    } catch (error) {
      setDeleteError(error?.message || "Unable to delete this user profile right now.");
    } finally {
      setIsDeletingUser(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        justifyContent: "flex-end",
      }}
    >
      {users.map((user, index) => {
        const label = user?.name?.trim() || `User ${index + 1}`;
        const isActive = user.id === activeUserId;
        const isEditing = editingUserId === user.id;

        if (isEditing) {
          return (
            <input
              key={user.id}
              value={draftUserName}
              onChange={(event) => setDraftUserName(event.target.value)}
              onBlur={() => onSaveUserName(user.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSaveUserName(user.id);
                if (event.key === "Escape") onCancelUserRename();
              }}
              autoFocus
              style={{
                color: "#eaf3ff",
                background: "rgba(0,136,255,.14)",
                border: "1px solid rgba(0,216,255,.38)",
                borderRadius: 999,
                padding: "9px 14px",
                minWidth: 120,
                outline: "none",
                fontWeight: 800,
                fontSize: 13,
              }}
            />
          );
        }

        return (
          <div
            key={user.id}
            ref={menuUserId === user.id ? menuRef : null}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <button
              onClick={() => {
                setMenuUserId(null);
                onSelectUser(user.id);
              }}
              onDoubleClick={() => {
                setMenuUserId(null);
                onStartEditingUser(user.id);
              }}
              title="Double-click to rename"
              style={{
                color: isActive ? "#f4fbff" : "#9fb0c9",
                background: isActive ? "rgba(0,136,255,.18)" : "rgba(0,136,255,.06)",
                border: isActive
                  ? "1px solid rgba(0,216,255,.42)"
                  : "1px solid rgba(0,216,255,.18)",
                borderRadius: 999,
                padding: "9px 14px",
                cursor: "pointer",
                fontWeight: 800,
                fontSize: 13,
                boxShadow: isActive ? "0 0 18px rgba(0,136,255,.18)" : "none",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </button>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuUserId === user.id}
              title={`Profile actions for ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuUserId((currentUserId) => (currentUserId === user.id ? null : user.id));
              }}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                border: isActive
                  ? "1px solid rgba(0,216,255,.35)"
                  : "1px solid rgba(0,216,255,.18)",
                background: isActive ? "rgba(0,136,255,.12)" : "rgba(0,136,255,.05)",
                color: isActive ? "#eaf7ff" : "#9fb0c9",
                cursor: "pointer",
                fontSize: 18,
                fontWeight: 900,
                lineHeight: 1,
              }}
            >
              ⋯
            </button>
            {menuUserId === user.id ? (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 10px)",
                  right: 0,
                  minWidth: 180,
                  borderRadius: 14,
                  border: "1px solid rgba(0,216,255,.24)",
                  background: "#081423",
                  boxShadow: "0 18px 42px rgba(0,8,18,.72), 0 0 28px rgba(0,136,255,.2)",
                  padding: 8,
                  display: "grid",
                  gap: 6,
                  zIndex: 120,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuUserId(null);
                    onStartEditingUser(user.id);
                  }}
                  style={{
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.16)",
                    color: "#eaf3ff",
                    borderRadius: 10,
                    padding: "10px 12px",
                    cursor: "pointer",
                    fontWeight: 800,
                    textAlign: "left",
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!hasMultipleUsers}
                  onClick={() => {
                    if (!hasMultipleUsers) return;
                    setDeleteError("");
                    setDeleteTargetUserId(user.id);
                    setMenuUserId(null);
                  }}
                  style={{
                    background: hasMultipleUsers ? "rgba(255,36,77,.10)" : "rgba(103,120,144,.10)",
                    border: hasMultipleUsers
                      ? "1px solid rgba(255,93,122,.28)"
                      : "1px solid rgba(126,166,216,.18)",
                    color: hasMultipleUsers ? "#ffd9df" : "#7f95b2",
                    borderRadius: 10,
                    padding: "10px 12px",
                    cursor: hasMultipleUsers ? "pointer" : "not-allowed",
                    fontWeight: 800,
                    textAlign: "left",
                  }}
                >
                  Delete user
                </button>
                {!hasMultipleUsers ? (
                  <div
                    style={{
                      color: "#7ea6d8",
                      fontSize: 11,
                      lineHeight: 1.45,
                      padding: "0 2px 2px",
                    }}
                  >
                    Keep at least one profile in the workspace.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <button
        onClick={() => {
          setMenuUserId(null);
          onAddUser();
        }}
        style={{
          background: "linear-gradient(90deg,#0077ff,#00d8ff)",
          border: "1px solid rgba(120,220,255,.45)",
          borderRadius: 999,
          color: "white",
          padding: "9px 14px",
          cursor: "pointer",
          fontWeight: 800,
          fontSize: 13,
          boxShadow: "0 0 18px rgba(0,136,255,.2)",
          whiteSpace: "nowrap",
        }}
      >
        + Add User
      </button>
      {deleteTarget ? (
        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDeleteDialog();
          }}
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
              Confirm Delete
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900, lineHeight: 1.15 }}>
              Delete {deleteTarget.name || "this user profile"}?
            </div>
            <p style={{ color: "#a8bfdc", lineHeight: 1.6, marginTop: 14, marginBottom: 0 }}>
              This permanently removes the profile from this workspace, including its accounts,
              transactions, budget setup, income streams, subscriptions, and planning data.
            </p>
            {deleteTarget.plaidItems?.length ? (
              <div
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  border: "1px solid rgba(255,93,122,.28)",
                  background: "rgba(255,36,77,.08)",
                  color: "#ffd9df",
                  padding: "12px 14px",
                  lineHeight: 1.55,
                }}
              >
                This profile has {deleteTarget.plaidItems.length} linked Plaid item
                {deleteTarget.plaidItems.length === 1 ? "" : "s"}. Stored linked-account data for
                this user will also be cleared from the workspace.
              </div>
            ) : null}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 10,
                marginTop: 18,
              }}
            >
              {deleteTargetSummary.map((item) => (
                <div
                  key={item.label}
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
                    {item.label}
                  </div>
                  <div style={{ color: "white", fontSize: 20, fontWeight: 800, marginTop: 6 }}>
                    {item.value}
                  </div>
                </div>
              ))}
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
                disabled={isDeletingUser}
                onClick={closeDeleteDialog}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: isDeletingUser ? "wait" : "pointer",
                  fontWeight: 800,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingUser}
                onClick={() => {
                  void confirmDeleteUser();
                }}
                style={{
                  background: "linear-gradient(90deg,#ff244d,#ff5d7a)",
                  border: "1px solid rgba(255,93,122,.55)",
                  color: "white",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: isDeletingUser ? "wait" : "pointer",
                  fontWeight: 900,
                  boxShadow: "0 0 22px rgba(255,36,77,.32)",
                }}
              >
                {isDeletingUser ? "Deleting..." : "Delete User"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MetricCard({ metric }) {
  const changeColor = metric.changeColor || (metric.red ? "#ff355d" : "#00f59b");
  const changeIcon = metric.changeIcon || (metric.red ? "↓" : "↑");
  const subLabel = metric.subLabel || "vs last 30 days";

  return (
    <button
      onClick={metric.onClick}
      style={{
        ...styles.panel,
        padding: 20,
        width: "100%",
        border: "none",
        cursor: metric.onClick ? "pointer" : "default",
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div
          style={{
            width: 50,
            height: 50,
            borderRadius: 9,
            border: "1px solid rgba(0,179,255,.55)",
            background: "rgba(0,104,255,.16)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#23d7ff",
            fontSize: 26,
            boxShadow: "0 0 24px rgba(0,128,255,.35)",
          }}
        >
          {metric.icon}
        </div>
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "#c9d8ee",
              fontSize: 12,
              letterSpacing: 0.3,
            }}
          >
            {metric.title}
            <InfoDot />
          </div>
          <div style={{ marginTop: 12, color: "white", fontSize: 25, fontWeight: 650 }}>
            {metric.value}
          </div>
          <div
            style={{
              marginTop: 12,
              color: changeColor,
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            {changeIcon} {metric.change}
          </div>
          <div style={{ marginTop: 4, color: "#9fb0c9", fontSize: 14 }}>{subLabel}</div>
        </div>
      </div>
    </button>
  );
}

export function MonthCoverageEditor({
  allMonths,
  selectedMonths,
  quickActions = [],
  onToggleMonth,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const triggerRef = useRef(null);
  const activeMonths = selectedMonths?.length ? selectedMonths : allMonths;
  const allSelected = activeMonths.length === allMonths.length;
  const summaryLabel = allSelected
    ? "All months"
    : activeMonths.length === 1
      ? activeMonths[0]
      : `${activeMonths.length} months`;

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleEscape = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || typeof window === "undefined") return undefined;

    const updatePopoverPosition = () => {
      const triggerBounds = triggerRef.current?.getBoundingClientRect();
      if (!triggerBounds) return;

      const desiredWidth = 300;
      const maxLeft = Math.max(12, window.innerWidth - desiredWidth - 12);
      setPopoverPosition({
        top: triggerBounds.bottom + 8,
        left: Math.min(Math.max(12, triggerBounds.left), maxLeft),
        width: desiredWidth,
      });
    };

    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [isOpen]);

  const popover =
    isOpen && popoverPosition && typeof document !== "undefined"
      ? createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 2400,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(2,8,18,.04)",
              }}
            />
            <div
              onMouseDown={(event) => event.stopPropagation()}
              style={{
                position: "absolute",
                top: popoverPosition.top,
                left: popoverPosition.left,
                width: popoverPosition.width,
                padding: 14,
                borderRadius: 14,
                border: "1px solid rgba(0,216,255,.28)",
                backgroundColor: "#081423",
                boxShadow: "0 18px 42px rgba(0,8,18,.72), 0 0 28px rgba(0,136,255,.2)",
                display: "grid",
                gap: 10,
              }}
            >
              <div
                style={{
                  color: "#7ea6d8",
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                Coverage
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {quickActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      action.onClick();
                    }}
                    style={{
                      background: "#10253b",
                      border: "1px solid rgba(0,216,255,.2)",
                      color: "#9fd8ff",
                      borderRadius: 999,
                      padding: "5px 10px",
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                {allMonths.map((month) => {
                  const isActive = activeMonths.includes(month);
                  return (
                    <button
                      key={month}
                      type="button"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleMonth(month);
                      }}
                      style={{
                        background: isActive ? "#12385d" : "#102133",
                        border: isActive
                          ? "1px solid rgba(0,216,255,.42)"
                          : "1px solid rgba(0,136,255,.16)",
                        color: isActive ? "#eaf7ff" : "#7ea6d8",
                        borderRadius: 999,
                        padding: "7px 0",
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: "pointer",
                        boxShadow: isActive ? "0 0 14px rgba(0,136,255,.16)" : "none",
                        minWidth: 42,
                      }}
                    >
                      {month}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                <button
                  type="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsOpen(false);
                  }}
                  style={{
                    background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                    border: "1px solid rgba(120,220,255,.34)",
                    borderRadius: 999,
                    color: "white",
                    padding: "6px 12px",
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <div style={{ position: "relative", marginTop: 10, zIndex: 40 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 12px",
          borderRadius: 10,
          background: "rgba(0,136,255,.08)",
          border: "1px solid rgba(0,216,255,.18)",
          color: "#9fd8ff",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 800,
          userSelect: "none",
          outline: "none",
        }}
      >
        <span>{summaryLabel}</span>
        <span style={{ color: "#7ea6d8", fontSize: 10 }}>
          {allSelected
            ? "All active"
            : `${activeMonths.length} active month${activeMonths.length === 1 ? "" : "s"}`}
        </span>
        <span style={{ fontSize: 11 }}>{isOpen ? "▴" : "▾"}</span>
      </button>
      {popover}
    </div>
  );
}
