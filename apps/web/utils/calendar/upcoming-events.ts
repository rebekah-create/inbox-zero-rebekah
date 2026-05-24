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
 *   4. Load enabled Calendar rows for the connection. Each row holds a
 *      Google calendarId synced at OAuth time. Call client.events.list for
 *      every enabled calendar in parallel (preserves responseStatus +
 *      all-day flag — do NOT route through GoogleCalendarEventProvider,
 *      see plan note). If a single calendar's API call fails, log and skip
 *      it; other calendars still contribute.
 *   5. If no Calendar rows exist (legacy connection that predates sync),
 *      fall back to a single `calendarId: "primary"` call so the digest
 *      still works.
 *   6. Concatenate items across calendars, filter declined/tentative via
 *      isExcluded, map through normalize, dedupe by event id.
 *   7. Write envelope to Redis with 24h hard TTL (best-effort).
 *   8. Return pastPrune(normalized, now).
 *   9. On any live-fetch failure (auth / network / all calendars failed):
 *      if envelope present, return pruned stale data; otherwise return [].
 *      Always logger.warn with structured fields only (never include event
 *      titles, descriptions, attendees, tokens — see D-11 and threat T-08-03).
 */

export const UPCOMING_EVENTS_CACHE_PREFIX = "calendar:events:";
const FRESH_MS = 15 * 60 * 1000; // D-05 soft expiry
const HARD_TTL_S = 24 * 60 * 60; // 24h hard TTL — stale-fallback window
const LOOKAHEAD_DAYS = 7;
const MAX_RESULTS_PER_CALENDAR = 250;

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

    // WR-03: Narrow explicitly. Prisma returns Date for DateTime cols, but the
    // schema could move to BigInt (a common token-expiry storage choice). An
    // unchecked `as number | null` cast would pass a BigInt straight through
    // to getCalendarClientWithRefresh and break arithmetic at the call site.
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
      emailAccountId,
      connectionId: connection.id,
      logger,
    });

    // Enabled calendars synced at OAuth time. Legacy connections (pre-sync)
    // have zero rows here; fall back to `primary` so the digest still works.
    const enabledCalendars = await prisma.calendar.findMany({
      where: { connectionId: connection.id, isEnabled: true },
      select: { calendarId: true },
    });
    const calendarIds =
      enabledCalendars.length > 0
        ? enabledCalendars.map((c) => c.calendarId)
        : ["primary"];

    const timeMin = now.toISOString();
    const timeMax = addDays(now, LOOKAHEAD_DAYS).toISOString();

    const perCalendarResults = await Promise.all(
      calendarIds.map(async (calendarId) => {
        try {
          const response = await client.events.list({
            calendarId,
            timeMin,
            timeMax,
            maxResults: MAX_RESULTS_PER_CALENDAR,
            singleEvents: true,
            orderBy: "startTime",
          });
          return {
            ok: true as const,
            items: response.data.items ?? [],
          };
        } catch (err) {
          // One calendar failing must not blank the whole digest. The
          // calendarId itself is fine to log (it's not a secret — it's the
          // group address Google issues). Surface count of failures back to
          // the caller to decide stale-fallback behavior.
          logger.warn("Calendar events.list failed for one calendar", {
            emailAccountId,
            calendarId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false as const, items: [] };
        }
      }),
    );

    const anySucceeded = perCalendarResults.some((r) => r.ok);
    if (!anySucceeded && calendarIds.length > 0) {
      // Every calendar call failed. Treat as a live-fetch failure so the
      // outer catch's stale-fallback path runs, instead of caching an empty
      // envelope and overwriting good stale data.
      throw new Error("All calendar events.list calls failed");
    }

    const mergedItems = perCalendarResults.flatMap((r) => r.items);

    const seen = new Set<string>();
    const normalized: NormalizedCalendarEvent[] = [];
    for (const event of mergedItems) {
      if (!hasStartAndEnd(event) || isExcluded(event)) continue;
      const n = normalize(event);
      if (!n.id || seen.has(n.id)) continue;
      seen.add(n.id);
      normalized.push(n);
    }

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
