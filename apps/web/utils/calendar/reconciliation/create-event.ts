import prisma from "@/utils/prisma";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import type { Logger } from "@/utils/logger";

/**
 * Phase 9 wave-2 Google Calendar `events.insert` wrapper.
 *
 * Auto-creates a calendar event from a candidate extracted from an email.
 *
 * Discipline (see 09-CONTEXT.md):
 *   - D-17: summary is prefixed with "[AI] " so AI-created events are spottable.
 *   - D-18: description includes a Gmail deep link + Message-ID back-ref.
 *   - D-08: all-day events use { date: "YYYY-MM-DD" }; timed use { dateTime, timeZone }.
 *   - T-09-05: logger payloads never include event title/description/location/summary.
 *   - T-09-06: emailAccountId is passed explicitly to getCalendarClientWithRefresh.
 *   - v1.1 scope: calendarId is "primary" only; no attendees (no outbound invites).
 *
 * Calls `client.events.insert` directly (per CONTEXT.md `<canonical_refs>`:
 * the legacy provider wrapper is reference-only and must not be routed through).
 */

export type CreateCalendarEventInput = {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  senderEmail: string;
  timezone: string;
  candidate: {
    title: string;
    startISO: string;
    endISO: string | null;
    location: string | null;
    isAllDay: boolean;
  };
};

export type CreateCalendarEventResult =
  | { ok: true; googleEventId: string; googleEventHtmlLink: string }
  | { ok: false; reason: "no-connection" | "api-error" };

export function buildBackRefDescription({
  threadId,
  senderEmail,
  messageId,
}: {
  threadId: string;
  senderEmail: string;
  messageId: string;
}): string {
  return `Auto-created by inbox.tdfurn.com from email:
https://mail.google.com/mail/u/0/#inbox/${threadId}

(Source: ${senderEmail} • Message-ID: ${messageId})`;
}

function nextDayDateString(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function createCalendarEvent({
  input,
  logger,
}: {
  input: CreateCalendarEventInput;
  logger: Logger;
}): Promise<CreateCalendarEventResult> {
  const connection = await prisma.calendarConnection.findFirst({
    where: {
      emailAccountId: input.emailAccountId,
      provider: "google",
      isConnected: true,
    },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });

  if (!connection) {
    logger.warn("No Google calendar connection found", {
      emailAccountId: input.emailAccountId,
    });
    return { ok: false, reason: "no-connection" };
  }

  // Narrow Date | bigint | number | null → number | null (mirrors upcoming-events.ts WR-03).
  const rawExpiresAt: unknown = connection.expiresAt;
  const expiresAtMs: number | null =
    rawExpiresAt instanceof Date
      ? rawExpiresAt.getTime()
      : typeof rawExpiresAt === "number"
        ? rawExpiresAt
        : typeof rawExpiresAt === "bigint"
          ? Number(rawExpiresAt)
          : null;

  const client = await getCalendarClientWithRefresh({
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: expiresAtMs,
    emailAccountId: input.emailAccountId,
    connectionId: connection.id,
    logger,
  });

  const { candidate, timezone } = input;
  let start: { date: string } | { dateTime: string; timeZone: string };
  let end: { date: string } | { dateTime: string; timeZone: string };

  if (candidate.isAllDay) {
    const startDate = candidate.startISO.slice(0, 10);
    start = { date: startDate };
    end = { date: nextDayDateString(startDate) };
  } else {
    start = { dateTime: candidate.startISO, timeZone: timezone };
    const endDateTime =
      candidate.endISO ??
      new Date(Date.parse(candidate.startISO) + 60 * 60 * 1000).toISOString();
    end = { dateTime: endDateTime, timeZone: timezone };
  }

  try {
    const inserted = await client.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: `[AI] ${candidate.title}`,
        description: buildBackRefDescription({
          threadId: input.threadId,
          senderEmail: input.senderEmail,
          messageId: input.messageId,
        }),
        location: candidate.location ?? undefined,
        start,
        end,
      },
    });

    const googleEventId = inserted.data?.id;
    const googleEventHtmlLink = inserted.data?.htmlLink;
    if (!googleEventId || !googleEventHtmlLink) {
      logger.error("events.insert returned no id/htmlLink", {
        emailAccountId: input.emailAccountId,
        messageId: input.messageId,
      });
      return { ok: false, reason: "api-error" };
    }
    return { ok: true, googleEventId, googleEventHtmlLink };
  } catch (error) {
    logger.error("Failed to create Google calendar event", {
      emailAccountId: input.emailAccountId,
      messageId: input.messageId,
      error,
    });
    return { ok: false, reason: "api-error" };
  }
}
