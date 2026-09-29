// CHIEF approval semantics — policy modes, review decisions, sticky
// session approvals, and the authorize/resolve contract for tool batches.
//
// PORT/ADAPT of möbius (citizenhicks, Apache-2.0; NOTICE reproduced in
// THIRD_PARTY_NOTICES.md — derived in part from OpenAI Codex and Ratatui)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source files: src/backend/sandbox/approval.rs, src/protocol/events.rs
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//   License text: licenses/MOBIUS-LICENSE-APACHE-2.0.txt (NOTICE: licenses/MOBIUS-NOTICE.txt)
//
// Preserved upstream semantics:
//   - ApprovalPolicy wire values: ask | allow | allow_network | full_access
//     (default ask); unknown values are rejected
//   - network access per policy: allow → denied; ask/allow_network/
//     full_access → allowed ("ask" cannot reach execution until per-call
//     mutation approval is granted)
//   - sandbox mode: full_access → danger_full_access, else workspace_write
//   - ReviewDecision wire values: approved | approved_for_session |
//     denied { rejection } | abort
//   - sticky session approvals keyed by SHA-256 of the JSON encoding of
//     [sessionId, toolName, arguments], capped at 64 per session (the set is
//     cleared when the cap is reached, exactly as upstream)
//   - authorize(): a mutation call executes immediately when policy != ask or
//     its sticky key is already approved; otherwise it is listed in an
//     approval request; unknown mutation call ids are an error
//   - resolve(): only approved/approved_for_session grant mutations; an
//     approval referencing an unknown call id is an error; approved_for_
//     session additionally records sticky keys; denied/abort grant nothing
//   - session_start/session_end lifecycle; authorizing an uninitialized
//     session is an error
// Documented adaptations (CHIEF-specific reasons):
//   - In-memory state is a contract implementation for one request lifetime;
//     Phase 3 persists session approval state in chief_approval /
//     chief_session so any serverless instance can resume a suspended turn
//     (docs/CHIEF_ARCHITECTURE.md §7.2).
//   - OS sandbox permissions (seatbelt/landlock) do not exist on this
//     platform; SandboxPermissions is reduced to the fields CHIEF consumes
//     (sandboxMode, networkAccess, approved mutation call ids).
//   - Frontend widget/block rendering stays out of this module (presentation
//     separation; UI belongs to later phases).

import { createHash } from "node:crypto";

// ReviewDecision is a protocol type (upstream defines it in src/protocol/
// events.rs and approval.rs imports it) — same layering here.
import { ReviewDecisionType } from "../protocol/index.js";

export { ReviewDecisionType };

export const ApprovalPolicy = Object.freeze({
  ASK: "ask",
  ALLOW: "allow",
  ALLOW_NETWORK: "allow_network",
  FULL_ACCESS: "full_access",
});

export const DEFAULT_APPROVAL_POLICY = ApprovalPolicy.ASK;

const APPROVAL_POLICY_VALUES = new Set(Object.values(ApprovalPolicy));

export const MAX_SESSION_APPROVALS = 64;

export const NetworkAccess = Object.freeze({
  ALLOWED: "allowed",
  DENIED: "denied",
});

export const SandboxMode = Object.freeze({
  WORKSPACE_WRITE: "workspace_write",
  DANGER_FULL_ACCESS: "danger_full_access",
});

export function parseApprovalPolicy(value) {
  if (!APPROVAL_POLICY_VALUES.has(value)) {
    throw new Error(`unknown sandbox approval policy \`${value}\``);
  }
  return value;
}

export function policyNetworkAccess(policy) {
  return policy === ApprovalPolicy.ALLOW ? NetworkAccess.DENIED : NetworkAccess.ALLOWED;
}

export function policySandboxMode(policy) {
  return policy === ApprovalPolicy.FULL_ACCESS
    ? SandboxMode.DANGER_FULL_ACCESS
    : SandboxMode.WORKSPACE_WRITE;
}

function decisionGrants(decision) {
  return (
    decision.type === ReviewDecisionType.APPROVED ||
    decision.type === ReviewDecisionType.APPROVED_FOR_SESSION
  );
}

