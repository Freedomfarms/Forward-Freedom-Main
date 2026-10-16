import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the homepage core is one purple filament ball outside the login scene", async () => {
  const page = read("src/components/chief/ChiefPage.jsx");
  const face = read("src/components/chief/ChiefInterface.jsx");
  const engine = read("src/visual/chiefIntelligence/ChiefIntelligenceEngine.js");
  const filaments = read("src/visual/chiefIntelligence/filamentCore.js");
  const login = read("src/visual/chiefCore/ChiefCoreScene.js");

  assert.match(face, /ChiefIntelligenceCore/);
  assert.doesNotMatch(page, /ChiefIntelligenceCore|chiefIntelligence|ChiefCore|chiefCore/);
  assert.match(engine, /poseFor/);
  assert.match(engine, /stepPose/);
  assert.equal(engine.split("requestAnimationFrame").length - 1, 1);
  assert.match(filaments, /0xff4ad8/);
  assert.match(filaments, /0x9b4dff/);
  assert.match(filaments, /0x4da3ff/);
  assert.match(filaments, /FILAMENT_ANCHOR_Y = 0\.426/);
  assert.doesNotMatch(`${engine}\n${filaments}`, /ApexWorld|ApexCore3D|0x67f1ff|0x22d3ee/);
  assert.doesNotMatch(login, /chiefIntelligence|filamentCore/);

  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createRadialGradient() {
              return { addColorStop() {} };
            },
            fillRect() {},
          };
        },
      };
    },
  };

  const { createFilamentCore } = await import("../src/visual/chiefIntelligence/filamentCore.js");
  const core = createFilamentCore({
    uTime: { value: 0 },
    uPace: { value: 1 },
    uHot: { value: 0.2 },
    uMagenta: { value: { set() {} } },
    uViolet: { value: { set() {} } },
  });
  const names = core.children.map((child) => child.name);
  assert.deepEqual(names, ["filament-volume", "filament-heart"]);
  const lattice = core.getObjectByName("filament-volume");
  assert.equal(lattice.geometry.index, null);
  assert.ok(lattice.geometry.attributes.position.count > 60000);
  assert.doesNotMatch(filaments, /TubeGeometry|Points\(|Sprite|uCamLocal/);
  core.userData.disposeCore();
});
