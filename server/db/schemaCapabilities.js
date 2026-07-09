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
    } catch {
      cached = { encryptionColumns: false };
    } finally {
      inflight = null;
    }
    return cached;
  })();

  return inflight;
}

export function isMissingEncryptionColumnError(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2022" &&
    /Ciphertext|plaidMask|\braw\b/i.test(message)
  );
}
