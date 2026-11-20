import { describe, expect, it } from "vitest";
import type { SystemResponse } from "../../shared/features/system.js";
import { ageStatus, ageText, loadStatus, redactSystem, settle, statusFromRatio, unknownNode, worstStatus } from "../features/system-lib.js";

describe("settle: one source never holds the others", () => {
  it("returns the value of a source that answers in time", async () => {
    expect(await settle(async () => 7, 100)).toEqual({ ok: true, value: 7 });
  });
  it("turns a source that outlives its deadline into a failure, without waiting for it", async () => {
    const t0 = Date.now();
    const r = await settle(() => new Promise<number>(() => undefined), 40);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("turns a throw into a failure", async () => {
    const r = await settle(async () => {
      throw new Error("ENOENT");
    }, 100);
    expect(r).toEqual({ ok: false, error: "ENOENT" });
  });
  it("never repeats file contents or absolute paths from the error", async () => {
    const json = await settle(async () => JSON.parse('{"env":{"TOKEN":sk-SECRETVALUE}}') as unknown, 100);
    expect(json).toEqual({ ok: false, error: "not valid JSON" });
    const fs = await settle(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/.dashable/services.yml'"), { code: "ENOENT" });
    }, 100);
    expect(fs).toEqual({ ok: false, error: "ENOENT" });
  });
});

describe("status rules", () => {
  it("ranks bad over warn over ok, and unknown only when nothing else is known", () => {
    expect(worstStatus(["ok", "bad", "warn"])).toBe("bad");
    expect(worstStatus(["ok", "unknown", "warn"])).toBe("warn");
    expect(worstStatus(["unknown", "unknown"])).toBe("unknown");
    expect(worstStatus([])).toBe("unknown");
  });
  it("maps up of total to ok, warn at 80%, bad below, unknown with nothing to count", () => {
    expect(statusFromRatio(29, 29)).toBe("ok");
    expect(statusFromRatio(24, 30)).toBe("warn");
    expect(statusFromRatio(10, 30)).toBe("bad");
    expect(statusFromRatio(0, 0)).toBe("unknown");
  });
  it("maps an age against its two limits", () => {
    expect(ageStatus(1000, 5000, 9000)).toBe("ok");
    expect(ageStatus(6000, 5000, 9000)).toBe("warn");
    expect(ageStatus(9000, 5000, 9000)).toBe("bad");
    expect(ageStatus(null, 5000, 9000)).toBe("unknown");
  });
  it("maps load per core", () => {
    expect(loadStatus(2, 10)).toBe("ok");
    expect(loadStatus(10, 10)).toBe("warn");
    expect(loadStatus(20, 10)).toBe("bad");
    expect(loadStatus(1, 0)).toBe("unknown");
  });
  it("words an age", () => {
    expect(ageText(30_000)).toBe("just now");
    expect(ageText(5 * 60_000)).toBe("5 min ago");
    expect(ageText(3 * 3_600_000)).toBe("3 h ago");
    expect(ageText(null)).toBe("unknown");
  });
});

describe("redactSystem", () => {
  it("hides private facts and keeps counts and statuses", () => {
    const r: SystemResponse = {
      ok: true,
      at: "2026-10-14T10:00:00.000Z",
      unavailable: [],
      planes: [{ id: "services", name: "S", emoji: "x", status: "ok", nodes: [{ id: "services.live", plane: "services", label: "Always-live", value: "3/3", status: "ok", source: "s", facts: [{ label: "Up", value: "secret-host :4200", private: true }, { label: "Total", value: "3" }] }] }],
    };
    const out = redactSystem(r);
    expect(JSON.stringify(out)).not.toContain("secret-host");
    expect(out.planes[0]?.nodes[0]?.facts).toEqual([{ label: "Up", value: "hidden", private: true }, { label: "Total", value: "3" }]);
    expect(JSON.stringify(r)).toContain("secret-host"); // the original is untouched
  });
  it("hides why a source failed (an error can name a path)", () => {
    const n = unknownNode({ id: "services.live", plane: "services", label: "Always-live", source: "s" }, "took over 4000 ms at /Users/someone");
    const r: SystemResponse = { ok: true, at: "2026-10-14T10:00:00.000Z", unavailable: ["services"], planes: [{ id: "services", name: "S", emoji: "x", status: "unknown", nodes: [n] }] };
    expect(JSON.stringify(redactSystem(r))).not.toContain("someone");
  });
});
