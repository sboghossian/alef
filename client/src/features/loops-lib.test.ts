import { describe, expect, it } from "vitest";
import type { LoopsBoard, LoopsItem } from "../../../shared/features/loops";
import { filterLoopsItems, groupLoopsByLens, launchFailureReason, launchToast, loopsSourceLabel, orderedLoopsItems, parseLoopsBoard, stepLaunchConfirm } from "./loops-lib";

const item = (over: Partial<LoopsItem> = {}): LoopsItem => ({
  id: "id1",
  task: "Ship the thing",
  project: "demo",
  lens: "do_today",
  score: 80,
  sources: ["whatsup"],
  sourceType: "todo_md",
  updatedAt: null,
  openPath: null,
  launchCwd: null,
  ...over,
});

describe("parseLoopsBoard", () => {
  it("parses a well-formed board", () => {
    const wire = {
      generatedAt: "2026-09-25T08:00:00.000Z",
      items: [item()],
      badge: 1,
      whatsupOk: true,
      whatsupError: null,
    };
    expect(parseLoopsBoard(wire)).toEqual(wire);
  });

  it("returns null for non-objects and for missing top-level fields", () => {
    expect(parseLoopsBoard(null)).toBeNull();
    expect(parseLoopsBoard("nope")).toBeNull();
    expect(parseLoopsBoard({ items: [] })).toBeNull(); // no generatedAt/badge/whatsupOk
  });

  it("drops individual items with an unknown lens or missing required fields, keeping the good ones", () => {
    const wire = {
      generatedAt: "2026-09-25T08:00:00.000Z",
      items: [item({ id: "good" }), { id: "bad-lens", task: "x", project: "p", lens: "not_real", score: 1, sources: [] }, { task: "no id", project: "p", lens: "do_today", sources: [] }],
      badge: 1,
      whatsupOk: true,
      whatsupError: null,
    };
    const board = parseLoopsBoard(wire);
    expect(board?.items.map((i) => i.id)).toEqual(["good"]);
  });

  it("filters unknown source kinds out of an item's sources array", () => {
    const wire = { generatedAt: "t", items: [item({ sources: ["whatsup", "mystery" as never, "scan"] })], badge: 0, whatsupOk: true, whatsupError: null };
    expect(parseLoopsBoard(wire)?.items[0]?.sources).toEqual(["whatsup", "scan"]);
  });
});

