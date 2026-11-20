import { describe, expect, it } from "vitest";
import type { AgentActivity, JevDecision, WorldAgent } from "../../../shared/types";
import type { ApprovalView } from "../../../shared/features/approvals";
import { isFeedDecision } from "../../../shared/features/feed";
import type { Routine } from "../../../shared/features/routines";
import type { ClientContext } from "../features/registry";
import { approvalFailureText, approvalGone, decideApprovalResult, TOO_LATE } from "../features/approvals";
import { FeedHolds, FeedSends, sendDecision } from "./feed-hold";
import {
  FeedStore,
  activityToFeed,
  approvalToFeed,
  awaitingDiff,
  awaitingToFeed,
  decisionToFeed,
  routineRunsToFeed,
  type FeedItem,
} from "./feed";

const T0 = Date.parse("2026-09-25T10:00:00Z");
const item = (id: string, at: number, extra: Partial<FeedItem> = {}): FeedItem => ({ id, kind: "activity", at, title: id, ...extra });
const who = (id: string): { title: string; city: string } | undefined => (id === "a1" ? { title: "Fix the blog", city: "acme-ai-next" } : undefined);

describe("FeedStore", () => {
  it("dedupes by id, updates in place, and only notifies on real changes", () => {
    const f = new FeedStore();
    let n = 0;
    f.onChange(() => n++);
    expect(f.push([item("x", T0), item("y", T0 + 1)])).toBe(true);
    expect(f.push(item("x", T0))).toBe(false);
    expect(f.push(item("x", T0, { title: "x2" }))).toBe(true);
    expect(f.size()).toBe(2);
    expect(f.get("x")?.title).toBe("x2");
    expect(n).toBe(2);
  });

  it("drops malformed items", () => {
    const f = new FeedStore();
    expect(f.push([item("", T0), { ...item("z", T0), title: "" }, item("nan", Number.NaN)])).toBe(false);
    expect(f.size()).toBe(0);
  });

  it("lists open pinned items first (approvals, then waiting, oldest first), then newest first", () => {
    const f = new FeedStore();
    f.push([
      item("old", T0),
      item("new", T0 + 50),
      item("wait", T0 + 10, { kind: "awaiting", pinned: true }),
      item("ap2", T0 + 30, { kind: "approval", pinned: true }),
      item("ap1", T0 + 20, { kind: "approval", pinned: true }),
    ]);
    expect(f.list().map((i) => i.id)).toEqual(["ap1", "ap2", "wait", "new", "old"]);
    f.resolve("ap1", "allow");
    expect(f.list().map((i) => i.id)).toEqual(["ap2", "wait", "new", "ap1", "old"]);
    expect(f.openCount()).toBe(2);
  });

  it("filters by kind and agent, and counts per kind", () => {
    const f = new FeedStore();
    f.push([item("a", T0, { agentId: "a1" }), item("d", T0 + 1, { kind: "decision" }), item("c", T0 + 2, { kind: "caption", agentId: "a1" })]);
    expect(f.list({ kinds: new Set(["decision"]) }).map((i) => i.id)).toEqual(["d"]);
    expect(f.list({ agentId: "a1" }).map((i) => i.id)).toEqual(["c", "a"]);
    expect(f.list({ kinds: new Set() }).length).toBe(3);
    expect(f.counts().caption).toBe(1);
    expect(f.counts().approval).toBe(0);
  });

  it("never re-opens a decided item when a stale copy arrives", () => {
    const f = new FeedStore();
    f.push(item("ap", T0, { kind: "approval", pinned: true }));
    f.resolve("ap", "deny");
    f.push(item("ap", T0, { kind: "approval", pinned: true }));
    expect(f.get("ap")?.outcome).toBe("deny");
    expect(f.openCount()).toBe(0);
  });

  it("caps the store, dropping the oldest closed items but never open ones", () => {
    const f = new FeedStore(3);
    f.push(item("pin", T0 - 1000, { kind: "approval", pinned: true }));
    for (let i = 0; i < 5; i++) f.push(item(`i${i}`, T0 + i));
    expect(f.size()).toBe(3);
    expect(f.get("pin")).toBeDefined();
    expect(f.list().map((i) => i.id)).toEqual(["pin", "i4", "i3"]);
  });

  it("counts unseen items since markSeen", () => {
    const f = new FeedStore();
    f.push([item("a", T0), item("b", T0 + 10)]);
    f.markSeen(T0 + 5);
    expect(f.unseen()).toBe(1);
  });
});

