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
  assert.deepEqual(off.state.body, { money: "off", web: "unavailable" });
  assert.equal(JSON.stringify(off.state.body).includes("KEY"), false);

  const on = mockResponse();
  await handleChiefRoomAccess(apiRequest("GET"), on.response, {
    authenticate: async () => ({ uid: "user-a" }),
    readMoney: async () => true,
    loadPolicy: async () => grantedPolicy(),
    credentialPresent: true,
  });
  assert.deepEqual(on.state.body, { money: "on", web: "on" });

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
  assert.deepEqual(unread.state.body, { money: "unavailable", web: "unavailable" });

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
  const field = readFileSync(
    path.join(process.cwd(), "src/components/chief/ChiefField.jsx"),
    "utf8"
  );
  assert.match(field, /pointerdown/);
  assert.match(field, /prefers-reduced-motion/);
  assert.ok(
    field.indexOf("pointColor(posed, motion)") < field.indexOf("rotateView(posed.x, posed.y")
  );
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
