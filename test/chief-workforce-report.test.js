// Self-report ingress. Enterprise OTEL is not connected.
// The fake transaction is the journal. No second event store.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  handleWorkforceReport,
  handleWorkforceReportKey,
} from "../server/chief/workforce/reportRoute.js";
import { acceptSelfReport, OBSERVATION_INGRESS } from "../server/chief/workforce/ingest.js";
import {
  createReportToken,
  hashReportToken,
  parseReportToken,
} from "../server/chief/workforce/reportKey.js";
import { describeCoverage } from "../server/chief/workforce/journal.js";

const encrypt = (text) => `sealed:${text}`;
const allow = async () => true;
const COVERAGE = describeCoverage(["self_report"]).line;

function memoryTx() {
  const bindings = new Map();
  const events = new Map();
  const agents = new Map();
  let ids = 0;
  const nextId = () => `id-${++ids}`;
  return {
    bindings,
    events,
    agents,
    workforceBinding: {
      async findUnique({ where }) {
        return bindings.get(where.userId) ?? null;
      },
      async create({ data }) {
        const row = { id: nextId(), reportKeyHash: null, reportKeyIssuedAt: null, ...data };
        bindings.set(data.userId, row);
        return row;
      },
      async update({ where, data }) {
        const row = bindings.get(where.userId);
        if (!row) throw new Error("missing binding");
        Object.assign(row, data);
        return row;
      },
    },
    activityEvent: {
      async findUnique({ where }) {
        const key = where.userId_source_sourceEventId;
        return events.get(`${key.userId}|${key.source}|${key.sourceEventId}`) ?? null;
      },
      async create({ data }) {
        const key = `${data.userId}|${data.source}|${data.sourceEventId}`;
        if (events.has(key)) {
          const error = new Error("unique");
          error.code = "P2002";
          throw error;
        }
        const row = { id: nextId(), ...data };
        events.set(key, row);
        return row;
      },
    },
    observedAgent: {
      async findUnique({ where }) {
        const key = where.userId_externalId;
        return agents.get(`${key.userId}|${key.externalId}`) ?? null;
      },
      async create({ data }) {
        const row = { id: nextId(), ...data };
        agents.set(`${data.userId}|${data.externalId}`, row);
        return row;
      },
      async update({ where, data }) {
        const key = where.userId_externalId;
        const row = { ...agents.get(`${key.userId}|${key.externalId}`), ...data };
        agents.set(`${key.userId}|${key.externalId}`, row);
        return row;
      },
    },
  };
}