// Sticky-approval key: SHA-256 over the JSON encoding of the tuple
// (session_id, call.name, call.arguments) — upstream `call_key`. serde_json
// encodes the tuple as a JSON array and preserves object key order, matching
// JSON.stringify on the same structure.
export function callKey(sessionId, call) {
  const encoded = JSON.stringify([sessionId, call.name, call.arguments]);
  return createHash("sha256").update(encoded).digest("hex");
}

export class SandboxPermissions {
  constructor(sessionId, sandboxMode, networkAccess, approvedCallIds) {
    this.sessionId = sessionId;
    this.sandboxMode = sandboxMode;
    this.networkAccess = networkAccess;
    this._approved = new Set(approvedCallIds);
  }

  allowMutations(callIds) {
    for (const callId of callIds) this._approved.add(callId);
  }

  forCall(callId) {
    return {
      sandboxMode: this.sandboxMode,
      networkAccess: this.networkAccess,
      mutation: this._approved.has(callId),
    };
  }
}

export class ApprovalCoordinator {
  constructor(defaultPolicy = DEFAULT_APPROVAL_POLICY, { generateId } = {}) {
    this._defaultPolicy = parseApprovalPolicy(defaultPolicy);
    this._states = new Map();
    this._generateId = generateId || (() => crypto.randomUUID());
  }

  get policy() {
    return this._defaultPolicy;
  }

  sessionStart(sessionId) {
    this._states.set(sessionId, { approvedForSession: new Set() });
  }

  sessionEnd(sessionId) {
    this._states.delete(sessionId);
  }

  // Phase 3 persistence: sticky keys live in the checkpoint so another
  // serverless instance can restore them. The cap rule is the same one
  // resolve() uses.
  restore(sessionId, keys = []) {
    this.sessionStart(sessionId);
    const state = this._state(sessionId);
    for (const key of keys) {
      if (state.approvedForSession.size >= MAX_SESSION_APPROVALS) {
        state.approvedForSession.clear();
      }
      state.approvedForSession.add(key);
    }
  }

  exportKeys(sessionId) {
    return [...this._state(sessionId).approvedForSession];
  }

  _state(sessionId) {
    const state = this._states.get(sessionId);
    if (!state) {
      throw new Error("approval state is not initialized");
    }
    return state;
  }

  authorize(sessionId, calls, mutationCallIds) {
    const state = this._state(sessionId);
    const policy = this._defaultPolicy;
    const callsById = new Map(calls.map((call) => [call.callId, call]));
    const approved = [];
    const requested = [];
    for (const callId of mutationCallIds) {
      const call = callsById.get(callId);
      if (!call) {
        throw new Error(`unknown mutation call \`${callId}\``);
      }
      if (policy !== ApprovalPolicy.ASK || state.approvedForSession.has(callKey(sessionId, call))) {
        approved.push(callId);
      } else {
        requested.push(callId);
      }
    }
    const permissions = new SandboxPermissions(
      sessionId,
      policySandboxMode(policy),
      policyNetworkAccess(policy),
      approved
    );
    if (requested.length === 0) {
      return { type: "execute", permissions };
    }
    return {
      type: "approval",
      request: {
        id: this._generateId(),
        reason: "one or more tools require approval",
        callIds: requested,
      },
      permissions,
    };
  }

  resolve(sessionId, calls, approvalCallIds, decision, permissions) {
    if (!decisionGrants(decision)) {
      return permissions;
    }
    const callsById = new Map(calls.map((call) => [call.callId, call]));
    for (const callId of approvalCallIds) {
      if (!callsById.has(callId)) {
        throw new Error(`approval references unknown call \`${callId}\``);
      }
    }
    permissions.allowMutations(approvalCallIds);
    if (decision.type !== ReviewDecisionType.APPROVED_FOR_SESSION) {
      return permissions;
    }
    const keys = approvalCallIds.map((callId) => callKey(sessionId, callsById.get(callId)));
    const state = this._state(sessionId);
    for (const key of keys) {
      if (state.approvedForSession.size >= MAX_SESSION_APPROVALS) {
        state.approvedForSession.clear();
      }
      state.approvedForSession.add(key);
    }
    return permissions;
  }
}
