import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import type { Logger } from "@/utils/logger";

const STALE_PENDING_MS = 5 * 60 * 1000;

export type ReconciliationOutcome =
  | "MATCHED"
  | "CREATED"
  | "AMBIGUOUS"
  | "PENDING"
  | "FAILED";

export type CreateReconciliationInput = {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  eventSignature: string;
  extractedTitle: string;
  extractedStart: Date;
  extractedEnd: Date | null;
  extractedLocation: string | null;
  extractedAttendees: string[];
  candidateConfidence: number;
  /**
   * 09-01 revision column. Orchestrator passes `candidate.isAllDay` so that
   * 09-06's stale-PENDING rehydration reads this back instead of guessing via
   * a midnight heuristic.
   */
  extractedIsAllDay: boolean;
};

/**
 * Create a ReconciliationRecord for the given (emailAccountId, messageId,
 * eventSignature) triple. Webhook replays that hit D-14's unique constraint
 * are caught via `isDuplicateError` and turned into a no-op return — never
 * rethrown — so the orchestrator can short-circuit cleanly.
 *
 * T-09-05 (information disclosure): the P2002 log payload is restricted to
 * `{ emailAccountId, messageId }`. Extracted title / location / attendees /
 * signature MUST NOT appear in logs.
 */
export async function createReconciliationRecord({
  input,
  logger,
}: {
  input: CreateReconciliationInput;
  logger: Logger;
}): Promise<
  | { created: true; record: Awaited<ReturnType<typeof prisma.reconciliationRecord.create>> }
  | { created: false; record: null }
> {
  try {
    const record = await prisma.reconciliationRecord.create({
      data: {
        emailAccountId: input.emailAccountId,
        messageId: input.messageId,
        threadId: input.threadId,
        outcome: "PENDING",
        extractedTitle: input.extractedTitle,
        extractedStart: input.extractedStart,
        extractedEnd: input.extractedEnd,
        extractedLocation: input.extractedLocation,
        extractedAttendees: input.extractedAttendees,
        candidateConfidence: input.candidateConfidence,
        extractedIsAllDay: input.extractedIsAllDay,
        eventSignature: input.eventSignature,
      },
    });
    return { created: true, record };
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    // D-14: unique-constraint hit → webhook replay landed on an existing row.
    // T-09-05: log only safe identifiers — NOT extractedTitle/location/attendees.
    logger.info("Reconciliation record already exists (idempotency hit)", {
      emailAccountId: input.emailAccountId,
      messageId: input.messageId,
    });
    return { created: false, record: null };
  }
}

export async function findExistingReconciliationRecord({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}) {
  return prisma.reconciliationRecord.findFirst({
    where: { emailAccountId, messageId },
  });
}

export async function updateReconciliationRecord({
  id,
  data,
}: {
  id: string;
  data: {
    outcome?: ReconciliationOutcome;
    googleEventId?: string | null;
    googleEventHtmlLink?: string | null;
    errorMessage?: string | null;
  };
}) {
  return prisma.reconciliationRecord.update({ where: { id }, data });
}

/**
 * D-16: stale PENDING sweep. Returns a PENDING row for
 * (emailAccountId, messageId) whose `updatedAt` is older than 5 minutes
 * ago — assumed to be the artefact of a crashed worker and eligible for
 * retry by the orchestrator (plan 09-06).
 *
 * `now` is injected so tests can pin the cutoff deterministically; production
 * callers can rely on the `Date.now()` default.
 */
export async function findStalePendingRecord({
  emailAccountId,
  messageId,
  now = Date.now(),
}: {
  emailAccountId: string;
  messageId: string;
  now?: number;
}) {
  const cutoff = new Date(now - STALE_PENDING_MS);
  return prisma.reconciliationRecord.findFirst({
    where: {
      emailAccountId,
      messageId,
      outcome: "PENDING",
      updatedAt: { lt: cutoff },
    },
  });
}
