/**
 * Whitespace-token Dice coefficient title similarity.
 *
 * Phase 9 reconciliation contract (see 09-RESEARCH.md §6 / 09-CONTEXT.md D-07).
 * Returns 0..1 where 1.0 is an exact token-set match.
 *
 * - Token boundary is whitespace only (not character bigrams like
 *   `string-similarity`). Treating "Dr Jones" vs "Dr Smith" as a near-match
 *   for character bigrams produces false positives across unrelated names; the
 *   token form is far stricter and matches how humans see appointment titles.
 * - Empty/empty returns 1 (both vacuous), empty/non-empty returns 0.
 * - Case-insensitive; collapses runs of whitespace.
 *
 * This module is pure — no I/O, no imports outside this file.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    s.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}
