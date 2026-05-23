import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

// Phase 4 (Daily Digest) — visual template, static-data only.
// Design reference: .planning/phases/04-daily-digest/design-reference/digest-mockup.html
// Wiring to real DigestItem data + Sonnet narrative happens in plan-phase.
//
// Phase 10 — extends DigestV2Props with optional `agenda` and `calendarActivity`
// (see .planning/phases/10-digest-agenda-reconciliation-outcomes/). When both
// fields are absent the template renders the Phase 4 layout unchanged (D-03).
//
// AgendaBlock and CalendarActivityBlock are declared inline here (not imported
// from apps/web) because packages/resend has no path alias into apps/web and
// importing across workspace boundaries breaks the resend tsconfig rootDir.
// Plan 03 (`apps/web/utils/digest/{agenda,calendar-activity}/types.ts`) keeps
// the authoritative definitions; the shapes here are byte-identical and
// structurally compatible at the call site in Plan 05.

export type ActionItem = {
  subject: string;
  senderName: string;
  senderEmail?: string;
  summary: string;
  reviewUrl?: string;
};

export type AutoFiledRow = {
  label: string;
  summary: string;
};

export type AutoFiledGroup = {
  category: "receipts" | "newsletters" | "marketing" | "notifications";
  title: string;
  emailCount: number;
  clusterCount: number;
  rows: AutoFiledRow[];
};

// --- Phase 10: agenda + calendar activity ----------------------------------

export type AgendaItem = {
  /** "9:00a" — D-07 single-letter am/pm marker. "All day" when isAllDay. */
  time: string;
  /** "10:00a" or null. Null when end equals start (D-06). */
  endTime: string | null;
  title: string;
  location: string | null;
  isAllDay: boolean;
  /** Ids of overlapping siblings in the same sub-section (D-08). Empty when no overlap. */
  overlapWith: string[];
  /** NormalizedCalendarEvent.id — needed so detectOverlaps can key its return map. */
  id: string;
};

export type AgendaBlock = {
  today: AgendaItem[];
  tomorrowMorning: AgendaItem[];
  /** D-05 fallback copy when today has no events; null otherwise. */
  todayFallback: string | null;
  /** D-05 fallback copy when tomorrow morning has no events; null otherwise. */
  tomorrowMorningFallback: string | null;
};

export type CalendarActivityRow = {
  sentence: string;
  href: string;
};

export type CalendarActivityBlock = {
  review: CalendarActivityRow[]; // AMBIGUOUS (D-11)
  added: CalendarActivityRow[]; // CREATED (D-11)
  confirmed: CalendarActivityRow[]; // MATCHED (D-11)
};

// ---------------------------------------------------------------------------

export type DigestV2Props = {
  baseUrl?: string;
  date?: string;
  sentTime?: string;
  narrativeGreeting: string;
  narrativeBody: string;
  urgent: ActionItem[];
  uncertain: ActionItem[];
  autoFiled: AutoFiledGroup[];
  /** Phase 10 — D-01: rendered between narrative and Urgent when truthy. */
  agenda?: AgendaBlock | null;
  /** Phase 10 — D-02: rendered between Uncertain and auto-filed groups when truthy AND non-empty. */
  calendarActivity?: CalendarActivityBlock | null;
};

const groupColor: Record<
  AutoFiledGroup["category"],
  { border: string; bg: string; heading: string }
> = {
  receipts: {
    border: "border-l-green-400",
    bg: "bg-green-50",
    heading: "text-green-800",
  },
  newsletters: {
    border: "border-l-blue-400",
    bg: "bg-blue-50",
    heading: "text-blue-800",
  },
  marketing: {
    border: "border-l-purple-400",
    bg: "bg-purple-50",
    heading: "text-purple-800",
  },
  notifications: {
    border: "border-l-pink-400",
    bg: "bg-pink-50",
    heading: "text-pink-800",
  },
};

