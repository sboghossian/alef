import { describe, expect, it } from "vitest";
import type { AgentActivity, WorldAgent, WorldObject } from "../../../shared/types";
import type { MetricSeries } from "../../../shared/features/metrics";
import type { FlagStore } from "../ui/kit";
import {
  BAR_CHIPS,
  METRIC_META,
  READOUTS,
  Remembered,
  SHELL_KEY_PREFIX,
  drawerNumbers,
  formatClockTime,
  formatMetricValue,
  nearestPointIndex,
  moreLabel,
  readoutsHtml,
  rememberedChoice,
  scalePoints,
  seriesLatest,
  statusNumbers,
  trayAlerts,
} from "./status-lib";
import { RIGHT_TABS } from "./views";

function mem(): FlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
const today = new Date(2026, 8, 25, 9, 0, 0).toISOString();
const old = new Date(2026, 8, 20, 9, 0, 0).toISOString();
const ag = (id: string, city: string, status: "live" | "dormant", last: string, awaiting = false): WorldAgent =>
  ({ id, islandId: city, status, lastActive: last, awaitingInput: awaiting, title: id }) as WorldAgent;

describe("status drawer state", () => {
  it("remembers open/closed and survives blocked storage", () => {
    const s = mem();
    const d = new Remembered(s, "drawer", false);
    expect(d.get()).toBe(false);
    expect(d.toggle()).toBe(true);
    expect(s.data.get(`${SHELL_KEY_PREFIX}drawer`)).toBe("1");
    expect(new Remembered(s, "drawer", false).get()).toBe(true);
    d.reset();
    expect(new Remembered(s, "drawer", false).get()).toBe(false);
    const blocked: FlagStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const b = new Remembered(blocked, "drawer", true);
    expect(b.get()).toBe(true);
    expect(b.toggle()).toBe(false);
    expect(new Remembered(null, "x", false).get()).toBe(false);
  });

  it("remembers a tab choice, ignoring values it doesn't know", () => {
    const s = mem();
    const tab = rememberedChoice(s, "tab", ["feed", "inbox"] as const, "feed");
    tab.set("inbox");
    expect(rememberedChoice(s, "tab", ["feed", "inbox"] as const, "feed").get()).toBe("inbox");
    s.data.set(`${SHELL_KEY_PREFIX}tab`, "nope");
    expect(rememberedChoice(s, "tab", ["feed", "inbox"] as const, "feed").get()).toBe("feed");
  });

  it("a stored alef.shell.tab=inbox (the tab is gone, UX-1) opens on the Feed", () => {
    const s = mem();
    s.data.set("alef.shell.tab", "inbox");
    expect(rememberedChoice(s, "tab", RIGHT_TABS, "feed").get()).toBe("feed");
  });
});