describe("feed adapters", () => {
  const act = (stage: AgentActivity["stage"], summary = "Edited index.ts"): AgentActivity => ({
    id: `id-${stage}`,
    agentId: "a1",
    at: "2026-09-25T10:00:00Z",
    stage,
    toolName: stage === "tool" ? "Edit" : null,
    targetObjectId: null,
    summary,
  });

  it("maps plan/reason lines to captions and the rest to activity", () => {
    expect(activityToFeed(act("reason"), who)?.kind).toBe("caption");
    expect(activityToFeed(act("plan"), who)?.kind).toBe("caption");
    const tool = activityToFeed(act("tool"), who);
    expect(tool).toMatchObject({ id: "act:id-tool", kind: "activity", at: T0, agentId: "a1", detail: "Fix the blog · acme-ai-next · Edit" });
    expect(activityToFeed(act("tool", ""), who)).toBeNull();
  });

  it("maps decisions to official results", () => {
    const d: JevDecision = { id: "d1", at: "2026-09-25T10:00:00Z", kind: "visit", subjects: ["a1", "skill:x"], choice: "go", probabilities: {}, confidence: 0.82, source: "jev", summary: "a1 visits blog" } as unknown as JevDecision;
    expect(decisionToFeed(d)).toMatchObject({ id: "dec:d1", kind: "decision", title: "a1 visits blog", detail: "Official result · Jev 82% sure", agentId: "a1" });
  });

  it("keeps the director's growth steps out of the Feed (isFeedDecision)", () => {
    const d = (kind: JevDecision["kind"]): JevDecision => ({ id: kind, at: "2026-10-27T09:00:00Z", kind, subjects: [], choice: "x", probabilities: {}, confidence: 1, source: "rules", summary: "x" });
    expect(isFeedDecision(d("grow"))).toBe(false);
    expect(isFeedDecision(d("roam"))).toBe(true);
    expect(isFeedDecision(d("pair"))).toBe(true);
  });

  it("maps approvals to pinned actionable items", () => {
    const a: ApprovalView = {
      id: "p1",
      agentId: "a1",
      cwd: "/x",
      toolName: "Bash",
      preview: { kind: "command", title: "rm -rf build", body: "rm -rf build" },
      createdAt: "2026-09-25T10:00:00Z",
      expiresAt: "2026-09-25T10:01:00Z",
    };
    expect(approvalToFeed(a, who)).toMatchObject({ id: "ap:p1", kind: "approval", pinned: true, title: "Bash: rm -rf build", approval: { id: "p1", toolName: "Bash", expiresAt: T0 + 60_000 } });
  });

  it("detects agents that start / stop waiting", () => {
    const ag = (id: string, awaiting: boolean): WorldAgent => ({ id, awaitingInput: awaiting, title: id, islandId: "c", lastActive: "2026-09-25T10:00:00Z" }) as WorldAgent;
    const d = awaitingDiff(new Set(["b"]), [ag("a", true), ag("b", false), ag("c", true)]);
    expect(d.started.map((a) => a.id)).toEqual(["a", "c"]);
    expect(d.stopped).toEqual(["b"]);
    expect(awaitingToFeed(ag("a", true), "city")).toMatchObject({ kind: "awaiting", pinned: true, agentId: "a", cityId: "c" });
  });

  it("turns routine running flips into start / finish items", () => {
    const r = (running: boolean, exit: number | null): Routine => ({
      label: "com.stephane.yalla-brief",
      shortName: "yalla-brief",
      program: "x",
      schedule: { kind: "calendar", text: "daily 08:00", nextRunAt: null },
      running,
      lastExitStatus: exit,
      ranRecently: false,
      skillDescription: null,
    });
    expect(routineRunsToFeed(null, [r(true, 0)], T0)).toEqual([]);
    expect(routineRunsToFeed([r(false, 0)], [r(true, 0)], T0)[0]?.title).toBe("yalla-brief started");
    expect(routineRunsToFeed([r(true, 0)], [r(false, 0)], T0)[0]?.title).toBe("yalla-brief finished OK");
    expect(routineRunsToFeed([r(true, 0)], [r(false, 2)], T0)[0]?.title).toBe("yalla-brief failed (exit 2)");
    expect(routineRunsToFeed([r(false, 0)], [r(false, 0)], T0)).toEqual([]);
  });
});

