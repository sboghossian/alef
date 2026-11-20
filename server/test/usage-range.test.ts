import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZERO_TOKENS, type TokenBucket } from "../../shared/features/usage.js";
import { localDateKey } from "../heuristics.js";
import { runBackfillPass } from "../features/usage-backfill.js";
import { buildRange, rangeBounds } from "../features/usage-range.js";
import { HOUR_BACKFILL_CUTOFF_KEY, UsageStore } from "../features/usage-store.js";
import { assistantLine } from "./helpers.js";

const tk = (p: Partial<TokenBucket>): TokenBucket => ({ ...ZERO_TOKENS, ...p });
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime(); // local noon, 14 Oct 2026

describe("rangeBounds", () => {
  it("covers N inclusive local days ending today", () => {
    expect(rangeBounds(7, NOW)).toEqual({ from: "2026-10-08", to: "2026-10-14" });
    expect(rangeBounds(30, NOW).from).toBe("2026-09-15");
    expect(rangeBounds(90, NOW).from).toBe("2026-07-17");
  });
});

describe("UsageStore hours", () => {
  it("adds per (date, hour), ignores bad hours, and always returns 24 entries over the range only", () => {
    const store = new UsageStore(":memory:");
    store.addHourMs("2026-10-14", 9, 1000);
    store.addHourMs("2026-10-14", 9, 500);
    store.addHourMs("2026-10-13", 23, 7);
    store.addHourMs("2026-10-14", 24, 99);
    store.addHourMs("2026-10-14", 5, 0);
    store.addHourMs("2026-09-01", 9, 999); // outside the range below
    const h = store.hourTotals("2026-10-08", "2026-10-14");
    expect(h).toHaveLength(24);
    expect(h[9]).toBe(1500);
    expect(h[23]).toBe(7);
    expect(h.reduce((a, b) => a + b, 0)).toBe(1507);
    store.close();
  });
});

describe("buildRange", () => {
  it("sums cost per model and city over the range, leaves out days outside it, and counts distinct sessions", () => {
    const store = new UsageStore(":memory:");
    store.addTokens("2026-10-14", "a", "s1", "claude-sonnet-5", tk({ inputTokens: 1_000_000 }));
    store.addTokens("2026-10-10", "a", "s2", "claude-sonnet-5", tk({ inputTokens: 1_000_000 }));
    store.addTokens("2026-10-12", "b", "s3", "mystery-model", tk({ inputTokens: 500 }));
    store.addTokens("2026-08-01", "a", "s4", "claude-sonnet-5", tk({ inputTokens: 1_000_000 })); // 7 d: out; 90 d: in
    store.addActiveMs("2026-10-14", "a", "s1", 60_000);
    store.addHourMs("2026-10-14", 8, 60_000);
    const seven = buildRange(store, 7, NOW, (id) => `city ${id}`);
    expect(seven.models.map((m) => m.model)).toEqual(["claude-sonnet-5", "mystery-model"]);
    expect(seven.models[1]).toMatchObject({ costUsd: null, unpricedTokens: 500 });
    const a = seven.perCity.find((c) => c.islandId === "a")!;
    expect(a).toMatchObject({ name: "city a", sessions: 2, activeMs: 60_000 });
    expect(seven.totalCostUsd).toBeCloseTo(a.costUsd, 10);
    expect(seven.totalUnpricedTokens).toBe(500);
    expect(seven.byHour[8]).toBe(60_000);
    const ninety = buildRange(store, 90, NOW, (id) => id);
    expect(ninety.totalCostUsd).toBeCloseTo(seven.totalCostUsd * 1.5, 6);
    store.close();
  });

  it("is empty and still has 24 hours for a store with no data", () => {
    const store = new UsageStore(":memory:");
    const r = buildRange(store, 30, NOW, (id) => id);
    expect(r).toMatchObject({ ok: true, days: 30, models: [], perCity: [], totalCostUsd: 0 });
    expect(r.byHour).toHaveLength(24);
    store.close();
  });
});

describe("backfill feeds the hour table", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  it("attributes a gap to the local hour of the line that closed it", async () => {
    dir = mkdtempSync(join(tmpdir(), "alef-usage-hr-"));
    const projectsDir = join(dir, "projects");
    mkdirSync(join(projectsDir, "-ws-a"), { recursive: true });
    const t1 = new Date(2026, 8, 24, 8, 0, 0);
    const t2 = new Date(2026, 8, 24, 8, 2, 0);
    const lines = [t1, t2].map((t, i) => assistantLine({ cwd: "/ws/a", timestamp: t.toISOString(), model: "claude-sonnet-5", messageId: `m${i}`, usage: { inputTokens: 1, outputTokens: 0 } }));
    writeFileSync(join(projectsDir, "-ws-a", "33333333-3333-3333-3333-333333333333.jsonl"), lines.join("\n") + "\n");
    const store = new UsageStore(":memory:");
    await runBackfillPass({ store, projectsDir, cutoffMs: Date.now(), getIslandForCwd: () => "a" });
    const date = localDateKey(t1);
    expect(store.hourTotals(date, date)[8]).toBe(120_000);
    store.close();
  });
});