describe("status numbers", () => {
  it("counts from real data only", () => {
    const n = statusNumbers({
      cities: 3,
      agents: [ag("a", "c1", "live", today), ag("b", "c1", "dormant", old)],
      edges: [{ from: "a", to: "b", kind: "visited", weight: 1 }] as never,
      stats: { liveCount: 1, awaitingCount: 0, tokensToday: null },
      subagents: [{ status: "running" }, { status: "done" }],
    });
    expect(n).toEqual({ cities: 3, agents: 2, live: 1, waiting: 0, links: 1, tokensToday: null, subagents: 2, subagentsLive: 1 });
  });

  it("builds the drawer: today/sleeping, kinds, busiest cities, decisions today, last line", () => {
    const line: AgentActivity = { id: "l", agentId: "a", at: today, stage: "tool", toolName: "Edit", targetObjectId: null, summary: "Edited x" };
    const d = drawerNumbers({
      agents: [ag("a", "c1", "live", today), ag("b", "c2", "dormant", today, true), ag("c", "c3", "dormant", old), ag("h", "harness", "live", today)],
      objects: [{ kind: "file" }, { kind: "skill" }, { kind: "skill" }, { kind: "mcp" }, { kind: "hook" }] as WorldObject[],
      decisionsAt: [today, old, "bad"],
      activities: [line],
      now: NOW,
    });
    expect(d.activeToday).toBe(3);
    expect(d.sleeping).toBe(1);
    expect(d.byKind).toEqual({ files: 1, skills: 2, hooks: 1, mcps: 1 });
    expect(d.topCities.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(d.decisionsToday).toBe(1);
    expect(d.lastLine?.summary).toBe("Edited x");
    expect(drawerNumbers({ agents: [], objects: [], decisionsAt: [], activities: [], now: NOW }).lastLine).toBeNull();
  });
});

describe("metrics dock (pure)", () => {
  it("scalePoints: empty series maps to no points", () => {
    expect(scalePoints([], 34, 12)).toEqual([]);
  });

  it("scalePoints: an all-zero series draws a flat line at the floor, not NaN", () => {
    const scaled = scalePoints(
      [
        { t: 0, v: 0 },
        { t: 1, v: 0 },
      ],
      34,
      12,
      2,
    );
    expect(scaled.every((p) => Number.isFinite(p.y))).toBe(true);
    expect(scaled[0]!.y).toBe(scaled[1]!.y);
  });

  it("scalePoints: a single point sits at the left padding, scaled to the height", () => {
    const scaled = scalePoints([{ t: 5, v: 10 }], 34, 12, 2);
    expect(scaled).toHaveLength(1);
    expect(scaled[0]!.x).toBe(2);
    expect(scaled[0]!.t).toBe(5);
  });

  it("scalePoints: the max value touches the top padding", () => {
    const scaled = scalePoints(
      [
        { t: 0, v: 0 },
        { t: 1, v: 10 },
      ],
      100,
      20,
      2,
    );
    expect(scaled[1]!.y).toBe(2); // top padding
    expect(scaled[0]!.y).toBe(18); // bottom (height - padding)
  });

  it("nearestPointIndex: -1 for an empty series, else the closest x", () => {
    expect(nearestPointIndex([], 5)).toBe(-1);
    const scaled = [
      { x: 0, y: 0, t: 0, v: 0 },
      { x: 10, y: 0, t: 1, v: 0 },
      { x: 20, y: 0, t: 2, v: 0 },
    ];
    expect(nearestPointIndex(scaled, 14)).toBe(1);
    expect(nearestPointIndex(scaled, 16)).toBe(2);
    expect(nearestPointIndex(scaled, -5)).toBe(0);
  });

  it("seriesLatest: last point's value, null when empty", () => {
    const series = (points: MetricSeries["points"]): MetricSeries => ({ key: "tokens", label: "Tokens", unit: "", kind: "bar", points });
    expect(seriesLatest(series([{ t: 0, v: 3 }, { t: 1, v: 7 }]))).toBe(7);
    expect(seriesLatest(series([]))).toBeNull();
  });

  it("formatMetricValue: reuses formatTokens for tokens, dollars for costUsd, rounds counts", () => {
    expect(formatMetricValue("tokens", 12_345)).toBe("12.3k");
    expect(formatMetricValue("costUsd", 4.2)).toBe("$4.20");
    expect(formatMetricValue("costUsd", 42)).toBe("$42.0");
    expect(formatMetricValue("cpuLoad", 1.238)).toBe("1.24");
    expect(formatMetricValue("memUsedPct", 63.6)).toBe("64%");
    expect(formatMetricValue("liveAgents", 3.2)).toBe("3");
    expect(formatMetricValue("liveAgents", NaN)).toBe("–");
  });

  it("formatClockTime: HH:MM, with a weekday prefix only for the 7d view", () => {
    const t = new Date(2026, 8, 25, 9, 5).getTime(); // a Friday
    expect(formatClockTime(t, "1h")).toBe("09:05");
    expect(formatClockTime(t, "24h")).toBe("09:05");
    expect(formatClockTime(t, "7d")).toBe("Fri 09:05");
  });

  it("METRIC_META covers every metric key with a non-empty icon/label/color", () => {
    const keys: Array<keyof typeof METRIC_META> = ["tokens", "costUsd", "liveAgents", "waitingAgents", "toolCalls", "subagentsActive", "cpuLoad", "memUsedPct"];
    for (const k of keys) {
      expect(METRIC_META[k].icon.length).toBeGreaterThan(0);
      expect(METRIC_META[k].short.length).toBeGreaterThan(0);
      expect(METRIC_META[k].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("the bar vs the drawer (UX-8)", () => {
  it("keeps only live / waiting as readouts in the bar; everything else waits in the drawer's tray", () => {
    const bar = readoutsHtml("bar");
    expect([...bar.matchAll(/<b id="([\w-]+)"/g)].map((m) => m[1])).toEqual(["sb-live", "sb-total", "sb-await"]);
    const tray = readoutsHtml("tray");
    for (const id of ["sb-cities", "sb-subs", "sb-links", "sb-tokens", "sb-toolcalls", "sb-cpu", "sb-mem", "sb-jev"]) expect(tray).toContain(`id="${id}"`);
    expect(bar.match(/class="sb-item[ "]/g)).toHaveLength(2);
  });

  it("makes the waiting count a button that opens Needs you now (UX-1)", () => {
    const bar = readoutsHtml("bar");
    expect(bar).toMatch(/<button type="button" class="sb-item sb-btn sb-act" data-action="needs"[^>]*>.*id="sb-await"/);
    expect(readoutsHtml("tray")).not.toContain("data-action");
  });

  it("shows cost today once: the usage chip in the bar, no second readout anywhere", () => {
    expect(BAR_CHIPS).toEqual(["hud-f-usage-chip", "hud-f-completeness-chip"]);
    expect(READOUTS.some((r) => /sb-cost|costUsd/.test(r.html))).toBe(false);
  });

  it("puts a dot on more for each drawer alert chip showing, and says which", () => {
    const chips = [
      { hidden: true, alert: "battery low" },
      { hidden: false, alert: "sick cases" },
    ];
    expect(trayAlerts(chips)).toEqual(["sick cases"]);
    expect(trayAlerts([{ hidden: true, alert: "battery low" }])).toEqual([]);
    expect(moreLabel([])).toBe("More numbers");
    expect(moreLabel(["battery low", "sick cases"])).toBe("More numbers (battery low, sick cases)");
  });

  it("every readout id is unique", () => {
    const ids = READOUTS.flatMap((r) => [...r.html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
