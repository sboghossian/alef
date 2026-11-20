import { describe, expect, it } from "vitest";
import type { ReplayEvent } from "../../shared/features/replay.js";
import { aggregateReport, completeLines, dayBoundsMs, sampleEvents } from "../features/replay-lib.js";

describe("dayBoundsMs", () => {
  it("returns local [start, end) 24h bounds for a valid date", () => {
    const bounds = dayBoundsMs("2026-09-24");
    expect(bounds).not.toBeNull();
    expect(bounds!.endMs - bounds!.startMs).toBe(24 * 60 * 60 * 1000);
    expect(new Date(bounds!.startMs).getDate()).toBe(24);
    expect(new Date(bounds!.startMs).getHours()).toBe(0);
  });

  it("rejects malformed date strings", () => {
    expect(dayBoundsMs("2026-9-24")).toBeNull();
    expect(dayBoundsMs("not-a-date")).toBeNull();
    expect(dayBoundsMs("")).toBeNull();
  });

  it("rejects a calendar-impossible date instead of silently normalizing it", () => {
    expect(dayBoundsMs("2026-02-30")).toBeNull();
    expect(dayBoundsMs("2026-13-01")).toBeNull();
  });
});

describe("sampleEvents", () => {
  it("returns everything untouched when under the cap", () => {
    const events = [1, 2, 3];
    expect(sampleEvents(events, 10)).toEqual({ sampled: [1, 2, 3], truncated: false });
  });

  it("downsamples evenly, keeps order, and always keeps the last event", () => {
    const events = Array.from({ length: 1000 }, (_, i) => i);
    const { sampled, truncated } = sampleEvents(events, 100);
    expect(truncated).toBe(true);
    expect(sampled).toHaveLength(100);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(999);
    // strictly increasing -> chronological order preserved
    for (let i = 1; i < sampled.length; i++) expect(sampled[i]).toBeGreaterThan(sampled[i - 1]!);
  });

  it("cap <= 0 returns everything untouched", () => {
    expect(sampleEvents([1, 2], 0)).toEqual({ sampled: [1, 2], truncated: false });
  });
});

function ev(partial: Partial<ReplayEvent>): ReplayEvent {
  return {
    id: partial.id ?? Math.random().toString(36),
    agentId: partial.agentId ?? "agent-1",
    islandId: partial.islandId ?? "acme-ai-next",
    at: partial.at ?? "2026-09-24T10:00:00.000Z",
    stage: partial.stage ?? "tool",
    toolName: partial.toolName ?? "Edit",
    targetObjectId: partial.targetObjectId ?? "file:/repo/a.ts",
    summary: partial.summary ?? "Edit a.ts",
  };
}

describe("aggregateReport", () => {
  it("counts sessions, per-city breakdown, and top files/tools/skills", () => {
    const events: ReplayEvent[] = [
      ev({ agentId: "a", islandId: "acme-ai-next", toolName: "Edit", targetObjectId: "file:/repo/a.ts" }),
      ev({ agentId: "a", islandId: "acme-ai-next", toolName: "Edit", targetObjectId: "file:/repo/a.ts" }),
      ev({ agentId: "b", islandId: "acme-ai-next", toolName: "Read", targetObjectId: "file:/repo/b.ts" }),
      ev({ agentId: "c", islandId: "agent-world", toolName: "Skill", targetObjectId: "skill:humanizer" }),
    ];
    const report = aggregateReport("2026-09-24", events, 12345, new Map([["acme-ai-next", "acme-ai-next"], ["agent-world", "Agent World"]]));
    expect(report.date).toBe("2026-09-24");
    expect(report.sessions).toBe(3);
    expect(report.tokens).toBe(12345);
    expect(report.events).toBe(4);
    expect(report.perCity).toEqual([
      { islandId: "acme-ai-next", name: "acme-ai-next", events: 3, sessions: 2 },
      { islandId: "agent-world", name: "Agent World", events: 1, sessions: 1 },
    ]);
    expect(report.topFiles[0]).toEqual({ name: "a.ts", count: 2 });
    expect(report.topTools.find((t) => t.name === "Edit")?.count).toBe(2);
    expect(report.topSkills).toEqual([{ name: "humanizer", count: 1 }]);
  });

  it("handles an empty day", () => {
    const report = aggregateReport("2026-09-24", [], 0, new Map());
    expect(report).toEqual({
      date: "2026-09-24",
      sessions: 0,
      tokens: 0,
      events: 0,
      perCity: [],
      topFiles: [],
      topTools: [],
      topSkills: [],
    });
  });
});

describe("completeLines", () => {
  it("consumes up to the last newline and leaves a half-written line for next time", () => {
    expect(completeLines(Buffer.from('{"a":1}\n{"b":'))).toEqual({ text: '{"a":1}\n', consumed: 8 });
    expect(completeLines(Buffer.from("no newline yet"))).toEqual({ text: "", consumed: 0 });
    expect(completeLines(Buffer.from(""))).toEqual({ text: "", consumed: 0 });
    const multi = Buffer.from('{"t":"é"}\n{"t":"ü');
    expect(completeLines(multi).consumed).toBe(Buffer.byteLength('{"t":"é"}\n'));
  });
});