describe("FeedHolds (inline approve / deny reuse the courier hold-to-confirm)", () => {
  it("fires once after a full hold on an armed item", () => {
    const h = new FeedHolds(1000, 600);
    h.sync(["p1"], 0);
    expect(h.press("p1", "allow", 100)).toBe("not-armed");
    expect(h.press("p1", "allow", 700)).toBe("started");
    expect(h.tick(1500)).toEqual([]);
    expect(h.progress("p1", 1200).value).toBeCloseTo(0.5);
    expect(h.tick(1700)).toEqual([{ action: "allow", targetId: "p1" }]);
    expect(h.tick(2000)).toEqual([]);
    // Still held: no second decision until released and pressed fresh.
    expect(h.press("p1", "allow", 2100)).toBe("busy");
  });

  it("sends nothing when released early, on key repeat, or once the item left the feed", () => {
    const h = new FeedHolds(1000, 600);
    h.sync(["p1", "p2"], 0);
    expect(h.press("p1", "deny", 700)).toBe("started");
    h.release("p1", "deny");
    expect(h.tick(5000)).toEqual([]);
    expect(h.press("p1", "deny", 800, true)).toBe("repeat");
    expect(h.press("p2", "allow", 700)).toBe("started");
    h.sync(["p1"], 900);
    expect(h.tick(5000)).toEqual([]);
    expect(h.press("p2", "allow", 5000)).toBe("no-target");
  });
});

describe("sendDecision (the Feed row reads Approved only once the server took it)", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
    let resolve = (): void => {};
    let reject = (_e: Error): void => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("shows Sending… while the POST is in flight and resolves the item only after it succeeds", async () => {
    const sends = new FeedSends();
    const d = deferred();
    const resolved: string[] = [];
    let renders = 0;
    let decides = 0;
    const deps = {
      decide: () => (decides++, d.promise),
      resolve: (id: string, o: string) => void resolved.push(`${id}=${o}`),
      changed: () => void renders++,
    };
    const run = sendDecision(sends, "p1", "allow", deps);
    expect(sends.get("p1")).toEqual({ phase: "sending", action: "allow" });
    expect(resolved).toEqual([]); // not "Approved" yet
    expect(renders).toBe(1);
    // A second fire while it's in flight is dropped: one POST per row.
    expect(await sendDecision(sends, "p1", "allow", deps)).toBe(false);
    expect(decides).toBe(1);
    d.resolve();
    expect(await run).toBe(true);
    expect(resolved).toEqual(["ap:p1=allow"]);
    expect(sends.get("p1")).toBeUndefined();
    expect(renders).toBe(2);
  });

  it("keeps the row actionable with the server's reason when the POST fails, and lets it retry", async () => {
    const sends = new FeedSends();
    const resolved: string[] = [];
    const failing = { decide: () => Promise.reject(new Error("Alef's server didn't answer")), resolve: (id: string, o: string) => void resolved.push(`${id}=${o}`), changed: () => {} };
    expect(await sendDecision(sends, "p1", "deny", failing)).toBe(false);
    expect(resolved).toEqual([]);
    expect(sends.get("p1")).toEqual({ phase: "failed", action: "deny", reason: "Alef's server didn't answer" });
    expect(sends.sending("p1")).toBe(false);
    const ok = { ...failing, decide: () => Promise.resolve() };
    expect(await sendDecision(sends, "p1", "deny", ok)).toBe(true);
    expect(resolved).toEqual(["ap:p1=deny"]);
  });

  it("forgets rows that are no longer open, but never one still in flight", () => {
    const sends = new FeedSends();
    sends.fail("gone", "allow", "x");
    sends.begin("flying", "allow");
    sends.fail("open", "deny", "y");
    sends.sync(["open"]);
    expect(sends.get("gone")).toBeUndefined();
    expect(sends.sending("flying")).toBe(true);
    expect(sends.get("open")?.phase).toBe("failed");
  });
});

