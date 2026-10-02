// Control plane: the catalog matches the live inventory, the baseline does
// not grow, and repository mutation cannot be constructed.

import test from "node:test";
import assert from "node:assert/strict";

import { Capability } from "../server/chief/core/capabilities.js";
import {
  CONTROL_PLANE,
  ControlDomain,
  ControlEffect,
  assertControlPlane,
  baselineCapabilities,
  isForbiddenControlCapability,
} from "../server/chief/control/plane.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { defineToolSpec } from "../server/chief/tools/spec.js";

test("the catalog matches the live tool inventory", () => {
  assert.equal(assertControlPlane(CHIEF_TOOL_INVENTORY), true);
  assert.equal(createChiefTools().length > 0, true);
});

test("the empty-grant baseline is unchanged and excludes observation and source read", () => {
  assert.deepEqual(baselineCapabilities(), [
    Capability.MEMORY_READ,
    Capability.MEMORY_WRITE,
    Capability.SCHEDULE_CREATE,
    Capability.FINANCE_READ,
    Capability.SKILL_READ,
    Capability.WEB_SEARCH,
    Capability.MODULE_ACCESS,
    Capability.CONVERSATION_READ,
  ]);
  assert.equal(baselineCapabilities().includes(Capability.WORKFORCE_READ), false);
  assert.equal(baselineCapabilities().includes(Capability.CODEBASE_READ), false);
  assert.equal(baselineCapabilities().includes(Capability.FILE_WRITE), false);
  assert.equal(baselineCapabilities().includes(Capability.CODE_EXECUTE), false);
  assert.equal(baselineCapabilities().includes(Capability.TOOL_INVOKE), false);
});

test("codebase admits read or forbidden, and forbidden rows cannot be granted", () => {
  const codebase = CONTROL_PLANE.filter((entry) => entry.domain === ControlDomain.CODEBASE);
  assert.equal(codebase.length > 0, true);
  for (const entry of codebase) {
    assert.equal(
      entry.effect === ControlEffect.READ || entry.effect === ControlEffect.FORBIDDEN,
      true,
      entry.id
    );
    if (entry.effect === ControlEffect.FORBIDDEN) assert.equal(entry.capability, null);
  }
  const read = codebase.find((entry) => entry.id === "codebase.read");
  assert.equal(read.capability, Capability.CODEBASE_READ);
  assert.equal(read.tool, null);
  assert.equal(read.baseline, false);
  const observe = CONTROL_PLANE.find((entry) => entry.id === "workforce.observe");
  assert.equal(observe.capability, Capability.WORKFORCE_READ);
  assert.equal(observe.tool, null);
  assert.equal(observe.baseline, false);
});

test("repository mutation tools and capabilities cannot be registered", () => {
  for (const name of [
    "codebase_write",
    "source_write",
    "git_add",
    "git_commit",
    "git_push",
    "deploy",
  ]) {
    assert.throws(() => defineToolSpec({ name, description: name }), /not allowed/);
  }
  assert.throws(
    () => defineToolSpec({ name: "notes", requiredCapabilities: ["git:commit"] }),
    /cannot require git:commit/
  );
  assert.equal(isForbiddenControlCapability("codebase:write"), true);
  assert.equal(isForbiddenControlCapability(Capability.CODEBASE_READ), false);
});
