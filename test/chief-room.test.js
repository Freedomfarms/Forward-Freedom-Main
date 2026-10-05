import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleChiefRoomAccess } from "../api/chief/access.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import {
  projectMoneyAccess,
  projectWebAccess,
  webSearchGranted,
} from "../server/chief/security/room-access.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import {
  CHIEF_FIELD,
  createDiamondPoints,
  fieldMotionForStatus,
  formationFrame,
  pointFrame,
  rotateView,
} from "../src/components/chief/chiefField.js";
import {
  visualStateForInteraction,
  visualStateForStatus,
  webStateForInteraction,
  webStateForStatus,
} from "../src/components/chief/apexVisualState.js";
import {
  conversationAccessWords,
  currentTurn,
  fieldKindForStatus,
  moneyWebLine,
} from "../src/utils/chiefRoom.js";

function apiRequest(method) {
  return { method, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

function mockResponse() {
  const state = { statusCode: null, body: null };
  return {
    state,
    response: {
      setHeader() {},
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

function grantedPolicy() {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("_default", Capability.WEB_SEARCH);
  return policy;
}

test("money and web stay distinct and a failed read is unavailable", () => {
  assert.equal(projectMoneyAccess({ enabled: true }), "on");
  assert.equal(projectMoneyAccess({ enabled: false }), "off");
  assert.equal(projectMoneyAccess({ readable: false }), "unavailable");
  assert.equal(projectWebAccess({ granted: true, credentialPresent: true }), "on");
  assert.equal(projectWebAccess({ granted: false, credentialPresent: true }), "off");
  assert.equal(projectWebAccess({ granted: true, credentialPresent: false }), "unavailable");
  assert.equal(projectWebAccess({ readable: false }), "unavailable");
  assert.equal(moneyWebLine("off", "on"), "Money off · Web on");
  assert.equal(moneyWebLine("nope", undefined), "Money unavailable · Web unavailable");
});

test("conversation permissions are unavailable when the route cannot be read", () => {
  assert.deepEqual(conversationAccessWords(null, { readable: false }), {
    read: "unavailable",
    organize: "unavailable",
    delete: "unavailable",
  });
  assert.deepEqual(
    conversationAccessWords({
      conversationRead: true,
      conversationOrganize: false,
      conversationDelete: false,
    }),
    { read: "on", organize: "off", delete: "off" }
  );
});

test("room access route reports money and web without secrets", async () => {
  const off = mockResponse();
  await handleChiefRoomAccess(apiRequest("GET"), off.response, {
    authenticate: async () => ({ uid: "user-a" }),
    readMoney: async () => false,
    loadPolicy: async () => grantedPolicy(),
    credentialPresent: false,
  });
  assert.equal(off.state.statusCode, 200);
  assert.equal(off.state.body.money, "off");
  assert.equal(off.state.body.web, "unavailable");
  assert.ok(off.state.body.inventory.unavailable.some((row) => row.id === "email:read"));
  assert.match(
    off.state.body.inventory.unavailable.find((row) => row.id === "email:read").detail,
    /no email connector is currently connected/
  );
  assert.equal(JSON.stringify(off.state.body).includes("KEY"), false);

  const on = mockResponse();
  await handleChiefRoomAccess(apiRequest("GET"), on.response, {
    authenticate: async () => ({ uid: "user-a" }),
    readMoney: async () => true,
    loadPolicy: async () => grantedPolicy(),
    credentialPresent: true,
  });
  assert.equal(on.state.body.money, "on");
  assert.equal(on.state.body.web, "on");
  assert.ok(on.state.body.inventory.read.some((row) => row.id === "web:read"));

  const denied = mockResponse();
  await handleChiefRoomAccess(apiRequest("GET"), denied.response, {
    authenticate: async () => ({ uid: "user-a" }),
    readMoney: async () => true,
    loadPolicy: async () => new CapabilityPolicy({ defaultDeny: true }),
    credentialPresent: true,
  });
  assert.equal(denied.state.body.web, "off");
  assert.equal(webSearchGranted(grantedPolicy()), true);
  assert.equal(webSearchGranted(new CapabilityPolicy({ defaultDeny: true })), false);

  const unread = mockResponse();
  await handleChiefRoomAccess(apiRequest("GET"), unread.response, {
    authenticate: async () => ({ uid: "user-a" }),
    readMoney: async () => {
      throw new Error("database");
    },
    loadPolicy: async () => {
      throw new Error("database");
    },
    credentialPresent: true,
  });
  assert.equal(unread.state.body.money, "unavailable");
  assert.equal(unread.state.body.web, "unavailable");
  assert.ok(unread.state.body.inventory.unavailable.some((row) => row.id === "email:read"));

  const posted = mockResponse();
  await handleChiefRoomAccess(apiRequest("POST"), posted.response, {
    authenticate: async () => ({ uid: "user-a" }),
  });
  assert.equal(posted.state.statusCode, 405);
});

test("the current turn is the latest exchange and earlier lines stay out of it", () => {
  const turn = currentTurn([
    { role: "user", text: "First" },
    { role: "assistant", text: "One" },
    { role: "tool", text: "secret" },
    { role: "user", text: "Second" },
    { role: "assistant", text: "Two" },
  ]);
  assert.equal(turn.userLine, "Second");
  assert.equal(turn.answer, "Two");
  assert.deepEqual(
    turn.earlier.map((message) => message.text),
    ["First", "One"]
  );
  assert.equal(JSON.stringify(turn).includes("secret"), false);

  const streaming = currentTurn(
    [
      { role: "user", text: "Second" },
      { role: "assistant", text: "Old" },
    ],
    "New"
  );
  assert.equal(streaming.answer, "New");
  assert.equal(streaming.userLine, "Second");
});

test("the diamond corners stay put while real work blooms", () => {
  const points = createDiamondPoints(80, 3);
  const corners = points.filter((point) => point.corner);
  assert.equal(corners.length, 4);
  const rest = fieldMotionForStatus(CHIEF_STATUS.READY);
  const bloom = fieldMotionForStatus(CHIEF_STATUS.WEB_SEARCH);
  assert.equal(fieldKindForStatus(CHIEF_STATUS.FINANCE), "working");
  assert.equal(fieldKindForStatus(CHIEF_STATUS.READY), "ready");
  assert.ok(bloom.filament > rest.filament);
  assert.equal(rest.filament, 0);
  assert.ok(CHIEF_FIELD.desktopPoints > CHIEF_FIELD.mobilePoints);
  for (const corner of corners) {
    const settled = pointFrame(corner, rest, 4);
    const moving = pointFrame(corner, bloom, 9);
    assert.deepEqual(settled, moving);
    assert.equal(Math.abs(settled.x) + Math.abs(settled.y), 1);
  }
  const sample = { x: 0.2, y: 0.15, corner: null, edge: false, layer: 1, phase: 0 };
  const bloomed = pointFrame(sample, bloom, 0);
  assert.ok(Math.hypot(bloomed.x, bloomed.y) > Math.hypot(sample.x, sample.y));
  assert.equal(CHIEF_FIELD.drawScale, 0.4);
});

test("the forming preset builds the diamond without replacing the room", () => {
  assert.notEqual(fieldMotionForStatus(CHIEF_STATUS.READY), CHIEF_FIELD.forming);
  assert.equal(fieldMotionForStatus(CHIEF_STATUS.READY).filament, 0);
  assert.equal(CHIEF_FIELD.forming.assemble, 0);
  const points = createDiamondPoints(64, 4);
  const done = { ...CHIEF_FIELD.forming, assemble: 1 };
  const early = { ...CHIEF_FIELD.forming, assemble: 0 };
  for (const corner of points.filter((point) => point.corner)) {
    const room = pointFrame(corner, CHIEF_FIELD.ready, 2);
    const formed = formationFrame(corner, done, 2);
    assert.equal(formed.x, room.x);
    assert.equal(formed.y, room.y);
    const born = formationFrame(corner, early, 2);
    assert.ok(Math.hypot(born.x - room.x, born.y - room.y) > 0.25);
  }
  const edge = points.find((point) => point.edge);
  const finalEdge = pointFrame(edge, done, 0.4);
  assert.deepEqual(formationFrame(edge, done, 0.4), finalEdge);
  const far = formationFrame(edge, { ...CHIEF_FIELD.forming, assemble: 0.12 }, 0);
  const near = formationFrame(edge, { ...CHIEF_FIELD.forming, assemble: 0.94 }, 0);
  const farDist = Math.hypot(far.x - finalEdge.x, far.y - finalEdge.y);
  const nearDist = Math.hypot(near.x - finalEdge.x, near.y - finalEdge.y);
  assert.ok(nearDist < farDist);
});

test("view rotation turns the diamond without moving field-space corners", () => {
  const north = rotateView(0, -1, Math.PI / 2);
  assert.ok(Math.abs(north.x - 1) < 1e-10);
  assert.ok(Math.abs(north.y) < 1e-10);
  assert.deepEqual(rotateView(0.4, -0.2, 0), { x: 0.4, y: -0.2 });
  const corners = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  const turned = corners.map(([x, y]) => rotateView(x, y, 0.7));
  for (const point of turned) {
    assert.ok(Math.abs(Math.hypot(point.x, point.y) - 1) < 1e-10);
  }
});

test("the room intelligence maps status onto the APEX orb and web", () => {
  assert.equal(visualStateForStatus(CHIEF_STATUS.READY), "idle");
  assert.equal(webStateForStatus(CHIEF_STATUS.READY), "standby");
  assert.equal(visualStateForStatus(CHIEF_STATUS.WORKING), "thinking");
  assert.equal(webStateForStatus(CHIEF_STATUS.WORKING), "processing");
  assert.equal(visualStateForStatus(CHIEF_STATUS.WEB_SEARCH), "thinking");
  assert.equal(webStateForStatus(CHIEF_STATUS.TOOL), "processing");
  assert.equal(visualStateForStatus(CHIEF_STATUS.APPROVAL), "idle");
  assert.equal(webStateForStatus(CHIEF_STATUS.APPROVAL), "standby");
  assert.equal(visualStateForStatus(CHIEF_STATUS.ERROR), "idle");
  assert.equal(webStateForStatus(CHIEF_STATUS.ERROR), "standby");
  assert.equal(visualStateForStatus(CHIEF_STATUS.RESPONDING), "thinking");
  assert.equal(webStateForStatus(CHIEF_STATUS.RESPONDING), "processing");
  assert.equal(visualStateForStatus(CHIEF_STATUS.RESPONDING, "speaking"), "speaking");
  assert.equal(webStateForStatus(CHIEF_STATUS.READY, "listening"), "listening");
  assert.equal(visualStateForStatus(CHIEF_STATUS.READY, "listening"), "listening");
  assert.equal(visualStateForStatus(CHIEF_STATUS.READY, "thinking"), "thinking");
  assert.equal(visualStateForStatus(CHIEF_STATUS.ERROR, "error"), "idle");
  assert.equal(
    visualStateForInteraction({ status: CHIEF_STATUS.READY, listening: true }),
    "listening"
  );
  assert.equal(
    webStateForInteraction({ status: CHIEF_STATUS.READY, listening: true }),
    "listening"
  );
  assert.equal(
    visualStateForInteraction({ status: CHIEF_STATUS.READY, speaking: true }),
    "speaking"
  );
  assert.equal(visualStateForInteraction({ status: CHIEF_STATUS.WORKING }), "thinking");
  assert.equal(webStateForInteraction({ status: CHIEF_STATUS.WORKING }), "processing");
  assert.equal(visualStateForInteraction({ status: CHIEF_STATUS.RESPONDING }), "thinking");
  assert.equal(
    visualStateForInteraction({ status: CHIEF_STATUS.RESPONDING, speaking: true }),
    "speaking"
  );
  assert.equal(
    visualStateForInteraction({ status: CHIEF_STATUS.WORKING, listening: true }),
    "listening"
  );

  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const world = readFileSync(path.join(root, "src/third_party/apex-ui/ApexWorld.jsx"), "utf8");
  const hero = readFileSync(path.join(root, "src/third_party/apex-ui/ApexHeroOrb.tsx"), "utf8");
  const core = readFileSync(path.join(root, "src/third_party/apex-ui/ApexCore3D.jsx"), "utf8");
  assert.match(page, /ApexWorld/);
  assert.equal(page.includes("ChiefField"), false);
  assert.equal(page.includes("renderIntelligence"), false);
  assert.match(world, /prefers-reduced-motion/);
  assert.match(hero, /listening/);
  assert.match(page, /sendMessage/);
  assert.match(hero, /variant="frame"/);
  assert.match(hero, /variant="particles"/);
  assert.doesNotMatch(hero, /variant="geodesic"/);
  assert.doesNotMatch(hero, /variant="meridian"/);
  assert.doesNotMatch(hero, /variant="gyro"/);
  assert.match(core, /const N = 1200/);
  assert.match(core, /dpr=\{\[1, 1\.5\]\}/);
  assert.match(page, /visualStateForInteraction/);
  assert.match(page, /ChiefVoiceDock/);
  assert.match(page, /sendRef\.current = sendMessage/);
  assert.match(page, /from "\.\/useChiefVoice\.js"/);
  assert.equal(page.includes('from "./voice/useChiefVoice.js"'), false);
  assert.equal((page.match(/useChiefVoice\(/g) || []).length, 1);
  assert.match(page, /<ChiefSettings/);
  assert.match(page, /setSettingsOpen\(true\)/);
  assert.match(world, /0\.12/);
  assert.match(world, /staticCore=\{resolvedMotion === "off"\}/);
  assert.match(world, /state=\{orbState\}/);
  assert.match(world, /audioLevelRef=\{audioLevelRef\}/);
  assert.match(world, /Speak to CHIEF/);
  assert.match(world, /showStatus \? <OrbStatusBar/);
  assert.doesNotMatch(page, /onCoreTap/);
});

test("the room source keeps conversation plain and navigation literal", () => {
  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const transcript = readFileSync(
    path.join(root, "src/components/chief/ChiefTranscript.jsx"),
    "utf8"
  );
  const composer = readFileSync(path.join(root, "src/components/chief/ChiefComposer.jsx"), "utf8");
  const approval = readFileSync(
    path.join(root, "src/components/chief/ChiefApprovalCard.jsx"),
    "utf8"
  );
  assert.equal(transcript.includes("borderRadius"), false);
  assert.equal(transcript.includes("bubble"), false);
  assert.match(page, /Freedom Financial/);
  assert.doesNotMatch(page, /CEO Agents/);
  assert.doesNotMatch(page, /Modules/);
  assert.match(composer, /Ask CHIEF/);
  assert.match(approval, /Allow/);
  assert.match(approval, /Don’t allow/);
  assert.equal(page.includes("freedomOs"), false);
  assert.equal(page.includes("ForwardFreedomDashboard"), false);
});

test("the apex conversation overlays the stage and does not form a panel", () => {
  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const world = readFileSync(path.join(root, "src/third_party/apex-ui/ApexWorld.jsx"), "utf8");
  const dock = readFileSync(path.join(root, "src/components/chief/ChiefVoiceDock.jsx"), "utf8");
  const css = readFileSync(path.join(root, "src/global.css"), "utf8");
  assert.match(page, /className="chief-apex-home"/);
  assert.equal(page.includes("minHeight: 620"), false);
  assert.match(world, /chief-apex-stage/);
  assert.match(dock, /chief-apex-dock/);
  assert.match(dock, /ChiefTranscript/);
  assert.match(css, /\.chief-apex-stage \{\s*position: absolute;\s*inset: 0;/);
  assert.match(css, /\.chief-voice-dock \{[\s\S]*position: absolute;/);
  assert.match(css, /\.chief-voice-dock \{[\s\S]*background: transparent;/);
  assert.match(css, /\.chief-voice-dock \.chief-earlier \{\s*display: none;/);
  assert.equal(css.includes("rgba(5, 16, 28, 0.42)"), false);
  assert.equal(css.includes("rgba(4, 14, 26, 0.72)"), false);
});
