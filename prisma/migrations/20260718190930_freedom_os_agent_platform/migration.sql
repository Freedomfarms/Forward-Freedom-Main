-- CreateEnum
CREATE TYPE "CeoPersonalityPreset" AS ENUM ('DIRECT_EFFICIENT', 'WARM_ENCOURAGING', 'FORMAL');

-- CreateEnum
CREATE TYPE "AgentPermissionLevel" AS ENUM ('READ_ONLY', 'DRAFT_ONLY', 'ACTION_REQUIRED_APPROVAL', 'AUTONOMOUS');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AgentChatRole" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CeoAgentConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'CEO Agent',
    "personalityPreset" "CeoPersonalityPreset" NOT NULL DEFAULT 'DIRECT_EFFICIENT',
    "avatarKey" TEXT,
    "profileCiphertext" TEXT,
    "profileUpdatedAt" TIMESTAMP(3),
    "lastDigestCiphertext" TEXT,
    "lastDigestAt" TIMESTAMP(3),
    "onboardingCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CeoAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ceoAgentConfigId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT,
    "definitionOfDone" TEXT,
    "permissionLevel" "AgentPermissionLevel" NOT NULL DEFAULT 'READ_ONLY',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    "toolAccess" JSONB,
    "schedule" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentConfigId" TEXT,
    "agentType" TEXT NOT NULL,
    "summary" TEXT,
    "dataAccessed" JSONB,
    "outputCiphertext" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "model" TEXT,
    "tokensInput" INTEGER,
    "tokensOutput" INTEGER,
    "estimatedCostUsd" DECIMAL(10,6),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentConfigId" TEXT,
    "ceoAgentConfigId" TEXT,
    "role" "AgentChatRole" NOT NULL,
    "contentCiphertext" TEXT NOT NULL,
    "relatedRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentConfigId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CeoAgentConfig_userId_key" ON "CeoAgentConfig"("userId");

-- CreateIndex
CREATE INDEX "AgentConfig_userId_idx" ON "AgentConfig"("userId");

-- CreateIndex
CREATE INDEX "AgentConfig_userId_agentType_idx" ON "AgentConfig"("userId", "agentType");

-- CreateIndex
CREATE INDEX "AgentRun_userId_startedAt_idx" ON "AgentRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_agentConfigId_startedAt_idx" ON "AgentRun"("agentConfigId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_userId_agentType_startedAt_idx" ON "AgentRun"("userId", "agentType", "startedAt");

-- CreateIndex
CREATE INDEX "AgentChatMessage_agentConfigId_createdAt_idx" ON "AgentChatMessage"("agentConfigId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentChatMessage_ceoAgentConfigId_createdAt_idx" ON "AgentChatMessage"("ceoAgentConfigId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentChatMessage_userId_createdAt_idx" ON "AgentChatMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CeoAgentConfig" ADD CONSTRAINT "CeoAgentConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_ceoAgentConfigId_fkey" FOREIGN KEY ("ceoAgentConfigId") REFERENCES "CeoAgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_agentConfigId_fkey" FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_agentConfigId_fkey" FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_ceoAgentConfigId_fkey" FOREIGN KEY ("ceoAgentConfigId") REFERENCES "CeoAgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_relatedRunId_fkey" FOREIGN KEY ("relatedRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_agentConfigId_fkey" FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A chat message belongs to exactly one chat: either a sub-agent chat
-- (agentConfigId) or the CEO Agent chat (ceoAgentConfigId), never both and
-- never neither. Mirrors the invariant enforced in application code.
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_exactly_one_chat_target_check" CHECK ((("agentConfigId" IS NULL) <> ("ceoAgentConfigId" IS NULL)));
