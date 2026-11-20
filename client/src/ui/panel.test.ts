// The Outcome row (round 2, graduation-badges): pure DOM-building tests. Client tests run in
// Node, so buildOutcomeSection gets a stub `document.createElement` (the same technique
// ui/toast.test.ts uses) rather than a real DOM — good enough to prove what got attached where,
// and (the point of these tests) that hostile record text lands in `.textContent`, never in
// markup a real browser could parse.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutcomeRecord } from "../../../shared/features/outcomes";
import { buildOutcomeSection } from "./panel";

/** Just enough of an Element for buildOutcomeSection: tag, class, text, a[href], and children. */
class FakeEl {
  tagName: string;
  className = "";
  textContent = "";
  href = "";
  target = "";
  rel = "";
  kids: FakeEl[] = [];
  constructor(tag: string) {
    this.tagName = tag;
  }
  appendChild(el: FakeEl): FakeEl {
    this.kids.push(el);
    return el;
  }
}

function asFake(el: unknown): FakeEl {
  return el as unknown as FakeEl;
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeEl(tag) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const baseRecord = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  sessionId: "943ddee1-a73d-470c-835a-55084c09c69f",
  outcome: "shipped",
  reason: "sboghossian/agent-world#61 merged",
  evidenceAt: "2026-09-28T10:00:00.000Z",
  lastActive: "2026-09-28T10:00:00.000Z",
  toolCalls: 40,
  writes: 6,
  learnings: [],
  artifacts: [],
  prs: [],
  pushes: [],
  todos: null,
  ending: null,
  onDisk: true,
  pending: false,
  provisionalUntil: null,
  ...over,
});

