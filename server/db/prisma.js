import prismaClientPackage from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const { PrismaClient, Prisma } = prismaClientPackage;

// Re-exported so writers can set JSON columns to SQL NULL (Prisma.DbNull) when
// migrating plaintext values to their encrypted counterparts.
export { Prisma };

const globalScope = globalThis;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPrismaClient() {
  if (!isDatabaseConfigured()) {
    return null;
  }

  if (!globalScope.__forwardFreedomPrisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    globalScope.__forwardFreedomPrisma = new PrismaClient({ adapter });
  }

  return globalScope.__forwardFreedomPrisma;
}

// Interactive transactions default to a 5s timeout, which is far too short for
// flows that interleave Plaid network calls with row writes (item sync can
// paginate transactions for minutes on a large institution).
const DEFAULT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * Runs `fn(tx)` inside a transaction whose first statement binds the Postgres
 * session setting `app.current_user_id` to the given user. Row-level-security
 * policies (see the freedom_os RLS migration) compare every row's "userId"
 * ("id" on "User") against that setting, so queries issued through `tx` are
 * database-enforced to the user's own rows — a forgotten WHERE clause can no
 * longer leak another user's data.
 *
 * The third set_config argument is `true` (transaction-local): the setting
 * evaporates at COMMIT/ROLLBACK, which is what makes this safe behind
 * Supabase's transaction-mode pooler where connections are shared across
 * requests between transactions.
 *
 * All user-scoped queries MUST go through the `tx` handed to `fn` — never the
 * bare client — otherwise they run without a user context and, once RLS is
 * live, see zero rows (fail closed).
 *
 * `options` is forwarded to prisma.$transaction; pass a larger `timeout` for
 * flows that hold the transaction open across external API calls.
 */
export async function withUserContext(userId, fn, options = {}) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId) {
    // Fail closed: running "just this once" without a user scope is exactly
    // the class of bug RLS exists to prevent.
    throw new Error("withUserContext requires a non-empty userId.");
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    const error = new Error("Database client is not configured.");
    error.status = 503;
    throw error;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${normalizedUserId}, true)`;
    return fn(tx);
  }, { ...DEFAULT_TRANSACTION_OPTIONS, ...options });
}
