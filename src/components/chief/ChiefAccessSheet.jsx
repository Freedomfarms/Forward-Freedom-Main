const ROWS = [
  ["money", "Money", "CHIEF can view Freedom Financial when this is on."],
  ["web", "Web", "CHIEF can search the public web when this is on."],
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
        Money and Web are the access switches. Your CHIEF conversations already belong to the
        signed-in user. Rename, archive, and delete them from Your conversations. There is no
        separate Read, Organize, or Delete grant.
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
