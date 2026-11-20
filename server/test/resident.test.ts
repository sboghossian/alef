// Feature-level tests for the Alef resident: never a real `claude` (a stub runner), never a real
// TypeSafe call (a stub fetch), never the real ~/.alef-resident (a temp home per test). Covers the
// kill switch (route + tick), the budget cap, the model-output validation (invalid → nothing
// written), "exit 0 having done nothing", the Jev tick (and Jev down), and approve/dismiss.

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorldAgent } from "../../shared/types.js";
import { isResidentState, type ResidentActionResult, type ResidentState } from "../../shared/features/resident.js";
import type { FetchLike } from "../director.js";
import { createResidentFeature, type ReflectRunner, type ResidentFeatureOptions } from "../features/resident.js";
import { hhmm, MAX_WAIT_EVENTS } from "../features/resident-lib.js";
import { checkRelShape } from "../features/resident-sandbox.js";
import { isAwaitingInput, isLive, processVouchedSessions } from "../heuristics.js";
import type { FeatureContext, ServerFeature } from "../features/registry.js";
import { bootTestServer } from "./helpers.js";
import type { RunningServer } from "../index.js";

/** A minimal fake IncomingMessage for calling a POST route's handler directly (no real HTTP):
 *  registers 'data'/'end' like readJsonBody expects, then delivers the body on the next microtask. */
function fakeJsonReq(body: unknown): IncomingMessage {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
    for (const cb of listeners.end ?? []) cb();
  });
  return req as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse {
  const res = { writeHead: () => res, end: () => {} };
  return res as unknown as ServerResponse;
}

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "resident-feature-"));
  home = join(root, "resident");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-26T10:00:00");
const TODAY = "2026-09-26";

function agent(id: string, status: "live" | "dormant", awaitingInput = false): WorldAgent {
  return { id, islandId: "x", cwd: "/x", title: `task ${id}`, status, startedAt: "", lastActive: "", messageCount: 1, model: null, role: "builder", color: "#000", targetIslandId: "x", tokens: 0, awaitingInput };
}

function fakeCtx(agents: () => WorldAgent[] = () => []): { ctx: FeatureContext; emitted: unknown[] } {
  const emitted: unknown[] = [];
  const ctx = {
    featureId: "resident",
    emit: (p: unknown) => emitted.push(p),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { typesafeApiKey: "" },
    worldViews: () => ({ agents: agents(), objects: [], edges: [], islands: [] }),
  };
  return { ctx: ctx as unknown as FeatureContext, emitted };
}

const reflection = { journal: "A calm hour.", goals: ["Watch closely", "Write daily"], skill: { name: "Fleet rhythm", body: "Mornings are busy." }, proposals: [{ kind: "session", title: "Clean stale todos", why: "Three are old." }] };

function envelope(result: string, cost = 0.02): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: cost });
}

type StubRunner = ReflectRunner & { calls: number; prompts: string[] };

function stubRunner(stdout: string): StubRunner {
  const stub: StubRunner = Object.assign(
    async (prompt: string) => {
      stub.calls++;
      stub.prompts.push(prompt);
      return { stdout, stderr: "", exitedOk: true };
    },
    { calls: 0, prompts: [] as string[] },
  );
  return stub;
}

function make(o: Partial<ResidentFeatureOptions> = {}): ServerFeature {
  return createResidentFeature({ homeDir: home, defaultEnabled: false, now: () => NOW, runner: stubRunner(envelope(JSON.stringify(reflection))), fetchImpl: async () => { throw new Error("no network"); }, ...o });
}

async function tick(f: ServerFeature, ctx: FeatureContext): Promise<void> {
  await f.onTick!(ctx);
}

function stateOf(f: ServerFeature, ctx: FeatureContext): ResidentState {
  const s = f.snapshotExtras!(ctx)["resident.state"];
  if (!isResidentState(s)) throw new Error("no valid resident.state");
  return s;
}

async function auditPaths(): Promise<string[]> {
  const text = await readFile(join(home, "writes.jsonl"), "utf8");
  return text.trim().split("\n").map((l) => (JSON.parse(l) as { path: string }).path);
}

async function seedState(extra: Record<string, unknown>): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "state.json"), JSON.stringify({ version: 1, name: "Alef resident", enabled: true, bornAt: "2026-09-24T09:00:00.000Z", capUsd: 0.5, spend: { day: TODAY, usd: 0 }, ...extra }));
}

