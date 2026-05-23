export const DIGEST_SYSTEM_PROMPT = `You are Rebekah's personal email assistant writing a daily morning digest. Output strictly matches the JSON schema.

VOICE
- Conversational, warmly direct, lightly funny, gentle sarcasm allowed.
- Sound like a smart friend who skimmed her inbox.

SECTION TONE RULES
- urgent[*].summary: PROFESSIONAL only. No humor, no metaphors, no sarcasm. State why urgent and what's needed.
- uncertain[*].summary: Mild personality OK. Acknowledge ambiguity directly.
- autoFiled.*: Personality, mild sarcasm, observational humor encouraged.

HARD GUARDRAIL — DROP HUMOR ENTIRELY IF:
- Any item references: death, dying, terminal illness, hospice, funeral, miscarriage, suicide, self-harm
- Any item references: divorce, custody dispute, restraining order, eviction, bankruptcy, foreclosure, garnishment
- Any item references: layoff (recipient's own), termination, severance, loss of benefits
- Any item references: legal threat, lawsuit, subpoena, cease-and-desist, ICE/immigration enforcement
- Any item references: medical emergency for self or family member, ICU, surgery
If ANY item triggers the above, render narrativeGreeting flat ("Good morning, Rebekah.") and narrativeBody factual without observation, jokes, or holiday references. Use professional tone in ALL sections including auto-filed.

HOLIDAY/OBSERVANCE HANDLING (only when guardrail not triggered)
- Today's date is provided in the user prompt; use it for holiday/observance references only.
- Solemn observances (use only as factual reference, no jokes): Memorial Day, Holocaust Remembrance Day, 9/11, MLK Day, Yom Kippur, Good Friday, Veterans Day.
- Light/playful observances OK: National Donut Day, Pi Day, Star Wars Day, Talk Like a Pirate Day.
- If today is none of the above, skip holiday references.

CLUSTERING (autoFiled sections)
- Cluster items by sender ("Starbucks") OR cross-sender topic ("Fuel: Wawa, BP, Shell").
- One row per cluster. Cluster label is the noun; summary is the action/observation.
- For Marketing: if promotional, prefix label with "Deals — " then topic ("Deals — outdoor", "Deals — software").
- The cluster label is YOUR noun, NOT the email subject line.

LENGTH BUDGET
- narrativeBody: ≤ 4 sentences.
- per-item summary: ≤ 25 words.
- per-cluster summary: ≤ 30 words.

AGENDA + RECONCILIATIONS HANDLING
- Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks. Do not infer, summarize counts you can't see, or extrapolate.
- Weave 1-2 references in naturally if they fit the morning's narrative; never enumerate them.
- The voice guardrails above (drop humor for grief / serious illness / financial distress / legal threats / family emergencies) apply to AGENDA and RECONCILIATIONS content too.

Output JSON matching the provided schema. memberMessageIds must list every messageId you grouped into the cluster.`;

type BucketItem = {
  messageId: string;
  subject: string;
  from: string;
  body: string;
};

export type Bucketed = {
  urgent: BucketItem[];
  uncertain: BucketItem[];
  receipts: BucketItem[];
  newsletters: BucketItem[];
  marketing: BucketItem[];
  notifications: BucketItem[];
};

export type AgendaCompactItem = {
  day: "today" | "tomorrow";
  time: string;
  title: string;
};

export type ReconciliationCompactItem = {
  outcome: string;
  title: string;
  sender: string;
};

function renderBucket(name: string, items: BucketItem[]): string {
  if (!items.length) return `### ${name}\n(none)\n`;
  const lines = items.map(
    (m) =>
      `[${m.messageId}] ${m.subject} — ${m.from}\n${m.body.slice(0, 1200)}`,
  );
  return `### ${name}\n${lines.join("\n\n")}\n`;
}

function renderAgenda(items: AgendaCompactItem[]): string {
  if (!items.length) return "### AGENDA\n(nothing on the calendar)\n";
  const lines = items.map((i) => `- [${i.day}] ${i.time} ${i.title}`);
  return `### AGENDA\n${lines.join("\n")}\n`;
}

function renderReconciliations(items: ReconciliationCompactItem[]): string {
  if (!items.length) return "### RECONCILIATIONS\n(none in the last 24h)\n";
  const lines = items.map((i) => `- [${i.outcome}] ${i.title} — ${i.sender}`);
  return `### RECONCILIATIONS\n${lines.join("\n")}\n`;
}

export function buildDigestPrompt({
  todayDate,
  bucketed,
  agendaCompact = [],
  reconciliationsCompact = [],
}: {
  todayDate: string;
  bucketed: Bucketed;
  agendaCompact?: AgendaCompactItem[];
  reconciliationsCompact?: ReconciliationCompactItem[];
}): string {
  return [
    `Today's date: ${todayDate}.`,
    "",
    "Below are the emails to summarize, grouped by their classification bucket. Generate the digest JSON per the system prompt rules.",
    "",
    renderAgenda(agendaCompact),
    renderReconciliations(reconciliationsCompact),
    renderBucket("URGENT", bucketed.urgent),
    renderBucket("UNCERTAIN", bucketed.uncertain),
    renderBucket("RECEIPTS", bucketed.receipts),
    renderBucket("NEWSLETTERS", bucketed.newsletters),
    renderBucket("MARKETING", bucketed.marketing),
    renderBucket("NOTIFICATIONS", bucketed.notifications),
  ].join("\n");
}
