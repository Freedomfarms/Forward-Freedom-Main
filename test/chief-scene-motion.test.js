import assert from "node:assert/strict";
import test from "node:test";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import {
  ORBITS,
  orbitPoint,
  sceneMotion,
  waveHead,
} from "../src/components/chief/chiefSceneMotion.js";

function apart(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

test("orbital rings move independently and energy heads travel", () => {
  const inner = ORBITS[0];
  const wide = ORBITS.find((ring) => ring.id === "wide");
  const innerStart = orbitPoint(inner, 0, 0, 0, 100);
  const innerLater = orbitPoint(inner, 1.4, 0, 0, 100);
  const wideStart = orbitPoint(wide, 0, 0, 0, 100);
  const wideLater = orbitPoint(wide, 1.4, 0, 0, 100);
  const innerTravel = apart(innerStart, innerLater);
  const wideTravel = apart(wideStart, wideLater);
  assert.ok(innerTravel > 8);
  assert.ok(wideTravel > 1);
  assert.notEqual(innerTravel.toFixed(2), wideTravel.toFixed(2));
  assert.notEqual(inner.speed, wide.speed);
  assert.notEqual(inner.dir, wide.dir);
  assert.notEqual(waveHead(inner, 0, 0), waveHead(inner, 1.4, 0));
  assert.notEqual(waveHead(inner, 1.4, 0), waveHead(wide, 1.4, 0));
});

test("scene pace follows the real turn and voice lifecycle", () => {
  const idle = sceneMotion({
    scenePhase: "idle",
    assistantState: "idle",
    status: CHIEF_STATUS.READY,
    statusTone: "ready",
  });
  const thinking = sceneMotion({
    scenePhase: "thinking",
    assistantState: "thinking",
    status: CHIEF_STATUS.WORKING,
    statusTone: "active",
  });
  const searching = sceneMotion({
    scenePhase: "thinking",
    assistantState: "thinking",
    status: CHIEF_STATUS.WEB_SEARCH,
    statusTone: "active",
  });
  const finance = sceneMotion({
    scenePhase: "thinking",
    assistantState: "thinking",
    status: CHIEF_STATUS.FINANCE,
    statusTone: "active",
  });
  const tool = sceneMotion({
    scenePhase: "thinking",
    assistantState: "thinking",
    status: CHIEF_STATUS.TOOL,
    statusTone: "active",
  });
  const responding = sceneMotion({
    scenePhase: "responding",
    assistantState: "speaking",
    status: CHIEF_STATUS.RESPONDING,
    statusTone: "active",
  });
  const listening = sceneMotion({
    scenePhase: "idle",
    assistantState: "listening",
    status: CHIEF_STATUS.READY,
    statusTone: "ready",
  });
  const error = sceneMotion({
    scenePhase: "idle",
    assistantState: "idle",
    status: CHIEF_STATUS.ERROR,
    statusTone: "error",
  });

  assert.equal(idle.pace, "idle");
  assert.equal(idle.activity.listening, false);
  assert.equal(idle.activity.reasoning, false);
  assert.ok(thinking.speed >= idle.speed * 2.5);
  assert.equal(thinking.activity.reasoning, true);
  assert.equal(searching.activity.searching, true);
  assert.equal(searching.activity.reasoning, false);
  assert.equal(finance.activity.processing, true);
  assert.equal(tool.activity.connecting, true);
  assert.ok(responding.violet > idle.violet);
  assert.equal(responding.pace, "responding");
  assert.equal(listening.pace, "listening");
  assert.equal(listening.activity.searching, false);
  assert.equal(error.pace, "error");
});
