import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CHIEF home mounts the supplied interface on the existing conversation path", () => {
  const page = read("src/components/chief/ChiefPage.jsx");
  const face = read("src/components/chief/ChiefInterface.jsx");
  const css = read("src/components/chief/ChiefInterface.css");

  assert.match(page, /from "\.\/ChiefInterface\.jsx"/);
  assert.match(page, /onSend=\{submitDraft\}/);
  assert.match(page, /streamChiefChat/);
  assert.match(page, /speakCompletedReply\(voice,/);
  assert.match(page, /voice\.toggleListening\(\)/);
  assert.match(page, /cpu: null/);
  assert.match(page, /memory: null/);
  assert.match(page, /agents: null/);
  assert.doesNotMatch(page, /allowAttach/);
  assert.doesNotMatch(page, /agentsApi|freedomOs/);
  assert.doesNotMatch(page, /<ApexWorld|<ApexClock/);

  assert.equal(face.includes("SYSTEM ONLINE"), false);
  assert.equal(face.includes("24%"), false);
  assert.equal(face.includes("8/8"), false);
  assert.equal(face.includes("-12ms"), false);
  assert.equal(face.includes("Research market opportunity"), false);
  assert.equal(face.includes("Search Web"), false);
  assert.equal(face.includes("Open Workspace"), false);
  assert.match(face, /chief-scene\.webp/);
  assert.match(face, /allowAttach \?/);
  assert.equal((face.match(/fetch\(/g) || []).length, 0);
  assert.match(page, /conversationLabel/);
  assert.match(page, /formatChiefTime/);
  assert.match(page, /quickActions=\{homeQuickActions\}/);
  assert.match(page, /setDraft\(text\)/);
  assert.doesNotMatch(page, /24%|8\/8|-12ms|Research market opportunity/);
  assert.match(face, /prefers-reduced-motion|is-reduced-motion/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.chief-interface \.chief-composer \{/);
  assert.doesNotMatch(css, /^\.chief-composer \{/m);
  assert.match(read("src/third_party/apex-ui/ApexWorld.jsx"), /ApexWorld/);
});