function response() {
  const state = { statusCode: null, body: null, headers: {} };
  return {
    state,
    response: {
      setHeader(name, value) {
        state.headers[name] = value;
      },
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

function request(method, { token, body, user } = {}) {
  return {
    method,
    body: body ?? {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: "127.0.0.1" },
    user,
  };
}

function scoped(tx) {
  return async (userId, fn) => fn(tx);
}

function report(agentExternalId, extra = {}) {
  return {
    sourceEventId: "evt-1",
    kind: "freedom.report.finding",
    occurredAt: "2026-10-02T12:00:00.000Z",
    agentExternalId,
    text: "The agent reported a finding.",
    ...extra,
  };
}

test("enterprise telemetry is not an ingress in this environment", () => {
  assert.equal(OBSERVATION_INGRESS.otel, false);
  assert.equal(OBSERVATION_INGRESS.selfReport, true);
  const ingest = readFileSync(
    new URL("../server/chief/workforce/ingest.js", import.meta.url),
    "utf8"
  );
  const route = readFileSync(
    new URL("../server/chief/workforce/reportRoute.js", import.meta.url),
    "utf8"
  );
  assert.equal(ingest.includes("getServicePrismaClient"), false);
  assert.equal(route.includes("getServicePrismaClient"), false);
  assert.equal(ingest.includes("/v1/logs"), false);
});

test("a report key is stored as a hash and the coverage sentence is explicit", async () => {
  const tx = memoryTx();
  const issued = response();
  await handleWorkforceReportKey(request("POST", { user: "user-1" }), issued.response, {
    enforceRateLimit: allow,
    authenticate: async (req) => ({ uid: req.user }),
    withUser: scoped(tx),
    now: new Date("2026-10-02T12:00:00.000Z"),
  });
  assert.equal(issued.state.statusCode, 201);
  assert.equal(issued.state.body.line, COVERAGE);
  assert.equal(issued.state.body.trust, "untrusted");
  assert.equal(issued.state.body.source, "self_report");
  const token = issued.state.body.reportKey;
  assert.equal(parseReportToken(token).userId, "user-1");
  const binding = tx.bindings.get("user-1");
  assert.equal(binding.reportKeyHash, hashReportToken(token));
  assert.notEqual(binding.reportKeyHash, token);
  assert.equal(JSON.stringify(binding).includes(token), false);

  const viewed = response();
  await handleWorkforceReportKey(request("GET", { user: "user-1" }), viewed.response, {
    enforceRateLimit: allow,
    authenticate: async (req) => ({ uid: req.user }),
    withUser: scoped(tx),
  });
  assert.equal(viewed.state.body.active, true);
  assert.equal(Object.hasOwn(viewed.state.body, "reportKey"), false);
  assert.equal(Object.hasOwn(viewed.state.body, "reportKeyHash"), false);
  assert.equal(viewed.state.body.line, COVERAGE);
});

test("authentication failure, an unbound user, and a revoked key do not write", async () => {
  const tx = memoryTx();
  const missing = response();
  await handleWorkforceReport(request("POST", { body: report("bot-1") }), missing.response, {
    enforceRateLimit: allow,
    withUser: scoped(tx),
    encrypt,
  });
  assert.equal(missing.state.statusCode, 401);
  assert.equal(tx.events.size, 0);

  const firebase = response();
  await handleWorkforceReport(
    request("POST", {
      token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.sig",
      body: report("bot-1"),
    }),
    firebase.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt }
  );
  assert.equal(firebase.state.statusCode, 401);

  const token = createReportToken("user-9");
  const unbound = response();
  await handleWorkforceReport(request("POST", { token, body: report("bot-1") }), unbound.response, {
    enforceRateLimit: allow,
    withUser: scoped(tx),
    encrypt,
  });
  assert.equal(unbound.state.statusCode, 401);
  assert.equal(tx.events.size, 0);

  await handleWorkforceReportKey(request("POST", { user: "user-1" }), response().response, {
    enforceRateLimit: allow,
    authenticate: async () => ({ uid: "user-1" }),
    withUser: scoped(tx),
  });
  const issued = tx.bindings.get("user-1");
  const live = createReportToken("user-1");
  issued.reportKeyHash = hashReportToken(live);
  await handleWorkforceReportKey(request("DELETE", { user: "user-1" }), response().response, {
    enforceRateLimit: allow,
    authenticate: async () => ({ uid: "user-1" }),
    withUser: scoped(tx),
  });
  const revoked = response();
  await handleWorkforceReport(
    request("POST", { token: live, body: report("bot-1") }),
    revoked.response,
    {
      enforceRateLimit: allow,
      withUser: scoped(tx),
      encrypt,
    }
  );
  assert.equal(revoked.state.statusCode, 401);
  assert.equal(tx.events.size, 0);
});

test("a report cannot choose another user or claim platform provenance", async () => {
  const tx = memoryTx();
  const token = createReportToken("user-1");
  await tx.workforceBinding.create({
    data: { userId: "user-1", status: "ACTIVE", cursorAccountId: null, emailCiphertext: null },
  });
  tx.bindings.get("user-1").reportKeyHash = hashReportToken(token);

  const cross = response();
  let seenUser = null;
  await handleWorkforceReport(
    request("POST", { token, body: report("bot-1", { userId: "user-2" }) }),
    cross.response,
    {
      enforceRateLimit: allow,
      encrypt,
      withUser: async (userId, fn) => {
        seenUser = userId;
        return fn(tx);
      },
    }
  );
  assert.equal(cross.state.statusCode, 400);
  assert.equal(seenUser, "user-1");
  assert.equal(tx.bindings.has("user-2"), false);
  assert.equal(tx.events.size, 0);

  const other = createReportToken("user-2").split(".");
  const stolen = `ffr.${other[1]}.${token.split(".")[2]}`;
  assert.equal(parseReportToken(stolen).userId, "user-2");
  await assert.rejects(
    () => acceptSelfReport(tx, stolen, report("bot-1"), { encrypt }),
    (error) => error.code === "UNBOUND" || error.code === "UNAUTHENTICATED"
  );
  assert.equal(tx.events.size, 0);

  await assert.rejects(
    () => acceptSelfReport(tx, token, report("bot-1", { source: "otel" }), { encrypt }),
    (error) => error.code === "PLATFORM"
  );
  await assert.rejects(
    () =>
      acceptSelfReport(tx, token, report("bot-1", { provenance: "server", trust: "platform" }), {
        encrypt,
      }),
    (error) => error.code === "PLATFORM" || error.code === "CROSS_USER" || error.status === 400
  );
  await assert.rejects(
    () =>
      acceptSelfReport(
        tx,
        token,
        report("bot-1", { kind: "cursor.grok_bot.shell_command", provenance: "report" }),
        { encrypt }
      ),
    (error) => error.status === 400
  );
  assert.equal(tx.events.size, 0);
});

test("a valid report projects the agent and a retry does not replace it", async () => {
  const tx = memoryTx();
  const token = createReportToken("user-1");
  const now = new Date("2026-10-02T12:10:00.000Z");
  await tx.workforceBinding.create({
    data: { userId: "user-1", status: "ACTIVE", cursorAccountId: null, emailCiphertext: null },
  });
  tx.bindings.get("user-1").reportKeyHash = hashReportToken(token);

  const first = response();
  await handleWorkforceReport(
    request("POST", {
      token,
      body: report("bot-1", {
        kind: "freedom.report.agent",
        coded: { displayName: "Scout", role: "Looks around" },
        text: "An agent reported its name.",
        unknownField: "dropped",
      }),
    }),
    first.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt, now }
  );
  assert.equal(first.state.statusCode, 200);
  assert.equal(first.state.body.duplicate, false);
  assert.equal(first.state.body.trust, "untrusted");
  assert.equal(first.state.body.source, "self_report");
  const row = [...tx.events.values()][0];
  assert.equal(row.userId, "user-1");
  assert.equal(row.source, "SELF_REPORT");
  assert.equal(row.trust, "UNTRUSTED");
  assert.equal(row.provenance, "report");
  assert.equal(row.textCiphertext, "sealed:An agent reported its name.");
  assert.equal(row.coded.displayName, "Scout");
  assert.equal(Object.hasOwn(row.coded, "unknownField"), false);
  const agent = tx.agents.get("user-1|bot-1");
  assert.equal(agent.displayName, "Scout");
  assert.equal(agent.role, "Looks around");
  assert.equal(agent.identityTrust, "UNTRUSTED");
  assert.equal(agent.liveness, "ACTIVE");
  assert.equal(agent.bindingId, tx.bindings.get("user-1").id);

  const retry = response();
  await handleWorkforceReport(
    request("POST", {
      token,
      body: report("bot-1", {
        kind: "freedom.report.agent",
        text: "A later retry invented a different name.",
        coded: { displayName: "Impostor" },
      }),
    }),
    retry.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt, now }
  );
  assert.equal(retry.state.statusCode, 200);
  assert.equal(retry.state.body.duplicate, true);
  assert.equal(tx.events.size, 1);
  assert.equal([...tx.events.values()][0].textCiphertext, "sealed:An agent reported its name.");
  assert.equal(tx.agents.get("user-1|bot-1").displayName, "Scout");
});

