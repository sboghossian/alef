import { describe, expect, it } from "vitest";
import { isResidentState, type ResidentState } from "../../../shared/features/resident";
import {
  APPROVE_BUTTON_LABEL,
  APPROVE_BUTTON_TITLE,
  draftPrompt,
  DRAFT_BUTTON_LABEL,
  renderResidentInbox,
  renderResidentPanel,
} from "./resident-lib";

function state(over: Partial<ResidentState> = {}): ResidentState {
  return {
    name: "Alef resident",
    enabled: true,
    bornAt: "2026-09-24T09:00:00.000Z",
    day: 3,
    lastTickAt: null,
    lastReflectAt: null,
    lastError: null,
    goals: ["Watch the fleet"],
    skills: ["fleet-rhythm"],
    journalTail: ["- 09:05 · busy (Jev 80%) · 1 started"],
    recentWrites: [{ at: "2026-09-26T09:05:00.000Z", path: "journal/2026-09-26.md", bytes: 42, reason: "jev tick: busy" }],
    proposals: [
      { id: "p1", at: "2026-09-26T09:00:00.000Z", kind: "note", title: "Tidy <todo>", why: "stale", status: "open" },
      { id: "p2", at: "2026-09-25T09:00:00.000Z", kind: "skill", title: "Old one", why: "w", status: "approved" },
      { id: "p3", at: "2026-09-26T09:10:00.000Z", kind: "session", title: "Fix the flaky test", why: "it failed twice this week", status: "open" },
    ],
    spend: { todayUsd: 0.12, capUsd: 0.5 },
    ...over,
  };
}

describe("isResidentState", () => {
  it("accepts a full state and rejects malformed ones", () => {
    expect(isResidentState(state())).toBe(true);
    expect(isResidentState(null)).toBe(false);
    expect(isResidentState({ ...state(), goals: [1] })).toBe(false);
    expect(isResidentState({ ...state(), spend: { todayUsd: "0" } })).toBe(false);
    expect(isResidentState({ ...state(), proposals: [{ ...state().proposals[0], kind: "shell" }] })).toBe(false);
  });
});

describe("renderResidentPanel", () => {
  it("shows name, day, spend, goals, skills, journal, writes and escaped proposals", () => {
    const html = renderResidentPanel(state(), Date.parse("2026-09-26T10:00:00Z"));
    expect(html).toContain("Alef resident");
    expect(html).toContain("Day 3");
    expect(html).toContain("$0.120 of $0.50 today");
    expect(html).toContain("Watch the fleet");
    expect(html).toContain("fleet-rhythm");
    expect(html).toContain("busy (Jev 80%)");
    expect(html).toContain("journal/2026-09-26.md");
    expect(html).toContain("Tidy &lt;todo&gt;");
    expect(html).not.toContain("<todo>");
    expect(html).toContain('data-res-approve="p1"');
    expect(html).not.toContain('data-res-approve="p2"'); // decided proposals have no buttons
    expect(html).toContain('data-res-enabled="false"'); // on → the button switches off
  });

  it("offers to switch on when off, and shows lastError", () => {
    const html = renderResidentPanel(state({ enabled: false, lastError: "over the daily cap" }));
    expect(html).toContain('data-res-enabled="true"');
    expect(html).toContain("over the daily cap");
  });

  it("Approve reads honestly as 'Mark approved', with a title that says nothing runs", () => {
    const html = renderResidentPanel(state());
    expect(html).toContain(`>${APPROVE_BUTTON_LABEL}<`);
    expect(html).toContain(`title="${APPROVE_BUTTON_TITLE}"`);
    expect(html).not.toMatch(/>Approve</); // the old, action-sounding label is gone
  });

  it("'Put in prompt box' appears only for an open 'session' proposal", () => {
    const html = renderResidentPanel(state());
    expect(html).toContain(`data-res-draft="p3"`); // p3 is the open session proposal
    expect(html).toContain(`>${DRAFT_BUTTON_LABEL}<`);
    expect(html).not.toContain(`data-res-draft="p1"`); // open, but kind "note"
    expect(html).not.toContain(`data-res-draft="p2"`); // kind "skill", and decided anyway
  });

  it("hostile proposal titles/why text are escaped, never raw HTML", () => {
    const hostile = state({
      proposals: [{ id: "p4", at: "2026-09-26T09:00:00.000Z", kind: "session", title: "<img src=x onerror=alert(1)>", why: "<script>steal()</script>", status: "open" }],
    });
    const html = renderResidentPanel(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  });
});

describe("renderResidentInbox", () => {
  it("lists open proposals only, and nothing when there are none", () => {
    const html = renderResidentInbox(state());
    expect(html).toContain("Tidy &lt;todo&gt;");
    expect(html).not.toContain("Old one");
    expect(renderResidentInbox(state({ proposals: [] }))).toBe("");
  });
});

describe("draftPrompt", () => {
  it("is the title, a blank line, then the why — plain text, no escaping (goes into a textarea value)", () => {
    expect(draftPrompt({ title: "Fix the flaky test", why: "it failed twice this week" })).toBe("Fix the flaky test\n\nit failed twice this week");
  });
});
