import { pickLinkTarget } from "./pick-link-target";
import { renderSentence } from "./render-sentence";
import type {
  CalendarActivityBlock,
  CalendarActivityOutcome,
  CalendarActivityRow,
} from "./types";

/**
 * D-11/D-12/D-14/D-16 Calendar Activity props builder (Phase 10).
 *
 * Composes Plan 10-02's pure helpers (renderSentence + pickLinkTarget) into the
 * CalendarActivityBlock that the React Email digest template (Plan 10-04) renders.
 *
 *  - Records with outcome === "AMBIGUOUS" -> `review`.
 *  - Records with outcome === "CREATED"   -> `added`.
 *  - Records with outcome === "MATCHED"   -> `confirmed`.
 *  - Records with outcome "FAILED" or "PENDING" are silently excluded (D-16) —
 *    those are internal/operational states and never appear in the digest body.
 *  - Within each group: ascending by extractedStart (D-14).
 *  - Returns null when all three groups are empty (D-12) so the renderer can
 *    hide the whole section.
 *
 * Sender resolution: senderMap.get(record.messageId) ?? record.messageId.
 * Plan 10-05's run-daily-digest builds the senderMap from a batched Gmail header
 * fetch; this builder treats whatever it receives as plain text.
 *
 * Pure helper — no Prisma client import (input is narrowed to a local interface
 * so future schema drift is caught at the call site, not here).
 */

/**
 * Local input shape — a narrow subset of Prisma's ReconciliationRecord. The
 * caller (Plan 10-05) maps `extractedIsAllDay ?? false` -> `isAllDay` here.
 *
 * Schema reminder (apps/web/prisma/schema.prisma lines 898-927):
 *   extractedTitle  String  (NOT NULL)
 *   extractedStart  DateTime (NOT NULL)
 *   extractedIsAllDay Boolean? @default(false)
 *   googleEventHtmlLink String?
 *   threadId        String
 *   messageId       String
 *   outcome         enum
 */
export interface ReconciliationInput {
  extractedStart: Date;
  extractedTitle: string;
  googleEventHtmlLink: string | null;
  id: string;
  isAllDay: boolean;
  messageId: string;
  outcome: string;
  threadId: string;
}

const SURFACE_OUTCOMES = new Set<string>(["MATCHED", "CREATED", "AMBIGUOUS"]);

export function buildCalendarActivity({
  records,
  senderMap,
}: {
  records: ReconciliationInput[];
  senderMap: Map<string, string>;
}): CalendarActivityBlock | null {
  // D-16: drop FAILED / PENDING / anything outside the surfaced enum.
  const surfaced = records.filter((r) => SURFACE_OUTCOMES.has(r.outcome));

  // Group by outcome.
  const review: ReconciliationInput[] = [];
  const added: ReconciliationInput[] = [];
  const confirmed: ReconciliationInput[] = [];
  for (const r of surfaced) {
    if (r.outcome === "AMBIGUOUS") review.push(r);
    else if (r.outcome === "CREATED") added.push(r);
    else if (r.outcome === "MATCHED") confirmed.push(r);
  }

  // D-14: sort each group ascending by extractedStart.
  const byStartAsc = (a: ReconciliationInput, b: ReconciliationInput): number =>
    a.extractedStart.getTime() - b.extractedStart.getTime();
  review.sort(byStartAsc);
  added.sort(byStartAsc);
  confirmed.sort(byStartAsc);

  const toRow = (r: ReconciliationInput): CalendarActivityRow => {
    const sender = senderMap.get(r.messageId) ?? r.messageId;
    return {
      sentence: renderSentence({
        outcome: r.outcome as CalendarActivityOutcome,
        sender,
        extractedTitle: r.extractedTitle,
        extractedStart: r.extractedStart,
        isAllDay: r.isAllDay,
      }),
      href: pickLinkTarget({
        outcome: r.outcome as CalendarActivityOutcome,
        googleEventHtmlLink: r.googleEventHtmlLink,
        threadId: r.threadId,
      }),
    };
  };

  const reviewRows = review.map(toRow);
  const addedRows = added.map(toRow);
  const confirmedRows = confirmed.map(toRow);

  // D-12: hide the whole section when all three groups are empty.
  if (
    reviewRows.length === 0 &&
    addedRows.length === 0 &&
    confirmedRows.length === 0
  ) {
    return null;
  }

  return {
    review: reviewRows,
    added: addedRows,
    confirmed: confirmedRows,
  };
}
