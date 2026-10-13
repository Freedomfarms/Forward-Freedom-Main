import { useState } from "react";
import { handoffSharedContext, proposeSharedContext } from "../../utils/chiefApi.js";

const DESTINATIONS = Object.freeze([
  Object.freeze(["claude", "Claude"]),
  Object.freeze(["chatgpt", "ChatGPT"]),
]);

function heldBack(item) {
  if (item.omitted === "untrusted-instruction") return "Instruction-like text was left out.";
  if (item.omitted === "sensitive") return "Sensitive text was left out.";
  return "";
}

export function ChiefContextShare({ user }) {
  const [query, setQuery] = useState("");
  const [proposed, setProposed] = useState(null);
  const [selected, setSelected] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [destination, setDestination] = useState("");
  const [payload, setPayload] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const items = (proposed?.items ?? []).filter((item) => !removed.includes(item.id));
  const destinationLabel = destination === "chatgpt" ? "ChatGPT" : "Claude";

  async function findContext(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setPayload("");
    setSelected([]);
    setRemoved([]);
    try {
      const next = await proposeSharedContext(user, query);
      setProposed(next);
    } catch (cause) {
      setProposed(null);
      setError(cause.message || "Context could not be gathered.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function remove(id) {
    setRemoved((current) => [...current, id]);
    setSelected((current) => current.filter((item) => item !== id));
  }

  async function copySelection() {
    setBusy(true);
    setError("");
    setNotice("");
    setPayload("");
    try {
      const result = await handoffSharedContext(user, {
        query,
        destination,
        itemIds: selected,
        confirm: true,
      });
      const text = typeof result?.payload === "string" ? result.payload : "";
      if (!text) {
        setError("Nothing was copied.");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setNotice(
          `Copied for ${destinationLabel}. Paste it into that chat. Freedom OS did not send it, and this package was not saved as a durable note.`
        );
      } catch {
        setPayload(text);
        setNotice(
          `Clipboard is unavailable. Copy the text below into ${destinationLabel}. Freedom OS did not send it.`
        );
      }
    } catch (cause) {
      setError(cause.message || "The context package was not copied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chief-context-share" aria-label="Share context">
      <div className="chief-sheet-title">Share context</div>
      <p className="chief-sheet-copy">
        Ask a question. Freedom OS gathers a few stored facts and historical excerpts for you to
        review. Sharing stays off until you select items and copy them. Paste the copy into Claude
        or ChatGPT yourself. Native chats stay where they are.
      </p>
      <form onSubmit={findContext}>
        <label className="chief-sheet-copy">
          Question
          <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} />
        </label>
        <div className="chief-approval">
          <button type="submit" className="chief-action" disabled={busy || !query.trim()}>
            {busy ? "Gathering context" : "Find context"}
          </button>
        </div>
      </form>
      {proposed ? <p className="chief-sheet-copy">{proposed.summary}</p> : null}
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <p className="chief-sheet-copy">
                {item.label} · {item.provider} · {item.title}
                {item.updatedAt ? ` · ${item.updatedAt}` : ""}
              </p>
              {item.excerpt ? <p className="chief-sheet-copy">{item.excerpt}</p> : null}
              {item.messageRefs?.length ? (
                <p className="chief-sheet-copy">
                  {item.messageRefs
                    .map((ref) => [ref.role, ref.id, ref.at].filter(Boolean).join(" · "))
                    .join("; ")}
                </p>
              ) : null}
              {heldBack(item) ? <p className="chief-sheet-copy">{heldBack(item)}</p> : null}
              <div className="chief-approval">
                <button
                  type="button"
                  className={`chief-action${selected.includes(item.id) ? "" : " chief-action--quiet"}`}
                  aria-pressed={selected.includes(item.id)}
                  disabled={!item.selectable}
                  onClick={() => toggle(item.id)}
                >
                  {selected.includes(item.id) ? "Selected" : "Select"}
                </button>
                <button
                  type="button"
                  className="chief-action chief-action--quiet"
                  onClick={() => remove(item.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chief-approval" role="group" aria-label="Destination">
        {DESTINATIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`chief-action${destination === id ? "" : " chief-action--quiet"}`}
            aria-pressed={destination === id}
            onClick={() => setDestination(id)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="chief-action"
          disabled={busy || !destination || selected.length === 0}
          onClick={copySelection}
        >
          {destination ? `Copy for ${destinationLabel}` : "Copy selection"}
        </button>
      </div>
      {notice ? <p className="chief-sheet-copy">{notice}</p> : null}
      {error ? <p className="chief-sheet-copy">{error}</p> : null}
      {payload ? (
        <label className="chief-sheet-copy">
          Context package
          <textarea readOnly value={payload} rows={8} />
        </label>
      ) : null}
    </section>
  );
}
