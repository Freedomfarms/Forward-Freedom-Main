// Per-user CHIEF conversational preferences. One row per account.
// A missing row is the JARVIS default for that user. Other settings are not written.

import { isDatabaseConfigured, withUserContext } from "../../db/prisma.js";
import {
  applyPersonalityPatch,
  defaultChiefPersonality,
  normalizeChiefPersonality,
} from "../../../src/utils/chiefPersonality.js";

function personalityError(message, code, status) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireUserId(userId) {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw personalityError("Authenticated user is required.", "UNAUTHENTICATED", 401);
  }
  return userId;
}

export function isMissingPersonalityStoreError(error) {
  const message = String(error?.message || "");
  const missing =
    error?.code === "P2021" ||
    error?.code === "P2022" ||
    /does not exist|Unknown table|Unknown arg/i.test(message);
  return missing && /chiefPersonality|chief_personality/i.test(message);
}

function publicResult(personality, { persisted, schemaReady }) {
  return {
    personality: normalizeChiefPersonality(personality),
    persisted: persisted === true,
    schemaReady: schemaReady !== false,
  };
}

function rowPersonality(row) {
  if (!row) return null;
  return normalizeChiefPersonality({
    preset: row.preset,
    responseLength: row.responseLength,
    humor: row.humor,
    directness: row.directness,
    proactiveness: row.proactiveness,
    customInstructions: row.customInstructions,
  });
}

async function readRow(userId, withUser) {
  return withUser(userId, (tx) =>
    tx.chiefPersonality.findUnique({
      where: { userId },
      select: {
        preset: true,
        responseLength: true,
        humor: true,
        directness: true,
        proactiveness: true,
        customInstructions: true,
      },
    })
  );
}

export async function readChiefPersonality(userId, { withUser } = {}) {
  const id = requireUserId(userId);
  const scoped = typeof withUser === "function" ? withUser : null;
  if (!scoped && !isDatabaseConfigured()) {
    return publicResult(defaultChiefPersonality(), { persisted: false, schemaReady: false });
  }
  const run = scoped || ((user, fn) => withUserContext(user, fn));
  try {
    const row = await readRow(id, run);
    if (!row) {
      return publicResult(defaultChiefPersonality(), { persisted: false, schemaReady: true });
    }
    return publicResult(rowPersonality(row), { persisted: true, schemaReady: true });
  } catch (error) {
    if (isMissingPersonalityStoreError(error)) {
      return publicResult(defaultChiefPersonality(), { persisted: false, schemaReady: false });
    }
    throw error;
  }
}

export async function saveChiefPersonality(userId, patch, { withUser } = {}) {
  const id = requireUserId(userId);
  if (typeof withUser !== "function" && !isDatabaseConfigured()) {
    throw personalityError(
      "Personality storage is not available on this database yet.",
      "PERSONALITY_SCHEMA_MISSING",
      503
    );
  }
  const run = typeof withUser === "function" ? withUser : (user, fn) => withUserContext(user, fn);
  let current;
  try {
    current = rowPersonality(await readRow(id, run)) || defaultChiefPersonality();
  } catch (error) {
    if (isMissingPersonalityStoreError(error)) {
      throw personalityError(
        "Personality storage is not available on this database yet.",
        "PERSONALITY_SCHEMA_MISSING",
        503
      );
    }
    throw error;
  }
  const personality = applyPersonalityPatch(current, patch);
  try {
    await run(id, (tx) =>
      tx.chiefPersonality.upsert({
        where: { userId: id },
        create: { userId: id, ...personality },
        update: personality,
      })
    );
  } catch (error) {
    if (isMissingPersonalityStoreError(error)) {
      throw personalityError(
        "Personality storage is not available on this database yet.",
        "PERSONALITY_SCHEMA_MISSING",
        503
      );
    }
    throw error;
  }
  return publicResult(personality, { persisted: true, schemaReady: true });
}
