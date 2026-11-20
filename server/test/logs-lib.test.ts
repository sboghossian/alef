import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../shared/features/feed.js";
import type { ActionLogFields, LogEntry } from "../../shared/features/logs.js";
import type { LogLine } from "../log.js";
import {
  draftFromFeedItem,
  draftFromLogLine,
  LogRing,
  parseLogsQuery,
  parseNdjson,
  queryEntries,
  redactLogText,
  serializeNdjson,
  truncate,
} from "../features/logs-lib.js";

const action = (over: Partial<ActionLogFields> = {}): ActionLogFields => ({
  kind: "action",
  method: "POST",
  route: "/api/reactivate/abc",
  status: 200,
  ok: true,
  reason: null,
  durationMs: 12,
  ...over,
});

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return { seq: 1, ts: "2026-09-28T00:00:00.000Z", level: "info", source: "server", scope: "server", message: "hi", detail: null, action: null, repeat: 1, ...over };
}

describe("redactLogText", () => {
  it("redacts every key shape while keeping UUIDs and file paths", () => {
    const cases: [string, string][] = [
      ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz here", "key «redacted» here"],
      ["sk-proj-abcdefghijklmnopqrstuvwx", "«redacted»"],
      ["token ghp_abcdefghijklmnopqrstuvwxyz0123", "token «redacted»"],
      ["gho_abcdefghijklmnopqrstuvwxyz0123", "«redacted»"],
      ["github_pat_abcdefghijklmnopqrstuvwxyz0123456789", "«redacted»"],
      ["xoxb-1234567890-abcdefghij", "«redacted»"],
      ["id AKIAABCDEFGHIJ123456 done", "id «redacted» done"],
      ["Authorization: Bearer abc.def-ghi.jkl", "Authorization: Bearer «redacted»"],
      ['key="super-secret-value" next', "key=«redacted» next"],
      ["token=abc123 done", "token=«redacted» done"],
      ["secret='shh shh' end", "secret=«redacted» end"],
      ["password=hunter2hunter2", "password=«redacted»"],
      [`hex ${"a1b2c3d4".repeat(5)} end`, "hex «redacted» end"],
      [`b64 ${"Zz".repeat(21)} end`, "b64 «redacted» end"],
    ];
    for (const [raw, want] of cases) expect(redactLogText(raw), raw).toBe(want);
  });

  it("keeps a bare UUID (36 chars, hyphen-broken) intact", () => {
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(redactLogText(`session ${uuid} started`)).toBe(`session ${uuid} started`);
  });

  it("keeps a long file path intact (the catch-alls exclude '/')", () => {
    const path = "/Users/alexboghossian/Documents/Code/agent-world/server/features/logs.ts";
    expect(redactLogText(`wrote ${path}`)).toBe(`wrote ${path}`);
  });

  it("does not touch ordinary text", () => {
    expect(redactLogText("GET /api/world -> 200 in 4ms")).toBe("GET /api/world -> 200 in 4ms");
  });
});

describe("truncate", () => {
  it("passes short text through unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi");
    expect(truncate("1234567890", 10)).toBe("1234567890");
  });
  it("caps overflow with a '…(+N chars)' suffix", () => {
    expect(truncate("a".repeat(1100), 1000)).toBe(`${"a".repeat(1000)}…(+100 chars)`);
  });
});

