-- CreateTable
CREATE TABLE "chief_budget_hold" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL DEFAULT '',
    "operationId" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT 'cursor',
    "periodType" TEXT NOT NULL DEFAULT 'run',
    "estimateUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "actualUsd" DECIMAL(12,6),
    "operatorAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chief_budget_hold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chief_budget_hold_operationId_key" ON "chief_budget_hold"("operationId");

-- CreateIndex
CREATE INDEX "chief_budget_hold_user_scope_period_idx" ON "chief_budget_hold"("userId", "scope", "periodType");
