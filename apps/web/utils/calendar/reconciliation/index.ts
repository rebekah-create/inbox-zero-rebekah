import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import { convertEmailHtmlToText } from "@/utils/mail";
import { getUpcomingEvents } from "@/utils/calendar/upcoming-events";
import { extractFromIcs } from "./ics-path";
import { extractCandidateEvent, type CandidateEvent } from "./extract";
import { decideOutcome } from "./match";
import { eventSignature } from "./signature";
import {
  createReconciliationRecord,
  findExistingReconciliationRecord,
  findStalePendingRecord,
  updateReconciliationRecord,
} from "./persist";
import { createCalendarEvent } from "./create-event";

/**
 * Phase 9 reconciliation orchestrator (plan 09-06).
 *
 * Wave 3 wiring of the D-12 sequence:
 *   1. Pre-filter (D-01) → if neither Path A (.ics) nor Path B (Haiku) applies, return.
 *   2. findExistingReconciliationRecord — early idempotency fast-path (T-09-04).
 *   3. Stale-PENDING recovery (D-16) → reuse existing row id, skip create + skip Haiku.
 *   4. Extract via Path A (ics-path) or Path B (extract).
 *   5. eventSignature → createReconciliationRecord (P2002 catch → no-op).
 *   6. getUpcomingEvents → decideOutcome → updateReconciliationRecord(outcome).
 *   7. If outcome=CREATED: createCalendarEvent → update with googleEventId / failed.
 *   8. Outer try/catch — orchestrator NEVER rethrows (OPS-01, EVT-05).
 *
 * Logging discipline (T-09-05): structured fields only on warn/error.
 *   - allowed: emailAccountId, messageId, threadId, outcome, errorCode, error.
 *   - forbidden: extractedTitle, extractedLocation, extractedAttendees,
 *                raw textPlain/textHtml, full subject line.
 */

// D-02 keyword backstop list — locked verbatim per plan 09-06 task 1.
const CALENDAR_KEYWORDS = [
  "appointment",
  "reminder",
  "scheduled",
  "confirmation",
  "reservation",
  "your visit",
  "rsvp",
  "calendar",
  "meeting",
  "invitation",
  "booked",
  "dr.",
] as const;

/**
 * Pure case-insensitive keyword backstop over subject + body.
 */
export function matchesKeywordBackstop({
  subject,
  body,
}: {
  subject: string;
  body: string;
}): boolean {
  const haystack = `${subject}\n${body}`.toLowerCase();
  return CALENDAR_KEYWORDS.some((kw) => haystack.includes(kw));
}

async function isClassifiedAsCalendar({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}): Promise<boolean> {
  const executed = await prisma.executedRule.findFirst({
    where: {
      emailAccountId,
      messageId,
      rule: { systemType: "CALENDAR" },
    },
    select: { id: true },
  });
  return executed !== null;
}

function truncateBody(parsedMessage: ParsedMessage): string {
  const raw =
    parsedMessage.textPlain ??
    convertEmailHtmlToText({ htmlText: parsedMessage.textHtml ?? "" });
  return raw.slice(0, 2000);
}

/**
 * The Phase 9 orchestrator entry point. Called from the `after()` fan-out
 * inside the Gmail webhook handler (plan 09-07 wires this up).
 *
 * Failure isolation (OPS-01, EVT-05): the entire body is wrapped in
 * try/catch. On any exception we log + best-effort flip the record to
 * FAILED + return without rethrowing. DO NOT rethrow.
 */
