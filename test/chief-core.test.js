import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  applyPinch,
  applyWheel,
  beginPinch,
  createMotion,
  endDrag,
  frameForViewport,
  noteDrag,
  stepMotion,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../src/visual/chiefCore/ChiefCoreControls.js";
import {
  createCoreParticleGeometry,
  particleBudgetFor,
} from "../src/visual/chiefCore/ChiefCoreParticles.js";
import {
  normalizeCoreState,
  poseFor,
  PREVIEW_SCRIPT,
  resolvePresentedState,
  stateFromSearch,
  stepPose,
  supportsWebGL,
} from "../src/visual/chiefCore/ChiefCoreState.js";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("core states ease and external state wins over the homepage preview", () => {
  assert.equal(normalizeCoreState("processing"), "thinking");
  assert.equal(normalizeCoreState("speaking"), "responding");
  assert.equal(normalizeCoreState("standby"), "idle");
  assert.equal(resolvePresentedState("idle", null, true), "idle");
  assert.equal(resolvePresentedState("idle", "thinking", true), "thinking");
  assert.equal(resolvePresentedState("listening", "thinking", true), "listening");
  assert.equal(resolvePresentedState("idle", "responding", false), "idle");
  assert.equal(stateFromSearch("?core=listening"), "listening");
  assert.equal(stateFromSearch("?core=speaking"), "responding");
  assert.equal(stateFromSearch("?core=nope"), null);
  assert.equal(stateFromSearch(""), null);
  assert.deepEqual(
    PREVIEW_SCRIPT.map((step) => step.state),
    ["listening", "thinking", "responding", "idle"]
  );

  const pose = poseFor("idle");
  const target = poseFor("thinking");
  assert.ok(target.inward > pose.inward);
  assert.ok(target.expand < pose.expand);
  for (let i = 0; i < 80; i += 1) stepPose(pose, target, 0.05);
  assert.ok(pose.inward > 0.8);
  assert.ok(pose.expand < 0.95);
  assert.ok(pose.hot > 0.9);
});

test("drag inertia eases back and zoom stays inside a subtle range", () => {
  const motion = createMotion();
  noteDrag(motion, 90, -20, 0.016);
  assert.ok(motion.yawVel > 0.4);
  assert.ok(motion.pitchVel > 0);
  const flung = Math.abs(motion.yawVel - 0.08);
  endDrag(motion);
  for (let i = 0; i < 80; i += 1) {
    stepMotion(motion, 0.05, { dragging: false, reduced: false, idleYaw: 0.08 });
  }
  assert.ok(Math.abs(motion.yawVel - 0.08) < flung);
  assert.ok(Math.abs(motion.yawVel - 0.08) < 0.04);
  assert.ok(Math.abs(motion.pitchVel) < 0.02);

  const held = createMotion();
  noteDrag(held, 50, 0, 0.016);
  stepMotion(held, 0.016, { dragging: true, idleYaw: 0.08 });
  const coast = Math.abs(held.yawVel);
  stepMotion(held, 0.12, { dragging: true, idleYaw: 0.08 });
  assert.ok(Math.abs(held.yawVel) < coast);

  const zoom = createMotion();
  for (let i = 0; i < 40; i += 1) applyWheel(zoom, 120);
  assert.equal(zoom.zoomTarget, ZOOM_MIN);
  beginPinch(zoom);
  applyPinch(zoom, 3);
  assert.equal(zoom.zoomTarget, ZOOM_MAX);
});

test("mobile framing lifts the core and uses fewer particles", () => {
  const phone = frameForViewport(390, 844, "home");
  const desktop = frameForViewport(1440, 900, "home");
  const authPhone = frameForViewport(390, 844, "auth");
  const authDesk = frameForViewport(1440, 900, "auth");
  assert.ok(phone.lookAt[1] < desktop.lookAt[1]);
  assert.ok(authPhone.lookAt[1] < phone.lookAt[1]);
  assert.ok(authDesk.lookAt[0] > desktop.lookAt[0]);
  assert.ok(phone.position[2] > desktop.position[2]);

  const mobile = particleBudgetFor(390, true);
  const full = particleBudgetFor(1440, false);
  assert.equal(full.count, 1200);
  assert.ok(mobile.count < full.count);
  const geometry = createCoreParticleGeometry(full);
  assert.equal(geometry.getAttribute("aDir").count, full.count);
  assert.equal(geometry.getAttribute("aBallR").count, full.count);
  const radii = geometry.getAttribute("aBallR").array;
  let sum = 0;
  for (let i = 0; i < radii.length; i += 1) sum += radii[i];
  assert.ok(sum / radii.length > 0.55);
  geometry.dispose();
});

test("webgl probe fails closed and does not keep a context", () => {
  assert.equal(supportsWebGL({ createElement: () => ({ getContext: () => null }) }), false);
  assert.equal(supportsWebGL({}), false);
  let lost = false;
  const doc = {
    createElement: () => ({
      getContext: () => ({
        getExtension: () => ({
          loseContext: () => {
            lost = true;
          },
        }),
      }),
    }),
  };
  assert.equal(supportsWebGL(doc), true);
  assert.equal(lost, true);
});

test("the homepage sandbox does not enter the CHIEF room", () => {
  const page = read("src/components/chief/ChiefPage.jsx");
  const atmosphere = read("src/components/chief/ChiefAtmosphere.jsx");
  const home = read("src/components/FreedomOsLanding.jsx");
  const auth = read("src/components/AuthScreen.jsx");
  const scene = read("src/visual/chiefCore/ChiefCoreScene.js");
  const shell = read("src/components/freedom/FreedomShell.jsx");

  assert.match(page, /ApexWorld/);
  assert.doesNotMatch(page, /ChiefCore|chiefCore/);
  assert.match(atmosphere, /visual\/chiefCore\/ChiefCore/);
  assert.doesNotMatch(atmosphere, /import .*ApexWorld|import .*ApexCore3D|import .*ApexClock/);
  assert.match(home, /<FreedomShell preview>/);
  assert.match(auth, /FreedomShell/);
  assert.match(auth, /signInWithEmail/);
  assert.match(shell, /layout=\{variant === "auth" \? "auth" : "home"\}/);
  assert.doesNotMatch(scene, /@react-three|useFrame|supabase|plaid|TurnMachine|firebase/i);
  assert.equal(scene.split("requestAnimationFrame").length - 1, 1);

  const advance = scene.slice(scene.indexOf("advance(dt)"), scene.indexOf("fail(error)"));
  assert.doesNotMatch(advance, /new THREE|SphereGeometry|ShaderMaterial|BufferGeometry/);

  for (const file of readdirSync(path.join(root, "src/visual/chiefCore"))) {
    if (!file.endsWith(".js") && !file.endsWith(".jsx")) continue;
    const source = read(path.join("src/visual/chiefCore", file));
    assert.doesNotMatch(source, /components\/chief|server\/|AuthContext|FreedomShell/);
  }
});
