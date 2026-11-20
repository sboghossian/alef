import { describe, expect, it } from "vitest";
import type { AgentState } from "../../../shared/features/agent-state";
import { SESSION_OUTCOMES, type KnownOutcome } from "../../../shared/features/outcomes";
import type { WorldAgent } from "../../../shared/types";
import { outcomeChip } from "../features/outcomes";
import { boardAgents, columnFor, dayKey, groupHistoryByDayAndProject, historyDayKeys, historyDayLabel, outcomeCounts, STALE_WAITING_MS, staleReason } from "./board";

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
const today = new Date(2026, 8, 25, 9, 0, 0).toISOString();
const old = new Date(2026, 8, 20, 9, 0, 0).toISOString();
const ag = (id: string, city: string, status: "live" | "dormant", last: string, awaiting = false): WorldAgent =>
  ({ id, islandId: city, status, lastActive: last, awaitingInput: awaiting, title: id }) as WorldAgent;
const agents = [ag("w", "c1", "live", today), ag("q", "c2", "dormant", today, true), ag("t", "c1", "dormant", today), ag("s", "c2", "dormant", old)];
const ids = (m: Map<string, WorldAgent[]>, col: string): string[] => (m.get(col as never) ?? []).map((a) => a.id);
/** No agent-state answer for anyone: boardAgents/columnFor fall back to the lastActive/status heuristic. */
const noState = (): AgentState | undefined => undefined;

describe("Board view filters", () => {
  it("puts every agent in its column with no filters", () => {
    const m = boardAgents(agents, {}, NOW, noState);
    expect([ids(m, "working"), ids(m, "waiting"), ids(m, "today"), ids(m, "sleeping")]).toEqual([["w"], ["q"], ["t"], ["s"]]);
  });
  it("narrows by district, columns and time", () => {
    expect(ids(boardAgents(agents, { district: ["c1"] }, NOW, noState), "today")).toEqual(["t"]);
    expect(ids(boardAgents(agents, { district: ["c1"] }, NOW, noState), "waiting")).toEqual([]);
    const cols = boardAgents(agents, { columns: ["waiting"] }, NOW, noState);
    expect(ids(cols, "working")).toEqual([]);
    expect(ids(cols, "waiting")).toEqual(["q"]);
    expect(ids(boardAgents(agents, { time: ["today"] }, NOW, noState), "sleeping")).toEqual([]);
  });
});

describe("outcomeChip (round 2, graduation-badges)", () => {
  it("gives the 6 known outcomes their fixed emoji, in the spec's order", () => {
    expect(SESSION_OUTCOMES.filter((o) => outcomeChip(o) !== null)).toEqual(["shipped", "delivered", "failed", "stopped", "abandoned", "finished"]);
    expect(outcomeChip("shipped")).toEqual({ emoji: "🎓", label: "shipped" });
    expect(outcomeChip("delivered")).toEqual({ emoji: "📦", label: "delivered" });
    expect(outcomeChip("failed")).toEqual({ emoji: "✗", label: "failed" });
    expect(outcomeChip("stopped")).toEqual({ emoji: "⏸", label: "stopped" });
    expect(outcomeChip("abandoned")).toEqual({ emoji: "⌛", label: "abandoned" });
    expect(outcomeChip("finished")).toEqual({ emoji: "✓", label: "finished" });
  });
  it("shows no chip for active or unknown — a badge would overstate what's known", () => {
    expect(outcomeChip("active")).toBeNull();
    expect(outcomeChip("unknown")).toBeNull();
  });
});

