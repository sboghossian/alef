import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../../shared/features/approvals.js";
import type { Automation } from "../../shared/features/automations.js";
import type { FeedItem, FeedMessage, FeedResponse } from "../../shared/features/feed.js";
import type { JevDecision } from "../../shared/types.js";
import { appendToFeed, createFeedFeature, onFeedItems } from "../features/feed.js";
import type { FeatureContext, Route } from "../features/registry.js";
import { bridgeItems, FEED_PAGE, FeedCursor, fetchFeedWindow } from "../../client/src/features/feed-bridge.js";
import { assistantLine, makeTempDb, makeTempProjectsDir, userLine } from "./helpers.js";

function fakeCtx(emitted: FeedMessage[], db: unknown = { getSession: () => ({ cwd: "/repo" }) }): FeatureContext {
  const ctx = {
    featureId: "feed",
    emit: (p: unknown) => void emitted.push(p as FeedMessage),
    db,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return ctx as unknown as FeatureContext;
}

async function getFeed(route: Route, ctx: FeatureContext, query: string): Promise<FeedResponse> {
  let body = "";
  const res = {
    writeHead: () => res,
    end: (d: string) => {
      body = d;
    },
  };
  await route.handler({ url: `/api/feed${query}` } as never, res as never, ctx, {});
  return JSON.parse(body) as FeedResponse;
}

const routine = (over: Partial<Automation>): Automation => ({
  id: "daily-recap",
  name: "daily-recap",
  description: null,
  kind: "launchd",
  launchdLabel: "com.stephane.daily-recap",
  skill: null,
  schedule: "daily 08:10",
  nextRunAt: null,
  lastRunAt: "2026-09-25T05:00:00.000Z",
  lastExitStatus: 0,
  running: false,
  runnable: true,
  dispatchCommand: null,
  latestOutput: null,
  outputDir: null,
  link: null,
  ...over,
});

describe("feed", () => {
  it("merges activity, decisions, approvals and routine runs into one seq-ordered stream", async () => {
    const decisions: JevDecision[] = [];
    let approvals: ApprovalView[] = [];
    let routines: Automation[] = [routine({})];
    let t = 1_000_000;
    const feed = createFeedFeature({
      sources: { decisions: () => decisions, approvals: () => approvals, routines: async () => routines },
      routineEveryMs: 0,
      now: () => t,
    });
    const emitted: FeedMessage[] = [];
    const ctx = fakeCtx(emitted);
    const route = feed.routes?.[0];
    if (!route || !feed.onIndexPass || !feed.onTick) throw new Error("feed shape");

    await feed.onTick(ctx); // seeds routines, nothing else
    expect((await getFeed(route, ctx, "")).items).toEqual([]);

    const at = "2026-09-25T07:00:00.000Z";
    await feed.onIndexPass(
      ctx,
      new Map([
        [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          [userLine({ cwd: "/repo", timestamp: at, text: "ship it" }), assistantLine({ cwd: "/repo", timestamp: at, toolUses: [{ name: "Edit", input: { file_path: "/repo/a.ts" } }] }), "not json"],
        ],
      ]),
    );
    decisions.unshift({ id: "d1", at, kind: "roam", subjects: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "agent visits x" });
    approvals = [{ id: "ap1", agentId: "a", cwd: "/repo", toolName: "Bash", preview: { kind: "command", title: "Run tests", body: "" }, createdAt: at, expiresAt: at }];
    routines = [routine({ running: true })];
    t += 1000;
    await feed.onTick(ctx);
    approvals = [];
    routines = [routine({ running: false, lastRunAt: "2026-09-25T07:01:00.000Z", lastExitStatus: 1 })];
    await feed.onTick(ctx);
    await feed.onTick(ctx); // no changes: nothing new, decisions deduped

    const all = await getFeed(route, ctx, "");
    expect(all.items.map((i) => [i.seq, i.kind, i.tag])).toEqual([
      [1, "activity", "hook"],
      [2, "activity", "tool"],
      [3, "decision", "roam"],
      [4, "approval", "Bash"],
      [5, "routine", "started"],
      [6, "approval-resolved", "Bash"],
      [7, "routine", "finished"],
    ]);
    expect(all.items[6]?.detail).toBe("exit 1");
    expect(all.cursor).toBe(7);
    expect(new Set(all.items.map((i) => i.id)).size).toBe(7);
    const since = await getFeed(route, ctx, "?since=5");
    expect(since.items.map((i) => i.seq)).toEqual([6, 7]);
    expect(since.bootId).toBe(all.bootId);
    expect(emitted.flatMap((m) => m.items).map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("decisions already in the store before boot are marked seen on the first tick, not replayed as new feed items (regression: the feed's first tick used to replay them every restart)", async () => {
    const existing: JevDecision[] = [
      { id: "old-1", at: "2026-06-08T03:00:00.000Z", kind: "roam", subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "an old decision" },
      { id: "old-2", at: "2026-06-08T03:01:00.000Z", kind: "roam", subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "another old decision" },
    ];
    let decisions: JevDecision[] = existing;
    const feed = createFeedFeature({ sources: { decisions: () => decisions, approvals: () => [], routines: async () => [] } });
    const emitted: FeedMessage[] = [];
    const ctx = fakeCtx(emitted);
    const route = feed.routes?.[0];
    if (!route || !feed.onTick) throw new Error("feed shape");

    await feed.onTick(ctx); // boot: these 2 decisions already existed before this process started
    expect((await getFeed(route, ctx, "")).items).toEqual([]); // must not be replayed as "new"

    decisions = [...existing, { id: "new-1", at: "2026-09-28T09:00:00.000Z", kind: "roam", subjects: [], choice: "y", probabilities: {}, confidence: 1, source: "rules", summary: "a genuinely new decision" }];
    await feed.onTick(ctx); // a real new decision after boot must still show up

    expect((await getFeed(route, ctx, "")).items.map((i) => i.id)).toEqual(["decision:new-1"]);

    // A restart against the same, unchanged store must not replay old-1/old-2 either.
    const feed2 = createFeedFeature({ sources: { decisions: () => existing, approvals: () => [], routines: async () => [] } });
    const ctx2 = fakeCtx([]);
    const route2 = feed2.routes?.[0];
    if (!route2 || !feed2.onTick) throw new Error("feed shape");
    await feed2.onTick(ctx2);
    expect((await getFeed(route2, ctx2, "")).items).toEqual([]);
  });

  it("decisions this process's own boot director tick wrote still reach the feed on its first tick; only ones stamped before the process started are seeded (regression: the first tick marked the boot tick's decisions seen too)", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    try {
      const decision = (id: string, at: string): JevDecision => ({ id, at, kind: "roam", subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: `decision ${id}` });
      db.insertDecision(decision("old-1", "2026-06-08T03:00:00.000Z")); // left in the store by an earlier run
      // index.ts's boot order: the feed module loads, directorTick() writes the boot tick's decisions, and only
      // then features.startTicks() — whose setInterval puts the feed's first tick ~5 s later.
      const feed = createFeedFeature({ sources: { approvals: () => [], routines: async () => [] } }); // decisions: the real ctx.db.listDecisions(50)
      db.insertDecision(decision("boot-1", new Date().toISOString())); // stamped the way director.ts's applyAnswers stamps them
      const ctx = fakeCtx([], db);
      const route = feed.routes?.[0];
      if (!route || !feed.onTick) throw new Error("feed shape");
      await feed.onTick(ctx);
      expect((await getFeed(route, ctx, "")).items.map((i) => i.id)).toEqual(["decision:boot-1"]);
      await feed.onTick(ctx);
      expect((await getFeed(route, ctx, "")).items.map((i) => i.id)).toEqual(["decision:boot-1"]); // not twice

      // The next restart (a minute on) finds boot-1 already in the store: history now, not news.
      const feed2 = createFeedFeature({ sources: { approvals: () => [], routines: async () => [] }, startedAt: Date.now() + 60_000 });
      const route2 = feed2.routes?.[0];
      if (!route2 || !feed2.onTick) throw new Error("feed shape");
      await feed2.onTick(ctx);
      expect((await getFeed(route2, ctx, "")).items).toEqual([]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the director's growth steps stay out of the feed (~1 a minute, not news); other store decisions still land", async () => {
    const at = "2026-10-27T09:00:00.000Z";
    const d = (id: string, kind: JevDecision["kind"]): JevDecision => ({ id, at, kind, subjects: ["skill:x"], choice: "skill:x", probabilities: {}, confidence: 1, source: "rules", summary: `${kind} ${id}` });
    let decisions: JevDecision[] = [];
    const feed = createFeedFeature({ sources: { decisions: () => decisions, approvals: () => [], routines: async () => [] } });
    const ctx = fakeCtx([]);
    const route = feed.routes?.[0];
    if (!route || !feed.onTick) throw new Error("feed shape");
    await feed.onTick(ctx);
    decisions = [d("g3", "grow"), d("r1", "roam"), d("g2", "grow"), d("g1", "grow")];
    await feed.onTick(ctx);
    await feed.onTick(ctx);
    expect((await getFeed(route, ctx, "")).items.map((i) => i.id)).toEqual(["decision:r1"]);
  });

  it("accepts a tripwire any feature publishes with appendToFeed (the Town square's generic hook)", async () => {
    const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] }, routineEveryMs: 60_000 });
    const emitted: FeedMessage[] = [];
    const ctx = fakeCtx(emitted);
    const route = feed.routes?.[0];
    if (!route || !feed.onTick) throw new Error("feed shape");
    appendToFeed({ id: "tripwire:lesson:1", at: "2026-09-27T16:00:00.000Z", kind: "tripwire", agentId: "s1", title: "Repeating a known lesson", detail: null, tag: "lesson" });
    await feed.onTick(ctx); // before the first tick there is no live context: queued, then flushed here
    appendToFeed({ id: "tripwire:lesson:2", at: "2026-09-27T16:01:00.000Z", kind: "tripwire", agentId: "s2", title: "Repeating a known lesson", detail: null, tag: "lesson" }); // live: flushed at once
    const r = await getFeed(route, ctx, "?since=0");
    expect(r.items.map((i) => [i.kind, i.id, i.agentId])).toEqual([
      ["tripwire", "tripwire:lesson:1", "s1"],
      ["tripwire", "tripwire:lesson:2", "s2"],
    ]);
    expect(emitted.flatMap((m) => m.items).map((i) => i.kind)).toEqual(["tripwire", "tripwire"]);
  });

  it("onFeedItems (the logs tap) fires once per push, with the added items", async () => {
    const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] } });
    const ctx = fakeCtx([]);
    const route = feed.routes?.[0];
    if (!route || !feed.onTick) throw new Error("feed shape");
    await feed.onTick(ctx); // gives it a live context: appendToFeed flushes at once from here on

    const seen: FeedItem[][] = [];
    const unsubscribe = onFeedItems((items) => void seen.push([...items]));
    try {
      appendToFeed({ id: "mac:1", at: "2026-09-27T16:00:00.000Z", kind: "mac", agentId: "a1", title: "Opened Safari", detail: null, tag: null });
      appendToFeed({ id: "mac:2", at: "2026-09-27T16:00:01.000Z", kind: "mac", agentId: "a1", title: "Quit Safari", detail: null, tag: null });
    } finally {
      unsubscribe();
    }
    expect(seen).toHaveLength(2); // one push per appendToFeed call: each flushes immediately
    expect(seen[0]?.map((i) => i.title)).toEqual(["Opened Safari"]);
    expect(seen[1]?.map((i) => i.title)).toEqual(["Quit Safari"]);
  });

  describe("retention: a 2 h time floor, not only a count cap", () => {
    const MIN = 60_000;
    const lines = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => userLine({ cwd: "/r", timestamp: `2026-09-25T07:00:${String(from + i).padStart(2, "0")}.000Z`, text: `p${from + i}` }));

    it("over `cap`, an item younger than 2 h is kept; once it is older, it goes", async () => {
      let t = 1_000_000_000;
      const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] }, cap: 3, now: () => t });
      const ctx = fakeCtx([]);
      const route = feed.routes?.[0];
      if (!route || !feed.onIndexPass) throw new Error("feed shape");
      await feed.onIndexPass(ctx, new Map([["s", lines(0, 5)]]));
      expect((await getFeed(route, ctx, "?since=0")).items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]); // 5 > cap, all under 2 h: all kept
      t += 90 * MIN;
      await feed.onIndexPass(ctx, new Map([["s", lines(5, 2)]]));
      expect((await getFeed(route, ctx, "?since=0")).items).toHaveLength(7); // the first 5 are 90 min old: still kept
      t += 31 * MIN; // the first 5 are now 121 min old, the next 2 are 31 min old
      await feed.onIndexPass(ctx, new Map([["s", lines(7, 1)]]));
      // Over cap: the 2 h-old ones go, but only down to `cap` — the ring never drops below it.
      expect((await getFeed(route, ctx, "?since=0")).items.map((i) => i.seq)).toEqual([6, 7, 8]);
    });

    it("ages items by when they landed, not by their own (older) source time", async () => {
      let t = Date.parse("2026-09-28T12:00:00.000Z");
      const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] }, cap: 1, now: () => t });
      const ctx = fakeCtx([]);
      const route = feed.routes?.[0];
      if (!route || !feed.onIndexPass) throw new Error("feed shape");
      await feed.onIndexPass(ctx, new Map([["s", lines(0, 3)]])); // source time: 3 days before `t`
      t += 60 * MIN;
      await feed.onIndexPass(ctx, new Map([["s", lines(3, 1)]]));
      expect((await getFeed(route, ctx, "?since=0")).items).toHaveLength(4);
    });

    it("the hard cap bounds a flood, even inside the 2 h (and says so once in the log)", async () => {
      const warnings: string[] = [];
      const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] }, cap: 2, hardCap: 4 });
      const ctx = { ...fakeCtx([]), log: { info: () => {}, warn: (_f: string, m: string) => void warnings.push(m), error: () => {} } } as unknown as FeatureContext;
      const route = feed.routes?.[0];
      if (!route || !feed.onIndexPass) throw new Error("feed shape");
      await feed.onIndexPass(ctx, new Map([["s", lines(0, 6)]]));
      await feed.onIndexPass(ctx, new Map([["s", lines(6, 1)]]));
      expect((await getFeed(route, ctx, "?since=0")).items.map((i) => i.seq)).toEqual([4, 5, 6, 7]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/ring over 4 items/);
    });
  });

  describe("the client bridge forwards governance decisions (client/src/features/feed-bridge.ts)", () => {
    const base = { seq: 1, at: "2026-09-28T12:00:00.000Z", agentId: null, detail: "d" };
    const items: FeedItem[] = [
      { ...base, id: "gov:jev:1", kind: "decision", title: "Jev ranked 3 candidates: 1 proposed, p(none) 0.20", tag: "gov:jev" },
      { ...base, id: "gov:click:president:x:dismissed:1", kind: "decision", title: "Alex dismissed a session proposal from the president's board", tag: "gov:click" },
      { ...base, id: "gov:council:c1", kind: "decision", title: "The council reached a verdict", tag: "gov:council" },
      { ...base, id: "gov:resident:filed:rp-1", kind: "decision", title: "The resident filed a note proposal", tag: "gov:resident" },
      { ...base, id: "gov:census:sboghossian/agent-world#57", kind: "decision", title: "Alef upgraded itself: merged sboghossian/agent-world#57", tag: "gov:census" },
      // The store's own decision (director.ts): it reaches the client through the store, never twice.
      { ...base, id: "decision:d1", kind: "decision", title: "agent grows", tag: "grow" },
      // A gov tag on another kind is not a governance decision.
      { ...base, id: "tripwire:x", kind: "tripwire", title: "Repeating a known lesson", tag: "gov:click" },
      // A timestamp that doesn't parse.
      { ...base, id: "gov:jev:bad", at: "not a date", kind: "decision", title: "x", tag: "gov:jev" },
    ];

    it("Jev's ranking stays a Jev decision, every other source is a system line; store decisions are skipped", () => {
      const { governance } = bridgeItems(items);
      expect(governance.map((i) => [i.id, i.kind])).toEqual([
        ["srv:gov:jev:1", "decision"],
        ["srv:gov:click:president:x:dismissed:1", "system"],
        ["srv:gov:council:c1", "system"],
        ["srv:gov:resident:filed:rp-1", "system"],
        ["srv:gov:census:sboghossian/agent-world#57", "system"],
      ]);
      expect(governance.every((i) => i.pinned === undefined && i.approval === undefined)).toBe(true);
      expect(governance.find((i) => i.id.includes("census"))?.href).toBe("https://github.com/sboghossian/agent-world/pull/57");
      expect(governance.filter((i) => i.href !== undefined)).toHaveLength(1);
      expect(governance[0]?.at).toBe(Date.parse(base.at));
      expect(governance[0]?.detail).toBe("d");
    });

    it("an unknown kind is still dropped, gov tag or not", () => {
      expect(bridgeItems([{ ...base, id: "gov:x", kind: "vote", title: "x", tag: "gov:click" }]).governance).toEqual([]);
    });
  });

  describe("history for the Town square (client/src/features/feed-bridge.ts)", () => {
    const MIN = 60_000;
    const NOW = Date.parse("2026-09-27T17:00:00.000Z");
    const WINDOW = 120 * MIN;

    /** A live feed holding 900 real routine-run items, one every 10 s over the last 150 min. */
    async function busyFeed(): Promise<{ route: Route; ctx: FeatureContext; get: (path: string) => Promise<FeedResponse> }> {
      const feed = createFeedFeature({ sources: { decisions: () => [], approvals: () => [], routines: async () => [] }, routineEveryMs: 60_000 });
      const ctx = fakeCtx([]);
      const route = feed.routes?.[0];
      if (!route || !feed.onTick) throw new Error("feed shape");
      await feed.onTick(ctx); // gives the feed its live context: appends flush at once
      for (let i = 0; i < 900; i++) {
        const at = new Date(NOW - 150 * MIN + i * 10_000).toISOString();
        appendToFeed({ id: `routine:job-${i}:done:${at}`, at, kind: "routine", agentId: null, title: `job-${i} ran`, detail: "exit 0", tag: "finished" });
      }
      return { route, ctx, get: (path) => getFeed(route, ctx, path.replace(/^\/api\/feed/, "")) };
    }

    it("GET /api/feed?before= pages back: the newest `limit` items under that seq", async () => {
      const { get } = await busyFeed();
      const newest = await get("/api/feed?since=0&limit=500");
      expect(newest.items.map((i) => i.seq)).toEqual(Array.from({ length: 500 }, (_, i) => 401 + i));
      const older = await get("/api/feed?since=0&before=401&limit=500");
      expect(older.items.map((i) => i.seq)).toEqual(Array.from({ length: 400 }, (_, i) => 1 + i));
      expect((await get("/api/feed?since=100&before=103")).items.map((i) => i.seq)).toEqual([101, 102]);
      expect((await get("/api/feed?since=898&before=")).items.map((i) => i.seq)).toEqual([899, 900]); // empty: no bound
    });

    it("the bridge's page-load fetch covers the 2 h window, not just the newest 500 (~83 min here)", async () => {
      const { get } = await busyFeed();
      const one = await get(`/api/feed?since=0&limit=${FEED_PAGE}`);
      expect(Date.parse(one.items[0]?.at ?? "")).toBeGreaterThan(NOW - WINDOW + 30 * MIN); // one page stops well short of 2 h
      const res = await fetchFeedWindow(get, 0, NOW - WINDOW);
      const inWindow = res?.items.filter((i) => Date.parse(i.at) >= NOW - WINDOW) ?? [];
      expect(inWindow).toHaveLength(720); // every run of the last 120 min (10 s apart, the newest 10 s ago)
      expect(res?.items.map((i) => i.seq)).toEqual(Array.from({ length: 900 }, (_, i) => 1 + i)); // oldest first, no gaps, no repeats
      // A reconnect in the same boot fetches only what it missed.
      const cursor = new FeedCursor();
      expect(cursor.see(res?.bootId ?? "", res?.items ?? [])).toBe(true);
      expect(cursor.since()).toBe(900);
      expect((await fetchFeedWindow(get, cursor.since(), NOW - WINDOW))?.items).toEqual([]);
    });

    it("paging against a server that ignores `before` stops instead of repeating the newest page", async () => {
      const { get } = await busyFeed();
      const oldServer = (path: string): Promise<FeedResponse> => get(path.replace(/&before=\d+/, ""));
      const res = await fetchFeedWindow(oldServer, 0, NOW - WINDOW);
      expect(res?.items.map((i) => i.seq)).toEqual(Array.from({ length: 500 }, (_, i) => 401 + i));
    });

    it("a push or response from another boot (the server restarted) sends the bridge back to seq 0", async () => {
      const cursor = new FeedCursor();
      expect(cursor.since()).toBe(0);
      const a = await busyFeed();
      const first = await fetchFeedWindow(a.get, 0, NOW - WINDOW);
      expect(cursor.see(first?.bootId ?? "", first?.items ?? [])).toBe(true);
      expect(cursor.since()).toBe(900);
      const b = await busyFeed(); // a new boot: new bootId, seq restarted
      const after = await b.get(`/api/feed?since=${cursor.since()}&limit=${FEED_PAGE}`);
      expect(after.items).toEqual([]); // asking the new boot from the old cursor misses everything…
      expect(cursor.see(after.bootId, after.items)).toBe(false); // …so the bridge notices the boot changed
      expect(cursor.since()).toBe(0);
      expect((await fetchFeedWindow(b.get, cursor.since(), NOW - WINDOW))?.items).toHaveLength(900);
    });
  });
});
