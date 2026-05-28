import { authenticateRequest, AuthError } from "../server/auth/verifyAuth.js";
import { getPrismaClient, isDatabaseConfigured } from "../server/db/prisma.js";
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

export default async function handler(request, response) {
  if (!["GET", "PUT"].includes(request.method || "")) {
    return response.status(405).json(buildErrorResponse("Method not allowed."));
  }

  if (!isDatabaseConfigured()) {
    return response
      .status(503)
      .json(buildErrorResponse("Database is not configured for workspace persistence yet."));
  }

  try {
    const decodedToken = await authenticateRequest(request);
    const prisma = getPrismaClient();
    if (!prisma) {
      return response
        .status(503)
        .json(buildErrorResponse("Database client is not configured for workspace persistence."));
    }

    if (request.method === "GET") {
      const snapshot = await prisma.workspaceSnapshot.findUnique({
        where: { userId: decodedToken.uid },
      });

      return response.status(200).json({
        snapshot: snapshot
          ? {
              state: sanitizeWorkspaceStateForPersistence(snapshot.state),
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

    const snapshot = await prisma.workspaceSnapshot.upsert({
      where: { userId: decodedToken.uid },
      update: {
        state: sanitizedState,
        source: typeof payload.source === "string" ? payload.source : "app-sync",
        lastClientUpdatedAt: payload.lastClientUpdatedAt
          ? new Date(payload.lastClientUpdatedAt)
          : null,
      },
      create: {
        userId: decodedToken.uid,
        state: sanitizedState,
        source: typeof payload.source === "string" ? payload.source : "app-sync",
        lastClientUpdatedAt: payload.lastClientUpdatedAt
          ? new Date(payload.lastClientUpdatedAt)
          : null,
      },
    });

    return response.status(200).json({
      snapshot: {
        state: snapshot.state,
        source: snapshot.source,
        updatedAt: snapshot.updatedAt,
        lastClientUpdatedAt: snapshot.lastClientUpdatedAt,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    return response
      .status(500)
      .json(
        buildErrorResponse(error?.message || "Unable to read or update the workspace snapshot.")
      );
  }
}