function ActionItemCard({
  item,
  variant,
}: {
  item: ActionItem;
  variant: "urgent" | "uncertain";
}) {
  const isUrgent = variant === "urgent";
  const cardClass = isUrgent
    ? "border-l-[4px] border-l-red-400 bg-red-50 rounded-[3px] py-[14px] px-[16px]"
    : "border-l-[4px] border-l-amber-400 bg-amber-50 rounded-[3px] py-[14px] px-[16px]";
  const subjectColor = isUrgent ? "text-red-800" : "text-amber-800";

  return (
    <Section className={cardClass}>
      <Text
        className={`text-[16px] font-bold leading-[1.3] m-0 mb-[4px] ${subjectColor}`}
      >
        {item.subject}
      </Text>
      <Text className="text-[13px] text-gray-500 m-0 mb-[8px]">
        <span className="text-gray-700 font-semibold">{item.senderName}</span>
        {item.senderEmail ? ` <${item.senderEmail}>` : null}
      </Text>
      <Text className="text-[14px] text-gray-700 leading-[1.5] m-0">
        {item.summary}
      </Text>
      {variant === "uncertain" && item.reviewUrl ? (
        <Section className="mt-[12px] text-right">
          <Link
            href={item.reviewUrl}
            className="text-[13px] font-semibold text-amber-800 no-underline"
          >
            Review in app →
          </Link>
        </Section>
      ) : null}
    </Section>
  );
}

function AutoFiledGroupCard({ group }: { group: AutoFiledGroup }) {
  const colors = groupColor[group.category];
  return (
    <Section
      className={`border-l-[4px] ${colors.border} ${colors.bg} rounded-[3px] py-[14px] px-[16px] pb-[6px]`}
    >
      <Text
        className={`m-0 mb-[10px] text-[13px] font-bold tracking-[0.02em] ${colors.heading}`}
      >
        {group.title}
        <span className="font-medium text-gray-400 text-[12px] ml-[6px]">
          {group.emailCount} emails · {group.clusterCount}{" "}
          {group.clusterCount === 1 ? "cluster" : "clusters"}
        </span>
      </Text>
      {group.rows.map((row, i) => (
        <Text
          key={`${group.category}-${i}`}
          className={`text-[14px] text-gray-700 leading-[1.55] m-0 py-[6px] ${
            i > 0 ? "border-0 border-t border-solid border-black/5" : ""
          }`}
        >
          <span className="font-bold text-gray-900 mr-[6px]">{row.label}</span>
          {row.summary}
        </Text>
      ))}
    </Section>
  );
}

// --- Phase 10 sub-components -----------------------------------------------

function AgendaItemRow({
  item,
  isFirst,
}: {
  item: AgendaItem;
  isFirst: boolean;
}) {
  const timeLabel = item.isAllDay
    ? "All day"
    : item.endTime
      ? `${item.time}–${item.endTime}`
      : item.time;
  const hasOverlap = item.overlapWith.length > 0;
  return (
    <Text
      className={`text-[14px] text-gray-700 leading-[1.55] m-0 py-[6px] ${
        isFirst ? "" : "border-0 border-t border-solid border-black/5"
      }`}
    >
      <span className="font-semibold text-gray-900 mr-[8px]">{timeLabel}</span>
      {item.title}
      {item.location ? (
        <span className="text-gray-500 ml-[8px]">· {item.location}</span>
      ) : null}
      {hasOverlap ? (
        <span className="bg-amber-100 text-amber-800 rounded px-[6px] py-[1px] text-[11px] font-semibold ml-[6px]">
          [⚠ overlaps]
        </span>
      ) : null}
    </Text>
  );
}

function AgendaDayBlock({
  heading,
  items,
  fallback,
}: {
  heading: string;
  items: AgendaItem[];
  fallback: string | null;
}) {
  return (
    <>
      <Text className="m-0 mb-[8px] mt-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">
        {heading}
      </Text>
      {items.length > 0 ? (
        items.map((item, i) => (
          <AgendaItemRow key={item.id} item={item} isFirst={i === 0} />
        ))
      ) : fallback ? (
        <Text className="italic text-gray-500 text-[14px] m-0 py-[6px]">
          {fallback}
        </Text>
      ) : null}
    </>
  );
}

function AgendaSection({ agenda }: { agenda: AgendaBlock }) {
  return (
    <Section className="pt-[28px] px-[32px] pb-[4px]">
      <AgendaDayBlock
        heading="TODAY"
        items={agenda.today}
        fallback={agenda.todayFallback}
      />
      <AgendaDayBlock
        heading="TOMORROW MORNING"
        items={agenda.tomorrowMorning}
        fallback={agenda.tomorrowMorningFallback}
      />
    </Section>
  );
}