describe("buildOutcomeSection", () => {
  it("shows the headline chip for a known outcome", () => {
    const el = asFake(buildOutcomeSection("shipped", null));
    expect(el.kids[0]?.textContent).toBe("🎓 shipped");
    expect(el.kids[0]?.className).toBe("panel-outcome-chip");
  });

  it("reads 'no outcome evidence' in grey, never failure styling, when there's nothing on record", () => {
    const el = asFake(buildOutcomeSection(null, null));
    expect(el.kids[0]?.textContent).toBe("no outcome evidence");
    expect(el.kids[0]?.className).toBe("panel-outcome-chip panel-outcome-unknown");
    expect(el.kids).toHaveLength(1); // no PR/artifact/reason sections with no record
  });

  it("reads 'active now', not 'no outcome evidence', for a live session (known === 'active')", () => {
    // outcomeOf() returns "active" for a live session, and outcomeChip("active") returns null on
    // purpose (no 🎓/✗/etc chip for it) — but that's not the same as no evidence at all: a live
    // session has evidence (it's running right now), and the Board's own filter agrees
    // (OUTCOME_FILTER_LABEL.active === "Active now").
    const el = asFake(buildOutcomeSection("active", null));
    expect(el.kids[0]?.textContent).toBe("active now");
    expect(el.kids[0]?.className).not.toContain("panel-outcome-unknown");
  });

  it("still shows a live session's PRs/artifacts under the 'active now' headline once the record arrives", () => {
    const rec = baseRecord({ outcome: "active", artifacts: ["https://claude.ai/artifact/live1"] });
    const el = asFake(buildOutcomeSection("active", rec));
    expect(el.kids[0]?.textContent).toBe("active now");
    const list = el.kids.find((k) => k.className === "panel-outcome-artifacts");
    expect(list?.kids[0]?.kids[0]?.href).toBe("https://claude.ai/artifact/live1");
  });

  it("lists PRs with their merge state and links to the real URL", () => {
    const rec = baseRecord({
      prs: [{ repo: "sboghossian/agent-world", number: 61, url: "https://github.com/sboghossian/agent-world/pull/61", state: "MERGED", mergedAt: "2026-09-28T09:59:00.000Z", checkedAt: "2026-09-28T10:00:00.000Z", firstSeenAt: "2026-09-28T09:00:00.000Z" }],
    });
    const el = asFake(buildOutcomeSection("shipped", rec));
    const list = el.kids.find((k) => k.className === "panel-outcome-prs");
    const li = list?.kids[0];
    const a = li?.kids[0];
    expect(a?.textContent).toBe("sboghossian/agent-world#61");
    expect(a?.href).toBe("https://github.com/sboghossian/agent-world/pull/61");
    expect(li?.kids[1]?.textContent).toBe(" · merged");
  });

  it("labels every PR state honestly (open/closed/unknown/unchecked, not just merged)", () => {
    const pr = (state: OutcomeRecord["prs"][number]["state"]) => ({ repo: "a/b", number: 1, url: "https://github.com/a/b/pull/1", state, mergedAt: null, checkedAt: "2026-09-28T10:00:00.000Z", firstSeenAt: "2026-09-28T09:00:00.000Z" });
    const label = (state: OutcomeRecord["prs"][number]["state"]) => {
      const el = asFake(buildOutcomeSection("delivered", baseRecord({ outcome: "delivered", prs: [pr(state)] })));
      return el.kids.find((k) => k.className === "panel-outcome-prs")?.kids[0]?.kids[1]?.textContent;
    };
    expect(label("OPEN")).toBe(" · open");
    expect(label("CLOSED")).toBe(" · closed");
    expect(label("unknown")).toBe(" · merge state unknown");
    expect(label("unchecked")).toBe(" · not checked yet");
  });

  it("lists artifact links", () => {
    const rec = baseRecord({ outcome: "delivered", artifacts: ["https://claude.ai/artifact/abc123"] });
    const el = asFake(buildOutcomeSection("delivered", rec));
    const list = el.kids.find((k) => k.className === "panel-outcome-artifacts");
    expect(list?.kids[0]?.kids[0]?.href).toBe("https://claude.ai/artifact/abc123");
    expect(list?.kids[0]?.kids[0]?.textContent).toBe("https://claude.ai/artifact/abc123");
  });

  it("shows the ending reason over the plain reason when a session failed or stopped", () => {
    const rec = baseRecord({ outcome: "failed", reason: "API Error: overloaded", ending: { status: "failed", reason: "cut off mid-turn", headless: true } });
    const el = asFake(buildOutcomeSection("failed", rec));
    expect(el.kids.find((k) => k.className === "panel-outcome-reason")?.textContent).toBe("cut off mid-turn");
  });

  it("falls back to the plain reason when there is no ending (shipped/delivered/finished)", () => {
    const rec = baseRecord({ outcome: "shipped", reason: "sboghossian/agent-world#61 merged" });
    const el = asFake(buildOutcomeSection("shipped", rec));
    expect(el.kids.find((k) => k.className === "panel-outcome-reason")?.textContent).toBe("sboghossian/agent-world#61 merged");
  });

  it("a hostile reason lands in textContent, never parsed as markup", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const rec = baseRecord({ outcome: "failed", reason: hostile });
    const el = asFake(buildOutcomeSection("failed", rec));
    expect(el.kids.find((k) => k.className === "panel-outcome-reason")?.textContent).toBe(hostile);
  });

  it("a hostile PR repo name still only ever reaches textContent", () => {
    const rec = baseRecord({ prs: [{ repo: '<img onerror=alert(1)>/x', number: 1, url: "https://github.com/a/b/pull/1", state: "MERGED", mergedAt: null, checkedAt: "2026-09-28T10:00:00.000Z", firstSeenAt: "2026-09-28T09:00:00.000Z" }] });
    const el = asFake(buildOutcomeSection("shipped", rec));
    const a = el.kids.find((k) => k.className === "panel-outcome-prs")?.kids[0]?.kids[0];
    expect(a?.textContent).toBe("<img onerror=alert(1)>/x#1");
  });

  it("never sets an href for a non-http(s) URL", () => {
    const rec = baseRecord({ prs: [{ repo: "a/b", number: 1, url: "javascript:alert(1)", state: "MERGED", mergedAt: null, checkedAt: "2026-09-28T10:00:00.000Z", firstSeenAt: "2026-09-28T09:00:00.000Z" }] });
    const el = asFake(buildOutcomeSection("shipped", rec));
    const a = el.kids.find((k) => k.className === "panel-outcome-prs")?.kids[0]?.kids[0];
    expect(a?.href).toBe("");
  });
});
