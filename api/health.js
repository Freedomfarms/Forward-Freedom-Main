import { isFirebaseAdminConfigured } from "../server/auth/firebaseAdmin.js";
import { isDatabaseConfigured } from "../server/db/prisma.js";

export default function handler(_request, response) {
  response.status(200).json({
    status: "ok",
    runtime: "vercel-node",
    services: {
      firebaseAdminConfigured: isFirebaseAdminConfigured(),
      databaseConfigured: isDatabaseConfigured(),
      plaidConfigured: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    },
  });
}
