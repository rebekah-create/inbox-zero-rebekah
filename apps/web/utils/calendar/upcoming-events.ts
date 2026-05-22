import "server-only";
import { addDays } from "date-fns";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import type { Logger } from "@/utils/logger";
import type {
  CalendarCacheEnvelope,
  NormalizedCalendarEvent,
} from "./upcoming-events-types";
import {
  hasStartAndEnd,
  isExcluded,
  normalize,
  pastPrune,
} from "./upcoming-events-helpers";

/**
 * Phase 8 single read path for "what is on the user's calendar in the next 7 days?".
 *
 * Compose order (matches plan 08-02 <behavior>):
 *   1. Read Redis envelope (best-effort; tolerate outage).
 *   2. Fresh hit (< FRESH_MS old) → return cached, no Google call.
 *   3. Cache miss / stale → load CalendarConnection from Postgres.
 *   4. Call client.events.list directly (preserves responseStatus + all-day flag
 *      — do NOT route through GoogleCalendarEventProvider, see plan note).
 *   5. Filter declined/tentative via isExcluded; map raw events through normalize.
 *   6. Write envelope to Redis with 24h hard TTL (best-effort).
 *   7. Return pastPrune(normalized, now).
 *   8. On any live-fetch failure: if envelope present, return pruned stale data;
 *      otherwise return []. Always logger.warn with structured fields only
 *      (never include event titles, descriptions, attendees, tokens — see D-11
 *      and threat T-08-03).
 */

export const UPCOMING_EVENTS_CACHE_PREFIX = "calendar:events:";
const FRESH_MS = 15 * 60 * 1000; // D-05 soft expiry
const HARD_TTL_S = 24 * 60 * 60; // 24h hard TTL — stale-fallback window
const LOOKAHEAD_DAYS = 7;
const MAX_RESULTS = 250;

export async function getUpcomingEvents({
  emailAccountId,
  now,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  logger: Logger;
}): Promise<NormalizedCalendarEvent[]> {
  const key = `${UPCOMING_EVENTS_CACHE_PREFIX}${emailAccountId}`;

  let envelope: CalendarCacheEnvelope | null = null;
  try {
    envelope = await redis.get<CalendarCacheEnvelope>(key);
  } catch {
    // Redis read failure — fall through to live fetch. Match account-validation.ts pattern.
  }

  if (envelope && now.getTime() - envelope.fetchedAt < FRESH_MS) {
    return pastPrune(envelope.data, now);
  }

  try {
    const connection = await prisma.calendarConnection.findFirst({
      where: { emailAccountId, provider: "google", isConnected: true },
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    });

    if (!connection) {
      logger.warn("No Google calendar connection found", { emailAccountId });
      return envelope ? pastPrune(envelope.data, now) : [];
    }

    const expiresAtMs =
      connection.expiresAt instanceof Date
        ? connection.expiresAt.getTime()
        : (connection.expiresAt as number | null);

    const client = await getCalendarClientWithRefresh({
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt: expiresAtMs ?? null,
      emailAccountId,
      connectionId: connection.id,
      logger,
    });

    const response = await client.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: addDays(now, LOOKAHEAD_DAYS).toISOString(),
      maxResults: MAX_RESULTS,
      singleEvents: true,
      orderBy: "startTime",
    });

    const items = response.data.items ?? [];
    const normalized: NormalizedCalendarEvent[] = items
      .filter((event) => hasStartAndEnd(event) && !isExcluded(event))
      .map((event) => normalize(event));

    try {
      await redis.set(
        key,
        { data: normalized, fetchedAt: now.getTime() },
        { ex: HARD_TTL_S },
      );
    } catch {
      // Redis write failure — return the fresh result anyway.
    }

    return pastPrune(normalized, now);
  } catch (err) {
    // D-09 stale fallback. Structured fields only — no event bodies, no tokens.
    logger.warn("Calendar API fetch failed; falling back", {
      emailAccountId,
      hasStale: !!envelope,
      eventCountStale: envelope?.data.length ?? 0,
      error: err instanceof Error ? err.message : String(err),
    });
    if (envelope) return pastPrune(envelope.data, now);
    return [];
  }
}
