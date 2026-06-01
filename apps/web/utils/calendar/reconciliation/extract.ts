import { z } from "zod";
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import { buildExtractionSystem } from "./extract-prompt";

/**
 * Zod 4 schema for the Haiku reconciliation extraction output.
 *
 * Flat object (D-13) — no nested objects, no discriminated unions. Every field
 * has `.describe()` so the schema is self-documenting to the model. Downstream
 * code branches on `isAllDay` for D-08 all-day matching — the model MUST set
 * it explicitly; we do NOT default it (`.describe()` only, no `.default()`).
 */
export const candidateEventSchema = z.object({
  title: z
    .string()
    .describe(
      "Event title as the sender described it. Do not add the '[AI]' prefix — that's added downstream.",
    ),
  startISO: z
    .string()
    .describe(
      "ISO 8601 with offset in the user's TZ. Empty string ONLY if no time is resolvable.",
    ),
  endISO: z
    .string()
    .nullable()
    .describe("End time ISO; null if the email did not specify one."),
  location: z
    .string()
    .nullable()
    .describe(
      "Physical address or video-conference link as literally written. null if absent.",
    ),
  attendees: z
    .array(z.string())
    .describe(
      "Email addresses literally present in the body. Empty array if none — do not invent.",
    ),
  // Intentionally NO .min/.max — Anthropic's structured-output validator rejects
  // numeric range constraints with "output_config.format.schema: For 'number'
  // type, properties maximum, minimum are not supported". The 0..1 contract is
  // documented in `.describe()` and enforced by the clamp at the call site.
  confidence: z
    .number()
    .describe(
      "Number between 0 and 1. 0 = body had no real event. 1 = unambiguous. ≤ 0.5 if uncertain.",
    ),
  isAllDay: z
    .boolean()
    .describe(
      "true when the email mentions a date without a time (e.g., 'school closed Monday', 'package arrives Thursday'). false when a specific time-of-day is given. Downstream code branches on this for D-08 — model MUST set explicitly.",
    ),
});

export type CandidateEvent = z.infer<typeof candidateEventSchema>;

/**
 * Call Haiku (economy tier) to extract a single CandidateEvent from a plain-text
 * email body. This is Phase 9's only LLM call (Path B). Path A (.ics) is handled
 * by `extractFromIcs` in `./ics-path.ts` deterministically — see T-09-02.
 *
 * Invariants:
 * - Goes through `getModel(emailAccount.user, "economy")` — Haiku only.
 * - Goes through `createGenerateObject` for OPS-02 cost tracking under
 *   `label: "Reconciliation extract"`.
 * - System prompt is cached via providerOptions on SystemModelMessage (sibling
 *   of content, not nested in a content-part array — Phase 8.5 pattern).
 * - User prompt wraps `email.bodyTruncated` in `<email_body_untrusted>` tags
 *   (D-04) and threads `promptHardening: { trust: "untrusted", level: "full" }`.
 * - `temperature: 0`, `maxOutputTokens: 400` set explicitly (T-09-04 cost cap).
 * - Body is assumed already capped at 2000 chars by the orchestrator (D-05).
 *
 * The `_logger` parameter is accepted for API symmetry with neighbouring helpers
 * but intentionally unused here — the orchestrator (plan 09-06) owns logging
 * with structured-fields-only discipline (T-09-05).
 */
export async function extractCandidateEvent({
  email,
  emailAccount,
  logger: _logger,
}: {
  email: { subject: string; from: string; bodyTruncated: string };
  emailAccount: EmailAccountWithAI;
  logger: Logger;
}): Promise<CandidateEvent> {
  const modelOptions = getModel(emailAccount.user, "economy");
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Reconciliation extract",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "full" },
  });

  const tz = emailAccount.timezone ?? "America/New_York";
  const system = buildExtractionSystem(tz);

  const prompt = `Sender: ${email.from}
Subject: ${email.subject}

<email_body_untrusted>
${email.bodyTruncated}
</email_body_untrusted>`;

  const result = await generateObject({
    ...modelOptions,
    system,
    prompt,
    schema: candidateEventSchema,
    temperature: 0,
    maxOutputTokens: 400,
  });

  // Clamp confidence to [0, 1]. The model is asked for that range via the
  // schema's `.describe()`, but the schema no longer enforces it (see comment
  // on `confidence` above). Downstream code in decideOutcome assumes the range.
  const rawConfidence = result.object.confidence;
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0;

  return { ...result.object, confidence };
}
