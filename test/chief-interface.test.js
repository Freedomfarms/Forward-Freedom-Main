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
  assert.match(face, /from "jarvis-ai-web-animation"/);
  assert.match(face, /jarvis-ai-web-animation\/LICENSE\?raw/);
  assert.match(face, /data-third-party-license=\{jarvisLicense\}/);
  assert.match(face, /<JarvisOrb/);
  assert.match(face, /palette=\{CHIEF_ORB_PALETTE\}/);
  assert.match(face, /state=\{motion\}/);
  assert.match(face, /breathing=\{!reducedMotion\}/);
  assert.match(face, /paused=\{reducedMotion\}/);
  assert.match(face, /0xc084fc/);
  assert.match(face, /0x7c3aed/);
  assert.doesNotMatch(face, /chief-scene\.webp/);
  assert.match(face, /allowAttach \?/);
  assert.equal((face.match(/fetch\(/g) || []).length, 0);
  assert.match(
    face,
    /workspace \? <div className="chief-workspace-slot">\{workspace\}<\/div> : null/
  );
  assert.match(page, /conversationLabel/);
  assert.match(page, /formatChiefTime/);
  assert.match(page, /quickActions=\{homeQuickActions\}/);
  assert.match(page, /setDraft\(text\)/);
  assert.doesNotMatch(page, /24%|8\/8|-12ms|Research market opportunity/);
  assert.match(face, /prefers-reduced-motion|is-reduced-motion/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.chief-interface \.chief-composer \{/);
  assert.doesNotMatch(css, /^\.chief-composer \{/m);
  assert.match(css, /\.chief-stage \{\s*position: relative;\s*flex: 1 1 auto;\s*display: flex;\s*flex-direction: column;/);
  assert.match(css, /\.chief-orb-frame \{/);
  assert.match(css, /\.chief-interface\.phase-responding/);
  assert.match(css, /\.chief-interface\.phase-thinking/);
  assert.doesNotMatch(css, /margin-top:\s*-/);
  assert.match(face, /phase-\$\{phase\}/);
  assert.match(read("src/third_party/jarvis-ai-web-animation/LICENSE"), /Copyright \(c\) 2026 cyber1443/);
  assert.match(read("src/third_party/jarvis-ai-web-animation/LICENSE"), /MIT License/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("preparing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("playing"\)/);
  assert.match(read("src/components/chief/useChiefVoice.js"), /setPlayback\("idle"\)/);
  assert.match(read("src/third_party/apex-ui/ApexWorld.jsx"), /ApexWorld/);
});