describe("Board outcome filter and counts (round 2, graduation-badges)", () => {
  // A real-shaped lookup (session id -> verdict, missing ids mean no evidence yet), the same
  // contract client/src/features/outcomes.ts's outcomeOf has — not a stub that hands back
  // whatever the test under it expects.
  const outcomes = new Map<string, KnownOutcome>([
    ["w", "shipped"],
    ["q", "failed"],
    ["t", "finished"],
  ]);
  const outcomeOf = (id: string): KnownOutcome | null => outcomes.get(id) ?? null;

  it("keeps only agents with the picked outcome", () => {
    const m = boardAgents(agents, { outcome: ["shipped"] }, NOW, noState, outcomeOf);
    expect(ids(m, "working")).toEqual(["w"]);
    expect([ids(m, "waiting"), ids(m, "today"), ids(m, "sleeping")]).toEqual([[], [], []]);
  });

  it("'no outcome evidence' picks up every session with no recorded verdict, never the ones with a real one", () => {
    const m = boardAgents(agents, { outcome: ["unknown"] }, NOW, noState, outcomeOf);
    expect([...m.values()].flat().map((a) => a.id)).toEqual(["s"]);
  });

  it("counts every outcome, including the two with no card chip", () => {
    expect(outcomeCounts(agents, outcomeOf)).toEqual({ shipped: 1, delivered: 0, failed: 1, stopped: 0, abandoned: 0, finished: 1, active: 0, unknown: 1 });
  });
});

describe("columnFor: agent-state chip wins over the heuristic when it has an answer", () => {
  it("maps permission and waiting to the waiting-on-you column", () => {
    expect(columnFor(ag("a", "c1", "live", today), NOW, () => "permission")).toBe("waiting");
    expect(columnFor(ag("a", "c1", "live", today), NOW, () => "waiting")).toBe("waiting");
  });
  it("maps working to working, idle to today, sleeping to sleeping", () => {
    expect(columnFor(ag("a", "c1", "live", today), NOW, () => "working")).toBe("working");
    expect(columnFor(ag("a", "c1", "live", today), NOW, () => "idle")).toBe("today");
    expect(columnFor(ag("a", "c1", "live", today), NOW, () => "sleeping")).toBe("sleeping");
  });
  it("overrides a heuristic that disagrees with the chip", () => {
    // "w" looks like "working" by status alone, but its chip says it's actually waiting on you.
    expect(columnFor(ag("w", "c1", "live", today), NOW, () => "waiting")).toBe("waiting");
    // "s" looks "sleeping" by lastActive alone, but its chip says it's idle (live but quiet).
    expect(columnFor(ag("s", "c2", "dormant", old), NOW, () => "idle")).toBe("today");
  });
  it("falls back to the lastActive/status heuristic when agent-state has no answer", () => {
    expect(columnFor(ag("w", "c1", "live", today), NOW, noState)).toBe("working");
    expect(columnFor(ag("s", "c2", "dormant", old), NOW, noState)).toBe("sleeping");
  });
  it("boardAgents applies the same per-agent override across the whole board", () => {
    const stateOf = (id: string): AgentState | undefined => (id === "w" ? "waiting" : id === "s" ? "idle" : undefined);
    const m = boardAgents(agents, {}, NOW, stateOf);
    expect(ids(m, "working")).toEqual([]);
    expect(ids(m, "waiting")).toEqual(["w", "q"]);
    expect(ids(m, "today")).toEqual(["t", "s"]);
    expect(ids(m, "sleeping")).toEqual([]);
  });
});

