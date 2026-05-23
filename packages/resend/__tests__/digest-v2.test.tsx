import { describe, it, expect } from "vitest";
import { render } from "@react-email/render";
import DigestV2Email, {
  type DigestV2Props,
  type AgendaBlock,
  type CalendarActivityBlock,
} from "../emails/digest-v2";

const fixture: DigestV2Props = {
  date: "Monday, May 4, 2026",
  narrativeGreeting: "Morning, Rebekah —",
  narrativeBody:
    "Two urgent items waiting on your reply, three roll-ups for cool-down reading.",
  urgent: [
    {
      subject: "Lease renewal",
      senderName: "Landlord",
      summary: "Sign by Friday.",
    },
  ],
  uncertain: [
    {
      subject: "Possible vendor outreach",
      senderName: "Acme",
      summary: "Sounds like a sales pitch.",
      reviewUrl: "https://inbox.tdfurn.com/uncertain/abc",
    },
  ],
  autoFiled: [
    {
      category: "receipts",
      title: "Receipts",
      emailCount: 4,
      clusterCount: 2,
      rows: [
        { label: "Starbucks", summary: "Two reloads totalling $40." },
        { label: "Amazon", summary: "One delivery confirmation." },
      ],
    },
    {
      category: "newsletters",
      title: "Newsletters",
      emailCount: 6,
      clusterCount: 1,
      rows: [
        {
          label: "Tech & politics",
          summary: "Six newsletters; nothing time-sensitive.",
        },
      ],
    },
    {
      category: "marketing",
      title: "Marketing",
      emailCount: 3,
      clusterCount: 2,
      rows: [
        { label: "Deals — outdoor", summary: "REI 20% sale ends Sunday." },
        { label: "Deals — software", summary: "Adobe 40% off CC." },
      ],
    },
    {
      category: "notifications",
      title: "Notifications",
      emailCount: 2,
      clusterCount: 1,
      rows: [{ label: "GitHub", summary: "Two PR review reminders." }],
    },
  ],
};

describe("digest-v2.tsx prop-driven render", () => {
  it("renders narrativeGreeting and narrativeBody verbatim from props", async () => {
    const html = await render(<DigestV2Email {...fixture} />);
    expect(html).toContain("Morning, Rebekah —");
    expect(html).toContain("Two urgent items waiting on your reply");
  });

  it("renders one card per urgent[] entry with subject + summary", async () => {
    const html = await render(<DigestV2Email {...fixture} />);
    expect(html).toContain("Lease renewal");
    expect(html).toContain("Sign by Friday.");
  });

  it("renders Marketing rows with 'Deals — ' prefix when Sonnet labels them so", async () => {
    const html = await render(<DigestV2Email {...fixture} />);
    expect(html).toContain("Deals — outdoor");
    expect(html).toContain("Deals — software");
  });

  it("renders auto-filed sections in fixed order: receipts → newsletters → marketing → notifications", async () => {
    const html = await render(<DigestV2Email {...fixture} />);
    const idx = (s: string) => html.indexOf(s);
    expect(idx("Receipts")).toBeLessThan(idx("Newsletters"));
    expect(idx("Newsletters")).toBeLessThan(idx("Marketing"));
    expect(idx("Marketing")).toBeLessThan(idx("Notifications"));
  });

  it("renders unchanged Phase 4 layout when agenda + calendarActivity are absent (D-03)", async () => {
    const html = await render(<DigestV2Email {...fixture} />);
    expect(html).not.toContain(">TODAY<");
    expect(html).not.toContain(">TOMORROW MORNING<");
    expect(html).not.toContain(">Calendar Activity<");
  });
});