export async function reconcileMessage({
  parsedMessage,
  emailAccount,
  emailAccountId,
  logger,
}: {
  parsedMessage: ParsedMessage;
  emailAccount: EmailAccountWithAI;
  emailAccountId: string;
  logger: Logger;
}): Promise<void> {
  const messageId = parsedMessage.id;
  const threadId = parsedMessage.threadId;
  const senderEmail = parsedMessage.headers?.from ?? "";
  const subject = parsedMessage.headers?.subject ?? parsedMessage.subject ?? "";

  try {
    // 1. Pre-filter (D-01).
    const icsCandidate = extractFromIcs(parsedMessage);
    const pathA = icsCandidate !== null;
    let pathB = false;
    let bodyTruncated = "";

    if (!pathA) {
      const isCalendar = await isClassifiedAsCalendar({
        emailAccountId,
        messageId,
      });
      bodyTruncated = truncateBody(parsedMessage);
      pathB =
        isCalendar || matchesKeywordBackstop({ subject, body: bodyTruncated });
      if (!pathB) return;
    } else {
      // Even for path A we may need bodyTruncated downstream — keep empty.
      bodyTruncated = "";
    }

    // 2. Idempotency fast-path + stale-PENDING recovery (D-14, D-16).
    const existing = await findExistingReconciliationRecord({
      emailAccountId,
      messageId,
    });
    let existingRowForReuse: { id: string } | null = null;
    if (existing) {
      const stale = await findStalePendingRecord({
        emailAccountId,
        messageId,
      });
      if (!stale) {
        // Non-stale row exists → idempotency no-op.
        logger.info("Reconciliation already processed (idempotency hit)", {
          emailAccountId,
          messageId,
          outcome: existing.outcome,
        });
        return;
      }
      // Stale-PENDING → reuse the existing row id, skip create attempt.
      existingRowForReuse = { id: stale.id };
    }

    // 3. Extract. For stale-PENDING recovery we re-hydrate the candidate from
    //    the persisted row (T-09-04: don't pay Haiku twice on crash-recovery).
    let candidate: CandidateEvent;
    if (existingRowForReuse) {
      const stale = await prisma.reconciliationRecord.findUnique({
        where: { id: existingRowForReuse.id },
      });
      if (!stale?.extractedTitle || !stale?.extractedStart) {
        // Defensive: persisted row missing fields → fresh extract fallback.
        existingRowForReuse = null;
        candidate = pathA
          ? (icsCandidate as CandidateEvent)
          : await extractCandidateEvent({
              email: { subject, from: senderEmail, bodyTruncated },
              emailAccount,
              logger,
            });
      } else {
        candidate = {
          title: stale.extractedTitle,
          startISO: stale.extractedStart.toISOString(),
          endISO: stale.extractedEnd ? stale.extractedEnd.toISOString() : null,
          location: stale.extractedLocation ?? null,
          attendees: stale.extractedAttendees ?? [],
          confidence: stale.candidateConfidence ?? 0,
          // isAllDay sourced from the persisted column (09-01 revision).
          // No heuristic — the LLM's authoritative flag was captured at first extraction.
          isAllDay: stale.extractedIsAllDay ?? false,
        };
      }
    } else {
      candidate = pathA
        ? (icsCandidate as CandidateEvent)
        : await extractCandidateEvent({
            email: { subject, from: senderEmail, bodyTruncated },
            emailAccount,
            logger,
          });
    }

    // D-08 all-day flag — sourced directly from candidate.isAllDay
    // (which is either the LLM's output for Path B or the ics adapter's
    // derived flag for Path A). The prior midnight heuristic was unsafe;
    // see the schema's isAllDay description in extract.ts.
    const isAllDay = candidate.isAllDay;

    const sig = eventSignature(candidate.title, candidate.startISO);

    // 4. Create-or-reuse the persistence row.
    let recordId: string;
    if (existingRowForReuse) {
      recordId = existingRowForReuse.id;
    } else {
      const created = await createReconciliationRecord({
        input: {
          emailAccountId,
          messageId,
          threadId,
          eventSignature: sig,
          extractedTitle: candidate.title,
          extractedStart: candidate.startISO
            ? new Date(candidate.startISO)
            : new Date(0),
          extractedEnd: candidate.endISO ? new Date(candidate.endISO) : null,
          extractedLocation: candidate.location,
          extractedAttendees: candidate.attendees,
          candidateConfidence: candidate.confidence,
          extractedIsAllDay: candidate.isAllDay,
        },
        logger,
      });
      if (!created.created) {
        // P2002 — concurrent webhook landed first; no-op.
        return;
      }
      recordId = created.record.id;
    }

    // 5. Match against the user's 7-day window.
    const now = new Date();
    const upcoming = await getUpcomingEvents({
      emailAccountId,
      now,
      logger,
    }).catch(() => []);
    const { outcome, matchedEventId } = decideOutcome({
      candidate: {
        title: candidate.title,
        startISO: candidate.startISO,
        isAllDay,
      },
      existingEvents: upcoming,
    });

    // 6. Persist MATCHED / AMBIGUOUS outcomes (no Google call).
    if (outcome !== "CREATED") {
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome, googleEventId: matchedEventId },
      });
      return;
    }

    // 7. CREATED path → Google events.insert.
    const tz = emailAccount.timezone ?? "America/New_York";
    const inserted = await createCalendarEvent({
      input: {
        emailAccountId,
        messageId,
        threadId,
        senderEmail,
        timezone: tz,
        candidate: {
          title: candidate.title,
          startISO: candidate.startISO,
          endISO: candidate.endISO,
          location: candidate.location,
          isAllDay,
        },
      },
      logger,
    });
    if (inserted.ok) {
      await updateReconciliationRecord({
        id: recordId,
        data: {
          outcome: "CREATED",
          googleEventId: inserted.googleEventId,
          googleEventHtmlLink: inserted.googleEventHtmlLink,
        },
      });
    } else {
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome: "FAILED", errorMessage: inserted.reason },
      });
    }
  } catch (error) {
    // Failure isolation (OPS-01, EVT-05) — DO NOT rethrow.
    logger.error("Reconciliation failed", {
      emailAccountId,
      messageId,
      error,
    });
    try {
      const existing = await findExistingReconciliationRecord({
        emailAccountId,
        messageId,
      });
      if (existing) {
        await updateReconciliationRecord({
          id: existing.id,
          data: {
            outcome: "FAILED",
            errorMessage: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 200),
          },
        });
      }
    } catch {
      // swallow — failure isolation.
    }
    // DO NOT rethrow.
  }
}
