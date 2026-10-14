// Source for the page script. Chrome loads extension/dist/content.js, the classic
// bundle from `npm run build:extension`. A Manifest V3 content script cannot use
// this file's static import. Unrecognized pages are not uploaded.

import { extractSnapshot } from "./src/extract.js";

let timer = 0;

function titleOf() {
  const heading = document.querySelector("h1, title");
  const text = typeof heading?.textContent === "string" ? heading.textContent.trim() : "";
  return text || document.title || "";
}

function publish() {
  const snapshot = extractSnapshot(document, location.href);
  if (snapshot.recognized) snapshot.title = titleOf().slice(0, 300);
  chrome.runtime.sendMessage({ type: "page", snapshot });
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(publish, 1500);
}

schedule();
const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
