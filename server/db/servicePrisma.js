import prismaClientPackage from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { getPrismaClient } from "./prisma.js";

const { PrismaClient } = prismaClientPackage;

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE-ROLE DATABASE CLIENT — DO NOT IMPORT THIS MODULE FROM NEW CODE.
//
// This client connects as the `freedom_service` role (SERVICE_DATABASE_URL),
// which carries BYPASSRLS: queries issued through it see EVERY user's rows.
// It exists for the small set of legitimately cross-user operations that
// cannot run inside a single user's row-level-security context:
//
//   (a) the Plaid webhook resolving an incoming item_id to its owning userId
//       (server/plaid/handlers.js, server/plaid/webhookHandler.js) — Plaid
//       sends no user token, so the owner is unknown until this lookup;
//   (b) the future cron dispatcher enumerating due agents across users
//       (api/cron/agent-dispatch.js);
//   (c) future admin usage/cost reporting queries.
//
// Every call site must carry a comment justifying the bypass, and must switch
// into withUserContext(resolvedUserId, ...) the moment a user is known.
// Anything else — handlers, agent runtime, UI-serving code — must use
// withUserContext from server/db/prisma.js instead.
// ─────────────────────────────────────────────────────────────────────────────

const globalScope = globalThis;

export function isServiceDatabaseConfigured() {
  return Boolean(process.env.SERVICE_DATABASE_URL || process.env.DATABASE_URL);
}

export function getServicePrismaClient() {
  const connectionString = process.env.SERVICE_DATABASE_URL;

  // Before the RLS rollout completes (rollout step 3), SERVICE_DATABASE_URL is
  // not set yet and DATABASE_URL still points at the table-owner role, which
  // policies do not restrict until they are live and FORCEd — so reusing the
  // app client keeps behavior identical during the staged rollout without
  // opening a second connection pool.
  if (!connectionString) {
    return getPrismaClient();
  }

  if (!globalScope.__forwardFreedomServicePrisma) {
    const adapter = new PrismaPg({ connectionString });
    globalScope.__forwardFreedomServicePrisma = new PrismaClient({ adapter });
  }

  return globalScope.__forwardFreedomServicePrisma;
}