function CalendarActivitySubGroup({
  heading,
  rows,
}: {
  heading: string;
  rows: CalendarActivityRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <Text className="m-0 mt-[10px] mb-[6px] text-[12px] font-bold tracking-[0.06em] uppercase text-slate-700">
        {heading}
      </Text>
      {rows.map((row, i) => (
        <Text
          key={`${heading}-${i}`}
          className={`text-[14px] text-slate-700 leading-[1.55] m-0 py-[6px] ${
            i > 0 ? "border-0 border-t border-solid border-black/5" : ""
          }`}
        >
          <Link href={row.href} className="text-slate-700 underline">
            {row.sentence}
          </Link>
        </Text>
      ))}
    </>
  );
}

function CalendarActivitySection({ block }: { block: CalendarActivityBlock }) {
  return (
    <Section className="pt-[28px] px-[32px] pb-[4px]">
      <Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">
        Calendar Activity
      </Text>
      <Section className="border-0 border-l-[4px] border-l-teal-400 border-solid bg-teal-50 rounded-[3px] py-[14px] px-[16px] pb-[10px]">
        <CalendarActivitySubGroup heading="Review" rows={block.review} />
        <CalendarActivitySubGroup heading="Added" rows={block.added} />
        <CalendarActivitySubGroup heading="Confirmed" rows={block.confirmed} />
      </Section>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export default function DigestV2Email({
  baseUrl = "https://inbox.tdfurn.com",
  date = "Monday, May 4",
  sentTime = "6:30am ET",
  narrativeGreeting,
  narrativeBody,
  urgent,
  uncertain,
  autoFiled,
  agenda,
  calendarActivity,
}: DigestV2Props) {
  const showCalendarActivity =
    !!calendarActivity &&
    (calendarActivity.review.length > 0 ||
      calendarActivity.added.length > 0 ||
      calendarActivity.confirmed.length > 0);

  return (
    <Html>
      <Head />
      <Tailwind>
        <Body className="bg-gray-100 m-0 p-0 font-sans text-gray-900">
          <Section className="w-full bg-gray-100 pt-[24px] pb-[56px]">
            <Container className="w-[600px] max-w-[600px] mx-auto bg-white border border-solid border-gray-200 rounded-[6px] overflow-hidden">
              {/* Header */}
              <Section className="text-center py-[28px] px-[32px] pb-[20px] border-b border-solid border-gray-100">
                <Text className="m-0">
                  <span className="inline-block w-[28px] h-[28px] bg-gray-900 rounded-[6px] text-white font-bold text-[15px] leading-[28px] text-center align-middle mr-[8px]">
                    IZ
                  </span>
                  <span className="inline-block align-middle text-[13px] font-semibold text-gray-700 tracking-[0.04em] uppercase">
                    Inbox Zero
                  </span>
                </Text>
                <Text className="mt-[10px] mb-0 text-[12px] text-gray-400 tracking-[0.02em]">
                  Daily digest · {date}
                </Text>
              </Section>

              {/* Narrative */}
              <Section className="pt-[24px] px-[32px] pb-[8px]">
                <Section className="bg-gray-50 rounded-[6px] py-[18px] px-[20px]">
                  <Text className="m-0 mb-[4px] text-[14px] font-semibold text-gray-900 tracking-[0.01em]">
                    {narrativeGreeting}
                  </Text>
                  <Text className="m-0 text-[15px] text-gray-700 leading-[1.65] italic">
                    {narrativeBody}
                  </Text>
                </Section>
              </Section>

              {/* Phase 10 — Agenda (between narrative and Urgent, D-01) */}
              {agenda ? <AgendaSection agenda={agenda} /> : null}

              {/* Urgent */}
              {urgent.length > 0 && (
                <Section className="pt-[28px] px-[32px] pb-[4px]">
                  <Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">
                    Urgent{" "}
                    <span className="text-gray-400 font-semibold">
                      ({urgent.length})
                    </span>
                  </Text>
                  {urgent.map((item, i) => (
                    <Section key={`urgent-${i}`}>
                      <ActionItemCard item={item} variant="urgent" />
                      {i < urgent.length - 1 && (
                        <Hr className="border-0 border-t border-solid border-gray-100 my-[10px]" />
                      )}
                    </Section>
                  ))}
                </Section>
              )}

              {/* Uncertain */}
              {uncertain.length > 0 && (
                <Section className="pt-[28px] px-[32px] pb-[4px]">
                  <Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">
                    Uncertain{" "}
                    <span className="text-gray-400 font-semibold">
                      ({uncertain.length})
                    </span>
                  </Text>
                  {uncertain.map((item, i) => (
                    <Section key={`uncertain-${i}`}>
                      <ActionItemCard item={item} variant="uncertain" />
                      {i < uncertain.length - 1 && (
                        <Hr className="border-0 border-t border-solid border-gray-100 my-[10px]" />
                      )}
                    </Section>
                  ))}
                </Section>
              )}

              {/* Phase 10 — Calendar Activity (between Uncertain and auto-filed, D-02) */}
              {showCalendarActivity && calendarActivity ? (
                <CalendarActivitySection block={calendarActivity} />
              ) : null}

              {/* Auto-filed groups */}
              {autoFiled.map((group) => (
                <Section
                  key={group.category}
                  className="pt-[28px] px-[32px] pb-[4px]"
                >
                  <Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">
                    Auto-filed · {group.title}
                  </Text>
                  <AutoFiledGroupCard group={group} />
                </Section>
              ))}

              {/* Footer */}
              <Section className="py-[28px] px-[32px] pb-[32px] border-t border-solid border-gray-100 mt-[16px] text-center">
                <Text className="m-0 text-[12px] text-gray-400 leading-[1.7]">
                  Sent at {sentTime} on {date}.
                </Text>
                <Text className="m-0 text-[12px] text-gray-400 leading-[1.7]">
                  AI-generated by Inbox Zero.
                </Text>
                <Text className="mt-[6px] m-0 text-[12px]">
                  <Link
                    href={`${baseUrl}/how-it-works`}
                    className="text-gray-500 underline"
                  >
                    How this works
                  </Link>
                  <span className="text-gray-300 mx-[6px]">·</span>
                  <Link
                    href={`${baseUrl}/preferences`}
                    className="text-gray-500 underline"
                  >
                    Preferences
                  </Link>
                  <span className="text-gray-300 mx-[6px]">·</span>
                  <Link
                    href={`${baseUrl}/unsubscribe`}
                    className="text-gray-500 underline"
                  >
                    Unsubscribe
                  </Link>
                </Text>
              </Section>
            </Container>
          </Section>
        </Body>
      </Tailwind>
    </Html>
  );
}

DigestV2Email.PreviewProps = {
  baseUrl: "https://inbox.tdfurn.com",
  date: "Monday, May 4",
  sentTime: "6:30am ET",
  narrativeGreeting: "Morning, Rebekah —",
  narrativeBody:
    "Happy National Donut Day, allegedly. (It's a real thing. The internet wouldn't lie.) Quiet night in your inbox: 31 emails, mostly receipts and newsletters. Two things actually want your time: Joe is now three follow-ups deep on the Q3 contract — pretty sure his next email will be in poetry — and Sarah Chen needs a yes/no on the Acme board reschedule before noon. Two emails confused the classifier; I parked them in Uncertain so you can teach me how to handle their kind.",
  agenda: {
    today: [
      {
        id: "evt-today-1",
        time: "9:00a",
        endTime: "10:00a",
        title: "Pediatrician visit — Mia",
        location: "Orlando Health",
        isAllDay: false,
        overlapWith: ["evt-today-2"],
      },
      {
        id: "evt-today-2",
        time: "9:30a",
        endTime: "10:15a",
        title: "Camping reservation call",
        location: null,
        isAllDay: false,
        overlapWith: ["evt-today-1"],
      },
      {
        id: "evt-today-3",
        time: "2:45p",
        endTime: null,
        title: "Camp pickup",
        location: "Riverside School",
        isAllDay: false,
        overlapWith: [],
      },
    ],
    tomorrowMorning: [
      {
        id: "evt-tomorrow-1",
        time: "8:30a",
        endTime: "9:15a",
        title: "Dentist",
        location: "Smile Dental",
        isAllDay: false,
        overlapWith: [],
      },
    ],
    todayFallback: null,
    tomorrowMorningFallback: null,
  },
  calendarActivity: {
    review: [
      {
        sentence:
          "REI: looks like it's about Camping reservation rescheduled — review →",
        href: "https://mail.google.com/mail/u/0/#inbox/abc123",
      },
    ],
    added: [
      {
        sentence:
          "Added Dentist Mon at 9:00a to your calendar (from Smile Dental) →",
        href: "https://calendar.google.com/event/xyz456",
      },
    ],
    confirmed: [
      {
        sentence:
          "Orlando Health confirmed Dr. Jones visit — already on your calendar",
        href: "https://calendar.google.com/event/qrs789",
      },
    ],
  },
  urgent: [
    {
      subject: "Re: Q3 contract — need final pricing today",
      senderName: "Joe Mancini",
      senderEmail: "joe@bayfield.legal",
      summary:
        "Third follow-up in 24h; pricing was promised Friday. Thread is buried at the bottom of the inbox, and he's now CC'ing his partner.",
    },
    {
      subject: "Acme board meeting — reschedule to 11/12?",
      senderName: "Sarah Chen",
      senderEmail: "s.chen@acmeholdings.com",
      summary:
        "Board chair asking to move Tuesday's meeting. Needs an answer before noon to lock the room.",
    },
  ],
  uncertain: [
    {
      subject: "Re: intro from David L.",
      senderName: "partnerships@flexport.com",
      summary:
        "Looks like a real intro reply, but the classifier wasn't confident whether this is a sales pitch or a legitimate referral.",
      reviewUrl: "https://inbox.tdfurn.com/uncertain/8ab12c",
    },
    {
      subject: "Your Q4 invoice + a new offering",
      senderName: "info@strivetraining.com",
      summary:
        "Half receipt, half marketing pitch. Classifier flagged for review so it can learn how you'd like these handled.",
      reviewUrl: "https://inbox.tdfurn.com/uncertain/4f29de",
    },
  ],
  autoFiled: [
    {
      category: "receipts",
      title: "Receipts",
      emailCount: 4,
      clusterCount: 3,
      rows: [
        {
          label: "Starbucks",
          summary:
            "reloaded your account balance twice yesterday for $40 total — the spirit is caffeinated, the wallet is concerned.",
        },
        {
          label: "Fuel",
          summary:
            "gas 3× at Wawa, BP, and Shell totaling $120. Either a road trip or a very ambitious morning commute.",
        },
        {
          label: "Amazon",
          summary:
            "order shipped (cat litter, $34). The cat thanks you for your service.",
        },
      ],
    },
    {
      category: "newsletters",
      title: "Newsletters",
      emailCount: 8,
      clusterCount: 2,
      rows: [
        {
          label: "Tech & politics",
          summary:
            "5 newsletters (Stratechery, Platformer, Slow Boring, Matt Levine, Garbage Day) all explaining the same news cycle in subtly competing ways.",
        },
        {
          label: "Industry digests",
          summary:
            "3 newsletters from Axios Pro, The Information, and Crain's — between them they cover roughly 80% of what any analyst will ask you about today.",
        },
      ],
    },
    {
      category: "marketing",
      title: "Marketing",
      emailCount: 6,
      clusterCount: 2,
      rows: [
        {
          label: "Deals — outdoor",
          summary:
            "Patagonia winter sale, REI member coupon, Backcountry 40% off jackets. Peak Q4 'buy a coat' energy.",
        },
        {
          label: "Deals — software",
          summary:
            "Notion AI upgrade, Linear annual discount, 1Password family plan. Apparently every SaaS scheduled their renewal pitch for the same week.",
        },
      ],
    },
    {
      category: "notifications",
      title: "Notifications",
      emailCount: 3,
      clusterCount: 1,
      rows: [
        {
          label: "GitHub",
          summary:
            "3 PR review requests across 2 repos (inbox-zero, tdfurn-marketing). They're patient. For now.",
        },
      ],
    },
  ],
} satisfies DigestV2Props;
