import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import { convertEmailHtmlToText } from "@/utils/mail";
import { getUpcomingEvents } from "@/utils/calendar/upcoming-events";
import { extractFromIcs } from "./ics-path";
import { extractCandidateEvent, type CandidateEvent } from "./extract";
import { decideAllDayOutcome } from "./match";
import { arbitrateOverlap } from "./arbitrate";
import { findIntervalOverlaps } from "./overlap";
import { eventSignature } from "./signature";
import {
  createReconciliationRecord,
  findExistingReconciliationRecord,
  findStalePendingRecord,
  updateReconciliationRecord,
  type ReconciliationOutcome,
} from "./persist";
import { createCalendarEvent, patchEventDescription } from "./create-event";

/**
 * Phase 11 reconciliation orchestrator (plan 11-05).
 *
 * D-13 sequence (Wave 3 wiring on top of waves 1+2 substrate):
 *   1. Pre-filter (D-01) — keyword backstop or CALENDAR ExecutedRule.
 *   2. findExistingReconciliationRecord — early idempotency fast-path (T-09-04).
 *   3. Stale-PENDING recovery (D-16) → reuse existing row id, skip create + skip Haiku.
 *   4. Extract via Path A (ics-path) or Path B (extract).
 *   5. eventSignature → createReconciliationRecord (P2002 catch → no-op).
 *   6. Match (NEW — D-13):
 *        - Path A (.ics, D-14) → outcome=CREATED deterministically; arbitrate skipped.
 *        - All-day candidate (D-03) → decideAllDayOutcome; if NEEDS_ARBITRATION call arbiter
 *          over the same-date schedule.
 *        - Timed candidate (D-01/D-02) → findIntervalOverlaps over the upcoming window;
 *          if any overlap, call arbiter over the FULL day schedule (D-07).
 *        - Arbiter verdicts (D-06):
 *            SAME → outcome=MATCHED (no Google call).
 *            SEPARATE → outcome=CREATED.
 *            RESCHEDULE → outcome=RESCHEDULE; insert new event THEN patch old event's
 *              description (D-09) — non-destructive annotation, never modifies time/title.
 *            SKIP → outcome=FAILED, errorMessage flags an arbiter-skipped record.
 *        - Arbiter throws / parse fail / id-whitelist fail (D-08) → fall through to
 *          CREATE deterministically; never block orchestrator.
 *   7. Act on outcome — MATCHED/FAILED short-circuit; CREATED+RESCHEDULE go through
 *      Google events.insert; RESCHEDULE additionally calls patchEventDescription.
 *   8. Outer try/catch — orchestrator NEVER rethrows (OPS-01, EVT-05).
 *
 * Logging discipline (T-09-05): structured fields only on warn/error.
 *   - allowed: emailAccountId, messageId, threadId, outcome, errorCode, error,
 *              verdict, dayScheduleCount.
 *   - forbidden: extractedTitle, extractedLocation, extractedAttendees,
 *                raw textPlain/textHtml, full subject line, body excerpts.
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

/**
 * SystemTypes the classifier already decided are categorically not calendar
 * events. When the message has been routed to one of these, the keyword
 * backstop is overruled and the reconciler short-circuits before Haiku runs.
 *
 * Excludes conversation-state types (TO_REPLY / FYI / ACTIONED / AWAITING_REPLY)
 * because a real meeting invite can land in TO_REPLY.
 */
const NON_CALENDAR_SYSTEM_TYPES = new Set<string>([
  "NEWSLETTER",
  "MARKETING",
  "RECEIPT",
  "NOTIFICATION",
  "COLD_EMAIL",
]);

/**
 * Custom rule names that should also block reconciliation. Use sparingly —
 * prefer routing messages to a NON_CALENDAR_SYSTEM_TYPES rule instead. The
 * "Internal" rule is the explicit user-defined opt-out for app-generated
 * mail (e.g. the daily digest, which mentions calendar terms in its narrative).
 */
const NON_CALENDAR_RULE_NAMES = new Set<string>(["Internal"]);

async function getMessageClassification({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}): Promise<{ systemType: string | null; name: string } | null> {
  const executed = await prisma.executedRule.findFirst({
    where: { emailAccountId, messageId },
    select: { rule: { select: { systemType: true, name: true } } },
  });
  return executed?.rule ?? null;
}

function truncateBody(parsedMessage: ParsedMessage): string {
  const raw =
    parsedMessage.textPlain ??
    convertEmailHtmlToText({ htmlText: parsedMessage.textHtml ?? "" });
  return raw.slice(0, 2000);
}

/**
 * D-08 fallback wrapper around `arbitrateOverlap`. Any thrown / rejected
 * arbitration (Zod parse failure, whitelist failure, network) is logged with
 * T-09-05-safe fields and resolves to a deterministic CREATED outcome. The
 * caller never observes an exception from this helper — under-creation is
 * worse than over-creation; the orchestrator must always make progress.
 */