describe("resident: kill switch", () => {
  it("defaults to disabled in tests: a tick creates nothing and never runs claude", async () => {
    const runner = stubRunner(envelope(JSON.stringify(reflection)));
    const f = make({ runner });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    expect(runner.calls).toBe(0);
    await expect(readdir(home)).rejects.toThrow(); // home never created
    expect(stateOf(f, ctx).enabled).toBe(false);
  });

  it("an enabled tick seeds the home, reflects once, and writes only allowlisted files", async () => {
    const runner = stubRunner(envelope(JSON.stringify(reflection), 0.021));
    const f = make({ runner, defaultEnabled: true });
    const { ctx, emitted } = fakeCtx();
    await tick(f, ctx);
    expect(runner.calls).toBe(1);
    expect(runner.prompts[0]).toContain("<<<UNTRUSTED_DATA");
    const s = stateOf(f, ctx);
    expect(s.day).toBe(1);
    expect(s.lastError).toBeNull();
    expect(s.lastReflectAt).not.toBeNull();
    expect(s.goals).toEqual(["Watch closely", "Write daily"]);
    expect(s.skills).toEqual(["fleet-rhythm"]);
    expect(s.spend).toEqual({ todayUsd: 0.021, capUsd: 0.5 });
    expect(s.proposals).toMatchObject([{ kind: "session", title: "Clean stale todos", status: "open" }]);
    expect(s.journalTail.join("\n")).toContain("A calm hour.");
    expect(s.recentWrites.length).toBeGreaterThan(0);
    const paths = await auditPaths();
    expect(paths.every((p) => checkRelShape(p) === null)).toBe(true);
    expect(paths).toContain(`journal/${TODAY}.md`);
    expect(emitted.at(-1)).toMatchObject({ kind: "state" });
    // A second tick inside the hour does not reflect again.
    await tick(f, ctx);
    expect(runner.calls).toBe(1);
  });

  it("switching off stops every later tick", async () => {
    await seedState({ enabled: false });
    const runner = stubRunner(envelope(JSON.stringify(reflection)));
    const f = make({ runner });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    expect(runner.calls).toBe(0);
  });

  it("POST /api/resident/enabled toggles it through the real server guard (JSON only)", async () => {
    let server: RunningServer | undefined;
    try {
      const booted = await bootTestServer({ configOverrides: { features: [make()] } });
      server = booted.server;
      const bad = await fetch(`${booted.base}/api/resident/enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) });
      expect(bad.status).toBe(400);
      const notJson = await fetch(`${booted.base}/api/resident/enabled`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "enabled=true" });
      expect(notJson.status).toBe(415);
      const on = await fetch(`${booted.base}/api/resident/enabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      expect(on.status).toBe(200);
      const body = (await on.json()) as ResidentActionResult;
      expect(body.ok && body.state?.enabled).toBe(true);
      expect(JSON.parse(await readFile(join(home, "state.json"), "utf8"))).toMatchObject({ enabled: true });
      const got = (await (await fetch(`${booted.base}/api/resident`)).json()) as ResidentState;
      expect(got.enabled).toBe(true);
    } finally {
      await server?.close();
    }
  });

  it("re-enabling resets the stale in-memory fleet sample, so the first tick after the kill switch never invents a wait/answer event timed to the re-enable instant", async () => {
    let t = NOW;
    let agents: WorldAgent[] = [agent("s1", "live", true)]; // waiting when the kill switch goes off
    const f = make({ defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // baseline: prevSample now remembers s1 as waiting

    const enabledRoute = f.routes!.find((r) => r.path === "/api/resident/enabled")!;
    const setEnabled = (enabled: boolean) => enabledRoute.handler(fakeJsonReq({ enabled }), fakeRes(), ctx, {});

    await setEnabled(false); // kill switch off
    t += 2 * 60 * 60_000; // hours pass; a disabled tick returns before touching prevSample
    await tick(f, ctx);
    agents = []; // by the time anyone looks again, s1 is simply gone — nobody witnessed how
    await setEnabled(true); // kill switch back on: the fix resets prevSample here
    t += 5 * 60_000;
    await tick(f, ctx); // first tick after re-enable
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    // No invented "stopped waiting"/"answered" for a change nobody saw happen. The only event is
    // the end the saved live set proves, stamped as a range over the off period, not this instant.
    expect(saved.waitEvents).toEqual([{ at: new Date(t).toISOString(), kind: "ended", title: "task s1", islandId: "x", sessionId: "s1", seenLiveAt: new Date(NOW).toISOString() }]);
  });
});

describe("resident: budget + validation", () => {
  it("skips the reflection when today's spend is at the cap, and notes it once", async () => {
    await seedState({ spend: { day: TODAY, usd: 0.495 } });
    const runner = stubRunner(envelope(JSON.stringify(reflection)));
    const f = make({ runner, reflectEveryMs: 0 });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    await tick(f, ctx);
    expect(runner.calls).toBe(0);
    const s = stateOf(f, ctx);
    expect(s.lastError).toMatch(/daily cap/);
    const journal = await readFile(join(home, `journal/${TODAY}.md`), "utf8");
    expect(journal.match(/budget/g)).toHaveLength(1);
  });

  it("invalid model JSON writes nothing from the model but still counts the spend", async () => {
    await seedState({});
    const bad = JSON.stringify({ ...reflection, proposals: [{ kind: "shell", title: "rm -rf ~", why: "x" }] });
    const f = make({ runner: stubRunner(envelope(bad, 0.03)) });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    const s = stateOf(f, ctx);
    expect(s.lastError).toMatch(/invalid reflection/);
    expect(s.lastReflectAt).toBeNull();
    expect(s.spend.todayUsd).toBe(0.03);
    expect(s.skills).toEqual([]);
    expect(s.proposals).toEqual([]);
    await expect(readFile(join(home, "proposals.json"), "utf8")).rejects.toThrow();
  });

  it("a run that exits 0 with no output is a failure, not a success", async () => {
    await seedState({});
    const f = make({ runner: stubRunner("") });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    const s = stateOf(f, ctx);
    expect(s.lastReflectAt).toBeNull();
    expect(s.lastError).toMatch(/reflection failed/);
  });
});

describe("resident: Jev tick", () => {
  const jevOk: FetchLike = async () =>
    new Response(JSON.stringify({ answers: { mood: { choice: "busy", probabilities: { busy: 0.8 }, confidence: 0.8 }, noteworthy: { choice: "yes", probabilities: { yes: 0.9 }, confidence: 0.9 } } }), { status: 200 });

  it("writes one observation line when Jev finds the change noteworthy", async () => {
    await seedState({ lastReflectAt: new Date(NOW).toISOString() });
    let agents = [agent("a", "dormant")];
    const f = make({ apiKey: "test-key", fetchImpl: jevOk });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // first sample: counts only, no Jev call
    agents = [agent("a", "live", true)];
    await tick(f, ctx);
    const journal = await readFile(join(home, `journal/${TODAY}.md`), "utf8");
    expect(journal).toMatch(/busy \(Jev 80%\) · 1 started \("task a"\)/);
  });

  it("Jev down: logs, skips, never throws", async () => {
    await seedState({ lastReflectAt: new Date(NOW).toISOString() });
    let agents = [agent("a", "dormant")];
    const f = make({ apiKey: "test-key" }); // fetchImpl always throws
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx);
    agents = [agent("a", "live")];
    await expect(tick(f, ctx)).resolves.toBeUndefined();
    const journal = await readFile(join(home, `journal/${TODAY}.md`), "utf8").catch(() => "");
    expect(journal).not.toMatch(/Jev/);
  });
});

describe("resident: reflects on change, not by the clock alone", () => {
  it("a quiet fleet waits 3 intervals; a change brings the next reflection back to 1 interval", async () => {
    const HOUR = 60 * 60_000;
    let t = NOW;
    let agents: WorldAgent[] = [];
    const runner = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const f = make({ runner, defaultEnabled: true, now: () => t, reflectEveryMs: HOUR });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // first tick after boot reflects on schedule
    expect(runner.calls).toBe(1);
    t += HOUR + 1;
    await tick(f, ctx); // an hour later, nothing changed: skip
    expect(runner.calls).toBe(1);
    t += 2 * HOUR;
    await tick(f, ctx); // 3h quiet: reflect anyway
    expect(runner.calls).toBe(2);
    agents = [{ id: "a1", title: "new work", status: "live", awaitingInput: false, islandId: "x", lastActive: new Date(t).toISOString() } as unknown as WorldAgent];
    t += HOUR + 1;
    await tick(f, ctx); // the fleet changed: hourly again
    expect(runner.calls).toBe(3);
  });

  it("a failed reflection keeps the hourly cadence after a change (only success resets it)", async () => {
    const HOUR = 60 * 60_000;
    let t = NOW;
    let agents: WorldAgent[] = [];
    const runner = stubRunner("not json");
    const f = make({ runner, defaultEnabled: true, now: () => t, reflectEveryMs: HOUR });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // boot: attempts and fails
    expect(runner.calls).toBe(1);
    agents = [{ id: "a1", title: "work", status: "live", awaitingInput: false, islandId: "x", lastActive: new Date(t).toISOString() } as unknown as WorldAgent];
    t += HOUR + 1;
    await tick(f, ctx); // fleet changed: retries hourly
    expect(runner.calls).toBe(2);
    t += HOUR + 1;
    await tick(f, ctx); // that one failed too: the change still counts, so hourly again
    expect(runner.calls).toBe(3);
  });
});

describe("resident: proposals", () => {
  it("approve and dismiss only change status inside the home", async () => {
    const f = make({ defaultEnabled: true, runner: stubRunner(envelope(JSON.stringify({ ...reflection, proposals: [reflection.proposals[0], { kind: "memory", title: "Remember X", why: "y" }] }))) });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    const [p1, p2] = stateOf(f, ctx).proposals;
    const route = (suffix: string) => f.routes!.find((r) => r.path === `/api/resident/proposals/:id/${suffix}`)!;
    const call = async (suffix: string, id: string): Promise<number> => {
      let code = 0;
      const res = { writeHead: (c: number) => ((code = c), res), end: () => {} };
      await route(suffix).handler({} as never, res as never, ctx, { id });
      return code;
    };
    expect(await call("approve", p1!.id)).toBe(200);
    expect(await call("dismiss", p2!.id)).toBe(200);
    expect(await call("approve", p1!.id)).toBe(404); // already decided
    expect(await call("dismiss", "nope")).toBe(404);
    const saved = JSON.parse(await readFile(join(home, "proposals.json"), "utf8")) as { id: string; status: string }[];
    expect(Object.fromEntries(saved.map((p) => [p.id, p.status]))).toEqual({ [p1!.id]: "approved", [p2!.id]: "dismissed" });
    expect((await auditPaths()).every((p) => checkRelShape(p) === null)).toBe(true);
  });

  it("the resident withdraws its own open proposals by id; unknown and decided ids are ignored", async () => {
    await seedState({ lastReflectAt: null });
    const old = [
      { id: "rp-a1-0", at: "2026-09-26T10:00:00.000Z", kind: "note", title: "Define the waiting signal", why: "w", status: "open" },
      { id: "rp-a2-0", at: "2026-09-26T09:00:00.000Z", kind: "note", title: "Remember tidy mornings", why: "w", status: "open" },
      { id: "rp-a3-0", at: "2026-09-26T08:00:00.000Z", kind: "note", title: "Something approved", why: "w", status: "approved" },
    ];
    await writeFile(join(home, "proposals.json"), JSON.stringify(old));
    const runner = stubRunner(envelope(JSON.stringify({ journal: "Cleaned up.", goals: ["g"], withdraw: ["rp-a1-0", "rp-a3-0", "rp-zz-0"] })));
    const f = make({ runner, defaultEnabled: true });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    expect(runner.prompts[0]).toContain("(id rp-a1-0) Define the waiting signal");
    const saved = JSON.parse(await readFile(join(home, "proposals.json"), "utf8")) as { id: string; status: string }[];
    expect(Object.fromEntries(saved.map((p) => [p.id, p.status]))).toEqual({ "rp-a1-0": "dismissed", "rp-a2-0": "open", "rp-a3-0": "approved" });
  });

  // Regression: a single malformed withdraw id used to fail parseReflection entirely, so the whole
  // hour's journal went unwritten. It must now cost only that id.
  it("a bad withdraw id costs only that id: the journal still writes and the drop is audited", async () => {
    await seedState({ lastReflectAt: null });
    const open = [{ id: "rp-muimu6sm-0", at: "2026-09-26T09:00:00.000Z", kind: "note", title: "Something open", why: "w", status: "open" }];
    await writeFile(join(home, "proposals.json"), JSON.stringify(open));
    const runner = stubRunner(envelope(JSON.stringify({ journal: "Withdrew what I could this hour.", goals: ["g"], withdraw: ["rp-xxxx", "rp-muimu6sm-0", 42] })));
    const f = make({ runner, defaultEnabled: true });
    const { ctx } = fakeCtx();
    await tick(f, ctx);
    const s = stateOf(f, ctx);
    expect(s.lastError).toBeNull(); // success, same as any other valid reflection
    expect(s.lastReflectAt).not.toBeNull();
    const journal = await readFile(join(home, `journal/${TODAY}.md`), "utf8");
    expect(journal).toContain("Withdrew what I could this hour."); // the hour's reflection was NOT thrown away
    const saved = JSON.parse(await readFile(join(home, "proposals.json"), "utf8")) as { id: string; status: string }[];
    expect(Object.fromEntries(saved.map((p) => [p.id, p.status]))).toEqual({ "rp-muimu6sm-0": "dismissed" }); // the well-formed id still withdrew
    expect(s.recentWrites.some((w) => /dropped 2 invalid withdraw id/.test(w.reason))).toBe(true); // the drop is on the audited path
  });

  it("snapshotExtras is empty until loaded, then carries resident.state", async () => {
    const f = make();
    const { ctx } = fakeCtx();
    expect(f.snapshotExtras!(ctx)).toEqual({});
    await f.routes!.find((r) => r.path === "/api/resident")!.handler({} as never, { writeHead: () => ({ end: () => {} }), end: () => {} } as never, ctx, {});
    expect(isResidentState(f.snapshotExtras!(ctx)["resident.state"])).toBe(true);
  });
});

// A session's real fields, not the trimmed FleetEntry shape: startedAt, lastActive and
// messageCount, the ones summarizeSince actually reads.
function fullAgent(over: Partial<WorldAgent> & Pick<WorldAgent, "id">): WorldAgent {
  return {
    islandId: "x",
    cwd: "/x",
    title: `task ${over.id}`,
    status: "live",
    startedAt: new Date(NOW).toISOString(),
    lastActive: new Date(NOW).toISOString(),
    messageCount: 1,
    model: null,
    role: "builder",
    color: "#000",
    targetIslandId: "x",
    tokens: 0,
    awaitingInput: false,
    ...over,
  };
}

describe("resident: since-last-reflection ground truth", () => {
  it("a session that starts and ends between two reflections appears in the next prompt", async () => {
    let t = NOW;
    let agents: WorldAgent[] = [];
    const runner = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const f = make({ runner, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // T0: first reflection ever (since = local midnight)
    expect(runner.calls).toBe(1);
    const startedIso = new Date(t + 20 * 60_000).toISOString();
    const endedIso = new Date(t + 40 * 60_000).toISOString();
    agents = [fullAgent({ id: "s1", status: "dormant", startedAt: startedIso, lastActive: endedIso })];
    t += 70 * 60_000;
    await tick(f, ctx); // T0+70m: since = T0 (the persisted lastReflectAt from the first reflection)
    expect(runner.calls).toBe(2);
    const prompt = runner.prompts[1]!;
    expect(prompt).toMatch(/started · task s1/);
    expect(prompt).toMatch(/ended · task s1/);
  });

  it("the same start+end pair survives a server restart (a new feature instance on the same home)", async () => {
    let t = NOW;
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx: ctxA } = fakeCtx(() => []);
    await tick(fA, ctxA); // T0, on instance A
    const startedIso = new Date(t + 20 * 60_000).toISOString();
    const endedIso = new Date(t + 40 * 60_000).toISOString();
    t += 70 * 60_000;
    // "Restart": a brand-new feature instance, same home, its own in-memory state (prevSample=null).
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const agentsB = [fullAgent({ id: "s1", status: "dormant", startedAt: startedIso, lastActive: endedIso })];
    const { ctx: ctxB } = fakeCtx(() => agentsB);
    await tick(fB, ctxB); // its "since" must come from state.json's lastReflectAt, not a live sample
    expect(runnerB.calls).toBe(1);
    const prompt = runnerB.prompts[0]!;
    expect(prompt).toMatch(/started · task s1/);
    expect(prompt).toMatch(/ended · task s1/);
  });

  it("a wait/answer pair survives a restart, reaches the next prompt, and clears only after a reflection lands", async () => {
    let t = NOW;
    let agents: WorldAgent[] = [fullAgent({ id: "s1", awaitingInput: false })];
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    // A very long interval: after the very first tick's always-reflects bootstrap (fresh state,
    // nothing to clear yet), later ticks in this test never come due again, isolating "a tick
    // noticed and persisted it" from "a reflection consumed it". The clock still advances by a
    // realistic 5-minute tick between samples (real ticks always do).
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(() => agents);
    await tick(fA, ctxA); // baseline sample; first-ever tick always reflects, but nothing to clear yet
    expect(runnerA.calls).toBe(1);
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1", awaitingInput: true })];
    await tick(fA, ctxA); // began waiting
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1", awaitingInput: false })];
    await tick(fA, ctxA); // Alex answered
    expect(runnerA.calls).toBe(1); // no reflection ran again on instance A
    const beforeRestart = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    expect(beforeRestart.waitEvents).toHaveLength(2);

    // "Restart": a fresh instance, same home, forced to reflect immediately.
    t += 5 * 60_000;
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx: ctxB } = fakeCtx(() => agents);
    await tick(fB, ctxB);
    expect(runnerB.calls).toBe(1);
    const prompt = runnerB.prompts[0]!;
    expect(prompt).toMatch(/began waiting on Alex/);
    expect(prompt).toMatch(/stopped waiting \(still live\) · task s1/); // not known to be a human answer
    expect(prompt).not.toMatch(/Alex answered/);
    const afterSuccess = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    expect(afterSuccess.waitEvents).toEqual([]); // cleared only because this reflection landed
  });

  it("a waiting session that goes DORMANT (not answered) never becomes a false 'Alex answered' ground-truth line", async () => {
    // Probe P2 from the PR #28 review: closing a session whose last message ended in "?", a headless
    // `claude -p` run ending on a question, or process vouching moving to a newer session in the
    // same cwd all flip awaitingInput true→false without Alex ever answering anything.
    let t = NOW;
    let agents: WorldAgent[] = [fullAgent({ id: "s1", status: "live", awaitingInput: true })];
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(() => agents);
    await tick(fA, ctxA); // baseline: s1 waiting
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1", status: "dormant", awaitingInput: false })]; // closed/ended, not answered
    await tick(fA, ctxA);
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: { kind: string }[] };
    expect(saved.waitEvents).toEqual([
      { at: expect.any(String), kind: "stopped_waiting", title: "task s1", islandId: "x", sessionId: "s1" },
      { at: expect.any(String), kind: "ended", title: "task s1", islandId: "x", sessionId: "s1" },
    ]);
    const endedAt = t;

    t += 5 * 60_000;
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx: ctxB } = fakeCtx(() => agents);
    await tick(fB, ctxB); // forced reflection: reads the persisted waitEvents as ground truth
    const prompt = runnerB.prompts[0]!;
    // One line for the one transition; a range back to its last write (NOW), since a vouch may have held it.
    expect(prompt).toContain(`ended between ${hhmm(NOW)} and ${hhmm(endedAt)} while waiting on Alex · task s1 · x`);
    expect(prompt).not.toMatch(/Alex answered|stopped waiting/);
  });

  it("a waiting session Alex answered that then ended before the next tick reads 'ended', never 'ended while waiting on Alex'", async () => {
    // Waiting at the 10:00 tick. Alex answers at 10:01 (the reply is the session's newest
    // line, so lastActive moves), it works until 10:04 and exits before the 10:05 tick. That tick
    // still sees "was waiting, now dormant", but the waiting sample was not its last state.
    let t = NOW;
    let agents: WorldAgent[] = [fullAgent({ id: "s1", status: "live", awaitingInput: true })];
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(() => agents);
    await tick(fA, ctxA); // baseline: s1 waiting
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1", status: "dormant", awaitingInput: false, lastActive: new Date(NOW + 4 * 60_000).toISOString() })];
    await tick(fA, ctxA);
    const endedAt = t;
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: { kind: string }[] };
    expect(saved.waitEvents).toEqual([{ at: expect.any(String), kind: "ended", title: "task s1", islandId: "x", sessionId: "s1" }]);

    t += 5 * 60_000;
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx: ctxB } = fakeCtx(() => agents);
    await tick(fB, ctxB);
    const prompt = runnerB.prompts[0]!;
    expect(prompt).toContain(`${hhmm(endedAt)} ended · task s1 · x`);
    expect(prompt).not.toMatch(/while waiting on Alex|stopped waiting/);
  });

  it("a session a running process kept live while idle is reported ended when the process exits, not hidden behind its old lastActive", async () => {
    // lastActive (and the jsonl mtime) are hours old; process vouching alone kept it "live". When
    // the process exits it goes dormant with lastActive unchanged, so the lastActive rule can't
    // see the end: before the fix the block claimed "No sessions started or ended since HH:MM".
    let t = NOW;
    const oldIso = new Date(NOW - 3 * 60 * 60_000).toISOString();
    let agents: WorldAgent[] = [fullAgent({ id: "s1", status: "live", startedAt: oldIso, lastActive: oldIso })];
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(() => agents);
    await tick(fA, ctxA); // baseline: s1 live (process-vouched), idle for 3h
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1", status: "dormant", startedAt: oldIso, lastActive: oldIso })]; // the process exited
    await tick(fA, ctxA);
    const endedAt = t;

    t += 5 * 60_000;
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const { ctx: ctxB } = fakeCtx(() => agents);
    await tick(fB, ctxB); // a restart, then a forced reflection: the end must come from state.json
    const prompt = runnerB.prompts[0]!;
    // Only the process exiting or a vouch moving could have ended it, and the tick can't tell
    // which: the end is somewhere between its last write and the tick that saw it dormant.
    expect(prompt).toContain(`ended between ${hhmm(Date.parse(oldIso))} and ${hhmm(endedAt)} · task s1 · x`);
    expect(prompt).not.toMatch(/No sessions started or ended/);
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    expect(saved.waitEvents).toEqual([]); // consumed by the reflection that landed
  });

  it("a session that goes dormant for one tick and is live again when the reflection runs reads 'went dormant (live again now)', never 'ended' or 'nothing happened'", async () => {
    // PR #28 review probe, real /api/world shape of session 96cbb6d9: held live by one of two VS
    // Code claude processes in the home folder, idle for ~3h, 1405 messages. A third home-folder
    // session writing moves processVouchedSessions' vouch off it for one tick; Alex typing in it
    // brings it back. Ticks 5 minutes apart; the default hourly cadence reflects on the last one.
    let t = NOW;
    const oldIso = new Date(NOW - 2 * 60 * 60_000).toISOString();
    const s = (status: "live" | "dormant"): WorldAgent[] => [fullAgent({ id: "96cbb6d9", title: "injest what we discussed", status, startedAt: oldIso, lastActive: oldIso, messageCount: 1405 })];
    let agents = s("live");
    const runner = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const f = make({ runner, defaultEnabled: true, now: () => t });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx); // T0: live; the first-ever tick reflects
    expect(runner.calls).toBe(1);
    t += 50 * 60_000;
    await tick(f, ctx); // T0+50: still live
    t += 5 * 60_000;
    agents = s("dormant");
    await tick(f, ctx); // T0+55: the vouch moved to a newer home-folder session, or its process exited (no reflection due yet)
    const dormantAt = t;
    expect(runner.calls).toBe(1);
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: { kind: string }[] };
    expect(saved.waitEvents.map((w) => w.kind)).toEqual(["ended"]); // the tick did see a live → dormant transition
    t += 5 * 60_000;
    agents = s("live");
    await tick(f, ctx); // T0+60: live again, and the hourly reflection runs
    expect(runner.calls).toBe(2);
    const prompt = runner.prompts[1]!;
    expect(prompt).not.toMatch(/ ended · injest what we discussed/);
    // Before: dropped, so the block claimed "No sessions started or ended", false when the process
    // really exited and Alex resumed the same session id.
    expect(prompt).toContain(`${hhmm(dormantAt)} went dormant (live again now) · injest what we discussed · x`);
    expect(prompt).not.toMatch(/No sessions started or ended/);
    expect(prompt).toContain("injest what we discussed · x · last active 180m ago · 1405 messages · 0 subagents running");
  });

  it("the review's home-folder hour, from the real liveness rules: a waiting session's vouch flap and a late-seen ritual end both read true (PR #28 review, findings 1 and 4)", async () => {
    // Two VS Code claude processes in the home folder. A has waited on Alex since 15:20;
    // 943ddee1 writes all the time; a headless ritual runs 17:02-17:04 on a third process. Alex
    // answers A at 17:28 (its reply lands 17:29). Statuses come from the real
    // processVouchedSessions + isLive + isAwaitingInput, the way computeAgents (server/index.ts)
    // derives them. Ticks every 5 minutes; the resident reflects at 17:00 and 18:00.
    const at = (hm: string): number => Date.parse(`2026-09-26T${hm}:00`);
    const world = (now: number): WorldAgent[] => {
      const sessions = [
        { id: "A", title: "should I merge the fleet PR?", startedAt: at("14:00"), mtime: now >= at("17:29") ? at("17:29") : at("15:20"), question: now < at("17:28"), messageCount: 818 },
        { id: "943ddee1", title: "resident review", startedAt: at("12:00"), mtime: now, question: false, messageCount: 3000 },
        ...(now >= at("17:02") ? [{ id: "ritual", title: "artifact ritual", startedAt: at("17:02"), mtime: Math.min(now, at("17:04")), question: false, messageCount: 12 }] : []),
      ];
      const processes = now >= at("17:02") && now < at("17:04") ? 3 : 2;
      const vouched = processVouchedSessions(sessions.map((x) => ({ id: x.id, cwd: "/home", jsonlMtime: x.mtime })), new Map([["/home", processes]]));
      return sessions.map((x) => {
        const status = isLive(now, x.mtime, vouched.has(x.id)) ? "live" : "dormant";
        const awaitingInput = isAwaitingInput(status, { kind: "assistant_text", toolName: null, textIsQuestion: x.question });
        return fullAgent({ id: x.id, islandId: "home", cwd: "/home", title: x.title, status, startedAt: new Date(x.startedAt).toISOString(), lastActive: new Date(x.mtime).toISOString(), messageCount: x.messageCount, awaitingInput });
      });
    };
    let t = at("17:00");
    const runner = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const f = make({ runner, defaultEnabled: true, now: () => t });
    const { ctx } = fakeCtx(() => world(t));
    expect(world(t).find((a) => a.id === "A")?.awaitingInput).toBe(true); // the premise: A is waiting at 17:00
    for (; t <= at("18:00"); t += 5 * 60_000) await tick(f, ctx);
    expect(runner.calls).toBe(2); // 17:00 and 18:00
    const prompt = runner.prompts[1]!;
    const block = [
      "17:02 started · artifact ritual · home",
      // Before: "17:05 stopped waiting (session ended)", though A never ended and Alex answered it.
      "17:05 went dormant while waiting on Alex (live again now) · should I merge the fleet PR? · home",
      // Before: "17:30 ended", 26 minutes after its process exited (the vouch held it until A wrote).
      "ended between 17:04 and 17:30 · artifact ritual · home",
      "resident review · home · last active 0m ago · 3000 messages · 0 subagents running",
      "should I merge the fleet PR? · home · last active 31m ago · 818 messages · 0 subagents running",
    ];
    expect(prompt).toContain(block.join("\n"));
    expect(prompt).not.toMatch(/session ended|17:30 ended|No sessions started or ended/);
  });

  it("a process-held session whose process exits during a restart is reported ended, as a range across the restart", async () => {
    // Idle for hours, live only because its process ran. It is live at the last tick before a
    // tsx-watch restart and its process exits during the restart: the new instance has no
    // in-memory sample, and lastActive is far outside the window.
    let t = NOW;
    const oldIso = new Date(NOW - 3 * 60 * 60_000).toISOString();
    const agentsA = [fullAgent({ id: "s1", status: "live", startedAt: oldIso, lastActive: oldIso })];
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(() => agentsA);
    await tick(fA, ctxA); // T0: s1 live; the live set changed (from nothing), so state.json keeps it
    const seenLiveAt = t;
    t += 5 * 60_000;
    await tick(fA, ctxA); // T0+5: nothing changed, nothing saved

    t += 10 * 60_000; // restart; the process exits meanwhile
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    const agentsB = [fullAgent({ id: "s1", status: "dormant", startedAt: oldIso, lastActive: oldIso })];
    await tick(fB, fakeCtx(() => agentsB).ctx); // first tick after boot, forced reflection
    const prompt = runnerB.prompts[0]!;
    // Idle for hours: the tick that saw it live at T0 may have been a vouch for a process that had
    // already exited, so the range starts at its last write, not at T0.
    expect(seenLiveAt).toBeGreaterThan(Date.parse(oldIso));
    expect(prompt).toContain(`ended between ${hhmm(Date.parse(oldIso))} and ${hhmm(t)} · task s1 · x`);
    expect(prompt).not.toMatch(/No sessions started or ended/);
  });

  it("saves the live set when it changes, and not on a tick where it didn't", async () => {
    let t = NOW;
    let agents: WorldAgent[] = [fullAgent({ id: "s1" })];
    const f = make({ defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx } = fakeCtx(() => agents);
    await tick(f, ctx);
    const reasons = async (): Promise<string[]> => (await readFile(join(home, "writes.jsonl"), "utf8")).trim().split("\n").map((l) => (JSON.parse(l) as { reason: string }).reason);
    const before = (await reasons()).length;
    t += 5 * 60_000;
    await tick(f, ctx); // same live set: no state.json write
    expect((await reasons()).length).toBe(before);
    t += 5 * 60_000;
    agents = [fullAgent({ id: "s1" }), fullAgent({ id: "s2", startedAt: new Date(t).toISOString() })];
    await tick(f, ctx); // s2 started: the live set changed
    expect((await reasons()).slice(before)).toEqual(["live sessions changed"]);
    const saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { lastLive: { at: string; sessions: { id: string }[] } };
    expect(saved.lastLive.at).toBe(new Date(t).toISOString());
    expect(saved.lastLive.sessions.map((x) => x.id)).toEqual(["s1", "s2"]);
  });

  it("counts events the capped log dropped, shows them as '+N earlier', and resets the count once a reflection lands", async () => {
    let t = NOW;
    let waiting = false;
    const ids = Array.from({ length: MAX_WAIT_EVENTS + 2 }, (_, i) => `s${i}`);
    const agentsNow = (): WorldAgent[] => ids.map((id) => fullAgent({ id, awaitingInput: waiting }));
    const runnerA = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fA = make({ runner: runnerA, defaultEnabled: true, now: () => t, reflectEveryMs: 999 * 60 * 60_000 });
    const { ctx: ctxA } = fakeCtx(agentsNow);
    await tick(fA, ctxA); // baseline
    t += 5 * 60_000;
    waiting = true;
    await tick(fA, ctxA); // MAX_WAIT_EVENTS + 2 sessions begin waiting at once: 2 fall off the cap
    let saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[]; waitEventsDropped: number };
    expect(saved.waitEvents).toHaveLength(MAX_WAIT_EVENTS);
    expect(saved.waitEventsDropped).toBe(2);

    t += 5 * 60_000;
    const runnerB = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const fB = make({ runner: runnerB, defaultEnabled: true, now: () => t, reflectEveryMs: 0 });
    await tick(fB, fakeCtx(agentsNow).ctx);
    expect(runnerB.prompts[0]!).toMatch(/^\+3 earlier$/m); // 2 dropped + 1 hidden by the 30-line display cap
    saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[]; waitEventsDropped: number };
    expect(saved.waitEvents).toEqual([]);
    expect(saved.waitEventsDropped).toBe(0);
  });

  it("an invalid reflection leaves waitEvents intact; a valid one clears them", async () => {
    let agents: WorldAgent[] = [fullAgent({ id: "s1", awaitingInput: false })];
    const { ctx } = fakeCtx(() => agents);
    const badRunner = stubRunner("not json");
    const f = make({ runner: badRunner, defaultEnabled: true, now: () => NOW, reflectEveryMs: 0 });
    await tick(f, ctx); // baseline sample (also a failed reflection attempt: reflectEveryMs is 0)
    agents = [fullAgent({ id: "s1", awaitingInput: true })];
    await tick(f, ctx); // began waiting, persisted; then another failed attempt
    let saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    expect(saved.waitEvents).toHaveLength(1); // untouched by the failed attempts

    const goodRunner = stubRunner(envelope(JSON.stringify(reflection), 0.001));
    const f2 = make({ runner: goodRunner, defaultEnabled: true, now: () => NOW, reflectEveryMs: 0 });
    await tick(f2, ctx); // a fresh instance, same home, whose reflection now succeeds
    saved = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as { waitEvents: unknown[] };
    expect(saved.waitEvents).toEqual([]);
  });
});
