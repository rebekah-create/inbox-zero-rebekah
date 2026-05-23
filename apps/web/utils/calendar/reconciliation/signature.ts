import { createHash } from "node:crypto";

/**
 * Event signature for D-14 unique-constraint dedupe.
 *
 * IMMUTABLE CONTRACT — once merged, bumping the algorithm or the input shape
 * invalidates every signature row already in the database. The unique index on
 * the persisted column would still be enforced, but old rows would no longer
 * map to current input, so dedupe silently breaks for the historical window.
 * If a change is ever needed, plan a one-off backfill migration that
 * recomputes signatures under the new contract for all existing rows.
 *
 * Inputs:
 *  - title:    raw event title (may be untrimmed, mixed-case, multi-spaced)
 *  - startISO: RFC3339 timestamp (timed) OR "YYYY-MM-DD" (all-day)
 *
 * Output: lowercase hex sha256 of `${normalizeTitle(title)}|${startISO}`.
 *
 * Pure helper — no I/O, no third-party hashing deps (node:crypto only).
 * See 09-RESEARCH.md §E lines 629-645.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function eventSignature(title: string, startISO: string): string {
  return createHash("sha256")
    .update(`${normalizeTitle(title)}|${startISO}`)
    .digest("hex");
}
