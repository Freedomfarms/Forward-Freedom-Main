// CHIEF core events — typed event taxonomy + pub/sub event bus.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/core/events.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - the EventType taxonomy string values, verbatim
//   - Event record shape: { eventType, timestamp, data }
//   - EventBus: subscribe/unsubscribe (idempotent removal), synchronous
//     publish in registration order over a snapshot of the listener list,
//     subscriber exceptions caught and logged so one broken observer neither
//     interrupts the publisher nor starves later subscribers, publish returns
//     the Event, optional history recording (history getter returns a copy)
//   - module singleton getEventBus()/resetEventBus() for parity with upstream
// Documented adaptations (CHIEF-specific reasons):
//   - No threading lock: Node's event loop is single-threaded; the listener
//     snapshot before dispatch is kept because subscribers may (un)subscribe
//     during publish.
//   - Python's process-control exception passthrough (KeyboardInterrupt/
//     SystemExit) has no JS equivalent; all subscriber throwables are logged.
//   - In the serverless runtime each request constructs its own EventBus
//     (docs/CHIEF_ARCHITECTURE.md §5.3); the singleton exists for scripts and
//     tests, mirroring upstream, and must not be relied on across requests.

export const EventType = Object.freeze({
  INFERENCE_START: "inference_start",
  INFERENCE_END: "inference_end",
  TOOL_CALL_START: "tool_call_start",
  TOOL_CALL_END: "tool_call_end",
  MEMORY_STORE: "memory_store",
  MEMORY_RETRIEVE: "memory_retrieve",
  CHAT_EXCHANGE_COMPLETED: "chat_exchange_completed",
  AGENT_TURN_START: "agent_turn_start",
  AGENT_TURN_END: "agent_turn_end",
  TELEMETRY_RECORD: "telemetry_record",
  TRACE_STEP: "trace_step",
  TRACE_COMPLETE: "trace_complete",
  CHANNEL_MESSAGE_RECEIVED: "channel_message_received",
  CHANNEL_MESSAGE_SENT: "channel_message_sent",
  SECURITY_SCAN: "security_scan",
  SECURITY_ALERT: "security_alert",
  SECURITY_BLOCK: "security_block",
  SCHEDULER_TASK_START: "scheduler_task_start",
  SCHEDULER_TASK_END: "scheduler_task_end",
  BATCH_START: "batch_start",
  BATCH_END: "batch_end",
  TOOL_TIMEOUT: "tool_timeout",
  LOOP_GUARD_TRIGGERED: "loop_guard_triggered",
  CAPABILITY_DENIED: "capability_denied",
  TAINT_VIOLATION: "taint_violation",
  RATE_LIMITED: "rate_limited",
  WORKFLOW_START: "workflow_start",
  WORKFLOW_NODE_START: "workflow_node_start",
  WORKFLOW_NODE_END: "workflow_node_end",
  WORKFLOW_END: "workflow_end",
  SKILL_EXECUTE_START: "skill_execute_start",
  SKILL_EXECUTE_END: "skill_execute_end",
  SESSION_START: "session_start",
  SESSION_END: "session_end",
  OPERATOR_TICK_START: "operator_tick_start",
  OPERATOR_TICK_END: "operator_tick_end",
  AGENT_TICK_START: "agent_tick_start",
  AGENT_TICK_END: "agent_tick_end",
  AGENT_TICK_ERROR: "agent_tick_error",
  AGENT_BUDGET_EXCEEDED: "agent_budget_exceeded",
  AGENT_STALL_DETECTED: "agent_stall_detected",
  AGENT_LEARNING_STARTED: "agent_learning_started",
  AGENT_LEARNING_COMPLETED: "agent_learning_completed",
  AGENT_MESSAGE_RECEIVED: "agent_message_received",
  AGENT_CHECKPOINT_SAVED: "agent_checkpoint_saved",
  OPTIMIZE_RUN_START: "optimize_run_start",
  OPTIMIZE_TRIAL_START: "optimize_trial_start",
  OPTIMIZE_TRIAL_END: "optimize_trial_end",
  OPTIMIZE_RUN_END: "optimize_run_end",
  FEEDBACK_RECEIVED: "feedback_received",
});

const EVENT_TYPE_VALUES = new Set(Object.values(EventType));

export function isEventType(value) {
  return EVENT_TYPE_VALUES.has(value);
}

export class EventBus {
  constructor({ recordHistory = false, logger = console } = {}) {
    this._subscribers = new Map();
    this._recordHistory = recordHistory;
    this._history = [];
    this._logger = logger;
  }

  subscribe(eventType, callback) {
    if (!this._subscribers.has(eventType)) {
      this._subscribers.set(eventType, []);
    }
    this._subscribers.get(eventType).push(callback);
  }

  unsubscribe(eventType, callback) {
    const listeners = this._subscribers.get(eventType);
    if (!listeners) return;
    const index = listeners.indexOf(callback);
    if (index !== -1) listeners.splice(index, 1);
  }

  publish(eventType, data = {}) {
    const event = {
      eventType,
      timestamp: Date.now() / 1000,
      data,
    };
    // Snapshot mirrors upstream copying the listener list under lock: a
    // subscriber that (un)subscribes during dispatch cannot skew this publish.
    const listeners = [...(this._subscribers.get(eventType) || [])];
    if (this._recordHistory) {
      this._history.push(event);
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // Upstream rule: one broken observer must neither interrupt the
        // publisher nor starve later subscribers.
        this._logger.error(
          `EventBus subscriber failed for ${eventType}:`,
          error,
        );
      }
    }
    return event;
  }

  get history() {
    return [...this._history];
  }

  clearHistory() {
    this._history = [];
  }
}

let _singletonBus = null;

export function getEventBus({ recordHistory = false } = {}) {
  if (_singletonBus === null) {
    _singletonBus = new EventBus({ recordHistory });
  }
  return _singletonBus;
}

export function resetEventBus() {
  _singletonBus = null;
}
