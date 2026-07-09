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
import { applySecurityHeaders } from "../server/http/responseHelpers.js";
import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (!chunks.length) return {};

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

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
        snapshot: snapshot
          ? {
              state: sanitizeWorkspaceStateForPersistence(readSnapshotState(snapshot)),
              source: snapshot.source,
              updatedAt: snapshot.updatedAt,
              lastClientUpdatedAt: snapshot.lastClientUpdatedAt,
            }
          : null,
      });
    }

    const payload = await readJsonBody(request);
    if (!payload?.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
      return response.status(400).json(buildErrorResponse("A workspace state object is required."));
    }
    const sanitizedState = sanitizeWorkspaceStateForPersistence(payload.state);
    const source = typeof payload.source === "string" ? payload.source : "app-sync";
    const lastClientUpdatedAt = payload.lastClientUpdatedAt
      ? new Date(payload.lastClientUpdatedAt)
      : null;

    async function upsertSnapshot(caps) {
      const stateColumns = buildSnapshotStateColumns(sanitizedState, caps);
      return prisma.workspaceSnapshot.upsert({
        where: { userId: decodedToken.uid },
        update: {
          ...stateColumns,
          source,
          lastClientUpdatedAt,
        },
        create: {
          userId: decodedToken.uid,
          ...stateColumns,
          source,
          lastClientUpdatedAt,
        },
        ...(caps.encryptionColumns ? {} : { select: LEGACY_SNAPSHOT_SELECT }),
      });
    }

    let snapshot;
    try {
      snapshot = await upsertSnapshot(capabilities);
    } catch (error) {
      if (isMissingEncryptionColumnError(error) && capabilities.encryptionColumns) {
        resetSchemaCapabilitiesCache();
        capabilities = await getSchemaCapabilities(prisma);
        snapshot = await upsertSnapshot(capabilities);
      } else {
        throw error;
      }
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

    return respondInternalError(
      response,
      "api/workspace",
      error,
      "Unable to read or update the workspace snapshot."
    );
  }
}