describe("draftFromLogLine", () => {
  it("a well-formed action line becomes source action, with detail null", () => {
    const line: LogLine = { ts: "t", level: "info", scope: "action", message: "POST /api/reactivate/abc → 200 in 12ms", extra: action() };
    const draft = draftFromLogLine(line);
    expect(draft.source).toBe("action");
    expect(draft.action).toEqual(action());
    expect(draft.detail).toBeNull();
  });

  it("a malformed 'action' line stays a plain server entry, extra kept as detail", () => {
    const line: LogLine = { ts: "t", level: "warn", scope: "action", message: "oops", extra: { not: "an action" } };
    const draft = draftFromLogLine(line);
    expect(draft.source).toBe("server");
    expect(draft.action).toBeNull();
    expect(draft.detail).toBe('{"not":"an action"}');
  });

  it("a plain server line has no action and null detail without extra", () => {
    const draft = draftFromLogLine({ ts: "t", level: "info", scope: "indexer", message: "incremental pass" });
    expect(draft).toMatchObject({ level: "info", source: "server", scope: "indexer", message: "incremental pass", detail: null, action: null });
  });

  it("redacts and truncates both message and detail", () => {
    const draft = draftFromLogLine({ ts: "t", level: "info", scope: "s", message: `key sk-ant-${"x".repeat(20)} in message`, extra: { token: "ghp_" + "y".repeat(20) } });
    expect(draft.message).toContain("«redacted»");
    expect(draft.detail).toContain("«redacted»");
  });

  it("redacts a secret in action.reason too — an action row must not bypass redaction", () => {
    const fields = action({ ok: false, status: 400, reason: "bad key sk-ant-abcdefghijklmnopqrstuv" });
    const line: LogLine = { ts: "t", level: "warn", scope: "action", message: "POST /api/reactivate/abc → 400 in 12ms: bad key «redacted»", extra: fields };
    const draft = draftFromLogLine(line);
    expect(draft.action?.reason).toBe("bad key «redacted»");
  });

  it("a null action.reason stays null", () => {
    const fields = action({ reason: null });
    const line: LogLine = { ts: "t", level: "info", scope: "action", message: "GET /api/mac/apps → 200 in 5ms", extra: fields };
    expect(draftFromLogLine(line).action?.reason).toBeNull();
  });
});

