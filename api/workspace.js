import { authenticateRequest, AuthError } from "../server/auth/verifyAuth.js";
import { getPrismaClient, isDatabaseConfigured, Prisma } from "../server/db/prisma.js";
import {
  getSchemaCapabilities,
  isMissingEncryptionColumnError,
  resetSchemaCapabilitiesCache,
} from "../server/db/schemaCapabilities.js";
import { decryptJson, encryptJson, isEncryptionConfigured } from "../server/security/envelope.js";
import { respondInternalError } from "../server/http/errorHelpers.js";
import {
  enforceRateLimit,
  generalApiRateLimit,
  workspaceWriteRateLimit,
} from "../server/http/rateLimit.js";
import { readJsonBody } from "../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../server/http/responseHelpers.js";
import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

function buildErrorResponse(message) {
  return {
    error: true,
    message,
  };
}

// The workspace blob holds manual financial data. Prefer encrypted storage when
// the migration has been applied; otherwise keep writing the legacy plaintext
// `state` column so the app works on an un-migrated production database.
function readSnapshotState(snapshot) {
  if (!snapshot) return null;
  if (snapshot.stateCiphertext != null) {
    return decryptJson(snapshot.stateCiphertext);
  }
  return snapshot.state ?? null;
}

function buildSnapshotStateColumns(sanitizedState, { encryptionColumns }) {
  if (encryptionColumns && isEncryptionConfigured()) {
    return { state: Prisma.DbNull, stateCiphertext: encryptJson(sanitizedState) };
  }
  // Pre-migration / no-key path: store plaintext only. Never reference
  // stateCiphertext so Prisma does not require the column to exist.
  return { state: sanitizedState };
}

const LEGACY_SNAPSHOT_SELECT = {
  id: true,
  userId: true,
  state: true,
  source: true,
  lastClientUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
};

async function findWorkspaceSnapshot(prisma, userId, { encryptionColumns }) {
  if (encryptionColumns) {
    return prisma.workspaceSnapshot.findUnique({ where: { userId } });
  }
  return prisma.workspaceSnapshot.findUnique({
    where: { userId },
    select: LEGACY_SNAPSHOT_SELECT,
  });
}

function buildSnapshotResponsePayload(snapshot) {
  return {
    state: sanitizeWorkspaceStateForPersistence(readSnapshotState(snapshot)),
    source: snapshot.source,
    updatedAt: snapshot.updatedAt,
    lastClientUpdatedAt: snapshot.lastClientUpdatedAt,
  };
}

