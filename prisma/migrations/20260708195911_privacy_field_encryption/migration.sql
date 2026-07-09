/*
  Warnings:

  - You are about to drop the column `plaidMask` on the `Account` table. All the data in the column will be lost.
  - You are about to drop the column `raw` on the `Transaction` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Account" DROP COLUMN "plaidMask",
ADD COLUMN     "balanceCiphertext" TEXT,
ADD COLUMN     "metadataCiphertext" TEXT;

-- AlterTable
ALTER TABLE "BudgetRow" ADD COLUMN     "reserveAnchor" JSONB,
ADD COLUMN     "reserveTargetMonths" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'O';

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "raw",
ADD COLUMN     "amountCiphertext" TEXT,
ADD COLUMN     "categoryCiphertext" TEXT,
ADD COLUMN     "merchantCiphertext" TEXT,
ALTER COLUMN "merchant" DROP NOT NULL,
ALTER COLUMN "amount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WorkspaceSnapshot" ADD COLUMN     "stateCiphertext" TEXT,
ALTER COLUMN "state" DROP NOT NULL;