describe("draftFromFeedItem", () => {
  const base: FeedItem = { id: "i1", seq: 1, at: "t", kind: "mac", agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Opened Safari", detail: null, tag: null };

  it("skips 'activity' — the Feed tab already shows it", () => {
    expect(draftFromFeedItem({ ...base, kind: "activity" })).toBeNull();
  });

  it("maps kind → scope, title (+detail) → message, short agent id → detail", () => {
    const draft = draftFromFeedItem({ ...base, detail: "via a click" });
    expect(draft).toMatchObject({ level: "info", source: "feed", scope: "mac", message: "Opened Safari · via a click", detail: "aaaaaaaa" });
  });

  it("a null agentId gives a null detail", () => {
    const draft = draftFromFeedItem({ ...base, agentId: null });
    expect(draft?.detail).toBeNull();
  });
});

describe("LogRing", () => {
  it("assigns monotonic seq and reports the cursor", () => {
    const ring = new LogRing({ now: () => 0 });
    const a = ring.push(entry());
    const b = ring.push(entry({ message: "two" }));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(ring.cursor()).toBe(2);
  });

  it("coalesces a repeated info (source, scope, message) into the newest entry's repeat + ts", () => {
    const ring = new LogRing();
    const draft = { level: "info" as const, source: "server" as const, scope: "indexer", message: "incremental pass", detail: null, action: null };
    const first = ring.push(draft, "t1");
    const second = ring.push(draft, "t2");
    expect(second).toBe(first); // same object, mutated
    expect(ring.list()).toHaveLength(1);
    expect(ring.list()[0]).toMatchObject({ seq: 1, repeat: 2, ts: "t2" });
  });

  it("does not coalesce a warn/error even with the same (source, scope, message)", () => {
    const ring = new LogRing();
    const draft = { level: "warn" as const, source: "server" as const, scope: "x", message: "same", detail: null, action: null };
    ring.push(draft, "t1");
    ring.push(draft, "t2");
    expect(ring.list()).toHaveLength(2);
  });

  it("does not coalesce across a different scope, source or message", () => {
    const ring = new LogRing();
    const info = (over: Partial<{ scope: string; source: "server" | "action" | "feed"; message: string }>) => ({
      level: "info" as const,
      source: "server" as const,
      scope: "x",
      message: "m",
      detail: null,
      action: null,
      ...over,
    });
    ring.push(info({}));
    ring.push(info({ scope: "y" }));
    ring.push(info({ message: "n" }));
    expect(ring.list()).toHaveLength(3);
  });

  it("eviction (over cap) drops the oldest server/info entry first, so actions/warnings/errors survive", () => {
    const ring = new LogRing({ cap: 3 });
    ring.push({ level: "info", source: "server", scope: "indexer", message: "pass 1", detail: null, action: null });
    ring.push({ level: "error", source: "server", scope: "x", message: "boom", detail: null, action: null });
    ring.push({ level: "info", source: "action", scope: "action", message: "an action", detail: null, action: action() });
    ring.push({ level: "info", source: "server", scope: "indexer", message: "pass 2", detail: null, action: null }); // over cap: evicts "pass 1"
    expect(ring.list().map((e) => e.message)).toEqual(["boom", "an action", "pass 2"]);
    ring.push({ level: "info", source: "server", scope: "indexer", message: "pass 3", detail: null, action: null }); // no server/info left but "pass 2": evicts it
    expect(ring.list().map((e) => e.message)).toEqual(["boom", "an action", "pass 3"]);
  });

  it("falls back to evicting the oldest overall once no server/info entry is left", () => {
    const ring = new LogRing({ cap: 2 });
    ring.push({ level: "error", source: "server", scope: "a", message: "e1", detail: null, action: null });
    ring.push({ level: "error", source: "server", scope: "b", message: "e2", detail: null, action: null });
    ring.push({ level: "error", source: "server", scope: "c", message: "e3", detail: null, action: null });
    expect(ring.list().map((e) => e.message)).toEqual(["e2", "e3"]);
  });

  it("seed() renumbers seq 1..N and resets the cursor", () => {
    const ring = new LogRing();
    ring.seed([entry({ seq: 40 }), entry({ seq: 41, message: "two" })]);
    expect(ring.list().map((e) => e.seq)).toEqual([1, 2]);
    expect(ring.cursor()).toBe(2);
    expect(ring.push(entry({ message: "three" })).seq).toBe(3);
  });
});

describe("parseLogsQuery", () => {
  const url = (qs: string): URLSearchParams => new URLSearchParams(qs);

  it("defaults: since 0, no level/source/scope/q filter, limit 500", () => {
    const r = parseLogsQuery(url(""));
    expect(r).toEqual({ ok: true, query: { since: 0, level: null, source: null, scope: null, q: null, limit: 500 } });
  });

  it("accepts every param alone", () => {
    expect(parseLogsQuery(url("since=10"))).toMatchObject({ ok: true, query: { since: 10 } });
    expect(parseLogsQuery(url("level=warn"))).toMatchObject({ ok: true, query: { level: "warn" } });
    expect(parseLogsQuery(url("source=server,feed"))).toMatchObject({ ok: true, query: { source: ["server", "feed"] } });
    expect(parseLogsQuery(url("scope=mac"))).toMatchObject({ ok: true, query: { scope: "mac" } });
    expect(parseLogsQuery(url("q=hello"))).toMatchObject({ ok: true, query: { q: "hello" } });
    expect(parseLogsQuery(url("limit=10"))).toMatchObject({ ok: true, query: { limit: 10 } });
  });

  it("accepts every param combined", () => {
    const r = parseLogsQuery(url("since=5&level=error&source=action&scope=mac&q=fail&limit=20"));
    expect(r).toEqual({ ok: true, query: { since: 5, level: "error", source: ["action"], scope: "mac", q: "fail", limit: 20 } });
  });

  it("caps q at 200 chars instead of erroring", () => {
    const r = parseLogsQuery(url(`q=${"a".repeat(250)}`));
    expect(r.ok && r.query.q?.length).toBe(200);
  });

  it("rejects an invalid since (non-integer or negative), naming the param", () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      const r = parseLogsQuery(url(`since=${bad}`));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/since/);
    }
  });

  it("rejects an invalid level, naming the param", () => {
    const r = parseLogsQuery(url("level=verbose"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/level/);
  });

  it("rejects an invalid source entry (even mixed with valid ones), naming the param", () => {
    const r = parseLogsQuery(url("source=server,bogus"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/source/);
  });

  it("rejects a limit outside 1..2000, naming the param", () => {
    for (const bad of ["0", "2001", "1.5", "abc"]) {
      const r = parseLogsQuery(url(`limit=${bad}`));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/limit/);
    }
  });
});

