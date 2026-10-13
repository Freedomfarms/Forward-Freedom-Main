const originInput = document.querySelector("#origin");
const tokenInput = document.querySelector("#token");
const claudeInput = document.querySelector("#claude");
const chatgptInput = document.querySelector("#chatgpt");
const pausedInput = document.querySelector("#paused");
const statusNode = document.querySelector("#status");
const noticeNode = document.querySelector("#notice");

function showStatus(status) {
  if (!status) {
    statusNode.textContent = "Capture status is unavailable.";
    return;
  }
  const success = status.lastSuccessAt
    ? `Last success ${status.lastSuccessAt}.`
    : "No successful capture yet.";
  const error = status.lastErrorCode
    ? `Last error ${status.lastErrorCode} at ${status.lastErrorAt || "unknown"}.`
    : "No capture error.";
  statusNode.textContent = `${status.label}. Pending ${status.pending}. ${success} ${error}`;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refresh() {
  const response = await send({ type: "status" });
  const settings = response?.settings;
  if (settings) {
    originInput.value = settings.origin || "";
    claudeInput.checked = Boolean(settings.providers?.claude);
    chatgptInput.checked = Boolean(settings.providers?.chatgpt);
    pausedInput.checked = Boolean(settings.paused);
  }
  showStatus(response?.status);
}

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  noticeNode.textContent = "";
  const origin = originInput.value.trim();
  let pattern;
  try {
    const url = new URL(origin);
    pattern = `${url.origin}/*`;
  } catch {
    noticeNode.textContent = "Enter the https origin of your Freedom OS site.";
    return;
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    noticeNode.textContent = "Freedom OS permission was not granted, so capture cannot be saved.";
    return;
  }
  const response = await send({
    type: "settings",
    origin,
    token: tokenInput.value,
    claude: claudeInput.checked,
    chatgpt: chatgptInput.checked,
    paused: pausedInput.checked,
  });
  if (!response?.ok) {
    noticeNode.textContent = response?.error || "Capture settings could not be saved.";
    return;
  }
  tokenInput.value = "";
  noticeNode.textContent = "Saved. The token stays in this browser's extension storage.";
  showStatus(response.status);
});

document.querySelector("#retry").addEventListener("click", async () => {
  noticeNode.textContent = "";
  const response = await send({ type: "retry" });
  showStatus(response?.status);
});

refresh().catch(() => {
  statusNode.textContent = "Capture status is unavailable.";
});
