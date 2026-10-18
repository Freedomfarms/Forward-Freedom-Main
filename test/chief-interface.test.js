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
  assert.equal(face.includes("Play Demo"), false);
  assert.match(face, /useFrontierScene/);
  assert.match(face, /Share a thought with CHIEF/);
  assert.match(face, /SYSTEM/);
  assert.doesNotMatch(face, /jarvis-ai-web-animation|JarvisOrb/);
  assert.doesNotMatch(face, /0xa855f7|breathing=\{|quality="/);
  assert.doesNotMatch(face, /chief-environment\.webp/);
  assert.match(css, /--bg:\s*#03080e/);
  assert.match(css, /\.chief-frontier/);
  assert.match(face, /allowAttach \?/);
  assert.equal((face.match(/fetch\(/g) || []).length, 0);
  assert.match(page, /ChiefConversationList/);
  assert.match(page, /onChooseModel=\{chooseModel\}/);
  assert.match(page, /quickActions=\{homeQuickActions\}/);
  assert.doesNotMatch(page, /ChiefModelSelect|homeSuggestions|recentConversations|modelControl=/);
  assert.doesNotMatch(face, /Help me plan|No recent conversations/);
  assert.match(page, /onStopTurn=\{stopTurn\}/);
  assert.match(page, /systems=\{access\.systems\}/);
  assert.doesNotMatch(page, /24%|8\/8|-12ms|Research market opportunity/);
  assert.match(face, /prefers-reduced-motion|is-reduced-motion/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.chief-frontier \.composer/);
  assert.doesNotMatch(css, /^\.chief-composer \{/m);
  assert.match(css, /\.chief-frontier \.workspace\s*\{[^}]*display:\s*grid/);
  assert.doesNotMatch(css, /margin-top:\s*-/);
  assert.match(face, /phase-\$\{phase\}/);
  assert.doesNotMatch(face, /chief-ring-field|chief-core-field|JarvisOrb|ChiefIntelligenceCore/);
  assert.doesNotMatch(face, /ApexWorld|ApexCore3D/);
  assert.doesNotMatch(page, /ChiefIntelligenceCore|chiefIntelligence/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("preparing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("playing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("idle"\)/);
  assert.match(read("src/third_party/apex-ui/ApexWorld.jsx"), /ApexWorld/);
});