describe("queryEntries", () => {
  const entries: LogEntry[] = [
    entry({ seq: 1, level: "info", source: "server", scope: "indexer", message: "pass" }),
    entry({ seq: 2, level: "warn", source: "server", scope: "mac", message: "slow read" }),
    entry({ seq: 3, level: "info", source: "action", scope: "action", message: "did a thing", action: action({ route: "/api/mac/open", reason: "timed out" }) }),
    entry({ seq: 4, level: "error", source: "feed", scope: "routine", message: "job failed", detail: "exit 1" }),
  ];

  it("returns seq > since, oldest first", () => {
    expect(queryEntries(entries, { since: 2, level: null, source: null, scope: null, q: null, limit: 500 }).map((e) => e.seq)).toEqual([3, 4]);
  });
  it("level is a minimum", () => {
    expect(queryEntries(entries, { since: 0, level: "warn", source: null, scope: null, q: null, limit: 500 }).map((e) => e.seq)).toEqual([2, 4]);
  });
  it("source is a set", () => {
    expect(queryEntries(entries, { since: 0, level: null, source: ["server"], scope: null, q: null, limit: 500 }).map((e) => e.seq)).toEqual([1, 2]);
  });
  it("scope is exact", () => {
    expect(queryEntries(entries, { since: 0, level: null, source: null, scope: "mac", q: null, limit: 500 }).map((e) => e.seq)).toEqual([2]);
  });
  it("q matches message, scope, detail, action.route and action.reason (case-insensitive)", () => {
    expect(queryEntries(entries, { since: 0, level: null, source: null, scope: null, q: "TIMED OUT", limit: 500 }).map((e) => e.seq)).toEqual([3]);
    expect(queryEntries(entries, { since: 0, level: null, source: null, scope: null, q: "mac/open", limit: 500 }).map((e) => e.seq)).toEqual([3]);
    expect(queryEntries(entries, { since: 0, level: null, source: null, scope: null, q: "exit 1", limit: 500 }).map((e) => e.seq)).toEqual([4]);
  });
  it("limit keeps the newest N matches, still oldest first", () => {
    expect(queryEntries(entries, { since: 0, level: null, source: null, scope: null, q: null, limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
  });
  it("every param combined narrows to the intersection", () => {
    const r = queryEntries(entries, { since: 0, level: "info", source: ["server", "action"], scope: null, q: "pass", limit: 500 });
    expect(r.map((e) => e.seq)).toEqual([1]);
  });
});

describe("NDJSON round trip", () => {
  it("serializes and parses back the same entries", () => {
    const entries = [entry({ seq: 1 }), entry({ seq: 2, action: action() })];
    expect(parseNdjson(serializeNdjson(entries))).toEqual(entries);
  });
  it("skips corrupt or malformed lines, keeps the rest", () => {
    const good = entry({ seq: 1 });
    const text = `${JSON.stringify(good)}\nnot json\n${JSON.stringify({ seq: "not a number" })}\n\n`;
    expect(parseNdjson(text)).toEqual([good]);
  });
  it("serializes an empty list as an empty string", () => {
    expect(serializeNdjson([])).toBe("");
  });
  it("keeps only the last line per seq — a coalesced repeat flushed at multiple persist ticks must not become separate rows on reload", () => {
    const bump1 = entry({ seq: 2, repeat: 1, ts: "t1", message: "incremental pass" });
    const bump2 = entry({ seq: 2, repeat: 2, ts: "t2", message: "incremental pass" });
    const bump6 = entry({ seq: 2, repeat: 6, ts: "t6", message: "incremental pass" });
    const text = `${JSON.stringify(entry({ seq: 1 }))}\n${JSON.stringify(bump1)}\n${JSON.stringify(bump2)}\n${JSON.stringify(bump6)}\n`;
    const parsed = parseNdjson(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((e) => e.seq === 2)).toEqual(bump6);
  });
});
