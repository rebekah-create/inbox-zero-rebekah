-- CreateEnum
CREATE TYPE "ReconciliationOutcome" AS ENUM ('MATCHED', 'CREATED', 'AMBIGUOUS', 'PENDING', 'FAILED');

-- CreateTable
CREATE TABLE "ReconciliationRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "outcome" "ReconciliationOutcome" NOT NULL,
    "googleEventId" TEXT,
    "googleEventHtmlLink" TEXT,
    "extractedTitle" TEXT NOT NULL,
    "extractedStart" TIMESTAMP(3) NOT NULL,
    "extractedEnd" TIMESTAMP(3),
    "extractedLocation" TEXT,
    "extractedAttendees" TEXT[],
    "extractedIsAllDay" BOOLEAN DEFAULT false,
    "candidateConfidence" DOUBLE PRECISION NOT NULL,
    "eventSignature" TEXT NOT NULL,
    "errorMessage" TEXT,

    CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRecord_emailAccountId_messageId_eventSignatu_key" ON "ReconciliationRecord"("emailAccountId", "messageId", "eventSignature");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_emailAccountId_createdAt_idx" ON "ReconciliationRecord"("emailAccountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ReconciliationRecord_emailAccountId_outcome_idx" ON "ReconciliationRecord"("emailAccountId", "outcome");

-- AddForeignKey
ALTER TABLE "ReconciliationRecord" ADD CONSTRAINT "ReconciliationRecord_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
