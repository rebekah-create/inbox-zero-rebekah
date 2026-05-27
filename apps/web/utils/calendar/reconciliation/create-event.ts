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

export type PatchEventDescriptionResult =
  | { ok: true }
  | { ok: false; reason: "no-connection" | "api-error" | "event-not-found" };

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

/**
 * Non-destructive event annotation for the RESCHEDULE outcome (D-09).
 *
 * NEVER modifies start, end, summary, location, or attendees — only appends
 * to the existing description. Google Calendar `events.patch` is a partial
 * update, so omitting those fields leaves them untouched on the server.
 *
 * Idempotent on retry: if the existing description already contains the
 * exact `appendText` verbatim, the patch is skipped and `{ ok: true }` is
 * returned without a second write.
 *
 * Logging discipline T-09-05: only emits structured fields
 * `{ emailAccountId, eventId, error }`. Never logs the existing description,
 * the appended text, the event title, or any other event payload.
 *
 * Failure isolation per OPS-01: caller is the reconciliation orchestrator
 * which expects this function never to throw — all paths return a Result.
 */
export async function patchEventDescription({
  input,
  logger,
}: {
  input: {
    emailAccountId: string;
    eventId: string;
    appendText: string;
  };
  logger: Logger;
}): Promise<PatchEventDescriptionResult> {
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

  // Narrow Date | bigint | number | null → number | null (mirrors createCalendarEvent WR-03).
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

  let existingDescription: string | null | undefined;
  try {
    const fetched = await client.events.get({
      calendarId: "primary",
      eventId: input.eventId,
    });
    existingDescription = fetched.data?.description ?? null;
  } catch (error) {
    const err = error as {
      code?: number | string;
      response?: { status?: number };
    };
    const status =
      typeof err?.response?.status === "number" ? err.response.status : null;
    const code =
      typeof err?.code === "number"
        ? err.code
        : typeof err?.code === "string"
          ? Number.parseInt(err.code, 10)
          : null;
    if (status === 404 || code === 404) {
      logger.warn("Calendar event not found for patch", {
        emailAccountId: input.emailAccountId,
        eventId: input.eventId,
      });
      return { ok: false, reason: "event-not-found" };
    }
    logger.error("Failed to fetch Google calendar event for patch", {
      emailAccountId: input.emailAccountId,
      eventId: input.eventId,
      error,
    });
    return { ok: false, reason: "api-error" };
  }

  // Idempotency: if append text is already present verbatim, skip the patch.
  if (
    typeof existingDescription === "string" &&
    existingDescription.includes(input.appendText)
  ) {
    return { ok: true };
  }

  const base =
    typeof existingDescription === "string" && existingDescription.length > 0
      ? existingDescription
      : "";
  const newDescription =
    base.length > 0 ? `${base}\n\n${input.appendText}` : input.appendText;

  try {
    await client.events.patch({
      calendarId: "primary",
      eventId: input.eventId,
      requestBody: {
        description: newDescription,
      },
    });
    return { ok: true };
  } catch (error) {
    logger.error("Failed to patch Google calendar event description", {
      emailAccountId: input.emailAccountId,
      eventId: input.eventId,
      error,
    });
    return { ok: false, reason: "api-error" };
  }
}
