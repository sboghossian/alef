import { describe, expect, it } from "vitest";
import type { ArchiveSummary } from "../../../shared/features/archive";
import type { CensusGenerations } from "../../../shared/features/census";
import type { VisionClaim } from "../../../shared/features/vision";
import { computeSessionsTotal, generationChain, prUrl, visionGroups, visionHeadline, visionLabel } from "./census-lib";

function archiveSummary(total: number, over: Partial<ArchiveSummary> = {}): ArchiveSummary {
  return { generatedAt: "2026-09-28T03:21:00Z", files: total, parsed: total, skipped: 0, duplicates: 0, skippedLive: 0, total, homeIslandId: "me", vault: "vault", places: [], ...over };
}

describe("computeSessionsTotal", () => {
  it("is unknown (never a fabricated 0) while the archive summary hasn't landed", () => {
    expect(computeSessionsTotal(267, null)).toEqual({ known: false });
  });

  it("sums agents.length + archive.summary.total once both are in (real TODAY numbers)", () => {
    expect(computeSessionsTotal(267, archiveSummary(1782))).toEqual({ known: true, total: 2049, indexed: 267, fossils: 1782 });
  });

  it("still known with 0 live agents (a fresh boot with only fossils)", () => {
    expect(computeSessionsTotal(0, archiveSummary(5))).toEqual({ known: true, total: 5, indexed: 0, fossils: 5 });
  });
});

function gen(over: Partial<CensusGenerations> = {}): CensusGenerations {
  return { total: 1106, since: "2026-09-07T02:16:00.000Z", byDepth: { 1: 1071, 2: 35 }, generations: 3, parents: 109, ...over };
}

describe("generationChain", () => {
  it("renders parents -> depth 1 -> depth 2 in order (real TODAY numbers)", () => {
    expect(generationChain(gen())).toEqual(["109 sessions", "1,071 children", "35 grandchildren"]);
  });

  it("falls back to a generic label past great-grandchildren", () => {
    expect(generationChain(gen({ byDepth: { 1: 2, 2: 1, 3: 1, 4: 1 }, parents: 1 }))).toEqual(["1 session", "2 children", "1 grandchild", "1 great-grandchild", "1 depth-4 descendant"]);
  });

  it("is empty when nothing has been folded in yet", () => {
    expect(generationChain(gen({ total: 0, byDepth: {}, generations: 0, parents: 0, since: null }))).toEqual([]);
  });

  it("only lists depths that actually occur", () => {
    expect(generationChain(gen({ total: 3, byDepth: { 1: 3 }, generations: 2, parents: 2 }))).toEqual(["2 sessions", "3 children"]);
  });
});

describe("prUrl", () => {
  it("is built from the repo slug and the PR number alone", () => {
    expect(prUrl("sboghossian/agent-world", 37)).toBe("https://github.com/sboghossian/agent-world/pull/37");
  });
});

function claim(over: Partial<VisionClaim> = {}): VisionClaim {
  return { n: 4, text: "2,051 sessions have lived there", status: "real", effective: "real", evidence: "e", probe: null, auditedAt: "2026-09-28", auditedBy: "t", probeResult: null, ...over };
}

describe("visionLabel", () => {
  const time = (iso: string): string => iso.slice(11, 16);
  it("an audited status says 'audited <date>'", () => {
    expect(visionLabel(claim(), time)).toBe("audited 2026-09-28");
  });
  it("a probe that re-checked it says 'probe ✓ <time>'", () => {
    const c = claim({ probe: "census-sessions", probeResult: { id: "census-sessions", state: "pass", detail: "d", at: "2026-09-28T13:05:00.000Z" } });
    expect(visionLabel(c, time)).toBe("probe ✓ 13:05");
  });
  it("a failed probe says what the audit was and what it is now", () => {
    const c = claim({ probe: "census-merged", effective: "partial", probeResult: { id: "census-merged", state: "fail", detail: "d", at: "2026-09-28T13:05:00.000Z" } });
    expect(visionLabel(c, time)).toBe("probe ✗ 13:05: audited real, now partial");
  });
  it("a pending probe leaves the audit label, marked pending", () => {
    const c = claim({ probe: "sickness", probeResult: { id: "sickness", state: "pending", detail: "d", at: "2026-09-28T13:05:00.000Z" } });
    expect(visionLabel(c, time)).toBe("audited 2026-09-28 · probe pending");
  });
});

describe("visionGroups / visionHeadline", () => {
  it("groups by the status that counts (a downgraded row moves), in row order", () => {
    const g = visionGroups([claim({ n: 14, effective: "partial" }), claim({ n: 3 }), claim({ n: 41, status: "metaphor", effective: "metaphor" }), claim({ n: 1 })]);
    expect(g.real.map((c) => c.n)).toEqual([1, 3]);
    expect(g.partial.map((c) => c.n)).toEqual([14]);
    expect(g.missing).toEqual([]);
    expect(g.metaphor.map((c) => c.n)).toEqual([41]);
  });
  it("the headline is never a bare 0% when nothing is scored", () => {
    expect(visionHeadline(75, 55.3)).toBe("75.0% runs today · strict 55.3%");
    expect(visionHeadline(null, null)).toBe("Not scored: no claim counts yet.");
  });
});
