import type { CalendarActivityOutcome } from "./types";

/**
 * D-13 link-target selector for a Calendar Activity row.
 *
 * Rules:
 *  - MATCHED / CREATED / RESCHEDULE with a non-null `googleEventHtmlLink` ->
 *    return that link (deep-links into the user's Google Calendar event; for
 *    RESCHEDULE this is the newly-created event at the new time).
 *  - MATCHED / CREATED with a null `googleEventHtmlLink` (legacy row or upstream
 *    Google API hiccup) -> fall back to the Gmail thread URL. Failure isolation
 *    per D-13: never render a row without a working link.
 *  - AMBIGUOUS always returns the Gmail thread URL — no event was created, so
 *    `googleEventHtmlLink` is null by design; the email IS the review surface.
 *
 * T-10-03 mitigation: `threadId` is URL-encoded via `encodeURIComponent` before
 * being interpolated into the Gmail URL. Threading is a Google-trusted source,
 * but defense-in-depth keeps the URL well-formed if upstream ever changes shape.
 *
 * Pure helper — no Prisma, no Google client, no AI SDK.
 */
export function pickLinkTarget({
  outcome,
  googleEventHtmlLink,
  threadId,
}: {
  outcome: CalendarActivityOutcome;
  googleEventHtmlLink: string | null;
  threadId: string;
}): string {
  if (outcome !== "AMBIGUOUS" && googleEventHtmlLink) {
    return googleEventHtmlLink;
  }
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
}
