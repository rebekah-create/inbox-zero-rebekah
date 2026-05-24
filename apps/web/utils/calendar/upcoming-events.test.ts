import type { calendar_v3 } from "@googleapis/calendar";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before the SUT import (vi.mock is hoisted, but explicit ordering helps readers).
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    calendarConnection: {
      findFirst: vi.fn(),
    },
    calendar: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/utils/calendar/client", () => ({
  getCalendarClientWithRefresh: vi.fn(),
}));

import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import type { Logger } from "@/utils/logger";
import {
  getUpcomingEvents,
  UPCOMING_EVENTS_CACHE_PREFIX,
} from "./upcoming-events";
import type { CalendarCacheEnvelope } from "./upcoming-events-types";

const EMAIL_ACCOUNT_ID = "acct_test";
const NOW = new Date("2026-05-22T12:00:00-04:00"); // fixed reference instant
const NOW_MS = NOW.getTime();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function makeMockLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeEvent({
  id = "evt-1",
  summary = "Sample event",
  isAllDay = false,
  selfResponse,
  startOffsetMin = 60, // 1 hour from NOW by default → future
  endOffsetMin = 120,
  attendees,
  description,
  location,
}: {
  id?: string;
  summary?: string;
  isAllDay?: boolean;
  selfResponse?: "accepted" | "declined" | "tentative" | "needsAction";
  startOffsetMin?: number;
  endOffsetMin?: number;
  attendees?: calendar_v3.Schema$EventAttendee[];
  description?: string;
  location?: string;
}): calendar_v3.Schema$Event {
  if (isAllDay) {
    // For all-day, ignore offsets and pick a future date.
    return {
      id,
      summary,
      htmlLink: `https://calendar.google.com/${id}`,
      start: { date: "2026-05-25" },
      end: { date: "2026-05-26" },
      attendees,
      description,
      location,
    };
  }
  const startISO = new Date(NOW_MS + startOffsetMin * 60_000).toISOString();
  const endISO = new Date(NOW_MS + endOffsetMin * 60_000).toISOString();
  let attendeesFinal = attendees;
  if (!attendeesFinal && selfResponse) {
    attendeesFinal = [
      { self: true, email: "owner@test.com", responseStatus: selfResponse },
    ];
  }
  return {
    id,
    summary,
    htmlLink: `https://calendar.google.com/${id}`,
    start: { dateTime: startISO, timeZone: "America/New_York" },
    end: { dateTime: endISO, timeZone: "America/New_York" },
    attendees: attendeesFinal,
    description,
    location,
  };
}

function makeConnectionRow() {
  return {
    id: "conn_1",
    accessToken: "tok",
    refreshToken: "refresh",
    expiresAt: NOW_MS + 60 * 60 * 1000,
  };
}

function makeEventsListMock(events: calendar_v3.Schema$Event[]) {
  return vi.fn().mockResolvedValue({ data: { items: events } });
}

function mockCalendarClient(events: calendar_v3.Schema$Event[]) {
  const listMock = makeEventsListMock(events);
  vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
    events: { list: listMock },
  } as unknown as calendar_v3.Calendar);
  return listMock;
}

