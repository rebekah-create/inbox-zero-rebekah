import { describe, expect, it } from "vitest";
import { pickLinkTarget } from "./pick-link-target";

describe("pickLinkTarget — D-13 link selection", () => {
  it("returns googleEventHtmlLink for MATCHED when link is non-null", () => {
    const href = pickLinkTarget({
      outcome: "MATCHED",
      googleEventHtmlLink: "https://calendar.google.com/event/abc",
      threadId: "T1",
    });
    expect(href).toBe("https://calendar.google.com/event/abc");
  });

  it("returns googleEventHtmlLink for CREATED when link is non-null", () => {
    const href = pickLinkTarget({
      outcome: "CREATED",
      googleEventHtmlLink: "https://calendar.google.com/event/xyz",
      threadId: "T2",
    });
    expect(href).toBe("https://calendar.google.com/event/xyz");
  });

  it("falls back to Gmail thread URL for MATCHED when googleEventHtmlLink is null", () => {
    const href = pickLinkTarget({
      outcome: "MATCHED",
      googleEventHtmlLink: null,
      threadId: "T3",
    });
    expect(href).toBe("https://mail.google.com/mail/u/0/#inbox/T3");
  });

  it("falls back to Gmail thread URL for CREATED when googleEventHtmlLink is null", () => {
    const href = pickLinkTarget({
      outcome: "CREATED",
      googleEventHtmlLink: null,
      threadId: "T4",
    });
    expect(href).toBe("https://mail.google.com/mail/u/0/#inbox/T4");
  });

  it("always returns Gmail thread URL for AMBIGUOUS even when googleEventHtmlLink is set", () => {
    const href = pickLinkTarget({
      outcome: "AMBIGUOUS",
      googleEventHtmlLink:
        "https://calendar.google.com/event/should-be-ignored",
      threadId: "T5",
    });
    expect(href).toBe("https://mail.google.com/mail/u/0/#inbox/T5");
  });

  it("URL-encodes threadId in Gmail fallback link (T-10-03)", () => {
    const href = pickLinkTarget({
      outcome: "AMBIGUOUS",
      googleEventHtmlLink: null,
      threadId: "thread id/with#special?chars",
    });
    expect(href).toBe(
      "https://mail.google.com/mail/u/0/#inbox/thread%20id%2Fwith%23special%3Fchars",
    );
    expect(href).toContain("%2F");
    expect(href).toContain("%23");
  });
});
