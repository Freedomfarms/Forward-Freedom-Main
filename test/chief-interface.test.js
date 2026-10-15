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
  assert.match(face, /chief-landscape\.webp/);
  assert.match(face, /ChiefScene/);
  assert.match(face, /Talk to CHIEF/);
  assert.match(face, /allowAttach \?/);
  assert.equal((face.match(/fetch\(/g) || []).length, 0);
  assert.match(page, /conversationLabel/);
  assert.match(page, /formatChiefTime/);
  assert.match(page, /quickActions=\{homeQuickActions\}/);
  assert.match(page, /audioLevelRef=\{voice\.audioLevelRef\}/);
  assert.match(page, /setDraft\(/);
  assert.doesNotMatch(page, /24%|8\/8|-12ms|Research market opportunity/);
  assert.match(face, /prefers-reduced-motion|is-reduced-motion/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.chief-interface \.chief-composer \{/);
  assert.doesNotMatch(css, /^\.chief-composer \{/m);
  assert.match(css, /\.chief-stage \{[^}]*display:\s*flex;/);
  assert.match(css, /\.chief-stage \{[^}]*flex-direction:\s*column;/);
  assert.match(css, /\.chief-stage \{[^}]*position:\s*absolute;/);
  assert.match(css, /\.chief-left-rail \{[^}]*position:\s*absolute;/);
  assert.match(css, /\.chief-right-rail \{[^}]*position:\s*absolute;/);
  assert.match(css, /chief-landscape\.webp|background-size:\s*cover/);
  assert.match(read("src/components/chief/chiefSceneMotion.js"), /thinking: 2\.5/);
  assert.match(read("src/components/chief/chiefSceneDraw.js"), /drawOrbits/);
  assert.match(read("src/components/chief/ChiefScene.jsx"), /prefers-reduced-motion/);
  assert.match(css, /\.chief-interface\.phase-responding/);
  assert.match(css, /\.chief-interface\.phase-thinking/);
  assert.doesNotMatch(css, /margin-top:\s*-/);
  assert.doesNotMatch(css, /hue-rotate\(26deg\)/);
  assert.match(face, /phase-\$\{phase\}/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("preparing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("playing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("idle"\)/);
  assert.match(read("src/third_party/apex-ui/ApexWorld.jsx"), /ApexWorld/);
});
