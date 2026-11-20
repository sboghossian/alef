import { describe, expect, it } from "vitest";
import { countActiveBindings, dispatchStartedText, parseStranded, resumeOfferFor } from "./talk";

describe("countActiveBindings", () => {
  it("counts only bindings with a non-null agentId — a dispatch still waiting for its first transcript doesn't count", () => {
    const bindings = [
      { agentId: null, tmuxName: "aw-aaaaaaaa", cwd: "/repo", startedAt: "2026-09-26T08:33:12.168Z" },
      { agentId: "7d3f0c2a-aaaa-4bbb-8ccc-ddddeeeeffff", tmuxName: "aw-bbbbbbbb", cwd: "/repo", startedAt: "2026-09-26T08:33:12.168Z" },
    ];
    expect(countActiveBindings(bindings)).toBe(1);
  });

  it("is zero for an empty list or one made entirely of unadopted dispatches", () => {
    expect(countActiveBindings([])).toBe(0);
    expect(countActiveBindings([{ agentId: null, tmuxName: "aw-aaaaaaaa", cwd: "/repo", startedAt: "2026-09-26T08:33:12.168Z" }])).toBe(0);
  });
});

describe("parseStranded", () => {
  const good = {
    tmuxName: "aw-68597ce4",
    cwd: "/Users/alexboghossian/Documents/Code/acme-www",
    startedAt: "2026-09-26T08:33:12.168Z",
    blockedOn: "empty-prompt",
    closable: false,
    promptHead: "Open PR aligning acme.ai FAQ 'end-to-end encryption' + homepage",
    lastLine: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
  };

  it("keeps well-formed entries, including null promptHead/lastLine", () => {
    expect(parseStranded([good])).toEqual([good]);
    expect(parseStranded([{ ...good, promptHead: null, lastLine: null }])).toEqual([{ ...good, promptHead: null, lastLine: null }]);
  });

  it("drops entries with an unknown blockedOn or a wrong field type", () => {
    expect(parseStranded([{ ...good, blockedOn: "onFire" }])).toEqual([]);
    expect(parseStranded([{ ...good, cwd: 5 }])).toEqual([]);
    expect(parseStranded([{ ...good, promptHead: 5 }])).toEqual([]);
    expect(parseStranded([{ ...good, closable: "yes" }])).toEqual([]);
    const { closable: _closable, ...noClosable } = good;
    expect(parseStranded([noClosable])).toEqual([]);
  });

  it("is empty for anything that isn't an array", () => {
    expect(parseStranded(null)).toEqual([]);
    expect(parseStranded(undefined)).toEqual([]);
    expect(parseStranded("nope")).toEqual([]);
  });
});

describe("dispatchStartedText", () => {
  it("says tmux started it and that the house comes with the first line", () => {
    const t = dispatchStartedText({ ok: true, mode: "tmux", tmuxName: "aw-5c67d47b" });
    expect(t).toBe("Started in tmux aw-5c67d47b: Stop, Talk and the Screen reach it. It becomes a house once Claude writes its first line.");
    expect(t).not.toMatch(/Launched|Done/);
  });

  it("says when claude is waiting on its trust dialog, from the server's answer", () => {
    const t = dispatchStartedText({ ok: true, mode: "tmux", tmuxName: "aw-5c67d47b", waitingOn: "trust", cwd: "/Users/s/Code/legal-taxonomy" });
    expect(t).toContain("Claude is waiting on its trust dialog for legal-taxonomy");
  });
});

describe("resumeOfferFor", () => {
  // No /api/talk/status answer yet in this test module: no bindings, tmux not known to be missing.
  it("never offers Resume for a live agent outside a world tmux session (a second copy, probe 2026-09-28)", () => {
    expect(resumeOfferFor("a9c4eac1-0000-4000-8000-000000000000", "live")).toBe("running-elsewhere");
  });

  it("offers Resume for a dormant or unknown agent", () => {
    expect(resumeOfferFor("a9c4eac1-0000-4000-8000-000000000000", "dormant")).toBe("resume");
    expect(resumeOfferFor("a9c4eac1-0000-4000-8000-000000000000", undefined)).toBe("resume");
  });
});
