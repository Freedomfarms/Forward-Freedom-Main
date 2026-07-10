-- CreateTable
CREATE TABLE "LegalConsentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "method" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalConsentEvent_userId_consentAt_idx" ON "LegalConsentEvent"("userId", "consentAt");

-- AddForeignKey
ALTER TABLE "LegalConsentEvent" ADD CONSTRAINT "LegalConsentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
