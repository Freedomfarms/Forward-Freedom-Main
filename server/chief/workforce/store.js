// The only writer for workforce observation rows.
//
// userId comes from the authenticated caller, never from the payload.
// A missing or revoked binding refuses the append. Duplicate delivery of
// the same source event id keeps the first payload.

import { encrypt as sealText } from "../../security/envelope.js";
import { DbTrust, normalizeObservation, projectAgent } from "./journal.js";

function bindingKey(userId) {
  return userId;
}

export async function openWorkforceBinding(
  tx,
  userId,
  { cursorAccountId = null, emailCiphertext = null, email = undefined } = {}
) {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("workforce binding requires a user");
  }
  if (email !== undefined) {
    throw new Error("workforce binding rejects plaintext email");
  }
  if (cursorAccountId != null && typeof cursorAccountId !== "string") {
    throw new Error("cursorAccountId must be a string");
  }
  if (emailCiphertext != null && typeof emailCiphertext !== "string") {
    throw new Error("emailCiphertext must be a string");
  }
  const existing = await tx.workforceBinding.findUnique({ where: { userId: bindingKey(userId) } });
  if (!existing) {
    return tx.workforceBinding.create({
      data: {
        userId,
        status: "ACTIVE",
        cursorAccountId,
        emailCiphertext,
      },
    });
  }
  if (existing.status !== "ACTIVE") {
    throw new Error("workforce binding is not active");
  }
  if (cursorAccountId && existing.cursorAccountId && existing.cursorAccountId !== cursorAccountId) {
    throw new Error("workforce binding is already linked to another account");
  }
  return existing;
}

async function requireActiveBinding(tx, userId) {
  const binding = await tx.workforceBinding.findUnique({ where: { userId } });
  if (!binding || binding.status !== "ACTIVE") {
    throw new Error("workforce binding is not active");
  }
  return binding;
}

function uniqueWhere(userId, event) {
  return {
    userId_source_sourceEventId: {
      userId,
      source: event.dbSource,
      sourceEventId: event.sourceEventId,
    },
  };
}

async function writeAgent(tx, userId, bindingId, event, now) {
  const current = await tx.observedAgent.findUnique({
    where: { userId_externalId: { userId, externalId: event.agentExternalId } },
  });
  const projected = projectAgent(current, event, now);
  const data = {
    displayName: projected.displayName,
    role: projected.role,
    identityTrust: projected.identityTrust ? DbTrust[projected.identityTrust] : null,
    lastEventAt: projected.lastEventAt,
    lastTurnId: projected.lastTurnId,
    liveness: projected.liveness,
  };
  if (!current) {
    return tx.observedAgent.create({
      data: {
        userId,
        bindingId,
        externalId: event.agentExternalId,
        ...data,
      },
    });
  }
  return tx.observedAgent.update({
    where: { userId_externalId: { userId, externalId: event.agentExternalId } },
    data,
  });
}

export async function appendObservation(
  tx,
  userId,
  input,
  { encrypt = sealText, now = new Date() } = {}
) {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("observation requires a user");
  }
  const event = normalizeObservation(input);
  const binding = await requireActiveBinding(tx, userId);
  const existing = await tx.activityEvent.findUnique({ where: uniqueWhere(userId, event) });
  if (existing) return { duplicate: true, event: existing };

  let textCiphertext = null;
  if (event.text != null) {
    textCiphertext = encrypt(event.text);
    if (typeof textCiphertext !== "string" || textCiphertext === event.text) {
      throw new Error("observation text was not sealed");
    }
  }

  try {
    const created = await tx.activityEvent.create({
      data: {
        userId,
        bindingId: binding.id,
        source: event.dbSource,
        trust: event.dbTrust,
        sourceEventId: event.sourceEventId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        agentExternalId: event.agentExternalId,
        turnId: event.turnId,
        rootTurnId: event.rootTurnId,
        toolCallId: event.toolCallId,
        sequence: event.sequence,
        provenance: event.provenance,
        coded: event.coded,
        textCiphertext,
      },
    });
    await writeAgent(tx, userId, binding.id, event, now);
    return { duplicate: false, event: created };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const raced = await tx.activityEvent.findUnique({ where: uniqueWhere(userId, event) });
    return { duplicate: true, event: raced };
  }
}
