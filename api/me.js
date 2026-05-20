import { authenticateRequest, AuthError } from "../server/auth/verifyAuth.js";
import { getPrismaClient, isDatabaseConfigured } from "../server/db/prisma.js";

function buildUserPayload(decodedToken, userRecord = null) {
  return {
    id: decodedToken.uid,
    email: decodedToken.email || userRecord?.email || null,
    displayName: decodedToken.name || userRecord?.displayName || null,
    photoURL: decodedToken.picture || userRecord?.photoURL || null,
    emailVerified: Boolean(decodedToken.email_verified),
    role: userRecord?.role || "OWNER",
  };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }

  try {
    const decodedToken = await authenticateRequest(request);
    const prisma = getPrismaClient();
    let userRecord = null;

    if (prisma && isDatabaseConfigured()) {
      userRecord = await prisma.user.upsert({
        where: { id: decodedToken.uid },
        update: {
          email: decodedToken.email || null,
          displayName: decodedToken.name || null,
          photoURL: decodedToken.picture || null,
          lastLoginAt: new Date(),
        },
        create: {
          id: decodedToken.uid,
          email: decodedToken.email || null,
          displayName: decodedToken.name || null,
          photoURL: decodedToken.picture || null,
          lastLoginAt: new Date(),
        },
      });
    }

    return response.status(200).json({
      user: buildUserPayload(decodedToken, userRecord),
      services: {
        databaseConfigured: isDatabaseConfigured(),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json({
        error: true,
        message: error.message,
      });
    }

    return response.status(500).json({
      error: true,
      message: error?.message || "Unable to load the authenticated workspace profile.",
    });
  }
}