describe("approval decisions: what the server's answer means for the card and the Feed", () => {
  it("classifies refusals: expired/unknown and already-settled are gone, network and 5xx are not", () => {
    expect(approvalGone("unknown or expired request")).toBe("expired");
    expect(approvalGone("request expired")).toBe("expired");
    expect(approvalGone("HTTP 410")).toBe("expired");
    expect(approvalGone("already settled")).toBe("settled");
    expect(approvalGone("world server unreachable")).toBeNull();
    expect(approvalGone("timed out")).toBeNull();
    expect(approvalGone("internal error")).toBeNull();
    expect(approvalGone("unknown error")).toBeNull();
    expect(approvalGone(undefined)).toBeNull();
    expect(approvalFailureText("unknown or expired request")).toBe(TOO_LATE);
    expect(approvalFailureText("world server unreachable")).toBe("Could not answer: Alef's server didn't answer (it may be restarting). Try again in a few seconds.");
  });

  function fakeCtx(answer: { ok: boolean; error?: string }): { ctx: ClientContext; resolved: string[]; posts: unknown[] } {
    const resolved: string[] = [];
    const posts: unknown[] = [];
    const ctx = {
      api: {
        postJson: <T,>(path: string, body: unknown): Promise<T> => {
          posts.push([path, body]);
          return Promise.resolve(answer as T);
        },
      },
      feed: { push: () => false, resolve: (id: string, o: string) => void resolved.push(`${id}=${o}`) },
      toast: () => {},
    } as unknown as ClientContext;
    return { ctx, resolved, posts };
  }

  it("records the real outcome in the Feed on success (before the queue drop could call it Closed)", async () => {
    const { ctx, resolved, posts } = fakeCtx({ ok: true });
    expect(await decideApprovalResult(ctx, "ap-1", "allow")).toEqual({ ok: true });
    expect(posts).toEqual([["/api/approvals/ap-1/decision", { behavior: "allow" }]]);
    expect(resolved).toEqual(["ap:ap-1=allow"]);
  });

  it("closes the item as expired on a 404 'unknown or expired request', and leaves it open on a network error", async () => {
    const gone = fakeCtx({ ok: false, error: "unknown or expired request" });
    expect(await decideApprovalResult(gone.ctx, "ap-2", "deny", "no")).toEqual({ ok: false, error: "unknown or expired request" });
    expect(gone.posts).toEqual([["/api/approvals/ap-2/decision", { behavior: "deny", message: "no" }]]);
    expect(gone.resolved).toEqual(["ap:ap-2=expired"]);
    const down = fakeCtx({ ok: false, error: "world server unreachable" });
    expect((await decideApprovalResult(down.ctx, "ap-3", "allow")).ok).toBe(false);
    expect(down.resolved).toEqual([]);
  });
});
