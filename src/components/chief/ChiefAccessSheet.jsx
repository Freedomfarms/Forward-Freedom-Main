const ROWS = [
  ["money", "Money", "CHIEF can view Freedom Financial when this is on."],
  ["web", "Web", "CHIEF can search the public web when this is on."],
  ["read", "Read", "CHIEF can list and open your conversations when this is on."],
  ["organize", "Organize", "CHIEF can rename and archive conversations when this is on."],
  ["delete", "Delete", "CHIEF can delete a conversation after you confirm, when this is on."],
];

export function ChiefAccessSheet({ open = false, access, onClose }) {
  return (
    <aside
      className={open ? "chief-sheet chief-sheet--right is-open" : "chief-sheet chief-sheet--right"}
      aria-label="What CHIEF can see"
      aria-hidden={open ? undefined : true}
    >
      <div className="chief-sheet-title">What CHIEF can see</div>
      <p className="chief-sheet-copy">
        This is the access CHIEF has right now. It does not grant anything. Your conversation list
        on this screen is separate from Read.
      </p>
      <div className="chief-access-rows">
        {ROWS.map(([key, label, copy]) => (
          <div key={key} className="chief-access-row">
            <div className="chief-access-row-label">
              <span>{label}</span>
              <span>{access?.[key] || "unavailable"}</span>
            </div>
            <p>{copy}</p>
          </div>
        ))}
      </div>
      <button type="button" className="chief-action chief-action--quiet" onClick={onClose}>
        Close
      </button>
    </aside>
  );
}
