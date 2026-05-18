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
}) {
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
          <button
            key={user.id}
            onClick={() => onSelectUser(user.id)}
            onDoubleClick={() => onStartEditingUser(user.id)}
            title="Double-click to rename"
            style={{
              color: isActive ? "#f4fbff" : "#9fb0c9",
              background: isActive ? "rgba(0,136,255,.18)" : "rgba(0,136,255,.06)",
              border: isActive ? "1px solid rgba(0,216,255,.42)" : "1px solid rgba(0,216,255,.18)",
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
        );
      })}

      <button
        onClick={onAddUser}
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
