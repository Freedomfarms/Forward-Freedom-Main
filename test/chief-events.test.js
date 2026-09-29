// CHIEF event bus tests — translated from OpenJarvis tests/core/test_events.py
// (commit 5e5f5ef). Threading tests are omitted (single-threaded event loop);
// the process-control-exception passthrough has no JS equivalent (documented
// adaptation in server/chief/core/events.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  EventBus,
  EventType,
  isEventType,
  getEventBus,
  resetEventBus,
} from "../server/chief/core/events.js";

const silentLogger = { error: () => {} };

test("subscribe and publish delivers the event with its data", () => {
  const bus = new EventBus();
  const received = [];
  bus.subscribe(EventType.INFERENCE_END, (event) => received.push(event));
  bus.publish(EventType.INFERENCE_END, { model: "test" });
  assert.equal(received.length, 1);
  assert.equal(received[0].data.model, "test");
});

test("multiple subscribers all receive the event", () => {
  const bus = new EventBus();
  const a = [];
  const b = [];
  bus.subscribe(EventType.TOOL_CALL_START, (e) => a.push(e));
  bus.subscribe(EventType.TOOL_CALL_START, (e) => b.push(e));
  bus.publish(EventType.TOOL_CALL_START);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test("failing subscriber does not starve later subscribers and is logged", () => {
  const logged = [];
  const bus = new EventBus({
    logger: { error: (...args) => logged.push(args.join(" ")) },
  });
  const received = [];
  bus.subscribe(EventType.INFERENCE_END, () => {
    throw new Error("boom");
  });
  bus.subscribe(EventType.INFERENCE_END, (e) => received.push(e));
  const event = bus.publish(EventType.INFERENCE_END, { model: "test" });
  assert.deepEqual(received, [event]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /inference_end/);
});

test("unsubscribe removes the callback; unsubscribing a missing callback is a no-op", () => {
  const bus = new EventBus();
  const received = [];
  const callback = (e) => received.push(e);
  bus.subscribe(EventType.MEMORY_STORE, callback);
  bus.unsubscribe(EventType.MEMORY_STORE, callback);
  bus.publish(EventType.MEMORY_STORE);
  assert.equal(received.length, 0);
  // no-op, must not throw
  bus.unsubscribe(EventType.INFERENCE_START, () => {});
});

test("history recording is opt-in and clearable", () => {
  const recording = new EventBus({ recordHistory: true });
  recording.publish(EventType.INFERENCE_START);
  recording.publish(EventType.INFERENCE_END);
  assert.equal(recording.history.length, 2);
  recording.clearHistory();
  assert.equal(recording.history.length, 0);

  const plain = new EventBus();
  plain.publish(EventType.INFERENCE_START);
  assert.equal(plain.history.length, 0);
});

test("history getter returns a copy", () => {
  const bus = new EventBus({ recordHistory: true });
  bus.publish(EventType.AGENT_TURN_START);
  bus.history.pop();
  assert.equal(bus.history.length, 1);
});

test("publish returns the event", () => {
  const bus = new EventBus();
  const event = bus.publish(EventType.TELEMETRY_RECORD, { k: "v" });
  assert.equal(event.eventType, EventType.TELEMETRY_RECORD);
  assert.equal(typeof event.timestamp, "number");
});

test("different event types are isolated", () => {
  const bus = new EventBus({ logger: silentLogger });
  const a = [];
  bus.subscribe(EventType.INFERENCE_START, (e) => a.push(e));
  bus.publish(EventType.INFERENCE_END);
  assert.equal(a.length, 0);
});

test("subscribers mutating the listener list during publish do not skew dispatch", () => {
  const bus = new EventBus();
  const received = [];
  const late = (e) => received.push(["late", e]);
  bus.subscribe(EventType.SESSION_START, (e) => {
    received.push(["first", e]);
    bus.subscribe(EventType.SESSION_START, late);
  });
  bus.publish(EventType.SESSION_START);
  // The listener added during dispatch must not run for the same publish.
  assert.deepEqual(
    received.map(([tag]) => tag),
    ["first"],
  );
});

test("agent tick and operational event types exist with upstream wire values", () => {
  assert.equal(EventType.AGENT_TICK_START, "agent_tick_start");
  assert.equal(EventType.AGENT_TICK_END, "agent_tick_end");
  assert.equal(EventType.AGENT_TICK_ERROR, "agent_tick_error");
  assert.equal(EventType.AGENT_BUDGET_EXCEEDED, "agent_budget_exceeded");
  assert.equal(EventType.AGENT_STALL_DETECTED, "agent_stall_detected");
  assert.equal(EventType.AGENT_MESSAGE_RECEIVED, "agent_message_received");
  assert.equal(EventType.AGENT_CHECKPOINT_SAVED, "agent_checkpoint_saved");
  assert.equal(EventType.CAPABILITY_DENIED, "capability_denied");
  assert.equal(EventType.TAINT_VIOLATION, "taint_violation");
  assert.equal(EventType.SECURITY_BLOCK, "security_block");
  assert.equal(isEventType("inference_start"), true);
  assert.equal(isEventType("not_an_event"), false);
});

test("singleton getEventBus returns the same instance until reset", () => {
  resetEventBus();
  const a = getEventBus();
  const b = getEventBus();
  assert.equal(a, b);
  resetEventBus();
  const c = getEventBus();
  assert.notEqual(a, c);
  resetEventBus();
});
