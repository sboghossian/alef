// bridgeItems / graduationHref (round 2, graduation-badges): pure, so tested directly on
// real-shaped server feed items (server/features/outcomes.ts's actual appendToFeed call), not on
// a stub that already knows the answer.

import { describe, expect, it } from "vitest";
import type { FeedItem as ServerFeedItem } from "../../../shared/features/feed";
import { bridgeItems, graduationHref, isServerFeedItem } from "./feed-bridge";

const AGENT = "943ddee1-a73d-470c-835a-55084c09c69f";

/** As server/features/outcomes.ts's `feed({ ... kind: "graduation" ... })` actually emits it. */
const shippedItem: ServerFeedItem = {
  id: `grad:${AGENT}:shipped`,
  seq: 61,
  at: "2026-09-28T10:00:00.000Z",
  kind: "graduation",
  agentId: AGENT,
  title: "🎓 Orchestrator shipped sboghossian/agent-world#61",
  detail: "sboghossian/agent-world#61 merged",
  tag: "shipped",
};

describe("graduationHref", () => {
  it("turns 'owner/repo#n' inside a graduation title into its GitHub PR URL", () => {
    expect(graduationHref(shippedItem.title)).toBe("https://github.com/sboghossian/agent-world/pull/61");
    expect(graduationHref("📦 Sweep delivered sboghossian/acme-ai-next#204")).toBe("https://github.com/sboghossian/acme-ai-next/pull/204");
  });

  it("has no href for a delivered item with no PR (a push or an artifact only)", () => {
    expect(graduationHref("📦 Vault Tidy delivered a push to alex_claude")).toBeUndefined();
    expect(graduationHref("📦 Brief delivered a claude.ai artifact")).toBeUndefined();
    expect(graduationHref("🎓 x shipped a PR")).toBeUndefined(); // no repo/number on record
  });

  it("anchors to the TRAILING owner/repo#n, never an earlier one embedded in the session's own name", () => {
    // graduationTitle() always puts the PR it names last; a session named after an unrelated PR
    // (e.g. a fix-review session) must never make its own ship look like it targets that PR.
    const title = "🎓 Fix acme-inc/acme-ai#554 review shipped sboghossian/agent-world#560";
    expect(graduationHref(title)).toBe("https://github.com/sboghossian/agent-world/pull/560");
  });

  it("returns undefined for a title sanitizeTitle truncated (always ends '…'), instead of a truncated PR number", () => {
    // server/heuristics.ts's sanitizeTitle caps at 80 chars and always appends "…" when it cuts —
    // never guess the rest of a PR number that got cut off mid-digit.
    const title = "🎓 A very long session name that goes on for a while delivered sboghossian/agent-world#1…";
    expect(graduationHref(title)).toBeUndefined();
  });
});

describe("bridgeItems: graduation", () => {
  it("forwards title, detail, agentId and the PR href", () => {
    const { graduations } = bridgeItems([shippedItem]);
    expect(graduations).toEqual([
      {
        id: `grad:${AGENT}:shipped`,
        kind: "graduation",
        at: Date.parse("2026-09-28T10:00:00.000Z"),
        title: "🎓 Orchestrator shipped sboghossian/agent-world#61",
        detail: "sboghossian/agent-world#61 merged",
        agentId: AGENT,
        href: "https://github.com/sboghossian/agent-world/pull/61",
      },
    ]);
  });

  it("never pins a graduation (it is town news, not something to answer)", () => {
    const { graduations } = bridgeItems([shippedItem]);
    expect(graduations[0]?.pinned).toBeUndefined();
  });

  it("carries a null detail through as undefined, and drops a graduation with no agentId's field only if malformed — a real one always has one", () => {
    const noDetail: ServerFeedItem = { ...shippedItem, detail: null };
    expect(bridgeItems([noDetail]).graduations[0]?.detail).toBeUndefined();
  });

  it("still drops unknown kinds and non-item junk (isServerFeedItem's job, unchanged)", () => {
    const unknownKind = { ...shippedItem, kind: "future-kind" };
    expect(isServerFeedItem(unknownKind)).toBe(false);
    const { graduations, tripwires, routines } = bridgeItems([shippedItem, unknownKind, { not: "an item" }, null, "junk"]);
    expect(graduations).toHaveLength(1);
    expect(tripwires).toHaveLength(0);
    expect(routines).toHaveLength(0);
  });

  it("drops a graduation item whose timestamp doesn't parse, rather than crash a downstream Date", () => {
    const badAt: ServerFeedItem = { ...shippedItem, at: "not-a-date" };
    expect(bridgeItems([badAt]).graduations).toHaveLength(0);
  });
});

