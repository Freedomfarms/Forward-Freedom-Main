import { getPrismaClient } from "./prisma.js";

// Detects whether the privacy-encryption migration has been applied.
// Production can briefly run new code against an un-migrated database (Vercel
// deploys code without applying migrations). Callers use this to fall back to
// the pre-encryption column set so the app keeps working until migrate deploy
// runs. Result is cached for the process lifetime.

let cached = null;
let inflight = null;

export function resetSchemaCapabilitiesCache() {
  cached = null;
  inflight = null;
}

export async function getSchemaCapabilities(prisma = getPrismaClient()) {
  if (cached) return cached;
  if (inflight) return inflight;
  if (!prisma) {
    cached = { encryptionColumns: false };
    return cached;
  }

  inflight = (async () => {
    try {
      // LIMIT 0 probes column existence without reading rows.
      await prisma.$queryRaw`SELECT "stateCiphertext" FROM "WorkspaceSnapshot" LIMIT 0`;
      cached = { encryptionColumns: true };
    } catch (error) {
      // Only treat *missing-column* failures as "encryption not migrated yet".
      // Permission denied (42501), connection errors, etc. must NOT be cached
      // as encryptionColumns: false — that sends callers down the legacy
      // plaintext `state` path and obscures the real failure (e.g. freedom_app
      // missing GRANT on WorkspaceSnapshot after the RLS role switch).
      if (isMissingEncryptionColumnProbeError(error)) {
        cached = { encryptionColumns: false };
      } else {
        inflight = null;
        throw error;
      }
    } finally {
      inflight = null;
    }
    return cached;
  })();

  return inflight;
}

function isMissingEncryptionColumnProbeError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || error?.cause?.code || "");
  // Postgres undefined_column, Prisma known-request missing-column, or a
  // driver message that names the probe column as absent.
  return (
    code === "42703" ||
    code === "P2022" ||
    (/stateCiphertext/i.test(message) && /does not exist|Unknown column|column .* not found/i.test(message))
  );
}

export function isMissingEncryptionColumnError(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2022" &&
    /Ciphertext|plaidMask|\braw\b/i.test(message)
  );
}
