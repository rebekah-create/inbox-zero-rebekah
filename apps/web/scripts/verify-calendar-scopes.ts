// One-shot operator script. Run via: pnpm exec tsx apps/web/scripts/verify-calendar-scopes.ts.
// Read-only. Does not modify Postgres or Google state.
//
// Purpose: Soft-verify that the live `CalendarConnection` row's OAuth grant covers the
// scopes the code constants (`CALENDAR_SCOPES` in apps/web/utils/gmail/scopes.ts) expect.
// Phase 8 needs calendar.readonly; Phase 9 will need calendar.events. If the user consented
// before `calendar.events` was added, Phase 8 will work but Phase 9 will 403 on event
// creation. This script catches that drift NOW.
//
// Output prints only scope strings + verdict — never the raw accessToken / refreshToken
// (per threat T-08-09 mitigation).

import "dotenv/config";
import prisma from "@/utils/prisma";
import { CALENDAR_SCOPES } from "@/utils/gmail/scopes";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("verify-calendar-scopes");

async function main() {
  const conn = await prisma.calendarConnection.findFirst({
    where: { provider: "google", isConnected: true },
    select: {
      id: true,
      emailAccountId: true,
      email: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!conn) {
    console.log("NO ACTIVE GOOGLE CALENDAR CONNECTION FOUND");
    console.log(
      "CALENDAR_SCOPE_VERDICT: FAIL — no connection row to verify; re-consent required",
    );
    process.exit(2);
  }

  console.log("Connection found:");
  console.log(`  id:             ${conn.id}`);
  console.log(`  emailAccountId: ${conn.emailAccountId}`);
  console.log(`  email:          ${conn.email}`);
  console.log(`  createdAt:      ${conn.createdAt.toISOString()}`);
  console.log(`  updatedAt:      ${conn.updatedAt.toISOString()}`);
  console.log(`  expiresAt:      ${conn.expiresAt?.toISOString() ?? "null"}`);
  console.log(
    `  hasAccessToken: ${conn.accessToken ? "yes" : "no"}  hasRefreshToken: ${conn.refreshToken ? "yes" : "no"}`,
  );

  console.log("\nCode-expected CALENDAR_SCOPES:");
  for (const s of CALENDAR_SCOPES) console.log(`  - ${s}`);

  console.log(
    "\nNote: CalendarConnection schema does NOT store granted scopes — DB-side scope diff is N/A.",
  );
  console.log(
    "Treating Google `oauth2.tokeninfo` as the live source of truth for what was actually granted.",
  );

  // --- Live read probe: calendarList.list should succeed if calendar.readonly is granted.
  let liveReadOk = false;
  let liveReadStatus: string;
  let calendarClient: Awaited<
    ReturnType<typeof getCalendarClientWithRefresh>
  > | null = null;

  try {
    calendarClient = await getCalendarClientWithRefresh({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      expiresAt: conn.expiresAt?.getTime() ?? null,
      emailAccountId: conn.emailAccountId,
      connectionId: conn.id,
      logger,
    });
    const res = await calendarClient.calendarList.list({ maxResults: 1 });
    const count = res.data.items?.length ?? 0;
    liveReadOk = true;
    liveReadStatus = `LIVE_READ_OK (returned ${count} calendar entry)`;
  } catch (error) {
    const err = error as Error & { code?: number; status?: number };
    const status = err.code ?? err.status;
    if (status === 403) {
      liveReadStatus = `LIVE_READ_403_SCOPE_MISSING: ${err.message}`;
    } else if (status === 401) {
      liveReadStatus = `LIVE_READ_FAILED (401): ${err.message}`;
    } else {
      liveReadStatus = `LIVE_READ_FAILED: ${err.message}`;
    }
  }
  console.log(`\n${liveReadStatus}`);

  // --- Tokeninfo probe: source of truth for currently-granted scopes on the live token.
  let tokeninfoScopes: string[] = [];
  let tokeninfoOk = false;
  try {
    // Ask the OAuth client we just used for a fresh access token (auto-refreshes if needed).
    // We grab it indirectly by re-fetching the connection row, since getCalendarClientWithRefresh
    // persists any rotated token back to the DB.
    const fresh = await prisma.calendarConnection.findUnique({
      where: { id: conn.id },
      select: { accessToken: true },
    });
    const accessToken = fresh?.accessToken;
    if (!accessToken) {
      console.log("LIVE_TOKENINFO_SCOPES: <no access token to query>");
    } else {
      const resp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
          accessToken,
        )}`,
      );
      if (!resp.ok) {
        const body = await resp.text();
        console.log(
          `LIVE_TOKENINFO_FAILED: ${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`,
        );
      } else {
        const data = (await resp.json()) as { scope?: string };
        const scopeStr = (data.scope ?? "").trim();
        tokeninfoScopes = scopeStr.length ? scopeStr.split(/\s+/) : [];
        tokeninfoOk = true;
        console.log(`LIVE_TOKENINFO_SCOPES: ${scopeStr}`);
      }
    }
  } catch (error) {
    console.log(`LIVE_TOKENINFO_FAILED: ${(error as Error).message}`);
  }

  // --- Diff vs. code constants.
  const tokenSet = new Set(tokeninfoScopes);
  const expectedOnly = CALENDAR_SCOPES.filter((s) => !tokenSet.has(s));
  const extras = tokeninfoScopes.filter((s) => !CALENDAR_SCOPES.includes(s));

  console.log("\nDiff (code-expected vs. live token):");
  console.log(
    `  expected_only (in code constant, missing from live token): ${
      expectedOnly.length ? expectedOnly.join(", ") : "none"
    }`,
  );
  console.log(
    `  extras (granted on live token but not in code constant): ${
      extras.length ? extras.join(", ") : "none"
    }`,
  );

  // --- Verdict.
  const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
  const hasReadonly = tokenSet.has(READONLY_SCOPE);
  const hasEvents = tokenSet.has(EVENTS_SCOPE);

  let verdict: string;
  if (!tokeninfoOk) {
    verdict = liveReadOk
      ? "PARTIAL — phase 8 read works, but tokeninfo unavailable; cannot confirm phase 9 readiness"
      : "FAIL — live read failed and tokeninfo unavailable; re-consent required";
  } else if (liveReadOk && hasEvents) {
    verdict = "OK";
  } else if (liveReadOk && hasReadonly && !hasEvents) {
    verdict = "PARTIAL — phase 8 ok, phase 9 will 403 (calendar.events not granted)";
  } else {
    verdict = "FAIL — re-consent required";
  }

  console.log(`\nCALENDAR_SCOPE_VERDICT: ${verdict}`);
}

main()
  .catch((err) => {
    console.error("Script error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