function parseOptionalDate(value, label) {
  if (value == null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${label} must be a valid ISO-8601 timestamp.`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

const SNAPSHOT_WRITE_CONFLICT = Symbol("snapshot-write-conflict");

// Concurrency control for snapshot writes (last-write-wins fix). Clients send
// baseSnapshotUpdatedAt — the server `updatedAt` of the snapshot their state
// is based on (null when they believe none exists). The write only lands if
// the row still matches that version; otherwise the caller receives a 409
// with the current snapshot so it can reconcile instead of silently
// clobbering a concurrent save from another tab or session.
//
// Legacy clients that do not send the field fall back to an ordering guard on
// lastClientUpdatedAt: a write stamped older than what is already stored
// (e.g. a delayed retry arriving after a newer save) is rejected.
async function writeSnapshotWithConcurrencyControl(prisma, userId, caps, payloadFields) {
  const { stateColumns, source, lastClientUpdatedAt, hasBaseMarker, baseSnapshotUpdatedAt } =
    payloadFields;
  const data = { ...stateColumns, source, lastClientUpdatedAt };

  async function createSnapshot() {
    try {
      return await prisma.workspaceSnapshot.create({
        data: { userId, ...data },
        ...(caps.encryptionColumns ? {} : { select: LEGACY_SNAPSHOT_SELECT }),
      });
    } catch (error) {
      // Unique(userId) race: another request created the row concurrently.
      if (error?.code === "P2002") {
        return SNAPSHOT_WRITE_CONFLICT;
      }
      throw error;
    }
  }

  if (hasBaseMarker) {
    if (!baseSnapshotUpdatedAt) {
      // Client believes no snapshot exists yet; only a create may succeed.
      const existing = await findWorkspaceSnapshot(prisma, userId, caps);
      if (existing) return SNAPSHOT_WRITE_CONFLICT;
      return createSnapshot();
    }

    const updated = await prisma.workspaceSnapshot.updateMany({
      where: { userId, updatedAt: baseSnapshotUpdatedAt },
      data,
    });
    if (updated.count === 0) {
      return SNAPSHOT_WRITE_CONFLICT;
    }
    return findWorkspaceSnapshot(prisma, userId, caps);
  }

  // Legacy path (no base marker): guard against out-of-order writes only.
  const orderingGuard = lastClientUpdatedAt
    ? { OR: [{ lastClientUpdatedAt: null }, { lastClientUpdatedAt: { lte: lastClientUpdatedAt } }] }
    : {};
  const updated = await prisma.workspaceSnapshot.updateMany({
    where: { userId, ...orderingGuard },
    data,
  });
  if (updated.count > 0) {
    return findWorkspaceSnapshot(prisma, userId, caps);
  }

  const existing = await findWorkspaceSnapshot(prisma, userId, caps);
  if (existing) {
    // The row exists but the ordering guard rejected this stale write.
    return SNAPSHOT_WRITE_CONFLICT;
  }
  return createSnapshot();
}

export default async function handler(request, response) {
  applySecurityHeaders(response);

  if (!["GET", "PUT"].includes(request.method || "")) {
    return response.status(405).json(buildErrorResponse("Method not allowed."));
  }

  const rateLimiter = request.method === "PUT" ? workspaceWriteRateLimit : generalApiRateLimit;
  if (!(await enforceRateLimit(request, response, rateLimiter))) return;

  try {
    const decodedToken = await authenticateRequest(request);

    if (!isDatabaseConfigured()) {
      return response
        .status(503)
        .json(buildErrorResponse("Database is not configured for workspace persistence yet."));
    }

    const prisma = getPrismaClient();
    if (!prisma) {
      return response
        .status(503)
        .json(buildErrorResponse("Database client is not configured for workspace persistence."));
    }

    let capabilities = await getSchemaCapabilities(prisma);

    if (request.method === "GET") {
      let snapshot;
      try {
        snapshot = await findWorkspaceSnapshot(prisma, decodedToken.uid, capabilities);
      } catch (error) {
        // Cache may be stale if the migration was applied mid-process, or the
        // opposite: we assumed columns exist but they don't. Retry once.
        if (isMissingEncryptionColumnError(error) && capabilities.encryptionColumns) {
          resetSchemaCapabilitiesCache();
          capabilities = await getSchemaCapabilities(prisma);
          snapshot = await findWorkspaceSnapshot(prisma, decodedToken.uid, capabilities);
        } else {
          throw error;
        }
      }

      return response.status(200).json({
        snapshot: snapshot ? buildSnapshotResponsePayload(snapshot) : null,
      });
    }

    const payload = await readJsonBody(request);
    if (!payload?.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
      return response.status(400).json(buildErrorResponse("A workspace state object is required."));
    }
    const sanitizedState = sanitizeWorkspaceStateForPersistence(payload.state);
    const source = typeof payload.source === "string" ? payload.source : "app-sync";
    const lastClientUpdatedAt = parseOptionalDate(
      payload.lastClientUpdatedAt,
      "lastClientUpdatedAt"
    );
    const hasBaseMarker = Object.hasOwn(payload, "baseSnapshotUpdatedAt");
    const baseSnapshotUpdatedAt = parseOptionalDate(
      payload.baseSnapshotUpdatedAt,
      "baseSnapshotUpdatedAt"
    );

    async function writeSnapshot(caps) {
      return writeSnapshotWithConcurrencyControl(prisma, decodedToken.uid, caps, {
        stateColumns: buildSnapshotStateColumns(sanitizedState, caps),
        source,
        lastClientUpdatedAt,
        hasBaseMarker,
        baseSnapshotUpdatedAt,
      });
    }

    let snapshot;
    try {
      snapshot = await writeSnapshot(capabilities);
    } catch (error) {
      if (isMissingEncryptionColumnError(error) && capabilities.encryptionColumns) {
        resetSchemaCapabilitiesCache();
        capabilities = await getSchemaCapabilities(prisma);
        snapshot = await writeSnapshot(capabilities);
      } else {
        throw error;
      }
    }

    if (snapshot === SNAPSHOT_WRITE_CONFLICT) {
      // Return the winning snapshot so the client can reconcile without an
      // extra round-trip instead of silently dropping the other writer's data.
      const currentSnapshot = await findWorkspaceSnapshot(prisma, decodedToken.uid, capabilities);
      return response.status(409).json({
        error: true,
        message:
          "The workspace was updated by another session since this state was loaded. Reload the latest snapshot before saving again.",
        snapshot: currentSnapshot ? buildSnapshotResponsePayload(currentSnapshot) : null,
      });
    }

    return response.status(200).json({
      snapshot: {
        state: sanitizedState,
        source: snapshot.source,
        updatedAt: snapshot.updatedAt,
        lastClientUpdatedAt: snapshot.lastClientUpdatedAt,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    if (error?.status === 400) {
      return response.status(400).json(buildErrorResponse(error.message));
    }

    return respondInternalError(
      response,
      "api/workspace",
      error,
      "Unable to read or update the workspace snapshot."
    );
  }
}
