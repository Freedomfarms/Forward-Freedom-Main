import { useEffect, useState } from "react";
import {
  fetchCaptureStatus,
  issueCaptureToken,
  revokeCaptureToken,
  updateCaptureControls,
} from "../../utils/chiefApi.js";

function formatWhen(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export function ChiefCapturePanel({ user }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchCaptureStatus(user)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message || "Capture status could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function run(work) {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      if (typeof next?.token === "string") {
        setToken(next.token);
        const rest = { ...next };
        delete rest.token;
        setStatus(rest);
      } else {
        setStatus(next);
      }
      return next;
    } catch (cause) {
      setError(cause.message || "Capture settings could not be saved.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggle(field) {
    if (!status) return;
    await run(() => updateCaptureControls(user, { [field]: !status[field] }));
  }

  return (
    <div className="chief-settings-confirm">
      <div className="chief-sheet-title">Live capture</div>
      <p className="chief-sheet-copy">
        Live capture stays off until you enable a provider and create a token. The extension stores
        the token on this browser. Captured chats are not turned into durable notes. Pause or revoke
        stops new writes. A shorter page snapshot will not replace a longer archived conversation.
      </p>
      <p className="chief-sheet-copy">
        Token {status?.issued ? "active" : "not created"}. Last success{" "}
        {formatWhen(status?.lastSuccessAt)}. Last error {status?.lastErrorCode || "none"}
        {status?.lastErrorAt ? ` at ${formatWhen(status.lastErrorAt)}` : ""}.
      </p>
      {token ? (
        <label className="chief-sheet-copy">
          Copy this token now. It is not shown again.
          <input readOnly value={token} />
        </label>
      ) : null}
      <div className="chief-approval">
        <button
          type="button"
          className={`chief-action${status?.claudeEnabled ? "" : " chief-action--quiet"}`}
          aria-pressed={Boolean(status?.claudeEnabled)}
          disabled={busy || !status}
          onClick={() => toggle("claudeEnabled")}
        >
          {status?.claudeEnabled ? "Claude capture on" : "Enable Claude capture"}
        </button>
        <button
          type="button"
          className={`chief-action${status?.chatgptEnabled ? "" : " chief-action--quiet"}`}
          aria-pressed={Boolean(status?.chatgptEnabled)}
          disabled={busy || !status}
          onClick={() => toggle("chatgptEnabled")}
        >
          {status?.chatgptEnabled ? "ChatGPT capture on" : "Enable ChatGPT capture"}
        </button>
        <button
          type="button"
          className={`chief-action${status?.paused ? " chief-action--danger" : " chief-action--quiet"}`}
          aria-pressed={Boolean(status?.paused)}
          disabled={busy || !status}
          onClick={() => toggle("paused")}
        >
          {status?.paused ? "Capture paused" : "Pause capture"}
        </button>
        <button
          type="button"
          className="chief-action"
          disabled={busy}
          onClick={() => run(() => issueCaptureToken(user))}
        >
          Create capture token
        </button>
        <button
          type="button"
          className="chief-action chief-action--quiet"
          disabled={busy || !status?.issued}
          onClick={() =>
            run(async () => {
              const next = await revokeCaptureToken(user);
              setToken("");
              return next;
            })
          }
        >
          Revoke capture token
        </button>
      </div>
      {error ? <p className="chief-sheet-copy">{error}</p> : null}
    </div>
  );
}