describe("usage.db v2 -> v3 migration", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A v2 file: the v3 tables minus usage_hour, with one token row, one time row and a done backfill. */
  function writeV2(path: string): void {
    const db = new Database(path);
    db.exec(`CREATE TABLE usage_tokens (date TEXT NOT NULL, island_id TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
               input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_write_5m INTEGER NOT NULL DEFAULT 0,
               cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, island_id, session_id, model));
             CREATE TABLE usage_time (date TEXT NOT NULL, island_id TEXT NOT NULL, session_id TEXT NOT NULL, active_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, island_id, session_id));
             CREATE TABLE usage_cursor (session_id TEXT PRIMARY KEY, last_message_id TEXT, last_event_ms INTEGER);
             CREATE TABLE usage_file_offset (path TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL);
             CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO usage_tokens (date, island_id, session_id, model, input_tokens) VALUES ('2026-09-05', 'a', 'old', 'claude-sonnet-5', 1000000);
             INSERT INTO usage_time VALUES ('2026-09-05', 'a', 'old', 60000);
             INSERT INTO usage_meta VALUES ('backfill_cutoff_ms', '1'), ('backfill_done', '1');`);
    db.pragma("user_version = 2");
    db.close();
  }

  it("keeps the v2 rows (their transcripts may be gone), backs the file up first and records the hour cutoff", () => {
    dir = mkdtempSync(join(tmpdir(), "alef-usage-mig-"));
    const path = join(dir, "usage.db");
    writeV2(path);
    const before = Date.now();
    const store = new UsageStore(path);
    expect(store.dayTokenRows("2026-09-05")).toHaveLength(1);
    expect(store.dayTimeRows("2026-09-05")[0]?.activeMs).toBe(60_000);
    expect(store.getMeta("backfill_done")).toBe("1");
    expect(Number(store.getMeta(HOUR_BACKFILL_CUTOFF_KEY))).toBeGreaterThanOrEqual(before);
    store.close();
    expect(existsSync(`${path}.pre-v3.bak`)).toBe(true);
    const bak = new Database(`${path}.pre-v3.bak`, { readonly: true });
    expect(bak.pragma("user_version", { simple: true })).toBe(2);
    bak.close();
    // Reopening is a no-op: same cutoff, rows intact.
    const again = new UsageStore(path);
    expect(again.dayTokenRows("2026-09-05")).toHaveLength(1);
    again.close();
  });

  it("the hour pass fills usage_hour only, converges when re-run, and skips a slice another process already applied", async () => {
    dir = mkdtempSync(join(tmpdir(), "alef-usage-mig-"));
    const projectsDir = join(dir, "projects");
    mkdirSync(join(projectsDir, "-ws-a"), { recursive: true });
    const t1 = new Date(2026, 9, 1, 14, 0, 0);
    const t2 = new Date(2026, 9, 1, 14, 3, 0);
    const lines = [t1, t2].map((t, i) => assistantLine({ cwd: "/ws/a", timestamp: t.toISOString(), model: "claude-sonnet-5", messageId: `m${i}`, usage: { inputTokens: 1, outputTokens: 0 } }));
    const file = join(projectsDir, "-ws-a", "44444444-4444-4444-4444-444444444444.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    const path = join(dir, "usage.db");
    writeV2(path);
    const store = new UsageStore(path);
    const deps = { store, projectsDir, cutoffMs: Number(store.getMeta(HOUR_BACKFILL_CUTOFF_KEY)), getIslandForCwd: () => "a", mode: "hour" as const };
    await runBackfillPass(deps);
    const date = localDateKey(t1);
    expect(store.hourTotals(date, date)[14]).toBe(180_000);
    expect(store.dayTokenRows(date)).toHaveLength(0); // totals stay the v2 rows': no double count
    expect(store.dayTimeRows(date)).toHaveLength(0);
    expect(store.getMeta("hour_backfill_done")).toBe("1");
    store.setMeta("hour_backfill_done", "0");
    await runBackfillPass(deps); // re-run (as after a crash before the flag): offsets say done, nothing added
    expect(store.hourTotals(date, date)[14]).toBe(180_000);
    const stale = store.applyBackfillBatch({ path: `hour:${file}`, fromOffset: 0, fileOffset: 10, sessionId: "x", cursorKey: "k", cursor: { lastMessageId: null, lastEventMs: null }, tokenDeltas: new Map(), timeDeltas: new Map(), hourDeltas: new Map([["d", { date, hour: 14, ms: 5 }]]) });
    expect(stale).toBe(false);
    expect(store.hourTotals(date, date)[14]).toBe(180_000);
    store.close();
  });

  it("a fresh file needs no hour pass", () => {
    const store = new UsageStore(":memory:");
    expect(store.getMeta(HOUR_BACKFILL_CUTOFF_KEY)).toBeNull();
    store.close();
  });
});
