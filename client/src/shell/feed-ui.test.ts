import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "../features/workspace-lib";
import { FEED_KINDS, kindIcon, type FeedItem } from "./feed";
import { FeedAnnouncer, isCommandRow, workspaceTopHtml } from "./feed-ui";

const item = (id: string, extra: Partial<FeedItem> = {}): FeedItem => ({ id, kind: "activity", at: 0, title: `title ${id}`, ...extra });

describe("FeedAnnouncer (the Feed's one role=status line)", () => {
  it("says nothing about what was already there on the first look", () => {
    const a = new FeedAnnouncer(10_000);
    expect(a.update([item("a"), item("b")], 0)).toBeNull();
    expect(a.waitMs(0)).toBeNull();
  });

  it("names how many arrived and the one on top", () => {
    const a = new FeedAnnouncer(10_000);
    a.update([item("a")], 0);
    expect(a.update([item("c"), item("b"), item("a")], 20_000)).toBe("2 new: title c");
    expect(a.update([item("c"), item("b"), item("a")], 40_000)).toBeNull(); // nothing new, nothing said
  });

  it("holds what lands inside 10 s and folds it into one later line", () => {
    const a = new FeedAnnouncer(10_000);
    a.update([item("a")], 0);
    expect(a.update([item("b"), item("a")], 20_000)).toBe("1 new: title b");
    expect(a.update([item("c"), item("b"), item("a")], 21_000)).toBeNull();
    expect(a.update([item("d"), item("c"), item("b"), item("a")], 25_000)).toBeNull();
    expect(a.waitMs(25_000)).toBe(5_000);
    expect(a.flush(29_999)).toBeNull();
    expect(a.flush(30_000)).toBe("2 new: title d");
    expect(a.waitMs(30_000)).toBeNull();
  });

  it("never announces rows stamped before the page loaded (the bridge's backfill)", () => {
    const a = new FeedAnnouncer(0, 1_000);
    a.update([], 1_000);
    expect(a.update([item("old", { at: 500 }), item("new", { at: 1_500 })], 2_000)).toBe("1 new: title new");
  });

  it("a pinned approval that arrives ranks first, as it does in the list", () => {
    const a = new FeedAnnouncer(0);
    a.update([item("a")], 0);
    const ap = item("ap", { kind: "approval", title: "Bash: Run tests", pinned: true });
    expect(a.update([ap, item("b"), item("a")], 1)).toBe("2 new: Bash: Run tests");
  });
});

describe("isCommandRow (clamped to one monospace line)", () => {
  it("is an activity row carrying a tool name", () => {
    expect(isCommandRow(item("x", { title: "npm test -- --run && git push origin main", detail: "Fix the blog · acme-ai-next · Bash" }))).toBe(true);
    expect(isCommandRow(item("x", { detail: "Edit" }))).toBe(true);
  });

  it("is not a new-prompt line, a caption, or a row without a tool", () => {
    expect(isCommandRow(item("x", { detail: "Fix the blog · acme-ai-next · hook" }))).toBe(false);
    expect(isCommandRow(item("x", { kind: "caption", detail: "Fix the blog" }))).toBe(false);
    expect(isCommandRow(item("x", { kind: "decision", detail: "Bash" }))).toBe(false);
    expect(isCommandRow(item("x"))).toBe(false);
  });
});

// VIS-10: the Feed's kinds and the Town square drew themselves in emoji, a dozen OS palettes on
// the busiest panel in the app. They are line icons now, in currentColor.
describe("the Feed's glyphs are line icons", () => {
  const emoji = /\p{Extended_Pictographic}/u;

  it("has an icon for every kind", () => {
    for (const k of FEED_KINDS) {
      const svg = kindIcon(k);
      expect(svg, k).toMatch(/^<svg class="alef-ico"[^>]*stroke="currentColor"/);
      expect(svg, k).not.toMatch(emoji);
    }
  });

  it("draws the Town square's heading and rows without emoji", () => {
    const entry: WorkspaceEntry = {
      key: "k1", urgency: "failure", origin: "health", text: "Health: hook not configured", at: 0, score: 60,
      held: false, since: 0, occurrences: 1, districts: [], agentIds: [], reason: "failure",
    };
    const tops: WorkspaceEntry[][] = [[entry], []];
    for (const top of tops) {
      const { html } = workspaceTopHtml(top);
      expect(html).toContain("Town square");
      expect(html).toContain('<svg class="alef-ico"');
      expect(html).not.toMatch(emoji);
    }
  });
});
