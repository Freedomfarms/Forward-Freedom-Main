#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Encryption backfill & key-rotation utility.
//
// Usage:
//   node scripts/encrypt-backfill.mjs            # backfill legacy plaintext rows
//   node scripts/encrypt-backfill.mjs --rotate   # re-encrypt everything under
//                                                # the active KEK version
//
// Backfill (safe, online):
//   • Encrypts any remaining plaintext Account/Transaction/WorkspaceSnapshot
//     values into their *Ciphertext columns and NULLs the plaintext.
//   • Re-wraps Plaid access tokens into the current envelope format.
//   After a successful backfill you can run the follow-up migration that drops
//   the plaintext columns (balance / amount / merchant / category / metadata /
//   state), because every row is fully encrypted.
//
// Rotate:
//   • Decrypts and re-encrypts every ciphertext value so it is wrapped by the
//     current active KEK version. Old KEK versions must remain configured in
//     FFF_ENCRYPTION_KEYS until rotation completes. No user reconnection needed.
//
// Requires: DATABASE_URL and a configured encryption key
// (FFF_ENCRYPTION_KEYS + FFF_ENCRYPTION_ACTIVE_VERSION, or PLAID_TOKEN_ENCRYPTION_KEY).
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { getPrismaClient, isDatabaseConfigured, Prisma } from "../server/db/prisma.js";
import {
  encrypt,
  encryptJson,
  encryptNumber,
  isEncryptionConfigured,
  reEncrypt,
} from "../server/security/envelope.js";

const ROTATE = process.argv.includes("--rotate");
const BATCH = 500;

function assertReady() {
  if (!isDatabaseConfigured()) throw new Error("DATABASE_URL is not configured.");
  if (!isEncryptionConfigured()) {
    throw new Error("No encryption key configured (FFF_ENCRYPTION_KEYS or PLAID_TOKEN_ENCRYPTION_KEY).");
  }
}

async function backfillAccounts(prisma) {
  let migrated = 0;
  const rows = await prisma.account.findMany({
    where: ROTATE
      ? { balanceCiphertext: { not: null } }
      : { OR: [{ balance: { not: null } }, { metadata: { not: Prisma.DbNull } }] },
    select: { id: true, balance: true, balanceCiphertext: true, metadata: true, metadataCiphertext: true },
    take: ROTATE ? undefined : BATCH * 100,
  });

  for (const row of rows) {
    const data = {};
    if (ROTATE) {
      if (row.balanceCiphertext) data.balanceCiphertext = reEncrypt(row.balanceCiphertext);
      if (row.metadataCiphertext) data.metadataCiphertext = reEncrypt(row.metadataCiphertext);
    } else {
      if (row.balance != null) {
        data.balanceCiphertext = encryptNumber(Number(row.balance));
        data.balance = null;
      }
      if (row.metadata != null) {
        data.metadataCiphertext = encryptJson(row.metadata);
        data.metadata = Prisma.DbNull;
      }
    }
    if (Object.keys(data).length) {
      await prisma.account.update({ where: { id: row.id }, data });
      migrated += 1;
    }
  }
  return migrated;
}

async function backfillTransactions(prisma) {
  let migrated = 0;
  const rows = await prisma.transaction.findMany({
    where: ROTATE
      ? { amountCiphertext: { not: null } }
      : { OR: [{ amount: { not: null } }, { merchant: { not: null } }, { category: { not: null } }] },
    select: {
      id: true,
      amount: true,
      amountCiphertext: true,
      merchant: true,
      merchantCiphertext: true,
      category: true,
      categoryCiphertext: true,
    },
  });

  for (const row of rows) {
    const data = {};
    if (ROTATE) {
      if (row.amountCiphertext) data.amountCiphertext = reEncrypt(row.amountCiphertext);
      if (row.merchantCiphertext) data.merchantCiphertext = reEncrypt(row.merchantCiphertext);
      if (row.categoryCiphertext) data.categoryCiphertext = reEncrypt(row.categoryCiphertext);
    } else {
      if (row.amount != null) {
        data.amountCiphertext = encryptNumber(Number(row.amount));
        data.amount = null;
      }
      if (row.merchant != null) {
        data.merchantCiphertext = encrypt(row.merchant);
        data.merchant = null;
      }
      if (row.category != null) {
        data.categoryCiphertext = encrypt(row.category);
        data.category = null;
      }
    }
    if (Object.keys(data).length) {
      await prisma.transaction.update({ where: { id: row.id }, data });
      migrated += 1;
    }
  }
  return migrated;
}

async function backfillPlaidItems(prisma) {
  // Re-wrap access tokens into the current envelope / active KEK.
  let migrated = 0;
  const rows = await prisma.plaidItem.findMany({
    select: { id: true, accessTokenCiphertext: true },
  });
  for (const row of rows) {
    if (!row.accessTokenCiphertext) continue;
    await prisma.plaidItem.update({
      where: { id: row.id },
      data: { accessTokenCiphertext: reEncrypt(row.accessTokenCiphertext) },
    });
    migrated += 1;
  }
  return migrated;
}

async function backfillWorkspaceSnapshots(prisma) {
  let migrated = 0;
  const rows = await prisma.workspaceSnapshot.findMany({
    where: ROTATE ? { stateCiphertext: { not: null } } : { state: { not: Prisma.DbNull } },
    select: { id: true, state: true, stateCiphertext: true },
  });
  for (const row of rows) {
    const data = {};
    if (ROTATE) {
      if (row.stateCiphertext) data.stateCiphertext = reEncrypt(row.stateCiphertext);
    } else if (row.state != null) {
      data.stateCiphertext = encryptJson(row.state);
      data.state = Prisma.DbNull;
    }
    if (Object.keys(data).length) {
      await prisma.workspaceSnapshot.update({ where: { id: row.id }, data });
      migrated += 1;
    }
  }
  return migrated;
}

async function main() {
  assertReady();
  const prisma = getPrismaClient();
  const mode = ROTATE ? "rotate" : "backfill";
  console.log(`[encrypt-${mode}] starting…`);

  const accounts = await backfillAccounts(prisma);
  const transactions = await backfillTransactions(prisma);
  const plaidItems = await backfillPlaidItems(prisma);
  const snapshots = await backfillWorkspaceSnapshots(prisma);

  console.log(
    `[encrypt-${mode}] done. accounts=${accounts} transactions=${transactions} plaidItems=${plaidItems} workspaceSnapshots=${snapshots}`
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(`[encrypt-backfill] failed: ${error?.message || "unknown error"}`);
  process.exitCode = 1;
});
