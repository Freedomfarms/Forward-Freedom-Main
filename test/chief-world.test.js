import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import {
  FIELD_ANCHORS,
  FIELD_LINKS,
  createAtmospherePositions,
  placeEntity,
} from "../src/visual/chiefWorld/chiefWorldField.js";
import {
  activityForStatus,
  phaseWeights,
  railsForRoster,
  resolveEntities,
  resolveWorldMotion,
  worldPhase,
} from "../src/visual/chiefWorld/chiefWorldPhase.js";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("home world phase follows existing CHIEF status and voice", () => {
  assert.equal(worldPhase({ status: CHIEF_STATUS.READY }), "idle");
  assert.equal(worldPhase({ status: CHIEF_STATUS.ERROR }), "idle");
  assert.equal(worldPhase({ status: CHIEF_STATUS.WORKING }), "thinking");
  assert.equal(worldPhase({ status: CHIEF_STATUS.RESPONDING }), "responding");
  assert.equal(worldPhase({ status: CHIEF_STATUS.WEB_SEARCH }), "working");
  assert.equal(worldPhase({ status: CHIEF_STATUS.FINANCE }), "working");
  assert.equal(worldPhase({ status: CHIEF_STATUS.TOOL }), "working");
  assert.equal(worldPhase({ status: CHIEF_STATUS.MODULE_ACCESS }), "working");
  assert.equal(worldPhase({ status: CHIEF_STATUS.APPROVAL }), "working");
  assert.equal(worldPhase({ status: CHIEF_STATUS.WORKING, listening: true }), "listening");
  assert.equal(worldPhase({ status: CHIEF_STATUS.READY, speaking: true }), "responding");
  assert.equal(
    worldPhase({ status: CHIEF_STATUS.RESPONDING, listening: true, speaking: true }),
    "listening"
  );
  const weights = phaseWeights("thinking");
  assert.equal(weights.think, 1);
  assert.equal(weights.work + weights.listen + weights.respond + weights.idle, 0);
});

test("home world activity uses real status and does not invent workers", () => {
  assert.equal(activityForStatus(CHIEF_STATUS.READY), null);
  assert.equal(activityForStatus(CHIEF_STATUS.WORKING), null);
  assert.equal(activityForStatus(CHIEF_STATUS.RESPONDING), null);
  assert.equal(activityForStatus(CHIEF_STATUS.ERROR), null);
  const search = activityForStatus(CHIEF_STATUS.WEB_SEARCH);
  assert.equal(search.lane, "research");
  assert.equal(search.label, CHIEF_STATUS.WEB_SEARCH);
  assert.equal(activityForStatus(CHIEF_STATUS.FINANCE).lane, "finance");
  assert.equal(activityForStatus(CHIEF_STATUS.APPROVAL).lane, "hold");

  assert.deepEqual(
    resolveEntities(search, null).map((entity) => entity.id),
    ["research"]
  );
  assert.deepEqual(resolveEntities(search, []), []);
  const supplied = [{ id: "grokbot", label: "Grokbot", lane: "tools" }];
  assert.deepEqual(resolveEntities(null, supplied), supplied);
  assert.deepEqual(resolveEntities(search, [{ id: "" }, null, { label: "nope" }]), []);
});

test("atmosphere fills a volume and navigation keeps the roster split", () => {
  let cursor = 0;
  const sequence = [0.1, 0.2, 0.9, 0.85, 0.15, 0.05, 0.5, 0.5, 0.5];
  const positions = createAtmospherePositions(3, () => sequence[cursor++]);
  assert.equal(positions.length, 9);
  const radii = [];
  for (let index = 0; index < 3; index += 1) {
    const radius = Math.hypot(
      positions[index * 3],
      positions[index * 3 + 1],
      positions[index * 3 + 2]
    );
    radii.push(radius);
    assert.ok(Math.abs(positions[index * 3]) <= 7);
    assert.ok(positions[index * 3 + 1] >= -0.3 && positions[index * 3 + 1] <= 3.1);
    assert.ok(positions[index * 3 + 2] <= 1.2 && positions[index * 3 + 2] >= -10.8);
  }
  assert.ok(Math.max(...radii) - Math.min(...radii) > 1);

  const rails = railsForRoster([
    ["finance", "Freedom Financial", "consultant", 436, 148, true],
    ["convos", "Convos", "consultant", 182, 150, true],
    ["agents", "GrokBot", "doer", 158, 266, true],
    ["settings", "Settings", "tool", 584, 208, true],
  ]);
  assert.deepEqual(
    rails.left.map((item) => item.key),
    ["convos", "agents"]
  );
  assert.deepEqual(
    rails.right.map((item) => item.key),
    ["finance", "settings"]
  );
  assert.deepEqual(placeEntity({ lane: "research" }), [2.45, 1.18, -2.55]);
  assert.deepEqual(placeEntity({ position: [1, 2, 3] }), [1, 2, 3]);
  assert.equal(placeEntity({ position: [1, Number.NaN, 3], lane: "finance" })[0], 1.7);
  assert.equal(placeEntity({ lane: "missing" }), null);

  assert.equal(FIELD_ANCHORS.length, 6);
  assert.equal(FIELD_LINKS.length, 7);
  for (const [from, to] of FIELD_LINKS) {
    assert.ok(FIELD_ANCHORS[from]);
    assert.ok(FIELD_ANCHORS[to]);
  }
  assert.equal(resolveWorldMotion("system", "full", true), "off");
  assert.equal(resolveWorldMotion("reduce", "full", false), "off");
  assert.equal(resolveWorldMotion("system", "off", false), "off");
  assert.equal(resolveWorldMotion("system", "low", false), "low");
  assert.equal(resolveWorldMotion("system", "full", false), "full");
});

test("the home world stays a presentation sandbox", () => {
  const files = readdirSync(path.join(root, "src/visual/chiefWorld"));
  assert.ok(files.includes("ChiefWorld.jsx"));
  assert.ok(files.includes("ChiefWorldScene.jsx"));
  for (const file of files) {
    if (!file.endsWith(".js") && !file.endsWith(".jsx")) continue;
    const source = read(path.join("src/visual/chiefWorld", file));
    assert.doesNotMatch(source, /SphereGeometry|Fresnel|createCoreParticleGeometry/);
    assert.doesNotMatch(source, /GLASS_PANELS|LIGHT_SEAMS|EdgesGeometry/);
    assert.doesNotMatch(
      source,
      /TurnMachine|useChiefVoice|chiefApi|components\/chief|server\/|AuthContext|ToolExecutor/
    );
  }
  const page = read("src/components/chief/ChiefPage.jsx");
  assert.match(page, /from "\.\.\/\.\.\/visual\/chiefWorld\/ChiefWorld\.jsx"/);
  assert.match(page, /sendMessage/);
  assert.match(page, /setRoom\("convos"\)/);
  assert.doesNotMatch(page, /worldPhase\(/);
});
