import { describe, expect, it } from "vitest";
import type { CouncilResult } from "../../shared/features/council.js";
import { loadCouncilHistory, pushCouncilHistory } from "../features/council-store.js";
import { makeTempDb, makeTempProjectsDir } from "./helpers.js";

function fakeResult(id: string, at: string): CouncilResult {
  return { id, at, decision: `decision ${id}`, options: ["a", "b"], personas: [], aggregate: { agreement: 0, split: {}, lowestConfidencePersona: null }, verdict: { ok: false }, source: "keyword" };
}

describe("council history (WorldDb meta table)", () => {
  it("is empty before anything is pushed", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    expect(loadCouncilHistory(db)).toEqual([]);
  });

  it("prepends newest first and round-trips through JSON", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    pushCouncilHistory(db, fakeResult("1", "2026-09-25T00:00:00.000Z"));
    const after = pushCouncilHistory(db, fakeResult("2", "2026-09-25T00:01:00.000Z"));
    expect(after.map((r) => r.id)).toEqual(["2", "1"]);
    expect(loadCouncilHistory(db).map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("caps at 20 entries", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    let last: CouncilResult[] = [];
    for (let i = 0; i < 25; i += 1) last = pushCouncilHistory(db, fakeResult(String(i), `2026-09-25T00:${String(i).padStart(2, "0")}:00.000Z`));
    expect(last).toHaveLength(20);
    expect(last[0]!.id).toBe("24"); // newest first
    expect(last[19]!.id).toBe("5"); // the oldest 5 (0..4) fell off
  });

  it("degrades to an empty list on corrupt stored JSON instead of throwing", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    db.setMeta("council.history", "{not json");
    expect(loadCouncilHistory(db)).toEqual([]);
  });

  it("round-trips a loop-round ref (a branch, or null for no pick) and keeps entries without one as they were", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    pushCouncilHistory(db, fakeResult("panel", "2026-09-25T00:00:00.000Z"));
    pushCouncilHistory(db, { ...fakeResult("nopick", "2026-09-28T10:00:00.000Z"), ref: { kind: "loop-round", branch: null } });
    pushCouncilHistory(db, { ...fakeResult("loop", "2026-09-28T11:00:00.000Z"), ref: { kind: "loop-round", branch: "feat/loop-governance" } });
    const back = loadCouncilHistory(db);
    expect(back.map((r) => r.id)).toEqual(["loop", "nopick", "panel"]);
    expect(back[0]!.ref).toEqual({ kind: "loop-round", branch: "feat/loop-governance" });
    expect(back[1]!.ref).toEqual({ kind: "loop-round", branch: null });
    expect("ref" in back[2]!).toBe(false);
    expect(back[2]).toEqual(fakeResult("panel", "2026-09-25T00:00:00.000Z"));
  });

  it("drops a stored ref that isn't a valid CouncilRef, keeping the rest of the entry", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    const bad = [
      { ...fakeResult("a", "2026-09-28T11:00:00.000Z"), ref: { kind: "loop-round", branch: "feat/x; rm -rf ~" } },
      { ...fakeResult("b", "2026-09-28T11:01:00.000Z"), ref: { kind: "panel", branch: "feat/x" } },
      { ...fakeResult("c", "2026-09-28T11:02:00.000Z"), ref: { kind: "loop-round", branch: "../../etc" } },
      { ...fakeResult("d", "2026-09-28T11:03:00.000Z"), ref: "feat/x" },
    ];
    db.setMeta("council.history", JSON.stringify(bad));
    const back = loadCouncilHistory(db);
    expect(back.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(back.every((r) => !("ref" in r))).toBe(true);
    expect(back[0]!.decision).toBe("decision a");
  });
});
