import assert from "node:assert/strict";
import test from "node:test";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { LIVING_SPEED, livingMotion } from "../src/components/chief/chiefLivingMotion.js";

test("orbital speed follows the real CHIEF lifecycle", () => {
  const idle = livingMotion({
    scenePhase: "idle",
    status: CHIEF_STATUS.READY,
    statusTone: "ready",
  });
  const thinking = livingMotion({
    scenePhase: "thinking",
    status: CHIEF_STATUS.WORKING,
    statusTone: "active",
  });
  const responding = livingMotion({
    scenePhase: "responding",
    status: CHIEF_STATUS.RESPONDING,
    statusTone: "active",
  });
  const listening = livingMotion({
    scenePhase: "thinking",
    assistantState: "listening",
    status: CHIEF_STATUS.WORKING,
  });
  const searching = livingMotion({
    scenePhase: "thinking",
    status: CHIEF_STATUS.WEB_SEARCH,
  });
  const errored = livingMotion({
    scenePhase: "idle",
    status: CHIEF_STATUS.ERROR,
    statusTone: "error",
  });

  assert.equal(idle.pace, "idle");
  assert.equal(idle.speed, LIVING_SPEED.idle);
  assert.equal(thinking.pace, "thinking");
  assert.ok(thinking.speed >= idle.speed * 2);
  assert.ok(thinking.speed <= idle.speed * 3);
  assert.equal(thinking.activity.reasoning, true);
  assert.equal(thinking.activity.processing, false);
  assert.ok(responding.violet > thinking.violet);
  assert.equal(responding.activity.responding, true);
  assert.equal(listening.pace, "listening");
  assert.equal(listening.activity.listening, true);
  assert.equal(searching.activity.searching, true);
  assert.equal(searching.activity.reasoning, false);
  assert.equal(errored.pace, "error");
  assert.ok(errored.speed < idle.speed);
});