describe("DigestV2Email — Phase 10 sections", () => {
  const agendaFixture: AgendaBlock = {
    today: [
      {
        id: "evt-1",
        time: "9:00a",
        endTime: "10:00a",
        title: "Pediatrician visit",
        location: "Orlando Health",
        isAllDay: false,
        overlapWith: ["evt-2"],
      },
      {
        id: "evt-2",
        time: "9:30a",
        endTime: "10:30a",
        title: "Camping reservation call",
        location: null,
        isAllDay: false,
        overlapWith: ["evt-1"],
      },
      {
        id: "evt-3",
        time: "2:00p",
        endTime: null,
        title: "Camp pickup",
        location: "School",
        isAllDay: false,
        overlapWith: [],
      },
    ],
    tomorrowMorning: [
      {
        id: "evt-4",
        time: "8:00a",
        endTime: "9:00a",
        title: "Dentist",
        location: "Smile Dental",
        isAllDay: false,
        overlapWith: [],
      },
    ],
    todayFallback: null,
    tomorrowMorningFallback: null,
  };

  const calendarActivityFixture: CalendarActivityBlock = {
    review: [
      {
        sentence:
          "REI: looks like it's about Camping reservation rescheduled — review →",
        href: "https://mail.google.com/mail/u/0/#inbox/abc",
      },
    ],
    added: [
      {
        sentence:
          "Added Dentist Mon at 9:00a to your calendar (from Smile Dental) →",
        href: "https://calendar.google.com/event/xyz",
      },
    ],
    confirmed: [
      {
        sentence:
          "Orlando Health confirmed Dr. Jones visit — already on your calendar",
        href: "https://calendar.google.com/event/qrs",
      },
    ],
  };

  it("renders AgendaSection when agenda prop is provided", async () => {
    const html = await render(
      <DigestV2Email {...fixture} agenda={agendaFixture} />,
    );
    expect(html).toContain("TODAY");
    expect(html).toContain("TOMORROW MORNING");
    expect(html).toContain("Pediatrician visit");
    expect(html).toContain("Camp pickup");
    expect(html).toContain("Dentist");
  });

  it("renders overlap pill on overlapping rows in TODAY's agenda (D-09)", async () => {
    const html = await render(
      <DigestV2Email {...fixture} agenda={agendaFixture} />,
    );
    expect(html).toContain("overlaps");
  });

  it("renders empty-day fallback when today is empty and fallback string is provided (D-05)", async () => {
    const emptyAgenda: AgendaBlock = {
      today: [],
      tomorrowMorning: [],
      todayFallback: "Nothing else on the calendar today.",
      tomorrowMorningFallback: "Nothing on the calendar tomorrow.",
    };
    const html = await render(
      <DigestV2Email {...fixture} agenda={emptyAgenda} />,
    );
    expect(html).toContain("Nothing else on the calendar today.");
    expect(html).toContain("Nothing on the calendar tomorrow.");
  });

  it("renders CalendarActivitySection with Review / Added / Confirmed sub-headings", async () => {
    const html = await render(
      <DigestV2Email
        {...fixture}
        calendarActivity={calendarActivityFixture}
      />,
    );
    expect(html).toContain("Calendar Activity");
    expect(html).toContain("Review</p>");
    expect(html).toContain("Added</p>");
    expect(html).toContain("Confirmed</p>");
    expect(html).toContain("already on your calendar");
  });

  it("hides CalendarActivitySection when all three groups are empty (D-12)", async () => {
    const html = await render(
      <DigestV2Email
        {...fixture}
        calendarActivity={{ review: [], added: [], confirmed: [] }}
      />,
    );
    expect(html).not.toContain("Calendar Activity");
  });

  it("hides individual sub-headings when their array is empty (D-12)", async () => {
    const html = await render(
      <DigestV2Email
        {...fixture}
        calendarActivity={{
          review: [],
          added: calendarActivityFixture.added,
          confirmed: [],
        }}
      />,
    );
    expect(html).toContain("Calendar Activity");
    expect(html).toContain("Added</p>");
    // Sub-headings for empty groups should not appear
    expect(html).not.toContain("Review</p>");
    expect(html).not.toContain("Confirmed</p>");
  });

  it("renders each Calendar Activity row as a Link with its href (D-13)", async () => {
    const html = await render(
      <DigestV2Email
        {...fixture}
        calendarActivity={calendarActivityFixture}
      />,
    );
    expect(html).toContain("https://mail.google.com/mail/u/0/#inbox/abc");
    expect(html).toContain("https://calendar.google.com/event/xyz");
    expect(html).toContain("https://calendar.google.com/event/qrs");
  });

  it("renders sections in correct order: narrative → agenda → urgent → uncertain → calendar activity → auto-filed (D-01, D-02)", async () => {
    const html = await render(
      <DigestV2Email
        {...fixture}
        agenda={agendaFixture}
        calendarActivity={calendarActivityFixture}
      />,
    );
    const idx = (s: string) => html.indexOf(s);
    expect(idx("Morning, Rebekah —")).toBeLessThan(idx(">TODAY<"));
    expect(idx(">TODAY<")).toBeLessThan(idx(">Urgent"));
    expect(idx(">Urgent")).toBeLessThan(idx(">Uncertain"));
    expect(idx(">Uncertain")).toBeLessThan(idx(">Calendar Activity<"));
    expect(idx(">Calendar Activity<")).toBeLessThan(idx(">Receipts"));
  });
});
