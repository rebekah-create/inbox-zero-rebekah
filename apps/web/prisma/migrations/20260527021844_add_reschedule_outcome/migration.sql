-- AlterEnum
ALTER TYPE "ReconciliationOutcome" ADD VALUE 'RESCHEDULE';

-- AlterTable
ALTER TABLE "ReconciliationRecord" ADD COLUMN "rescheduleOfEventId" TEXT;