describe("filterLoopsItems", () => {
  const items = [item({ id: "a", project: "brain-viz", task: "Cutover to v2" }), item({ id: "b", project: "acme", task: "Ship the landing page" })];

  it("keeps everything for an empty/whitespace query", () => {
    expect(filterLoopsItems(items, "")).toEqual(items);
    expect(filterLoopsItems(items, "   ")).toEqual(items);
  });

  it("matches case-insensitively on project or task", () => {
    expect(filterLoopsItems(items, "BRAIN").map((i) => i.id)).toEqual(["a"]);
    expect(filterLoopsItems(items, "landing").map((i) => i.id)).toEqual(["b"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterLoopsItems(items, "nonexistent")).toEqual([]);
  });
});

describe("groupLoopsByLens", () => {
  it("always returns every lens key, ranked lenses sorted by score desc", () => {
    const items = [item({ id: "low", lens: "do_today", score: 10, task: "b" }), item({ id: "high", lens: "do_today", score: 90, task: "a" })];
    const groups = groupLoopsByLens(items);
    expect([...groups.keys()]).toEqual(["do_today", "high_leverage", "one_step", "waiting", "unranked"]);
    expect(groups.get("do_today")?.map((i) => i.id)).toEqual(["high", "low"]);
    expect(groups.get("waiting")).toEqual([]);
  });

  it("sorts the unranked lens by recency, newest first", () => {
    const items = [
      item({ id: "old", lens: "unranked", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "new", lens: "unranked", updatedAt: "2026-09-01T00:00:00.000Z" }),
      item({ id: "none", lens: "unranked", updatedAt: null }),
    ];
    expect(groupLoopsByLens(items).get("unranked")?.map((i) => i.id)).toEqual(["new", "old", "none"]);
  });

  it("breaks a score tie by task text", () => {
    const items = [item({ id: "b", task: "banana", score: 50 }), item({ id: "a", task: "apple", score: 50 })];
    expect(groupLoopsByLens(items).get("do_today")?.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("orderedLoopsItems", () => {
  const board = (items: LoopsItem[]): LoopsBoard => ({ generatedAt: "t", items, badge: 0, whatsupOk: true, whatsupError: null });

  it("returns [] for a null board", () => {
    expect(orderedLoopsItems(null)).toEqual([]);
  });

  it("flattens every lens in board order, matching groupLoopsByLens' own ranking within each lens", () => {
    const items = [
      item({ id: "wait1", lens: "waiting", score: 5 }),
      item({ id: "today-low", lens: "do_today", score: 10 }),
      item({ id: "today-high", lens: "do_today", score: 90 }),
      item({ id: "step1", lens: "one_step", score: 20 }),
    ];
    expect(orderedLoopsItems(board(items)).map((i) => i.id)).toEqual(["today-high", "today-low", "step1", "wait1"]);
  });

  it("is exactly the flattening of groupLoopsByLens, so the Loops tab and the quick prompt can't disagree", () => {
    const items = [item({ id: "a", lens: "unranked", updatedAt: "2026-01-01T00:00:00.000Z" }), item({ id: "b", lens: "high_leverage", score: 40 })];
    const groups = groupLoopsByLens(items);
    const expected = [...groups.values()].flat().map((i) => i.id);
    expect(orderedLoopsItems(board(items)).map((i) => i.id)).toEqual(expected);
  });
});

describe("loopsSourceLabel", () => {
  it("labels each combination", () => {
    expect(loopsSourceLabel(["whatsup"])).toBe("whatsup");
    expect(loopsSourceLabel(["scan"])).toBe("scan");
    expect(loopsSourceLabel(["whatsup", "scan"])).toBe("whatsup + scan");
  });
});

describe("stepLaunchConfirm", () => {
  it("arms on the first click, fires on a second click within the window, and clears afterwards", () => {
    const step1 = stepLaunchConfirm(new Map(), "x", 1000, 4000);
    expect(step1.fire).toBe(false);
    expect(step1.pending.has("x")).toBe(true);

    const step2 = stepLaunchConfirm(step1.pending, "x", 2000, 4000);
    expect(step2.fire).toBe(true);
    expect(step2.pending.has("x")).toBe(false);
  });

  it("does not fire, and re-arms instead, once the confirm window has elapsed", () => {
    const step1 = stepLaunchConfirm(new Map(), "x", 1000, 4000);
    const step2 = stepLaunchConfirm(step1.pending, "x", 1000 + 4000, 4000); // exactly at the edge: expired
    expect(step2.fire).toBe(false);
    expect(step2.pending.get("x")).toBe(1000 + 4000);
  });

  it("tracks each id independently", () => {
    const step1 = stepLaunchConfirm(new Map(), "a", 1000);
    const step2 = stepLaunchConfirm(step1.pending, "b", 1000);
    expect(step2.fire).toBe(false);
    expect(step2.pending.has("a")).toBe(true);
    expect(step2.pending.has("b")).toBe(true);
    const step3 = stepLaunchConfirm(step2.pending, "a", 1500);
    expect(step3.fire).toBe(true);
    expect(step3.pending.has("b")).toBe(true); // b's own arm is untouched
  });
});

describe("launchToast", () => {
  const ok = { ok: true, mode: "tmux" as const, tmuxName: "aw-5c67d47b", cwd: "/Users/s/Documents/Code/acme-www" };
  const started = "Started (plan mode) in tmux aw-5c67d47b: Stop, Talk and the Screen reach it.";

  // 2026-09-28: aw-5c67d47b and aw-e10a9ec9 sat on this dialog while the toast said "Launched".
  it("waiting on the trust dialog (seen in its pane at launch): names the folder and stays up", () => {
    const t = launchToast({ ...ok, trust: "untrusted", waitingOn: "trust" });
    expect(t).toEqual({
      text: `${started} Claude is waiting on its trust dialog for acme-www: nothing runs until you trust the folder (button here or in the Inbox) or answer it in Terminal.`,
      kind: "error",
    });
  });

  it("untrusted but no dialog seen yet: says what to pick if it asks, error-styled so it stays up", () => {
    const t = launchToast({ ...ok, trust: "untrusted" });
    expect(t).toEqual({ text: `${started} Claude hasn't trusted acme-www yet: if it asks, pick Yes, I trust this folder in Terminal, or nothing will run.`, kind: "error" });
  });

  it("unknown: says how to answer a trust question if one comes", () => {
    expect(launchToast({ ...ok, trust: "unknown" })).toEqual({ text: `${started} If Claude asks whether you trust the folder, answer it there.`, kind: "info" });
  });

  it("an older server with no trust field (or a garbage one) reads as unknown, never as trusted", () => {
    expect(launchToast(ok)).toEqual(launchToast({ ...ok, trust: "unknown" }));
    expect(launchToast({ ...ok, trust: "yes" })).toEqual(launchToast({ ...ok, trust: "unknown" }));
  });

  it("trusted: a plain started line", () => {
    expect(launchToast({ ...ok, trust: "trusted" })).toEqual({ text: started, kind: "info" });
  });

  it("a Terminal that didn't open is said, and stays up: claude still runs in tmux", () => {
    const t = launchToast({ ...ok, trust: "trusted", warning: "couldn't open Terminal (-1743); it's running in tmux aw-5c67d47b: use Attach or the Screen" });
    expect(t.kind).toBe("error");
    expect(t.text).toBe(`${started} Couldn't open Terminal (-1743); it's running in tmux aw-5c67d47b: use Attach or the Screen.`);
  });

  it("a repeat click within the repeat window says nothing new was launched", () => {
    expect(launchToast({ ...ok, trust: "trusted", reused: true }).text).toBe("Already started as aw-5c67d47b, so nothing new was launched.");
  });

  it("never says Launched or Done", () => {
    for (const trust of ["trusted", "untrusted", "unknown"]) expect(launchToast({ ...ok, trust }).text).not.toMatch(/Launched|Done/);
  });

  it("falls back to 'this folder' without a cwd", () => {
    expect(launchToast({ ok: true, mode: "tmux", tmuxName: "aw-x", trust: "untrusted" }).text).toContain("Claude hasn't trusted this folder yet");
  });

  it("failure: 'Couldn't launch: <reason>' with the server's own reason", () => {
    expect(launchToast({ ok: false, error: "Alef is still reading your loops after a restart. Try again in a few seconds." })).toEqual({
      text: "Couldn't launch: Alef is still reading your loops after a restart. Try again in a few seconds.",
      kind: "error",
    });
    expect(launchToast({ ok: false }).text).toBe("Couldn't launch: unknown error");
  });

  it("failure mentioning osascript: says the session may still have started and where to look", () => {
    const t = launchToast({ ok: false, error: "Error: Command failed: osascript -e tell application \"Terminal\" to do script" });
    expect(t.kind).toBe("error");
    expect(t.text).toContain("Couldn't launch: Error: Command failed: osascript");
    expect(t.text).toMatch(/The session may still have started: check Inbox › Started from Alef but never began\.$/);
  });

  // The exact error string a throwaway server (osascript shim exiting 1) returned on 2026-09-28.
  it("shows osascript's own error, not the command line, for a refused Terminal attach", () => {
    const real =
      "Error: Command failed: osascript -e tell application \"Terminal\" to do script \"'/opt/homebrew/bin/tmux' attach -t 'aw-a7cd977f'\"\n0:43: execution error: Not authorized to send Apple events to Terminal. (-1743)\n";
    expect(launchFailureReason(real)).toBe("osascript: 0:43: execution error: Not authorized to send Apple events to Terminal. (-1743)");
    expect(launchToast({ ok: false, error: real }).text).toBe(
      "Couldn't launch: osascript: 0:43: execution error: Not authorized to send Apple events to Terminal. (-1743) The session may still have started: check Inbox › Started from Alef but never began.",
    );
    expect(launchFailureReason("Error: Command failed: /opt/homebrew/bin/tmux new-session -d -s aw-x\nduplicate session: aw-x")).toBe("tmux: duplicate session: aw-x");
    expect(launchFailureReason("tmux is not installed")).toBe("tmux is not installed");
  });

  it("keeps the osascript hint even behind a very long reason", () => {
    const t = launchToast({ ok: false, error: `osascript ${"x".repeat(2000)}` });
    expect(t.text.length).toBeLessThan(400);
    expect(t.text).toContain("check Inbox › Started from Alef but never began.");
  });
});