test("the same event id on another user stays isolated, and liveness follows last-seen", async () => {
  const tx = memoryTx();
  const tokenA = createReportToken("user-1");
  const tokenB = createReportToken("user-2");
  for (const [userId, token] of [
    ["user-1", tokenA],
    ["user-2", tokenB],
  ]) {
    await tx.workforceBinding.create({
      data: { userId, status: "ACTIVE", cursorAccountId: null, emailCiphertext: null },
    });
    tx.bindings.get(userId).reportKeyHash = hashReportToken(token);
  }

  await acceptSelfReport(tx, tokenA, report("bot-1", { text: "user one" }), {
    encrypt,
    now: new Date("2026-10-02T12:00:00.000Z"),
  });
  await acceptSelfReport(tx, tokenB, report("bot-1", { text: "user two" }), {
    encrypt,
    now: new Date("2026-10-02T12:00:00.000Z"),
  });
  assert.equal(tx.events.size, 2);
  assert.equal(tx.events.get("user-1|SELF_REPORT|evt-1").textCiphertext, "sealed:user one");
  assert.equal(tx.events.get("user-2|SELF_REPORT|evt-1").textCiphertext, "sealed:user two");
  assert.equal(tx.events.get("user-1|SELF_REPORT|evt-1").bindingId, tx.bindings.get("user-1").id);
  assert.notEqual(
    tx.events.get("user-1|SELF_REPORT|evt-1").bindingId,
    tx.bindings.get("user-2").id
  );

  const stale = await acceptSelfReport(
    tx,
    tokenA,
    report("bot-1", {
      sourceEventId: "evt-old",
      occurredAt: "2026-10-02T00:00:00.000Z",
      text: "old",
    }),
    { encrypt, now: new Date("2026-10-02T12:00:00.000Z") }
  );
  assert.equal(stale.duplicate, false);
  assert.equal(tx.agents.get("user-1|bot-1").liveness, "ACTIVE");
  assert.equal(
    new Date(tx.agents.get("user-1|bot-1").lastEventAt).toISOString(),
    "2026-10-02T12:00:00.000Z"
  );

  await acceptSelfReport(
    tx,
    tokenA,
    report("bot-9", {
      sourceEventId: "evt-quiet",
      occurredAt: "2026-10-02T01:00:00.000Z",
      kind: "freedom.report.work",
      text: "quiet",
    }),
    { encrypt, now: new Date("2026-10-02T12:00:00.000Z") }
  );
  assert.equal(tx.agents.get("user-1|bot-9").liveness, "STALE");
  assert.equal(tx.agents.get("user-1|bot-9").displayName, null);
});

