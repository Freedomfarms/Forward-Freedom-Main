function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

function AccessGroup({ title, children }) {
  return (
    <section className="chief-access-group">
      <div className="chief-sheet-title">{title}</div>
      {children}
    </section>
  );
}

export function ChiefAccessSheet({ open = false, access, onClose }) {
  const inventory = access?.inventory;
  const connected = rowsOf(inventory?.connected);
  const read = rowsOf(inventory?.read);
  const actions = rowsOf(inventory?.actions);
  const unavailable = rowsOf(inventory?.unavailable);
  return (
    <aside
      className={open ? "chief-sheet chief-sheet--right is-open" : "chief-sheet chief-sheet--right"}
      aria-label="What CHIEF can see"
      aria-hidden={open ? undefined : true}
    >
      <div className="chief-sheet-title">Access</div>
      <p className="chief-sheet-copy">
        Money {access?.money || "unavailable"} · Web {access?.web || "unavailable"}. The command
        room stays clear. This panel is the control plane.
      </p>
      {inventory ? (
        <>
          <AccessGroup title="Connected">
            <p className="chief-sheet-copy">
              {connected.length ? connected.join(", ") : "No external connector is connected."}
            </p>
          </AccessGroup>
          <AccessGroup title="Read">
            <div className="chief-access-rows">
              {read.length ? (
                read.map((row) => (
                  <div key={row.id} className="chief-access-row">
                    <div className="chief-access-row-label">
                      <span>{row.id}</span>
                      <span>{row.state === "gated" ? "gated" : "on"}</span>
                    </div>
                    {row.detail ? <p>{row.detail}</p> : null}
                  </div>
                ))
              ) : (
                <p className="chief-sheet-copy">No read capability is ready.</p>
              )}
            </div>
          </AccessGroup>
          <AccessGroup title="Actions">
            <div className="chief-access-rows">
              {actions.length ? (
                actions.map((row) => (
                  <div key={row.id} className="chief-access-row">
                    <div className="chief-access-row-label">
                      <span>{row.id}</span>
                      <span>{row.approval ? "approval" : "on"}</span>
                    </div>
                    {row.detail ? <p>{row.detail}</p> : null}
                  </div>
                ))
              ) : (
                <p className="chief-sheet-copy">No action is ready.</p>
              )}
            </div>
          </AccessGroup>
          <AccessGroup title="Unavailable">
            <div className="chief-access-rows">
              {unavailable.map((row) => (
                <div key={row.id} className="chief-access-row">
                  <div className="chief-access-row-label">
                    <span>{row.id}</span>
                  </div>
                  {row.detail ? <p>{row.detail}</p> : null}
                </div>
              ))}
            </div>
          </AccessGroup>
        </>
      ) : (
        <p className="chief-sheet-copy">Access could not be read.</p>
      )}
      <button type="button" className="chief-action chief-action--quiet" onClick={onClose}>
        Close
      </button>
    </aside>
  );
}
