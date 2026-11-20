import { describe, expect, it } from "vitest";
import type { WorldAgent } from "../../../shared/types";
import { activityScore, boardColumn, cityStats, startOfLocalDay } from "./world";

const NOW = new Date(2026, 8, 24, 15, 0, 0).getTime(); // local 15:00
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

const agent = (id: string, islandId: string, extra: Partial<WorldAgent> = {}): WorldAgent => ({
  id,
  islandId,
  cwd: "/x",
  title: id,
  status: "dormant",
  startedAt: iso(48 * HOUR),
  lastActive: iso(30 * HOUR),
  messageCount: 1,
  model: "claude-opus-5-5",
  role: "builder",
  color: "#2563eb",
  targetIslandId: islandId,
  tokens: 100,
  awaitingInput: false,
  ...extra,
});

describe("cityStats", () => {
  it("counts agents, live, awaiting, today and tokens per city", () => {
    const stats = cityStats(
      [
        agent("a", "web", { status: "live", lastActive: iso(HOUR), tokens: 1000 }),
        agent("b", "web", { status: "live", awaitingInput: true, lastActive: iso(2 * HOUR) }),
        agent("c", "web"),
        agent("d", "docs", { tokens: Number.NaN }),
      ],
      NOW,
    );
    expect(stats.get("web")).toMatchObject({ agents: 3, live: 2, awaiting: 1, activeToday: 2, tokens: 1200 });
    expect(stats.get("docs")).toMatchObject({ agents: 1, live: 0, activeToday: 0, tokens: 0 });
  });

  it("tolerates agents from an older server without tokens / awaitingInput", () => {
    const legacy = agent("x", "web");
    const partial: Partial<WorldAgent> = { ...legacy };
    delete partial.tokens;
    delete partial.awaitingInput;
    const stats = cityStats([partial as WorldAgent], NOW);
    expect(stats.get("web")).toMatchObject({ agents: 1, awaiting: 0, tokens: 0 });
  });

  it("returns an empty map for no agents", () => {
    expect(cityStats([], NOW).size).toBe(0);
  });
});

describe("activityScore", () => {
  it("ranks waiting > live > today > recency", () => {
    const base = { agents: 1, tokens: 0 };
    const waiting = activityScore({ ...base, live: 0, awaiting: 1, activeToday: 0, lastActive: 1 });
    const live = activityScore({ ...base, live: 3, awaiting: 0, activeToday: 0, lastActive: NOW });
    const today = activityScore({ ...base, live: 0, awaiting: 0, activeToday: 5, lastActive: NOW });
    const old = activityScore({ ...base, live: 0, awaiting: 0, activeToday: 0, lastActive: NOW });
    expect(waiting).toBeGreaterThan(live);
    expect(live).toBeGreaterThan(today);
    expect(today).toBeGreaterThan(old);
    expect(activityScore(undefined)).toBe(0);
  });
});

describe("boardColumn", () => {
  it("sorts agents into the four board columns", () => {
    expect(boardColumn(agent("a", "w", { awaitingInput: true, status: "live" }), NOW)).toBe("waiting");
    expect(boardColumn(agent("a", "w", { status: "live" }), NOW)).toBe("working");
    expect(boardColumn(agent("a", "w", { lastActive: iso(HOUR) }), NOW)).toBe("today");
    expect(boardColumn(agent("a", "w", { lastActive: iso(40 * HOUR) }), NOW)).toBe("sleeping");
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 8, 24).getTime());
  });
});