test("malformed reports and a body that is too large are refused", async () => {
  const tx = memoryTx();
  const token = createReportToken("user-1");
  await tx.workforceBinding.create({
    data: { userId: "user-1", status: "ACTIVE", cursorAccountId: null, emailCiphertext: null },
  });
  tx.bindings.get("user-1").reportKeyHash = hashReportToken(token);

  const malformed = response();
  await handleWorkforceReport(
    request("POST", { token, body: { kind: "freedom.report.finding" } }),
    malformed.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt }
  );
  assert.equal(malformed.state.statusCode, 400);
  assert.equal(tx.events.size, 0);

  const coded = response();
  await handleWorkforceReport(
    request("POST", { token, body: report("bot-1", { coded: { trust: "platform" } }) }),
    coded.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt }
  );
  assert.equal(coded.state.statusCode, 400);

  const huge = response();
  await handleWorkforceReport(
    request("POST", { token, body: report("bot-1", { text: "x".repeat(20_000) }) }),
    huge.response,
    { enforceRateLimit: allow, withUser: scoped(tx), encrypt }
  );
  assert.equal(huge.state.statusCode, 413);
  assert.equal(tx.events.size, 0);

  const wrongMethod = response();
  await handleWorkforceReport(request("GET", { token }), wrongMethod.response, {
    enforceRateLimit: allow,
    withUser: scoped(tx),
    encrypt,
  });
  assert.equal(wrongMethod.state.statusCode, 405);
});
