// Once-per-browser-tab-session lifecycle for the public CHIEF Draft 4 intro.
// The flag is shared by the public homepage and the login screen so moving
// between them never replays the automatic intro. sessionStorage scopes it to
// the tab and clears it when the tab closes. Manual Replay ignores the flag.

const INTRO_PLAYED_KEY = "freedom-os.chief-intro.played";

export function hasChiefIntroPlayed(storage = defaultStorage()) {
  try {
    return storage?.getItem(INTRO_PLAYED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markChiefIntroPlayed(storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(INTRO_PLAYED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

function defaultStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