// server/features/careers-lib.ts's careerFeedItem (merged in #53, wired to appendToFeed at
// careers.ts) also emits kind "graduation" — the same wire kind outcomes.ts uses — but tagged
// "career-lapsed" / "career-probation" / "career-returned" / "career-trusted". Only the last one
// is real graduation news; the other three are bad or neutral news that must never wear the 🎓
// chip or join the Town square's shared "graduation" topic (workspace-lib.ts's feedCandidate
// groups every kind:"graduation" item under one topic for its 4-district wave). Titles/tag below
// are careerFeedItem's real output format (its docstring and server/test/careers-lib.test.ts's
// own fixtures), including the exact wording a live-data code review captured for /inbox-sweep.
const careerLapsedItem: ServerFeedItem = {
  id: "career:/inbox-sweep:lapsed:none",
  seq: 62,
  at: "2026-09-28T10:00:00.000Z",
  kind: "graduation",
  agentId: null,
  title: "💤 /inbox-sweep stopped reporting (last run 2026-09-20)",
  detail: "no run since 2026-09-20",
  tag: "career-lapsed",
};

const careerProbationItem: ServerFeedItem = {
  ...careerLapsedItem,
  id: "career:/inbox-sweep:probation:none",
  title: "↩ /inbox-sweep back on probation: did nothing: 0 tool calls",
  detail: "did nothing: 0 tool calls",
  tag: "career-probation",
};

const careerReturnedItem: ServerFeedItem = {
  ...careerLapsedItem,
  id: "career:/daily-recap:returned:none",
  title: "↺ Quill (/daily-recap) ran again after you retired it",
  detail: null,
  tag: "career-returned",
};

const careerTrustedItem: ServerFeedItem = {
  ...careerLapsedItem,
  id: "career:/daily-recap:trusted:none",
  title: "🎓 /daily-recap graduated: 5 clean runs in a row · Reports & Briefs",
  detail: "5 clean runs in a row",
  tag: "career-trusted",
};

describe("bridgeItems: career news shares the wire kind 'graduation' but isn't one", () => {
  it("routes career-lapsed to 'system' — bad news never gets the 🎓 chip", () => {
    const { graduations } = bridgeItems([careerLapsedItem]);
    expect(graduations).toHaveLength(1);
    expect(graduations[0]?.kind).toBe("system");
    expect(graduations[0]?.title).toBe("💤 /inbox-sweep stopped reporting (last run 2026-09-20)");
  });

  it("routes career-probation to 'system' too", () => {
    const { graduations } = bridgeItems([careerProbationItem]);
    expect(graduations[0]?.kind).toBe("system");
  });

  it("routes career-returned to 'system' (neutral news, not a graduation)", () => {
    const { graduations } = bridgeItems([careerReturnedItem]);
    expect(graduations[0]?.kind).toBe("system");
  });

  it("still badges career-trusted as a real graduation (a worker crossing into trusted IS one)", () => {
    const { graduations } = bridgeItems([careerTrustedItem]);
    expect(graduations[0]?.kind).toBe("graduation");
  });

  it("never computes a graduation href for a demoted career item", () => {
    const { graduations } = bridgeItems([careerProbationItem, careerLapsedItem, careerReturnedItem]);
    for (const g of graduations) expect(g.href).toBeUndefined();
  });
});