describe("getUpcomingEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: cache miss, connection present, calendar empty.
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue("OK" as any);
    vi.mocked(prisma.calendarConnection.findFirst).mockResolvedValue(
      makeConnectionRow() as any,
    );
    // Default: no Calendar rows → falls back to ["primary"], preserving the
    // legacy single-calendar behavior the bulk of these tests assert.
    vi.mocked(prisma.calendar.findMany).mockResolvedValue([] as any);
  });

  // Test 1
  it("returns normalized D-02 shape on cache miss (no Google fields leak)", async () => {
    mockCalendarClient([
      makeEvent({ id: "e1", summary: "Standup", selfResponse: "accepted" }),
      makeEvent({ id: "e2", isAllDay: true, summary: "Holiday" }),
    ]);
    const logger = makeMockLogger();
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "e1",
      title: "Standup",
      isAllDay: false,
    });
    // Confirm absent Google fields
    expect(result[0]).not.toHaveProperty("attendeesResponseStatus");
    expect(result[0]).not.toHaveProperty("organizer");
  });

  // Test 2
  it("calls client.events.list with exact required params", async () => {
    const listMock = mockCalendarClient([]);
    await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: NOW.toISOString(),
      timeMax: new Date(NOW_MS + SEVEN_DAYS_MS).toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: "startTime",
    });
  });

  // Test 3
  it("excludes declined events", async () => {
    mockCalendarClient([
      makeEvent({ id: "yes", selfResponse: "accepted" }),
      makeEvent({ id: "no", selfResponse: "declined" }),
    ]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["yes"]);
  });

  // Test 4
  it("excludes tentative events", async () => {
    mockCalendarClient([
      makeEvent({ id: "yes", selfResponse: "accepted" }),
      makeEvent({ id: "maybe", selfResponse: "tentative" }),
    ]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["yes"]);
  });

  // Test 5
  it("keeps owner-created events (no attendees array)", async () => {
    mockCalendarClient([makeEvent({ id: "solo", attendees: undefined })]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["solo"]);
  });

  // Test 6
  it("keeps accepted and needsAction events", async () => {
    mockCalendarClient([
      makeEvent({ id: "a", selfResponse: "accepted" }),
      makeEvent({ id: "n", selfResponse: "needsAction" }),
    ]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id).sort()).toEqual(["a", "n"]);
  });

  // Test 7
  it("surfaces all-day events with YYYY-MM-DD strings and isAllDay=true", async () => {
    mockCalendarClient([
      makeEvent({ id: "ad", isAllDay: true, summary: "All-day" }),
    ]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result[0]).toMatchObject({
      start: "2026-05-25",
      end: "2026-05-26",
      isAllDay: true,
    });
  });

  // Test 8
  it("fresh cache hit (within 15 min) skips Google call", async () => {
    const envelope: CalendarCacheEnvelope = {
      data: [
        {
          id: "cached",
          title: "Cached",
          start: new Date(NOW_MS + 30 * 60_000).toISOString(),
          end: new Date(NOW_MS + 60 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          htmlLink: "",
        },
      ],
      fetchedAt: NOW_MS - 10 * 60 * 1000, // 10 minutes ago (fresh)
    };
    vi.mocked(redis.get).mockResolvedValue(envelope as any);
    const listMock = mockCalendarClient([]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(result.map((e) => e.id)).toEqual(["cached"]);
  });

  // Test 9
  it("reads from cache key calendar:events:acct_test", async () => {
    mockCalendarClient([]);
    await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(redis.get).toHaveBeenCalledWith("calendar:events:acct_test");
    expect(UPCOMING_EVENTS_CACHE_PREFIX).toBe("calendar:events:");
  });

  // Test 10
  it("returns stale envelope on API failure when within hard TTL and logs warn once", async () => {
    const staleEnvelope: CalendarCacheEnvelope = {
      data: [
        {
          id: "stale-future",
          title: "Stale future",
          start: new Date(NOW_MS + 60 * 60_000).toISOString(),
          end: new Date(NOW_MS + 90 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          htmlLink: "",
        },
      ],
      fetchedAt: NOW_MS - 20 * 60 * 1000, // older than 15 min, fresh-stale
    };
    vi.mocked(redis.get).mockResolvedValue(staleEnvelope as any);
    vi.mocked(getCalendarClientWithRefresh).mockRejectedValue(
      new Error("Google blew up"),
    );
    const logger = makeMockLogger();
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });
    expect(result.map((e) => e.id)).toEqual(["stale-future"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // Test 11
  it("returns [] and warns when no envelope present and API fails", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(getCalendarClientWithRefresh).mockRejectedValue(
      new Error("token refresh failed"),
    );
    const logger = makeMockLogger();
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // Test 12
  it("prunes past events on fresh fetch", async () => {
    mockCalendarClient([
      makeEvent({
        id: "past",
        startOffsetMin: -120,
        endOffsetMin: -60,
        selfResponse: "accepted",
      }),
      makeEvent({ id: "future", selfResponse: "accepted" }),
    ]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["future"]);
  });

  // Test 13
  it("prunes past events on stale fallback", async () => {
    const envelope: CalendarCacheEnvelope = {
      data: [
        {
          id: "past",
          title: "past",
          start: new Date(NOW_MS - 120 * 60_000).toISOString(),
          end: new Date(NOW_MS - 60 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          htmlLink: "",
        },
        {
          id: "future",
          title: "future",
          start: new Date(NOW_MS + 60 * 60_000).toISOString(),
          end: new Date(NOW_MS + 90 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          htmlLink: "",
        },
      ],
      fetchedAt: NOW_MS - 30 * 60 * 1000, // stale but within hard TTL
    };
    vi.mocked(redis.get).mockResolvedValue(envelope as any);
    vi.mocked(getCalendarClientWithRefresh).mockRejectedValue(
      new Error("API down"),
    );
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["future"]);
  });

  // Test 14
  it("returns [] and warns when no calendar connection exists; does not call calendar client", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(prisma.calendarConnection.findFirst).mockResolvedValue(null);
    const logger = makeMockLogger();
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    expect(getCalendarClientWithRefresh).not.toHaveBeenCalled();
  });

  // Test 15
  it("Redis down on read falls through to live fetch", async () => {
    vi.mocked(redis.get).mockRejectedValue(new Error("Upstash 500"));
    mockCalendarClient([makeEvent({ id: "ok", selfResponse: "accepted" })]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["ok"]);
  });

  // Test 16
  it("Redis down on write does not crash; result still returned", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockRejectedValue(new Error("Upstash 500"));
    mockCalendarClient([makeEvent({ id: "ok", selfResponse: "accepted" })]);
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["ok"]);
  });

  // Test 17 — log-leak guard
  it("logger.warn never receives full event body on stale fallback (SENSITIVE-LOG-MARKER)", async () => {
    const envelope: CalendarCacheEnvelope = {
      data: [
        {
          id: "leak",
          title: "SENSITIVE-LOG-MARKER",
          description: "SENSITIVE-LOG-MARKER body",
          start: new Date(NOW_MS + 60 * 60_000).toISOString(),
          end: new Date(NOW_MS + 90 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          attendees: ["someone@x.com"],
          htmlLink: "",
        },
      ],
      fetchedAt: NOW_MS - 20 * 60 * 1000,
    };
    vi.mocked(redis.get).mockResolvedValue(envelope as any);
    vi.mocked(getCalendarClientWithRefresh).mockRejectedValue(
      new Error("boom"),
    );
    const logger = makeMockLogger();
    await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });
    const serialized = JSON.stringify(
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(serialized).not.toContain("SENSITIVE-LOG-MARKER");
  });

  // Test 18 — thundering-herd shape (WR-04: honest assertion)
  //
  // The current implementation has NO in-flight dedupe / single-flight: each
  // concurrent cold read issues its own Google call. For the v1.1 personal-volume
  // use case (one user, one webhook at a time) this is acceptable per 08-CONTEXT.
  //
  // This test asserts the current behavior exactly (N concurrent cold reads = N
  // Google calls) so any future regression toward dedupe surfaces as a test
  // failure that has to be explicitly acknowledged. If dedupe is later added,
  // flip the assertion to .toBe(1).
  it("two concurrent cold reads issue exactly 2 Google calls (no single-flight today; WR-04)", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    const listMock = vi.fn(async () => {
      // Defer to next microtask so both invocations interleave.
      await Promise.resolve();
      return { data: { items: [] } };
    });
    vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
      events: { list: listMock },
    } as unknown as calendar_v3.Calendar);

    const logger = makeMockLogger();
    await Promise.all([
      getUpcomingEvents({
        emailAccountId: EMAIL_ACCOUNT_ID,
        now: NOW,
        logger,
      }),
      getUpcomingEvents({
        emailAccountId: EMAIL_ACCOUNT_ID,
        now: NOW,
        logger,
      }),
    ]);
    expect(listMock.mock.calls.length).toBe(2);
  });

  // Test 19 — multi-calendar fan-out (regression for the May 24 2026 digest
  // bug where Memorial Day [holidays calendar] and Ninja class [kids calendar]
  // were silently dropped because we only queried `primary`).
  it("fans out events.list across every enabled Calendar row for the connection", async () => {
    vi.mocked(prisma.calendar.findMany).mockResolvedValue([
      { calendarId: "primary" },
      { calendarId: "en.usa#holiday@group.v.calendar.google.com" },
      { calendarId: "kids-calendar-id@group.calendar.google.com" },
    ] as any);
    const listMock = vi
      .fn()
      .mockImplementation(async ({ calendarId }: { calendarId: string }) => {
        if (calendarId === "primary") {
          return {
            data: {
              items: [
                makeEvent({ id: "primary-evt", selfResponse: "accepted" }),
              ],
            },
          };
        }
        if (calendarId === "en.usa#holiday@group.v.calendar.google.com") {
          return {
            data: {
              items: [
                makeEvent({
                  id: "holiday-evt",
                  isAllDay: true,
                  summary: "Memorial Day",
                }),
              ],
            },
          };
        }
        if (calendarId === "kids-calendar-id@group.calendar.google.com") {
          return {
            data: {
              items: [
                makeEvent({
                  id: "kids-evt",
                  summary: "Ninja class",
                  selfResponse: "accepted",
                }),
              ],
            },
          };
        }
        return { data: { items: [] } };
      });
    vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
      events: { list: listMock },
    } as unknown as calendar_v3.Calendar);

    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });

    expect(listMock).toHaveBeenCalledTimes(3);
    expect(result.map((e) => e.id).sort()).toEqual([
      "holiday-evt",
      "kids-evt",
      "primary-evt",
    ]);
  });

  // Test 20 — one bad calendar must not blank the whole digest.
  it("returns events from healthy calendars when one calendar's events.list throws", async () => {
    vi.mocked(prisma.calendar.findMany).mockResolvedValue([
      { calendarId: "primary" },
      { calendarId: "broken@group.calendar.google.com" },
    ] as any);
    const listMock = vi
      .fn()
      .mockImplementation(async ({ calendarId }: { calendarId: string }) => {
        if (calendarId === "broken@group.calendar.google.com") {
          throw new Error("Google 403 on this calendar");
        }
        return {
          data: {
            items: [makeEvent({ id: "ok", selfResponse: "accepted" })],
          },
        };
      });
    vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
      events: { list: listMock },
    } as unknown as calendar_v3.Calendar);

    const logger = makeMockLogger();
    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger,
    });

    expect(result.map((e) => e.id)).toEqual(["ok"]);
    // One per-calendar warn for the failure; no top-level warn.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // Test 21 — when EVERY calendar throws, fall through to the stale envelope
  // instead of caching an empty result.
  it("falls back to stale envelope when every enabled calendar's events.list throws", async () => {
    vi.mocked(prisma.calendar.findMany).mockResolvedValue([
      { calendarId: "a@group.calendar.google.com" },
      { calendarId: "b@group.calendar.google.com" },
    ] as any);
    const staleEnvelope: CalendarCacheEnvelope = {
      data: [
        {
          id: "stale-future",
          title: "Stale future",
          start: new Date(NOW_MS + 60 * 60_000).toISOString(),
          end: new Date(NOW_MS + 90 * 60_000).toISOString(),
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          htmlLink: "",
        },
      ],
      fetchedAt: NOW_MS - 20 * 60 * 1000,
    };
    vi.mocked(redis.get).mockResolvedValue(staleEnvelope as any);
    const listMock = vi.fn().mockRejectedValue(new Error("Google down"));
    vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
      events: { list: listMock },
    } as unknown as calendar_v3.Calendar);

    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["stale-future"]);
    // Crucially: the empty result was NOT written to cache.
    expect(redis.set).not.toHaveBeenCalled();
  });

  // Test 22 — dedupe across calendars (defensive — Google IDs are
  // calendar-scoped, but shared/imported calendars can produce duplicates).
  it("dedupes events by id when the same id appears across calendars", async () => {
    vi.mocked(prisma.calendar.findMany).mockResolvedValue([
      { calendarId: "a@group.calendar.google.com" },
      { calendarId: "b@group.calendar.google.com" },
    ] as any);
    const listMock = vi.fn().mockImplementation(async () => ({
      data: {
        items: [makeEvent({ id: "shared", selfResponse: "accepted" })],
      },
    }));
    vi.mocked(getCalendarClientWithRefresh).mockResolvedValue({
      events: { list: listMock },
    } as unknown as calendar_v3.Calendar);

    const result = await getUpcomingEvents({
      emailAccountId: EMAIL_ACCOUNT_ID,
      now: NOW,
      logger: makeMockLogger(),
    });
    expect(result.map((e) => e.id)).toEqual(["shared"]);
  });
});