describe("Board history (round 11, package D)", () => {
  const now = new Date(2026, 8, 26, 15, 0, 0).getTime(); // Sat 2026-09-26 15:00 local
  const iso = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();
  const hAgent = (id: string, city: string, status: "live" | "dormant", last: string): WorldAgent => ({ id, islandId: city, status, lastActive: last, title: id }) as WorldAgent;

  describe("dayKey", () => {
    it("formats a local calendar day, zero-padded", () => {
      expect(dayKey(new Date(2026, 0, 5, 23, 59).toISOString())).toBe("2026-01-05");
    });
  });

  describe("historyDayLabel", () => {
    it("says Yesterday for the day before now", () => {
      expect(historyDayLabel(dayKey(iso(2026, 9, 25)), now)).toBe("Yesterday");
    });
    it("otherwise a short weekday+date", () => {
      expect(historyDayLabel(dayKey(iso(2026, 9, 20)), now)).toMatch(/Sep 20/);
    });
  });

  describe("historyDayKeys", () => {
    const agents = [
      hAgent("live-today", "c1", "live", iso(2026, 9, 26)),
      hAgent("dormant-today", "c1", "dormant", iso(2026, 9, 26)),
      hAgent("yesterday", "c1", "dormant", iso(2026, 9, 25)),
      hAgent("last-week", "c2", "dormant", iso(2026, 9, 20)),
      hAgent("ancient", "c2", "dormant", iso(2026, 1, 1)),
    ];
    it("today: no history days at all (the 4 columns already cover today)", () => {
      expect(historyDayKeys(agents, "today", now)).toEqual([]);
    });
    it("week: the last 7 rolling days, excluding today, most recent first", () => {
      expect(historyDayKeys(agents, "week", now)).toEqual(["2026-09-25", "2026-09-20"]);
    });
    it("all: every distinct past day, excluding today, most recent first", () => {
      expect(historyDayKeys(agents, "all", now)).toEqual(["2026-09-25", "2026-09-20", "2026-01-01"]);
    });
    it("ignores agents with no parseable lastActive", () => {
      const bad = [...agents, hAgent("bad", "c1", "dormant", "not-a-date")];
      expect(historyDayKeys(bad, "all", now)).toEqual(historyDayKeys(agents, "all", now));
    });
  });

  describe("groupHistoryByDayAndProject", () => {
    it("groups finished sessions by day then project, biggest project first, newest agent first", () => {
      const agents = [
        hAgent("a1", "c1", "dormant", iso(2026, 9, 25, 9)),
        hAgent("a2", "c1", "dormant", iso(2026, 9, 25, 14)),
        hAgent("a3", "c2", "dormant", iso(2026, 9, 25, 10)),
        hAgent("a4", "c1", "dormant", iso(2026, 9, 20, 9)),
      ];
      const groups = groupHistoryByDayAndProject(agents, ["2026-09-25", "2026-09-20"]);
      expect(groups.map((g) => g.day)).toEqual(["2026-09-25", "2026-09-20"]);
      expect(groups[0]!.projects.map((p) => p.islandId)).toEqual(["c1", "c2"]); // c1 has 2, c2 has 1
      expect(groups[0]!.projects[0]!.agents.map((a) => a.id)).toEqual(["a2", "a1"]); // newest first
    });
    it("excludes live agents (they belong on the board above, not in history)", () => {
      const agents = [hAgent("live", "c1", "live", iso(2026, 9, 25)), hAgent("dormant", "c1", "dormant", iso(2026, 9, 25))];
      const groups = groupHistoryByDayAndProject(agents, ["2026-09-25"]);
      expect(groups[0]!.projects[0]!.agents.map((a) => a.id)).toEqual(["dormant"]);
    });
    it("omits a day with nothing in it rather than an empty group", () => {
      const agents = [hAgent("a1", "c1", "dormant", iso(2026, 9, 25))];
      expect(groupHistoryByDayAndProject(agents, ["2026-09-25", "2026-09-24"]).map((g) => g.day)).toEqual(["2026-09-25"]);
    });
  });
});

describe("Board stale cards (Draft a fix)", () => {
  const at = (msAgo: number): Pick<WorldAgent, "lastActive"> => ({ lastActive: new Date(NOW - msAgo).toISOString() });
  it("flags a failed or abandoned card whatever its column", () => {
    expect(staleReason(at(60_000), "today", "failed", NOW)).toBe("failed");
    expect(staleReason(at(60_000), "sleeping", "abandoned", NOW)).toBe("abandoned");
  });
  it("flags a card waiting on you for STALE_WAITING_MS, not before, and never a shipped one in another column", () => {
    expect(staleReason(at(STALE_WAITING_MS - 60_000), "waiting", null, NOW)).toBeNull();
    expect(staleReason(at(3 * 3_600_000), "waiting", null, NOW)).toBe("waiting on you for 3h");
    expect(staleReason(at(3 * 3_600_000), "today", "shipped", NOW)).toBeNull();
  });
});