async function runArbitrationOrFallback(args: {
  email: { subject: string; from: string; bodyTruncated: string };
  candidate: {
    title: string;
    startISO: string;
    endISO: string | null;
    location: string | null;
  };
  daySchedule: Parameters<typeof arbitrateOverlap>[0]["daySchedule"];
  emailAccount: EmailAccountWithAI;
  logger: Logger;
  emailAccountId: string;
  messageId: string;
}): Promise<{
  outcome: ReconciliationOutcome;
  matchedEventId: string | null;
  rescheduleOfEventId: string | null;
  arbiterErrorMessage: string | null;
}> {
  try {
    const arb = await arbitrateOverlap({
      email: args.email,
      candidate: args.candidate,
      daySchedule: args.daySchedule,
      emailAccount: args.emailAccount,
      logger: args.logger,
    });
    switch (arb.verdict) {
      case "SAME":
        return {
          outcome: "MATCHED",
          matchedEventId: arb.matchedEventId,
          rescheduleOfEventId: null,
          arbiterErrorMessage: null,
        };
      case "SEPARATE":
        return {
          outcome: "CREATED",
          matchedEventId: null,
          rescheduleOfEventId: null,
          arbiterErrorMessage: null,
        };
      case "RESCHEDULE":
        return {
          outcome: "RESCHEDULE",
          matchedEventId: null,
          rescheduleOfEventId: arb.matchedEventId,
          arbiterErrorMessage: null,
        };
      case "SKIP":
        return {
          outcome: "FAILED",
          matchedEventId: null,
          rescheduleOfEventId: null,
          arbiterErrorMessage: "arbiter_skip",
        };
    }
  } catch (err) {
    args.logger.warn(
      "Reconciliation arbitration failed; falling through to CREATE",
      {
        emailAccountId: args.emailAccountId,
        messageId: args.messageId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return {
      outcome: "CREATED",
      matchedEventId: null,
      rescheduleOfEventId: null,
      arbiterErrorMessage: null,
    };
  }
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
      const classification = await getMessageClassification({
        emailAccountId,
        messageId,
      });
      // Hard skip: classifier already routed this to a clearly-non-calendar
      // category. Don't pay for Haiku or pollute the ReconciliationRecord
      // table with false-positive ledger rows.
      if (
        classification &&
        ((classification.systemType !== null &&
          NON_CALENDAR_SYSTEM_TYPES.has(classification.systemType)) ||
          NON_CALENDAR_RULE_NAMES.has(classification.name))
      ) {
        logger.info("reconcile_skip_classified_non_calendar", {
          emailAccountId,
          messageId,
          threadId,
        });
        return;
      }
      const isCalendar = classification?.systemType === "CALENDAR";
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

    // 4.5 Empty-startISO short-circuit. Haiku's schema (extract.ts:22-26)
    // explicitly permits `startISO === ""` to signal "no resolvable event."
    // The keyword backstop is lenient by design (e.g. `confirmation`,
    // `reminder`) and routinely accepts marketing / newsletter / receipt copy
    // that mentions those words — Haiku is the gatekeeper that says no.
    //
    // Without this guard the orchestrator routes such cases to outcome=CREATED
    // and calls `createCalendarEvent`, where `new Date(Date.parse("") + 1h)
    // .toISOString()` throws `RangeError: Invalid time value` (the symptom in
    // production logs). Persist a clean FAILED ledger row instead so we keep
    // visibility into backstop false-positives without crashing.
    if (!candidate.startISO) {
      logger.info("reconcile_route", {
        emailAccountId,
        messageId,
        threadId,
        outcome: "FAILED",
      });
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome: "FAILED", errorMessage: "no_resolvable_time" },
      });
      return;
    }

    // 5. Determine outcome (D-13). The Phase 11 flow replaces token-Dice with
    //    pure interval-overlap + arbitrate-if-overlap. Path A (.ics) is a
    //    deterministic CREATE per D-14 — iCalendar UIDs handle dedup upstream.
    let outcome: ReconciliationOutcome;
    let matchedEventId: string | null = null;
    let rescheduleOfEventId: string | null = null;
    let arbiterErrorMessage: string | null = null;

    if (!pathA) {
      const now = new Date();
      const upcoming = await getUpcomingEvents({
        emailAccountId,
        now,
        logger,
      }).catch(() => []);

      if (isAllDay) {
        // D-03 all-day branch.
        const allDay = decideAllDayOutcome({
          candidate: {
            title: candidate.title,
            startISO: candidate.startISO,
            isAllDay: true,
          },
          existingEvents: upcoming,
        });
        if (allDay.outcome === "CREATED") {
          outcome = "CREATED";
          logger.info("reconcile_route", {
            emailAccountId,
            messageId,
            threadId,
            outcome,
          });
        } else if (allDay.outcome === "MATCHED") {
          // Forward-compat: decideAllDayOutcome does not produce MATCHED today,
          // but the type permits it. Honor it as a no-Google MATCHED.
          outcome = "MATCHED";
          matchedEventId = allDay.matchedEventId;
          logger.info("reconcile_route", {
            emailAccountId,
            messageId,
            threadId,
            outcome,
          });
        } else {
          // NEEDS_ARBITRATION — hand off to Haiku over the same-date schedule.
          const verdict = await runArbitrationOrFallback({
            email: { subject, from: senderEmail, bodyTruncated },
            candidate: {
              title: candidate.title,
              startISO: candidate.startISO,
              endISO: candidate.endISO,
              location: candidate.location,
            },
            daySchedule: allDay.sameDateEvents,
            emailAccount,
            logger,
            emailAccountId,
            messageId,
          });
          ({
            outcome,
            matchedEventId,
            rescheduleOfEventId,
            arbiterErrorMessage,
          } = verdict);
          logger.info("reconcile_route", {
            emailAccountId,
            messageId,
            threadId,
            outcome,
            verdict: verdict.outcome,
            dayScheduleCount: allDay.sameDateEvents.length,
          });
        }
      } else {
        // D-01/D-02 timed branch — pure interval intersection.
        // (candidate.startISO is guaranteed non-empty by the 4.5 guard above.)
        const overlaps = findIntervalOverlaps({
          candidateStartISO: candidate.startISO,
          candidateEndISO: candidate.endISO,
          existingEvents: upcoming,
        });
        if (overlaps.length === 0) {
          outcome = "CREATED";
          logger.info("reconcile_route", {
            emailAccountId,
            messageId,
            threadId,
            outcome,
          });
        } else {
          // D-07: send Haiku the FULL day schedule, not just the overlapping
          // events. Include candidate's start AND end dates in case the
          // candidate spans midnight.
          const overlapDates = new Set(
            overlaps.map((e) => e.start.slice(0, 10)),
          );
          overlapDates.add(candidate.startISO.slice(0, 10));
          if (candidate.endISO) {
            overlapDates.add(candidate.endISO.slice(0, 10));
          }
          const daySchedule = upcoming.filter((e) =>
            overlapDates.has(e.start.slice(0, 10)),
          );

          const verdict = await runArbitrationOrFallback({
            email: { subject, from: senderEmail, bodyTruncated },
            candidate: {
              title: candidate.title,
              startISO: candidate.startISO,
              endISO: candidate.endISO,
              location: candidate.location,
            },
            daySchedule,
            emailAccount,
            logger,
            emailAccountId,
            messageId,
          });
          ({
            outcome,
            matchedEventId,
            rescheduleOfEventId,
            arbiterErrorMessage,
          } = verdict);
          logger.info("reconcile_route", {
            emailAccountId,
            messageId,
            threadId,
            outcome,
            verdict: verdict.outcome,
            dayScheduleCount: daySchedule.length,
          });
        }
      }
    } else {
      // pathA (.ics) — Phase 9 deterministic CREATE path (D-14). iCal UID
      // handles dedup upstream; no overlap-or-arbitrate work needed.
      outcome = "CREATED";
      logger.info("reconcile_route", {
        emailAccountId,
        messageId,
        threadId,
        outcome,
      });
    }

    // 6. Act on outcome.
    if (outcome === "MATCHED") {
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome: "MATCHED", googleEventId: matchedEventId },
      });
      return;
    }
    if (outcome === "FAILED") {
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome: "FAILED", errorMessage: arbiterErrorMessage },
      });
      return;
    }

    // CREATED or RESCHEDULE → both insert a new Google event first.
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

    if (!inserted.ok) {
      // Insert failed — persist FAILED. For RESCHEDULE we do NOT patch the
      // old event because we have no new htmlLink to point to.
      await updateReconciliationRecord({
        id: recordId,
        data: { outcome: "FAILED", errorMessage: inserted.reason },
      });
      return;
    }

    if (outcome === "RESCHEDULE" && rescheduleOfEventId) {
      // D-09: non-destructive annotation on the old event. patchEventDescription
      // owns the leading-newline separator — we pass the raw note text.
      const patchResult = await patchEventDescription({
        input: {
          emailAccountId,
          eventId: rescheduleOfEventId,
          appendText: `[Possibly rescheduled? See ${inserted.googleEventHtmlLink}]`,
        },
        logger,
      });
      await updateReconciliationRecord({
        id: recordId,
        data: {
          outcome: "RESCHEDULE",
          googleEventId: inserted.googleEventId,
          googleEventHtmlLink: inserted.googleEventHtmlLink,
          rescheduleOfEventId,
          errorMessage: patchResult.ok
            ? null
            : `patch_failed:${patchResult.reason}`,
        },
      });
      return;
    }

    await updateReconciliationRecord({
      id: recordId,
      data: {
        outcome: "CREATED",
        googleEventId: inserted.googleEventId,
        googleEventHtmlLink: inserted.googleEventHtmlLink,
      },
    });
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
