import { describe, expect, it } from "vitest";
import type { ActionLogFields, LogEntry } from "../../../shared/features/logs";
import {
  actionSummary,
  bootChanged,
  classifyLogsClick,
  copyLine,
  copyLines,
  cursorOf,
  defaultFilterState,
  filterEntries,
  isFailure,
  isLogEntry,
  isLogsMessage,
  isLogsResponse,
  keepValidEntries,
  LogsSync,
  matchesFilters,
  mergeBySeq,
  relativeLabel,
  RENDER_CAP,
  scopesSeen,
  sortNewestFirst,
  visibleRows,
  type LogFilterState,
} from "./logs-lib";

const action = (over: Partial<ActionLogFields> = {}): ActionLogFields => ({
  kind: "action",
  method: "GET",
  route: "/api/mac/apps",
  status: 200,
  ok: true,
  reason: null,
  durationMs: 5,
  ...over,
});

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return { seq: 1, ts: "2026-09-28T00:00:00.000Z", level: "info", source: "server", scope: "server", message: "hi", detail: null, action: null, repeat: 1, ...over };
}

describe("mergeBySeq", () => {
  it("dedupes by seq, ascending", () => {
    const a = [entry({ seq: 1 }), entry({ seq: 3 })];
    const b = [entry({ seq: 2 })];
    expect(mergeBySeq(a, b).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("the incoming copy wins — a coalesced repeat update replaces the old copy of the same seq", () => {
    const a = [entry({ seq: 1, repeat: 1, message: "m" })];
    const b = [entry({ seq: 1, repeat: 3, message: "m" })];
    const merged = mergeBySeq(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.repeat).toBe(3);
  });

  it("cursorOf is the highest seq, 0 for an empty list", () => {
    expect(cursorOf([entry({ seq: 5 }), entry({ seq: 2 })])).toBe(5);
    expect(cursorOf([])).toBe(0);
  });
});

describe("keepValidEntries", () => {
  it("filters out malformed candidates", () => {
    const good = entry();
    const out = keepValidEntries([good, { seq: "nope" }, null, 42, { ...good, level: "verbose" }]);
    expect(out).toEqual([good]);
  });
});

describe("filters", () => {
  const entries: LogEntry[] = [
    entry({ seq: 1, level: "info", source: "server", scope: "indexer", message: "pass" }),
    entry({ seq: 2, level: "warn", source: "server", scope: "mac", message: "slow read" }),
    entry({ seq: 3, level: "info", source: "action", scope: "action", message: "did a thing", action: action({ ok: false, reason: "timed out" }) }),
    entry({ seq: 4, level: "error", source: "feed", scope: "routine", message: "job failed", detail: "exit 1" }),
  ];

  it("defaultFilterState narrows nothing", () => {
    expect(filterEntries(entries, defaultFilterState())).toHaveLength(4);
  });

  it("level: warn-error excludes info (even a failed action, which is info-level); error keeps only error", () => {
    const warnErr: LogFilterState = { ...defaultFilterState(), level: "warn-error" };
    expect(filterEntries(entries, warnErr).map((e) => e.seq)).toEqual([2, 4]);
    const errOnly: LogFilterState = { ...defaultFilterState(), level: "error" };
    expect(filterEntries(entries, errOnly).map((e) => e.seq)).toEqual([4]);
  });

  it("source narrows to one source", () => {
    const f: LogFilterState = { ...defaultFilterState(), source: "feed" };
    expect(filterEntries(entries, f).map((e) => e.seq)).toEqual([4]);
  });

  it("scope narrows to an exact match", () => {
    const f: LogFilterState = { ...defaultFilterState(), scope: "mac" };
    expect(filterEntries(entries, f).map((e) => e.seq)).toEqual([2]);
  });

  it("actionsOnly keeps only source action", () => {
    const f: LogFilterState = { ...defaultFilterState(), actionsOnly: true };
    expect(filterEntries(entries, f).map((e) => e.seq)).toEqual([3]);
  });

  it("failuresOnly keeps warn/error plus any failed action", () => {
    const f: LogFilterState = { ...defaultFilterState(), failuresOnly: true };
    expect(filterEntries(entries, f).map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("query matches message, scope, detail, action.route and action.reason, case-insensitively", () => {
    expect(filterEntries(entries, { ...defaultFilterState(), query: "TIMED OUT" }).map((e) => e.seq)).toEqual([3]);
    expect(filterEntries(entries, { ...defaultFilterState(), query: "exit 1" }).map((e) => e.seq)).toEqual([4]);
  });

  it("combines filters (intersection)", () => {
    const f: LogFilterState = { ...defaultFilterState(), source: "server", level: "warn-error" };
    expect(filterEntries(entries, f).map((e) => e.seq)).toEqual([2]);
  });

  it("isFailure: info-with-failed-action or any warn/error", () => {
    expect(isFailure(entries[0]!)).toBe(false);
    expect(isFailure(entries[1]!)).toBe(true);
    expect(isFailure(entries[2]!)).toBe(true); // ok: false action
    expect(isFailure(entries[3]!)).toBe(true);
  });

  it("matchesFilters agrees with filterEntries per-row", () => {
    const f = defaultFilterState();
    expect(entries.every((e) => matchesFilters(e, f))).toBe(true);
  });
});

describe("sortNewestFirst / scopesSeen / visibleRows", () => {
  it("sorts descending by seq", () => {
    const entries = [entry({ seq: 1 }), entry({ seq: 3 }), entry({ seq: 2 })];
    expect(sortNewestFirst(entries).map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("scopesSeen is distinct and A–Z", () => {
    const entries = [entry({ scope: "mac" }), entry({ scope: "action" }), entry({ scope: "mac" }), entry({ scope: "feed" })];
    expect(scopesSeen(entries)).toEqual(["action", "feed", "mac"]);
  });

  it("visibleRows caps at RENDER_CAP by default and reports the remainder", () => {
    const entries = Array.from({ length: RENDER_CAP + 50 }, (_, i) => entry({ seq: i + 1 }));
    const { rows, remaining } = visibleRows(entries);
    expect(rows).toHaveLength(RENDER_CAP);
    expect(remaining).toBe(50);
  });

  it("visibleRows never reports negative remaining", () => {
    expect(visibleRows([entry()], RENDER_CAP).remaining).toBe(0);
  });
});

describe("relativeLabel", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  it("buckets: just now, seconds, minutes, hours, days", () => {
    expect(relativeLabel(new Date(now - 2_000).toISOString(), now)).toBe("just now");
    expect(relativeLabel(new Date(now - 12_000).toISOString(), now)).toBe("12s");
    expect(relativeLabel(new Date(now - 4 * 60_000).toISOString(), now)).toBe("4m");
    expect(relativeLabel(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("2h");
    expect(relativeLabel(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3d");
  });
  it("invalid timestamps read '?'", () => {
    expect(relativeLabel("not a date", now)).toBe("?");
  });
});

describe("copy format", () => {
  it("copyLine: 'ISO LEVEL [scope] message detail'", () => {
    expect(copyLine(entry({ ts: "2026-09-28T00:00:00.000Z", level: "warn", scope: "mac", message: "slow read" }))).toBe("2026-09-28T00:00:00.000Z WARN [mac] slow read");
    expect(copyLine(entry({ ts: "t", level: "info", scope: "s", message: "m", detail: "d" }))).toBe("t INFO [s] m d");
  });
  it("copyLines joins with newlines", () => {
    const a = entry({ seq: 1, message: "a" });
    const b = entry({ seq: 2, message: "b" });
    expect(copyLines([a, b])).toBe(`${copyLine(a)}\n${copyLine(b)}`);
  });
  it("actionSummary reads method/route/status/duration, with the reason appended on failure", () => {
    expect(actionSummary(action())).toBe("GET /api/mac/apps → 200 in 5ms");
    expect(actionSummary(action({ ok: false, status: 500, reason: "boom" }))).toBe("GET /api/mac/apps → 500 in 5ms: boom");
    expect(actionSummary(action({ ok: false, status: 0, reason: "client closed the connection" }))).toBe("GET /api/mac/apps → no answer in 5ms: client closed the connection");
  });
});

describe("bootChanged", () => {
  it("null stored bootId never counts as a change (first load)", () => {
    expect(bootChanged(null, "boot-1")).toBe(false);
  });
  it("a different bootId is a change; the same one is not", () => {
    expect(bootChanged("boot-1", "boot-2")).toBe(true);
    expect(bootChanged("boot-1", "boot-1")).toBe(false);
  });
});

describe("LogsSync (the restart race)", () => {
  const at = (...seqs: number[]): LogEntry[] => seqs.map((seq) => entry({ seq }));

  it("adopt merges same-boot entries and advances the cursor", () => {
    const sync = new LogsSync();
    sync.applyReload({ bootId: "A", cursor: 2, entries: at(1, 2) });
    sync.adopt(at(3));
    expect(sync.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(sync.cursor).toBe(3);
  });

  it("bufferForReload never touches bootId or entries — a concurrent reloadSince must still see the old boot and also reload, not merge a delta onto a dead cursor", () => {
    const sync = new LogsSync();
    sync.applyReload({ bootId: "A", cursor: 2, entries: at(1, 2) });
    sync.bufferForReload(at(1)); // the new boot's own seq 1 — must not be mistaken for boot A's seq 1
    expect(sync.bootId).toBe("A");
    expect(sync.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("applyReload merges in whatever was buffered while its GET was in flight — the reported race: new-boot pushes (seq 49, 50) land in the same millisecond as the reload's own GET, whose snapshot misses them", () => {
    const sync = new LogsSync();
    sync.applyReload({ bootId: "A", cursor: 254, entries: at(253, 254) });
    sync.bufferForReload(at(49, 50));
    sync.applyReload({ bootId: "B", cursor: 48, entries: at(47, 48) });
    expect(sync.entries.map((e) => e.seq)).toEqual([47, 48, 49, 50]);
    expect(sync.bootId).toBe("B");
    expect(sync.cursor).toBe(50);
  });

  it("the fetched snapshot wins over a stale buffered copy of the same seq (never regresses a coalesced repeat count)", () => {
    const sync = new LogsSync();
    sync.bufferForReload([entry({ seq: 5, repeat: 1 })]);
    sync.applyReload({ bootId: "B", cursor: 5, entries: [entry({ seq: 5, repeat: 3 })] });
    expect(sync.entries.find((e) => e.seq === 5)?.repeat).toBe(3);
  });
});

describe("classifyLogsClick", () => {
  const cls = (name: string): { contains(c: string): boolean } => ({ contains: (c: string) => c === name });

  it("routes each known button class to its action", () => {
    expect(classifyLogsClick(cls("lg-retry"))).toBe("retry");
    expect(classifyLogsClick(cls("lg-copy-all"))).toBe("copy-all");
    expect(classifyLogsClick(cls("lg-copy-row"))).toBe("copy-row");
  });

  it("an unrelated button resolves to no action", () => {
    expect(classifyLogsClick(cls("lg-follow"))).toBeNull();
  });
});

describe("payload validators reject malformed messages", () => {
  it("isLogEntry", () => {
    expect(isLogEntry(entry())).toBe(true);
    expect(isLogEntry({ ...entry(), level: "verbose" })).toBe(false);
    expect(isLogEntry({ ...entry(), action: { kind: "action" } })).toBe(false);
    expect(isLogEntry(null)).toBe(false);
    expect(isLogEntry("nope")).toBe(false);
  });
  it("isLogsResponse", () => {
    expect(isLogsResponse({ ok: true, bootId: "b", cursor: 1, entries: [entry()] })).toBe(true);
    expect(isLogsResponse({ ok: true, bootId: "b", cursor: 1, entries: [{ bad: true }] })).toBe(false);
    expect(isLogsResponse({ ok: false })).toBe(false);
  });
  it("isLogsMessage", () => {
    expect(isLogsMessage({ kind: "entries", bootId: "b", entries: [entry()] })).toBe(true);
    expect(isLogsMessage({ kind: "wrong", bootId: "b", entries: [] })).toBe(false);
    expect(isLogsMessage({ kind: "entries", bootId: "b", entries: [{ seq: "nope" }] })).toBe(false);
    expect(isLogsMessage(undefined)).toBe(false);
  });
});
