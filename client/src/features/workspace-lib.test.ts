import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../../../shared/features/approvals";
import type { CompletenessCheck } from "../../../shared/features/completeness";
import type { FeedItem as ServerFeedItem } from "../../../shared/features/feed";
import type { PresidentBoard } from "../../../shared/features/president";
import type { ResidentState } from "../../../shared/features/resident";
import type { Routine } from "../../../shared/features/routines";
import type { RunEnding, SubagentRecord } from "../../../shared/features/subagents";
import type { StrandedDispatch } from "../../../shared/features/talk";
import type { VillageMessage } from "../../../shared/features/village";
import type { WorldAgent } from "../../../shared/types";
import { FEED_CAP, FeedStore, approvalToFeed, awaitingToFeed, routineRunsToFeed, type FeedItem } from "../shell/feed";
import { htmlWriter, workspaceTopHtml } from "../shell/feed-ui";
import { bridgeItems } from "./feed-bridge";
import { residentData } from "./resident-data";
import { workspaceData, workspaceSources } from "./workspace-data";
import {
  URGENCY_WEIGHT,
  WORKSPACE,
  agentLookup,
  feedCandidate,
  gatherCandidates,
  groupCandidates,
  healthCandidates,
  messageCandidates,
  normalizeText,
  occurrenceTimes,
  presidentCandidates,
  residentCandidates,
  routineCandidates,
  runCandidates,
  salience,
  selectWorkspace,
  strandedCandidates,
  subagentCandidates,
  type HealthSummary,
  type WorkspaceCandidate,
  type WorkspaceIsland,
  type WorkspaceSlot,
  type WorkspaceSources,
  type WorkspaceUrgency,
} from "./workspace-lib";

const MIN = 60_000;
const T0 = Date.parse("2026-09-27T16:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const agent = (id: string, islandId: string, title: string): WorldAgent => ({
  id,
  islandId,
  cwd: `/Users/s/Documents/Code/${islandId}`,
  title,
  status: "live",
  startedAt: iso(T0 - 60 * MIN),
  lastActive: iso(T0),
  messageCount: 12,
  model: "claude-opus-5-5",
  role: "builder",
  color: "#ffb3cd",
  targetIslandId: islandId,
  tokens: 12_000,
  awaitingInput: false,
});

const AGENTS = new Map(
  [
    agent("943ddee1-a73d-470c-835a-55084c09c69f", "agent-world", "Build the global workspace"),
    agent("96cbb6d9-0000-4000-8000-000000000001", "acme-ai-next", "Competitor sweep"),
    agent("aaaa1111-0000-4000-8000-000000000002", "alex_claude", "Vault tidy"),
    agent("bbbb2222-0000-4000-8000-000000000003", "yalla-brief", "Morning brief"),
  ].map((a) => [a.id, a] as const),
);
const [ORCH, SWEEP, VAULT, BRIEF] = [...AGENTS.keys()] as [string, string, string, string];
const lookup = agentLookup(() => AGENTS);

let seq = 0;
/** A candidate as the adapters make them (for the scorer tests). */
const cand = (urgency: WorkspaceUrgency, at: number, text: string, over: Partial<WorkspaceCandidate> = {}): WorkspaceCandidate => ({
  id: `c${++seq}`,
  urgency,
  origin: "test",
  at,
  text,
  agentIds: [ORCH],
  districts: ["agent-world"],
  ...over,
});

const subagent = (over: Partial<SubagentRecord>): SubagentRecord => ({
  id: "ab1c09dac5b39fd75",
  parentSessionId: ORCH,
  parentAgentId: null,
  workflowId: null,
  description: "Review PR 22",
  agentType: "general-purpose",
  model: "claude-opus-5-5",
  status: "done",
  reason: null,
  startedAt: iso(T0 - 20 * MIN),
  lastActive: iso(T0 - 5 * MIN),
  tokens: 90_000,
  toolCounts: { Bash: 12, Read: 4 },
  files: [],
  depth: 1,
  ...over,
});

const EMPTY: WorkspaceSources = { feed: [], messages: [], subagents: [], runEndings: [], resident: null, serverFeed: [], stranded: [], islands: [], health: null, presidentBoard: null };

/** Real island shapes (id + cwd path) the AGENTS fixture's own sessions live under, plus two more
 *  (real repos from the 09-28 vision-post measurement) for the stranded-launch tests, which have
 *  no session/agentId of their own yet. */
const ISLANDS: WorkspaceIsland[] = [
  ...new Set([...AGENTS.values()].map((a) => a.islandId)),
  "acme-www",
  "legal-taxonomy",
].map((id) => ({ id, path: `/Users/s/Documents/Code/${id}` }));

const stranded = (over: Partial<StrandedDispatch> = {}): StrandedDispatch => ({
  tmuxName: "aw-68597ce4",
  cwd: "/Users/s/Documents/Code/acme-www",
  startedAt: iso(T0 - 30 * MIN),
  blockedOn: "empty-prompt",
  closable: false,
  promptHead: "Open PR aligning acme.ai FAQ 'end-to-end encryption' + homepage 'no one can access your data but you' with the DPA (Nat…",
  lastLine: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
  ...over,
});

const liveVisibleFail: CompletenessCheck = {
  id: "live-visible",
  label: "Live sessions are visible",
  group: "see",
  weight: 3,
  state: "fail",
  detail: "2 live claude processes, 0 visible",
  confidence: "measured",
};

describe("salience factors", () => {
  it("ranks urgency: waiting on Alex > failure > tripwire > message > info", () => {
    const order: WorkspaceUrgency[] = ["waiting", "failure", "tripwire", "message", "info"];
    const scores = order.map((u) => salience({ key: u, members: [cand(u, T0, `same ${u}`)] }, T0).score);
    expect(scores).toEqual(order.map((u) => URGENCY_WEIGHT[u]));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1] ?? 0);
  });

  it("decays with a 30 min half-life, from the newest member", () => {
    const g = { key: "k", members: [cand("failure", T0, "routine failed")] };
    expect(salience(g, T0).recency).toBe(1);
    expect(salience(g, T0 + 30 * MIN).score).toBeCloseTo(URGENCY_WEIGHT.failure / 2, 6);
    expect(salience(g, T0 + 60 * MIN).score).toBeCloseTo(URGENCY_WEIGHT.failure / 4, 6);
    // Two groups keep their ratio as they decay: decay alone never reorders the slot.
    const h = { key: "h", members: [cand("message", T0 - 10 * MIN, "hello")] };
    const ratio = (t: number): number => salience(g, t).score / salience(h, t).score;
    expect(ratio(T0 + 5 * MIN)).toBeCloseTo(ratio(T0 + 50 * MIN), 9);
  });

  it("novelty: repeats in one district decay the score; an echo < 2 min apart is not a repeat", () => {
    const once = salience({ key: "a", members: [cand("message", T0, "deploy done")] }, T0);
    expect(once.novelty).toBe(1);
    const echo = salience({ key: "b", members: [cand("message", T0, "deploy done"), cand("message", T0 - 30_000, "deploy done")] }, T0);
    expect(echo.occurrences).toBe(1);
    expect(echo.novelty).toBe(1);
    const repeated = salience({ key: "c", members: [cand("message", T0, "deploy done"), cand("message", T0 - 10 * MIN, "deploy done"), cand("message", T0 - 20 * MIN, "deploy done")] }, T0);
    const repeats = 1 + 0.5 ** (10 / 30) + 0.5 ** (20 / 30);
    expect(repeated.occurrences).toBe(3);
    expect(repeated.repeats).toBeCloseTo(repeats, 9);
    expect(repeated.novelty).toBeCloseTo(0.75 ** (repeats - 1), 9);
    expect(repeated.score).toBeLessThan(once.score);
    // …and bottoms out at the floor.
    const flood = salience({ key: "d", members: Array.from({ length: 20 }, (_, i) => cand("info", T0 - i * 3 * MIN, "agent wanders to aleph")) }, T0);
    expect(flood.novelty).toBe(WORKSPACE.noveltyFloor);
  });

  it("breadth: the same thing in several districts scores higher (and is not counted as repeats)", () => {
    const one = salience({ key: "a", members: [cand("tripwire", T0, "lesson repeated")] }, T0);
    const three = salience(
      {
        key: "b",
        members: [
          cand("tripwire", T0, "lesson repeated", { districts: ["agent-world"] }),
          cand("tripwire", T0 - 5 * MIN, "lesson repeated", { districts: ["acme-ai-next"] }),
          cand("tripwire", T0 - 8 * MIN, "lesson repeated", { districts: ["yalla-brief"] }),
        ],
      },
      T0,
    );
    expect(three.breadth).toBe(1.5);
    expect(three.novelty).toBe(1);
    expect(three.score).toBeGreaterThan(one.score);
    const seven = salience({ key: "c", members: [cand("info", T0, "x", { districts: ["a", "b", "c", "d", "e", "f", "g"] })] }, T0);
    expect(seven.breadth).toBe(2); // capped at 5 districts
  });

  it("normalizes near-identical text (numbers, hashes, punctuation) into one group", () => {
    expect(normalizeText('skill "scout" grows (now 0.40)')).toBe(normalizeText('skill "scout" grows (now 0.80)'));
    expect(normalizeText("pushed 8b9b995..b08eb6a on fix/x")).toBe(normalizeText("pushed 0ae1759..fd33ca4 on fix/x"));
    expect(normalizeText("failed: discover:ux")).not.toBe(normalizeText("failed: discover:truth"));
    const groups = groupCandidates([cand("info", T0, 'skill "scout" grows (now 0.40)'), cand("info", T0 + MIN, 'skill "scout" grows (now 0.50)'), cand("info", T0, "other")]);
    expect(groups.map((g) => g.members.length).sort()).toEqual([1, 2]);
  });

  it("clusters echoes from each cluster's first member, not by chaining", () => {
    // 0, 30 s and 90 s are one cluster (all < 2 min after 0); 150 s starts a new one even though
    // it is only 60 s after 90 s — chaining would have merged 0 … 150 s into one.
    expect(occurrenceTimes([150_000, 0, 400_000, 30_000, 90_000])).toEqual([90_000, 150_000, 400_000]);
  });
});

describe("the slot: threshold, hysteresis, cap", () => {
  it("only groups at or above the enter threshold get in", () => {
    const fresh = cand("message", T0 - 10 * MIN, "fresh message"); // 30 × 0.79 = 23.8
    const stale = cand("message", T0 - 20 * MIN, "stale message"); // 30 × 0.63 = 18.9
    const info = cand("info", T0, "an info line"); // 12
    const r = selectWorkspace([fresh, stale, info], {}, T0);
    expect(r.top.map((e) => e.text)).toEqual(["fresh message"]);
    expect(r.counts).toMatchObject({ candidates: 3, groups: 3, shown: 1, belowThreshold: 2, crowdedOut: 0 });
    expect(r.top[0]?.reason).toBe("message · test · 10m ago → 23 (≥ 20)");
  });

  it("hysteresis: once in, a group stays until it falls under the exit threshold — no bounce at the edge", () => {
    const c = cand("message", T0, "a message");
    let slot: WorkspaceSlot = {};
    const inAt: boolean[] = [];
    // 30 × 0.5^(t/30): ≥ 20 until ~17.5 min, ≥ 14 until ~33 min. Tick every 15 s for 45 min.
    for (let t = T0; t <= T0 + 45 * MIN; t += 15_000) {
      const r = selectWorkspace([c], slot, t);
      slot = r.slot;
      inAt.push(r.top.length === 1);
      if (t === T0 + 25 * MIN) {
        expect(r.top[0]?.held).toBe(true);
        expect(r.top[0]?.reason).toContain("holding, ≥ 14");
        // A newcomer at the very same score would NOT get in.
        expect(selectWorkspace([c], {}, t).top).toEqual([]);
      }
    }
    const flips = inAt.filter((v, i) => i > 0 && v !== inAt[i - 1]).length;
    expect(flips).toBe(1); // entered at t0, left once, never came back
    const leftTick = inAt.indexOf(false);
    const leftMin = (leftTick * 15_000) / MIN;
    expect(leftMin).toBeGreaterThan(32);
    expect(leftMin).toBeLessThan(34);
    // `since` survives across runs.
    const first = selectWorkspace([c], {}, T0);
    expect(selectWorkspace([c], first.slot, T0 + 5 * MIN).top[0]?.since).toBe(T0);
  });

  it("shows at most 5, most salient first; the rest are crowded out", () => {
    const cands = Array.from({ length: 8 }, (_, i) => cand("failure", T0 - i * MIN, `routine ${String.fromCharCode(97 + i)} failed`));
    const r = selectWorkspace(cands, {}, T0);
    expect(r.top).toHaveLength(WORKSPACE.slots);
    expect(r.top.map((e) => e.text)).toEqual(["routine a failed", "routine b failed", "routine c failed", "routine d failed", "routine e failed"]);
    expect(r.counts).toMatchObject({ groups: 8, shown: 5, belowThreshold: 0, crowdedOut: 3 });
    for (let i = 1; i < r.top.length; i++) expect(r.top[i]?.score).toBeLessThanOrEqual(r.top[i - 1]?.score ?? 0);
  });

  it("an incumbent keeps its slot unless a newcomer beats it by more than 15%", () => {
    const five = Array.from({ length: 5 }, (_, i) => cand("failure", T0 - 30 * MIN, `incumbent ${String.fromCharCode(97 + i)}`)); // 30 each
    const slot = selectWorkspace(five, {}, T0 - 30 * MIN).slot;
    const close = cand("failure", T0 - 26 * MIN, "challenger close"); // 60 × 0.5^(26/30) = 32.9 < 30 × 1.15
    const clear = cand("failure", T0 - 20 * MIN, "challenger clear"); // 37.8 > 34.5
    expect(selectWorkspace([...five, close], slot, T0).top.map((e) => e.text)).not.toContain("challenger close");
    const r = selectWorkspace([...five, clear], slot, T0);
    expect(r.top.map((e) => e.text)).toContain("challenger clear");
    expect(r.top).toHaveLength(5);
  });

  it("counts how many groups could clear the bar at all (info needs 4+ districts)", () => {
    const four = ["agent-world", "acme-ai-next", "alex_claude", "yalla-brief"];
    const r = selectWorkspace(
      [
        cand("info", T0, "roam decision one district"),
        cand("info", T0, "roam decision three districts", { districts: four.slice(0, 3) }),
        cand("info", T0, "one lesson in four districts", { districts: four }),
        cand("failure", T0 - 3 * 60 * MIN, "an old failure: a contender, just decayed"),
      ],
      {},
      T0,
    );
    expect(r.counts).toMatchObject({ groups: 4, contenders: 2, shown: 1 });
    expect(r.top[0]?.text).toBe("one lesson in four districts"); // 12 × 1.75 = 21
  });

  it("is deterministic and independent of input order", () => {
    const cands = [cand("failure", T0 - 3 * MIN, "b failed"), cand("waiting", T0 - 60 * MIN, "x is waiting"), cand("message", T0 - MIN, "hi"), cand("message", T0 - MIN, "hi", { id: "dup" })];
    const a = selectWorkspace(cands, {}, T0);
    const b = selectWorkspace([...cands].reverse(), {}, T0);
    expect(b).toEqual(a);
  });
});

describe("adapters (real source shapes)", () => {
  it("Feed items: waits/approvals are 'waiting' until answered; routine failures; PRs; Jev is info", () => {
    const wait: FeedItem = { id: `wait:${SWEEP}:x`, kind: "awaiting", at: T0, title: "Competitor sweep is waiting for your reply", detail: "acme-ai-next", agentId: SWEEP, cityId: "acme-ai-next", pinned: true };
    expect(feedCandidate(wait, lookup)).toMatchObject({ urgency: "waiting", districts: ["acme-ai-next"], topic: `wait:${SWEEP}` });
    expect(feedCandidate({ ...wait, outcome: "answered" }, lookup)).toBeNull();
    expect(feedCandidate({ id: "rt:x:end:1", kind: "routine", at: T0, title: "eulex-bench failed (exit 1)" }, lookup)?.urgency).toBe("failure");
    expect(feedCandidate({ id: "rt:y:end:1", kind: "routine", at: T0, title: "vault-sync finished OK" }, lookup)?.urgency).toBe("info");
    expect(feedCandidate({ id: "mac:1", kind: "system", at: T0, title: "🖥️ Mac: quit Slack (failed)" }, lookup)?.urgency).toBe("failure");
    expect(feedCandidate({ id: "report:today:1", kind: "report", at: T0, title: "Today so far: 3 PRs merged, one build failed" }, lookup)?.urgency).toBe("info");
    expect(feedCandidate({ id: "act:1", kind: "activity", at: T0, title: "Bash: gh pr create --base main --title feat", agentId: ORCH }, lookup)).toMatchObject({ urgency: "message", origin: "PR" });
    expect(feedCandidate({ id: "act:2", kind: "activity", at: T0, title: "Bash: gh pr view 24", agentId: ORCH }, lookup)?.urgency).toBe("info");
    expect(feedCandidate({ id: "dec:1", kind: "decision", at: T0, title: "root agent visits agent-world (and back)" }, lookup)?.urgency).toBe("info");
    expect(feedCandidate({ id: "grad:1:shipped", kind: "graduation", at: T0, title: "🎓 Orchestrator shipped agent-world#61", agentId: ORCH }, lookup)).toMatchObject({ urgency: "info", origin: "graduation", topic: "graduation" });
  });

  it("graduation: one merge stays under the entry bar; a wave across 4+ districts clears it", () => {
    const grad = (agentId: string): FeedItem => ({ id: `grad:${agentId}:shipped`, kind: "graduation", at: T0, title: "🎓 x shipped a/b#1", agentId });
    const one = selectWorkspace([feedCandidate(grad(ORCH), lookup)!], {}, T0);
    expect(one.top).toEqual([]); // 12 × 1 = 12 < 20
    const wave = selectWorkspace([ORCH, SWEEP, VAULT, BRIEF].map((id) => feedCandidate(grad(id), lookup)!), {}, T0);
    expect(wave.top).toHaveLength(1);
    expect(wave.top[0]).toMatchObject({ urgency: "info" }); // 12 × 1.75 = 21 ≥ 20
    expect(wave.top[0]?.districts).toHaveLength(4);
  });

  it("a subagent's hand-back message and its record are one event, not a repeat", () => {
    const rec = subagent({ lastActive: iso(T0 - 5 * MIN + 20_000) });
    const handback: VillageMessage = {
      id: "received:12h892v",
      at: iso(T0 - 5 * MIN),
      direction: "received",
      fromSessionId: null,
      fromRaw: rec.id,
      toSessionId: ORCH,
      toRaw: ORCH,
      preview: "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the…",
    };
    const subs = new Map([[rec.id, rec]]);
    const cands = [...messageCandidates([handback], subs, lookup), ...subagentCandidates([rec], lookup)];
    expect(cands.map((c) => c.text)).toEqual(["handed back: Review PR 22", "handed back: Review PR 22"]);
    const groups = groupCandidates(cands);
    expect(groups).toHaveLength(1);
    expect(salience(groups[0]!, T0).occurrences).toBe(1);
  });

  it("a message between two districts: both ends' districts count, names not raw ids", () => {
    const sent: VillageMessage = { id: "sent:1", at: iso(T0 - 2 * MIN), direction: "sent", fromSessionId: ORCH, fromRaw: ORCH, toSessionId: SWEEP, toRaw: "sweep", preview: "Can you re-run the MENA sweep?" };
    const received: VillageMessage = { ...sent, id: "received:1", at: iso(T0 - 2 * MIN + 5_000), direction: "received", fromRaw: "builder", toRaw: SWEEP };
    const cands = messageCandidates([sent, received], new Map(), lookup);
    expect(cands[0]?.text).toBe("Build the global workspace → Competitor sweep: Can you re-run the MENA sweep?");
    expect(cands[0]?.districts).toEqual(["agent-world", "acme-ai-next"]);
    const g = groupCandidates(cands);
    expect(g).toHaveLength(1);
    const s = salience(g[0]!, T0);
    expect(s.occurrences).toBe(1); // sender's and receiver's copies: one event
    expect(s.breadth).toBe(1.25);
  });

  it("server routine runs: a non-zero exit is a failure, worded like the Feed tab's own line", () => {
    const run = (id: string, detail: string | null): ServerFeedItem => ({ id, seq: 1, at: iso(T0 - MIN), kind: "routine", agentId: null, title: "eulex-bench ran", detail, tag: "finished" });
    const out = routineCandidates([run("routine:eulex-bench:done:a", "exit 1"), run("routine:vault-sync:done:b", "exit 0"), run("routine:x:done:c", null)]);
    expect(out.map((c) => [c.urgency, c.text])).toEqual([
      ["failure", "eulex-bench failed (exit 1)"],
      ["info", "eulex-bench ran · exit 0"],
      ["info", "eulex-bench ran"],
    ]);
    // The Feed tab's copy of the same failure lands in the same group.
    const client = feedCandidate({ id: "rt:com.stephane.eulex-bench:end:1", kind: "routine", at: T0 - MIN + 30_000, title: "eulex-bench failed (exit 1)" }, lookup);
    expect(groupCandidates([out[0]!, client!])).toHaveLength(1);
  });

  it("one routine failure is one group even when its two copies are worded differently (dev.dashable.*)", () => {
    const routine = (running: boolean, lastExitStatus: number | null): Routine => ({
      label: "dev.dashable.yalla-brief",
      shortName: "dev.dashable.yalla-brief", // server/features/routines.ts strips only "com.stephane."
      program: "/bin/zsh",
      schedule: { kind: "calendar", text: "daily 08:00", nextRunAt: null },
      running,
      lastExitStatus,
      ranRecently: true,
      skillDescription: null,
    });
    const [clientLine] = routineRunsToFeed([routine(true, null)], [routine(false, 1)], T0 - MIN + 20_000);
    expect(clientLine?.title).toBe("dev.dashable.yalla-brief failed (exit 1)");
    // The server feed's run of the same job (server/features/feed.ts: automation id strips both prefixes).
    const serverRun: ServerFeedItem = { id: `routine:yalla-brief:done:${iso(T0 - MIN)}`, seq: 7, at: iso(T0 - MIN), kind: "routine", agentId: null, title: "yalla-brief ran", detail: "exit 1", tag: "finished" };
    const cands = [feedCandidate(clientLine!, lookup)!, ...routineCandidates([serverRun])];
    expect(cands.map((c) => [c.urgency, c.text])).toEqual([
      ["failure", "dev.dashable.yalla-brief failed (exit 1)"],
      ["failure", "yalla-brief failed (exit 1)"],
    ]);
    const r = selectWorkspace(cands, {}, T0);
    expect(r.top).toHaveLength(1);
    expect(r.top[0]?.occurrences).toBe(1);
  });

  it("resident: open proposals are messages; journal lines only with a known time", () => {
    const now = new Date(2026, 8, 27, 19, 30).getTime(); // local time, like the journal's own HH:MM
    const state: ResidentState = {
      name: "Alef resident",
      enabled: true,
      bornAt: "2026-09-25T10:00:00.000Z",
      day: 3,
      lastTickAt: null,
      lastReflectAt: null,
      lastError: null,
      goals: [],
      skills: [],
      journalTail: ["An undated paragraph with no header above it.", "## 18:17 · reflection", "Fleet remains 2 live, 0 waiting.", "- 19:22 · Skipped my reflection: I hit today's budget."],
      recentWrites: [],
      proposals: [
        { id: "rp-1", at: iso(now - 10 * MIN), kind: "note", title: "Define 'waiting on Alex'", why: "…", status: "open" },
        { id: "rp-2", at: iso(now - 10 * MIN), kind: "note", title: "Old idea", why: "…", status: "dismissed" },
      ],
      spend: { todayUsd: 0.1, capUsd: 0.5 },
    };
    const out = residentCandidates(state, now);
    expect(out.map((c) => [c.urgency, c.text, new Date(c.at).getHours(), new Date(c.at).getMinutes()])).toEqual([
      ["message", "resident proposes: Define 'waiting on Alex'", new Date(now - 10 * MIN).getHours(), new Date(now - 10 * MIN).getMinutes()],
      ["info", "resident: Fleet remains 2 live, 0 waiting.", 18, 17],
      ["info", "resident: Skipped my reflection: I hit today's budget.", 19, 22],
    ]);
    expect(residentCandidates({ ...state, enabled: false }, now)).toEqual([]);
    // A time later than now is yesterday's.
    const late = residentCandidates({ ...state, proposals: [], journalTail: ["- 23:50 · late note"] }, now);
    expect(now - (late[0]?.at ?? now)).toBeGreaterThan(19 * 60 * MIN);
  });

  it("an unanswered wait does not decay: still in the slot at 60, 90 and 150 min, gone once answered", () => {
    const feed = new FeedStore();
    const sweep = AGENTS.get(SWEEP);
    if (!sweep) throw new Error("fixture");
    const wait = awaitingToFeed({ ...sweep, awaitingInput: true, lastActive: iso(T0) }, "acme-ai-next", T0);
    feed.push(wait);
    let slot: WorkspaceSlot = {};
    for (const mins of [60, 90, 150]) {
      const now = T0 + mins * MIN;
      const fresh = selectWorkspace(gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, now).candidates, {}, now); // a page opened now
      expect(fresh.top.map((e) => [e.urgency, e.score, e.agentIds[0]])).toEqual([["waiting", 100, SWEEP]]);
      const held = selectWorkspace(gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, now).candidates, slot, now); // a page open all along
      expect(held.top.map((e) => e.key)).toEqual([`wait:${SWEEP}`]);
      slot = held.slot;
    }
    expect(selectWorkspace(gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, T0 + 90 * MIN).candidates, {}, T0 + 90 * MIN).top[0]?.reason).toBe("waiting on you · waiting · 1h 30m ago → 100 (≥ 20)");
    feed.resolve(wait.id, "answered");
    expect(gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, T0 + 90 * MIN).candidates).toEqual([]);
  });

  it("two open approvals with the same words from two sessions are two slots; PR lines keep their number", () => {
    const view = (id: string, agentId: string): ApprovalView => ({
      id,
      agentId,
      cwd: "/Users/s/Documents/Code/agent-world",
      toolName: "Bash",
      preview: { kind: "command", title: "npm test", body: "npm test" },
      createdAt: iso(T0 - MIN),
      expiresAt: iso(T0 + 9 * MIN),
    });
    const who = (id: string): { title: string; city: string } | undefined => {
      const a = AGENTS.get(id);
      return a ? { title: a.title, city: a.islandId } : undefined;
    };
    const approvals = [approvalToFeed(view("ap-1", ORCH), who, T0), approvalToFeed(view("ap-2", SWEEP), who, T0)];
    const r = selectWorkspace(gatherCandidates({ ...EMPTY, feed: approvals }, lookup, T0).candidates, {}, T0);
    expect(r.top.map((e) => [e.text, e.score, e.occurrences, e.agentIds])).toEqual([
      ["Bash: npm test", 100, 1, [ORCH]],
      ["Bash: npm test", 100, 1, [SWEEP]],
    ]);

    const pr = (id: string, n: number, at: number): FeedItem => ({ id, kind: "activity", at, title: `Bash: gh pr merge ${n} --squash --delete-branch`, agentId: ORCH });
    const prs = [pr("act:pr24", 24, T0 - 3 * MIN), pr("act:pr26", 26, T0 - 2 * MIN)].map((i) => feedCandidate(i, lookup));
    const groups = groupCandidates(prs.filter((c): c is WorkspaceCandidate => c !== null));
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => salience(g, T0).occurrences)).toEqual([1, 1]);
  });

  it("gathers every source and windows out what can no longer reach the bar (2 h)", () => {
    const g = gatherCandidates(
      { ...EMPTY, subagents: [subagent({ id: "old", lastActive: iso(T0 - 3 * 60 * MIN) }), subagent({ id: "new", status: "failed", description: "discover:ux" })] },
      lookup,
      T0,
    );
    expect(g.observed).toBe(2);
    expect(g.candidates.map((c) => c.text)).toEqual(["failed: discover:ux"]);
    // Nothing older than the window could have reached the exit threshold anyway.
    expect(URGENCY_WEIGHT.waiting * 2 * 0.5 ** (WORKSPACE.windowMs / WORKSPACE.halfLifeMs)).toBeLessThan(WORKSPACE.exit);
  });
});

describe("the generic publish hook: a tripwire through the existing Feed", () => {
  it("a client feature's ctx.feed.push({ kind: 'tripwire' }) becomes a scored candidate", () => {
    const feed = new FeedStore();
    const tripwire: FeedItem = { id: "tw:lesson:1", kind: "tripwire", at: T0 - 2 * MIN, title: "Repeating a known lesson: pipe masks exit code", agentId: VAULT };
    expect(feed.push(tripwire)).toBe(true);
    expect(feed.counts().tripwire).toBe(1);
    const { candidates } = gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, T0);
    const r = selectWorkspace(candidates, {}, T0);
    expect(r.top).toHaveLength(1);
    expect(r.top[0]).toMatchObject({ urgency: "tripwire", origin: "tripwire", agentIds: [VAULT], districts: ["alex_claude"] });
    expect(r.top[0]?.reason).toMatch(/^tripwire · tripwire · 2m ago → 42 \(≥ 20\)$/);
  });

  it("a tripwire outlives the Feed's cap: 400 newer activity lines don't evict it from the workspace", () => {
    const feed = new FeedStore();
    feed.push({ id: "tw:lesson:1", kind: "tripwire", at: T0 - 30 * MIN, title: "Repeating a known lesson: pipe masks exit code", agentId: VAULT });
    for (let i = 0; i < 400; i++) feed.push({ id: `act:${i}`, kind: "activity", at: T0 - 29 * MIN + i * 4_000, title: `Read file ${i}.ts`, agentId: ORCH });
    expect(feed.size()).toBe(FEED_CAP);
    expect(feed.counts().tripwire).toBe(1);
    const r = selectWorkspace(gatherCandidates({ ...EMPTY, feed: feed.list() }, lookup, T0).candidates, {}, T0);
    expect(r.top.map((e) => e.urgency)).toEqual(["tripwire"]);
  });

  it("a server feature's appendToFeed tripwire (the /api/feed shape) is bridged into the Feed", () => {
    const fromServer: ServerFeedItem[] = [
      { id: "tripwire:lesson:a", seq: 41, at: iso(T0 - MIN), kind: "tripwire", agentId: BRIEF, title: "Same lesson in 2 sessions: verify the artifact, not the exit code", detail: "journal 2026-09-27", tag: "lesson" },
      { id: "tripwire:lesson:b", seq: 42, at: iso(T0 - MIN), kind: "tripwire", agentId: SWEEP, title: "Same lesson in 2 sessions: verify the artifact, not the exit code", detail: null, tag: "lesson" },
      { id: "routine:vault-sync:done:x", seq: 43, at: iso(T0 - MIN), kind: "routine", agentId: null, title: "vault-sync ran", detail: "exit 0", tag: "finished" },
    ];
    const bridged = bridgeItems([...fromServer, { not: "an item" }, null], T0);
    expect(bridged.tripwires.map((t) => [t.id, t.kind, t.agentId])).toEqual([
      ["srv:tripwire:lesson:a", "tripwire", BRIEF],
      ["srv:tripwire:lesson:b", "tripwire", SWEEP],
    ]);
    expect(bridged.routines.map((r) => r.id)).toEqual(["routine:vault-sync:done:x"]);
    const feed = new FeedStore();
    expect(feed.push(bridged.tripwires)).toBe(true);
    // One lesson in two districts: one slot, breadth ×1.25, no repeat penalty.
    const r = selectWorkspace(gatherCandidates({ ...EMPTY, feed: feed.list(), serverFeed: bridged.routines }, lookup, T0).candidates, {}, T0);
    expect(r.top).toHaveLength(1);
    expect(r.top[0]).toMatchObject({ urgency: "tripwire", occurrences: 1, districts: ["yalla-brief", "acme-ai-next"] });
    expect(r.top[0]?.reason).toContain("2 districts");
  });
});

describe("failed automated runs and subagents, with their deterministic reason", () => {
  // Real titles: a headless /daily-recap step (autonomy level 3) and an interactive session (level 1).
  const RECAP_ID = "912664eb-8222-4691-9985-08bf9c0d304b";
  const CHAT_ID = "be043071-0000-4000-8000-000000000001";
  const agents = new Map([
    [RECAP_ID, { ...agent(RECAP_ID, "alexboghossian", "You are the narrative step of Alex's /daily-recap. A deterministic script already extracted…"), messageCount: 4 }],
    [CHAT_ID, { ...agent(CHAT_ID, "agent-world", "nothing needs my work :)"), messageCount: 40 }],
  ]);
  const look = agentLookup(() => agents);
  const ending = (sessionId: string, over: Partial<RunEnding> = {}): RunEnding => ({ sessionId, status: "failed", reason: "API Error: Unable to connect to API (ConnectionRefused)", at: iso(T0 - 10 * MIN), headless: false, ...over });

  it("a failed automated session is a failure candidate naming its reason; interactive ones and unknown sessions are left out", () => {
    expect(look(RECAP_ID)?.automated).toBe(true);
    expect(look(CHAT_ID)?.automated).toBe(false);
    const c = runCandidates([ending(RECAP_ID), ending(CHAT_ID, { reason: "cut off: its prompt was never answered" }), ending("ffffffff-0000-4000-8000-000000000000")], look);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ urgency: "failure", origin: "automation", topic: `run:${RECAP_ID}`, agentIds: [RECAP_ID], districts: ["alexboghossian"] });
    expect(c[0]?.text).toBe("/daily-recap · narrative failed: API Error: Unable to connect to API (ConnectionRefused)");
    // A headless (sdk-cli) transcript counts as automated even when its title doesn't say so.
    expect(runCandidates([ending(CHAT_ID, { headless: true, reason: "cut off: a tool call never returned" })], look)[0]?.urgency).toBe("failure");
    // Stopped is info (Alex or a parent did it on purpose), so it never takes a failure slot.
    expect(runCandidates([ending(RECAP_ID, { status: "stopped", reason: "interrupted by the user" })], look)[0]?.urgency).toBe("info");
    const r = selectWorkspace(gatherCandidates({ ...EMPTY, runEndings: [ending(RECAP_ID)] }, look, T0).candidates, {}, T0);
    expect(r.top[0]?.reason).toBe("failure · automation · 10m ago → 47 (≥ 20)");
  });

  it("a failed subagent carries its reason; a stopped one is info, not a failure", () => {
    const c = subagentCandidates([subagent({ id: "f", status: "failed", reason: "API error: Request timed out" }), subagent({ id: "s", status: "stopped", reason: "interrupted by the user" })], lookup);
    expect(c.map((x) => [x.urgency, x.text])).toEqual([
      ["failure", "failed: Review PR 22 · API error: Request timed out"],
      ["info", "stopped: Review PR 22"],
    ]);
  });
});

describe("live sources (workspace-data.ts)", () => {
  it("reads the resident live: a proposal made after load shows, one dismissed in the Inbox leaves", () => {
    const at = iso(T0 - 2 * MIN);
    const state: ResidentState = {
      name: "Alef resident",
      enabled: true,
      bornAt: "2026-09-26T15:48:45.059Z",
      day: 2,
      lastTickAt: at,
      lastReflectAt: null,
      lastError: null,
      goals: [],
      skills: [],
      journalTail: [],
      recentWrites: [],
      proposals: [],
      spend: { todayUsd: 0.1, capUsd: 0.5 },
    };
    const proposal = { id: "rp-9", at, kind: "note" as const, title: "Ask the builder to re-run the sweep", why: "…", status: "open" as const };
    const proposals = (): string[] => gatherCandidates(workspaceSources(new FeedStore()), lookup, T0).candidates.map((c) => c.text);
    // Page load: the snapshot has no proposal. Later, the "resident" WS push carries a new one…
    expect(residentData.accept(state)).toBe(true);
    expect(proposals()).toEqual([]);
    expect(residentData.accept({ ...state, proposals: [proposal] })).toBe(true);
    expect(proposals()).toEqual(["resident proposes: Ask the builder to re-run the sweep"]);
    // …and Dismiss in the Inbox returns the state with it dismissed.
    expect(residentData.accept({ ...state, proposals: [{ ...proposal, status: "dismissed" }] })).toBe(true);
    expect(proposals()).toEqual([]);
    expect(residentData.accept({ not: "a state" })).toBe(false);
  });
});

describe("rendering the slot (untrusted text)", () => {
  it("escapes titles and keys in the Feed tab's Town square header, and picks the agent", () => {
    const evil = cand("waiting", T0, `<img src=x onerror="alert(1)"> & 'quotes'`, { topic: `wait:"><script>` });
    const r = selectWorkspace([evil], {}, T0);
    const { html, picks } = workspaceTopHtml(r.top);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;");
    expect(html).toContain(`data-top="wait:&quot;&gt;&lt;script&gt;"`);
    expect(picks.get(`wait:"><script>`)).toMatchObject({ agentId: ORCH, cityId: "agent-world" });
    expect(workspaceTopHtml([]).html).toContain("nothing clears the bar (20)");
  });

  it("the Feed tab's header is not rebuilt when only the counts changed (keyboard focus stays)", () => {
    let writes = 0;
    let html = "";
    const el = {
      get innerHTML(): string {
        return html;
      },
      set innerHTML(v: string) {
        writes++;
        html = v;
      },
    };
    const write = htmlWriter(el);
    let notified = 0;
    // Exactly what feed-ui.ts's renderTop does on each workspace change.
    const off = workspaceData.onChange(() => {
      notified++;
      write(workspaceTopHtml(workspaceData.result.top).html);
    });
    const tripwire: FeedItem = { id: "tw:1", kind: "tripwire", at: T0 - MIN, title: "Repeating a known lesson", agentId: VAULT };
    const line = (i: number): FeedItem => ({ id: `act:${i}`, kind: "activity", at: T0 - MIN + i * 1_000, title: `Read file ${i}.ts`, agentId: ORCH });
    workspaceData.update({ ...EMPTY, feed: [tripwire] }, lookup, T0);
    workspaceData.update({ ...EMPTY, feed: [tripwire, line(1)] }, lookup, T0); // a new activity line: counts change, the top 5 doesn't
    workspaceData.update({ ...EMPTY, feed: [tripwire, line(1), line(2)] }, lookup, T0);
    off();
    expect(notified).toBe(3);
    expect(writes).toBe(1);
    expect(html).toContain("Repeating a known lesson");
  });
});

describe("stranded launches: always waiting, districted by the longest cwd prefix, never decaying", () => {
  it("is always 'waiting' and 'open', districted by the island whose path is the longest prefix of cwd", () => {
    const c = strandedCandidates([stranded()], ISLANDS);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      id: "stranded:aw-68597ce4",
      urgency: "waiting",
      origin: "launch",
      topic: "stranded:aw-68597ce4",
      open: true,
      agentIds: [],
      districts: ["acme-www"],
    });
    expect(c[0]?.text).toBe("Launch waiting on you: Open PR aligning acme.ai FAQ 'end-to-end encryption' + homepage 'no one can acc… - empty prompt");
  });

  it("picks the longest matching path, never a shorter sibling prefix, and never invents a district", () => {
    const nested = [{ id: "code", path: "/Users/s/Documents/Code" }, ...ISLANDS];
    expect(strandedCandidates([stranded({ cwd: "/Users/s/Documents/Code/acme-www" })], nested)[0]?.districts).toEqual(["acme-www"]);
    // "/Users/s/Documents/Code/acme-www-old" is NOT under "/Users/s/Documents/Code/acme-www" (no slash boundary), and no
    // other island owns it: an unmatched cwd gets no invented district, ever.
    expect(strandedCandidates([stranded({ tmuxName: "aw-sib", cwd: "/Users/s/Documents/Code/acme-www-old" })], ISLANDS)[0]?.districts).toEqual([]);
    expect(strandedCandidates([stranded({ tmuxName: "aw-none", cwd: "/somewhere/else" })], ISLANDS)[0]?.districts).toEqual([]);
  });

  it("covers every StrandedBlockedOn wording, and falls back honestly when promptHead is null", () => {
    const reasons = (
      ["trust", "chrome", "menu", "empty-prompt", "exited", "unknown"] as const
    ).map((blockedOn) => strandedCandidates([stranded({ blockedOn, promptHead: null })], ISLANDS)[0]?.text);
    expect(reasons).toEqual([
      "Launch waiting on you: (no prompt on record) - trust dialog",
      "Launch waiting on you: (no prompt on record) - Chrome dialog",
      "Launch waiting on you: (no prompt on record) - menu",
      "Launch waiting on you: (no prompt on record) - empty prompt",
      "Launch waiting on you: (no prompt on record) - exited",
      "Launch waiting on you: (no prompt on record) - unrecognized screen",
    ]);
  });

  it("scores at full weight (100) and holds the slot without decaying, like an unanswered wait", () => {
    const r = selectWorkspace(strandedCandidates([stranded()], ISLANDS), {}, T0 + 3 * 60 * MIN); // 3 h later: well past the 2 h window
    expect(r.top).toEqual([expect.objectContaining({ urgency: "waiting", score: 100, held: false })]);
  });
});

describe("Health: a failing check is a failure, a warning is info, and only what's wrong shows", () => {
  const warn: CompletenessCheck = { id: "routines", label: "Routines are healthy", group: "routines", weight: 2, state: "warn", detail: "At least one routine's last run exited non-zero.", confidence: "measured" };
  const pass: CompletenessCheck = { id: "tmux", label: "tmux available", group: "control", weight: 2, state: "pass", detail: "tmux 3.5a", confidence: "measured" };
  const unknown: CompletenessCheck = { id: "indexes", label: "Brain index is warm", group: "code", weight: 1, state: "unknown", detail: "not measured yet", confidence: "measured" };

  it("maps state to urgency and formats 'Health: <what is wrong>: <detail>'; pass/unknown say nothing", () => {
    const summary: HealthSummary = { generatedAt: iso(T0), checks: [liveVisibleFail, warn, pass, unknown] };
    const c = healthCandidates(summary);
    expect(c.map((x) => [x.urgency, x.origin, x.topic, x.text])).toEqual([
      ["failure", "Health", "health:live-visible", "Health: Live sessions aren't all visible: 2 live claude processes, 0 visible"],
      ["info", "Health", "health:routines", "Health: A routine is failing: At least one routine's last run exited non-zero."],
    ]);
    expect(c.every((x) => x.at === Date.parse(summary.generatedAt))).toBe(true);
    expect(healthCandidates(null)).toEqual([]);
  });

  it("never words a failing check as its passing label (Jev offline, not 'is online')", () => {
    const jev: CompletenessCheck = { id: "jev-key", label: "Jev (TypeSafe)", group: "jev", weight: 2, state: "fail", detail: "TYPESAFE_API_KEY not set.", confidence: "measured" };
    expect(healthCandidates({ generatedAt: iso(T0), checks: [jev] }).map((x) => x.text)).toEqual(["Health: Jev is offline: TYPESAFE_API_KEY not set."]);
  });

  it("a check snoozed or marked won't fix in Health is not pinned", () => {
    const snoozed: CompletenessCheck = { ...liveVisibleFail, dismissed: { kind: "snooze", at: iso(T0), until: iso(T0 + 7 * 24 * 60 * MIN), reason: null } };
    const wontFix: CompletenessCheck = { ...warn, dismissed: { kind: "wont-fix", at: iso(T0), until: null, reason: "no routines here" } };
    expect(healthCandidates({ generatedAt: iso(T0), checks: [snoozed, wontFix] })).toEqual([]);
    expect(healthCandidates({ generatedAt: iso(T0), checks: [snoozed, warn] }).map((x) => x.topic)).toEqual(["health:routines"]);
  });

  it("a fail is open: true (like an unanswered wait); a warn is not", () => {
    const c = healthCandidates({ generatedAt: iso(T0), checks: [liveVisibleFail, warn] });
    expect(c.find((x) => x.origin === "Health" && x.urgency === "failure")?.open).toBe(true);
    expect(c.find((x) => x.origin === "Health" && x.urgency === "info")?.open).toBe(false);
  });

  it("a still-reported failure never decays or drops out from age alone, however stale its own generatedAt is", () => {
    const c = healthCandidates({ generatedAt: iso(T0), checks: [liveVisibleFail] });
    // 90 minutes past `generatedAt` — well past the 30 min half-life (would otherwise decay 60
    // to ~7.5, under both the 20 ENTER and 14 EXIT bars) and past the 2 h window's start, too.
    // A check the server is still reporting failing must hold its full weight regardless.
    const r = selectWorkspace(c, {}, T0 + 90 * MIN);
    expect(r.top).toEqual([expect.objectContaining({ urgency: "failure", score: 60, held: false })]);
  });
});

describe("Jev's proposal board: every open proposal is info, worded like the Inbox's own rows", () => {
  it("a session proposal names its task; a merge proposal names the merge", () => {
    const board: PresidentBoard = {
      generatedAt: iso(T0),
      source: "jev",
      proposals: [
        { id: "p1", kind: "session", task: "Re-run the MENA competitor sweep", city: "acme-ai-next", model: "sonnet", why: "3 days stale" },
        { id: "p2", kind: "merge", districts: ["a", "b"], into: "a", sessions: 2, why: "both dormant 14+ days" },
      ],
    };
    expect(presidentCandidates(board).map((c) => [c.urgency, c.origin, c.text])).toEqual([
      ["info", "Jev", "Jev proposes: Re-run the MENA competitor sweep"],
      ["info", "Jev", "Jev proposes: merge 2 districts into a"],
    ]);
    expect(presidentCandidates(null)).toEqual([]);
    expect(presidentCandidates({ ...board, proposals: [] })).toEqual([]);
  });
});

describe("workflow hand-backs are demoted: plumbing of a running workflow, not town news", () => {
  it("a 'done' workflow subagent (by workflowId or by agentType) is info/workflow; a non-workflow one stays message/subagent; a FAILURE never demotes", () => {
    const byWorkflowId = subagent({ id: "h1", workflowId: "wf_90d74f64-9c8", agentType: "general-purpose", description: "build:broken-fixes" });
    const byAgentType = subagent({ id: "h2", workflowId: null, agentType: "workflow-subagent", description: "plan" });
    const adHoc = subagent({ id: "h3", workflowId: null, agentType: "general-purpose", description: "Build v8 Crusoe-style landing" });
    const failedWorkflow = subagent({ id: "h4", workflowId: "wf_90d74f64-9c8", status: "failed", reason: "API Error: timeout", description: "fix:launch-honesty" });
    const c = subagentCandidates([byWorkflowId, byAgentType, adHoc, failedWorkflow], lookup);
    expect(c.map((x) => [x.urgency, x.origin, x.text])).toEqual([
      ["info", "workflow", "handed back: build:broken-fixes"],
      ["info", "workflow", "handed back: plan"],
      ["message", "subagent", "handed back: Build v8 Crusoe-style landing"],
      ["failure", "subagent", "failed: fix:launch-honesty · API Error: timeout"],
    ]);
  });

  it("the hand-back MESSAGE for the same workflow subagent demotes the same way, and still groups as one event", () => {
    const rec = subagent({ id: "wf9", workflowId: "wf_90d74f64-9c8", description: "review:town-logs:works:r1" });
    const handback: VillageMessage = { id: "received:1", at: iso(T0 - 2 * MIN), direction: "received", fromSessionId: null, fromRaw: rec.id, toSessionId: ORCH, toRaw: ORCH, preview: "[Subagent hand-back] …" };
    const mc = messageCandidates([handback], new Map([[rec.id, rec]]), lookup);
    expect(mc[0]).toMatchObject({ urgency: "info", origin: "workflow" });
    // A hand-back whose subagent record isn't on hand is never demoted on a guess.
    const orphan = messageCandidates([{ ...handback, id: "received:2", fromRaw: "unknownagent" }], new Map(), lookup);
    expect(orphan[0]).toMatchObject({ urgency: "message", origin: "subagent" });
  });
});

describe("truthful town square: stranded launches and a failing Health check beat workflow plumbing", () => {
  it("a stranded entry that disappears drops out; a failing check that turns to pass drops out", () => {
    const s1 = stranded({ tmuxName: "aw-68597ce4" });
    const s2 = stranded({ tmuxName: "aw-5c67d47b", cwd: "/Users/s/Documents/Code/legal-taxonomy", blockedOn: "trust" });
    let slot: WorkspaceSlot = {};
    const run = (list: StrandedDispatch[], checks: CompletenessCheck[]): ReturnType<typeof selectWorkspace> => {
      const { candidates } = gatherCandidates({ ...EMPTY, stranded: list, islands: ISLANDS, health: { generatedAt: iso(T0), checks } }, lookup, T0);
      const r = selectWorkspace(candidates, slot, T0);
      slot = r.slot;
      return r;
    };
    let r = run([s1, s2], [liveVisibleFail]);
    expect(r.top.map((e) => e.key)).toEqual(expect.arrayContaining([`stranded:${s1.tmuxName}`, `stranded:${s2.tmuxName}`, "health:live-visible"]));
    // s2 closes, and live-visible turns to pass.
    r = run([s1], [{ ...liveVisibleFail, state: "pass" }]);
    expect(r.top.map((e) => e.key)).not.toContain(`stranded:${s2.tmuxName}`);
    expect(r.top.map((e) => e.key)).not.toContain("health:live-visible");
    expect(r.top.map((e) => e.key)).toContain(`stranded:${s1.tmuxName}`);
  });

  it("selectWorkspace on a fixture mirroring the 09-28 03:25Z mix puts the stranded launches in the top 5, with the failing Health check, and no workflow hand-back takes a slot", () => {
    const strandedList = [
      stranded({ tmuxName: "aw-68597ce4", cwd: "/Users/s/Documents/Code/acme-www", blockedOn: "empty-prompt" }),
      stranded({ tmuxName: "aw-5c67d47b", cwd: "/Users/s/Documents/Code/legal-taxonomy", blockedOn: "trust", promptHead: "Cutover (HARD STOP moment, pre-approved 2026-09-25): tunnel ingress removed, Worker custom domain attached, launchd job…" }),
      stranded({ tmuxName: "aw-e10a9ec9", cwd: "/Users/s/Documents/Code/agent-world", blockedOn: "chrome", promptHead: null }),
    ];
    // The four workflow-subagent hand-backs the real 03:25Z snapshot showed in the top 5 (#7-10 in
    // the post's numbering): all born of the same review/fix workflow, all "done".
    const workflowHandbacks = [
      subagent({ id: "wf1", workflowId: "wf_90d74f64-9c8", agentType: "general-purpose", description: "build:broken-fixes", status: "done", lastActive: iso(T0 - 5 * MIN) }),
      subagent({ id: "wf2", workflowId: "wf_a884ad3f-651", agentType: "workflow-subagent", description: "map:3", status: "done", lastActive: iso(T0 - 6 * MIN) }),
      subagent({ id: "wf3", workflowId: "wf_90d74f64-9c8", agentType: "general-purpose", description: "build:launch-honesty", status: "done", lastActive: iso(T0 - 7 * MIN) }),
      subagent({ id: "wf4", workflowId: "wf_90d74f64-9c8", agentType: "general-purpose", description: "build:action-feedback", status: "done", lastActive: iso(T0 - 8 * MIN) }),
    ];
    const routineFail: ServerFeedItem = { id: "routine:eulex-bench:done:a", seq: 1, at: iso(T0 - MIN), kind: "routine", agentId: null, title: "eulex-bench ran", detail: "exit 2", tag: "finished" };
    const health: HealthSummary = { generatedAt: iso(T0), checks: [liveVisibleFail] };
    const board: PresidentBoard = { generatedAt: iso(T0), proposals: [], source: "jev" };

    const { candidates, observed } = gatherCandidates(
      { ...EMPTY, subagents: workflowHandbacks, serverFeed: [routineFail], stranded: strandedList, islands: ISLANDS, health, presidentBoard: board },
      lookup,
      T0,
    );
    expect(observed).toBe(3 + 4 + 1 + 1); // 3 stranded + 4 subagent hand-backs + 1 routine failure + 1 failing Health check (0 Jev proposals)
    const r = selectWorkspace(candidates, {}, T0);

    const launches = r.top.filter((e) => e.origin === "launch");
    expect(launches).toHaveLength(3);
    for (const e of launches) {
      expect(e.urgency).toBe("waiting");
      expect(e.score).toBe(100);
      expect(e.held).toBe(false); // 100 clears the 20 ENTER bar outright, not just the 14 hysteresis floor
    }
    expect(r.top.some((e) => e.key === "health:live-visible" && e.urgency === "failure")).toBe(true);
    for (const desc of ["build:broken-fixes", "map:3", "build:launch-honesty", "build:action-feedback"]) {
      expect(r.top.some((e) => e.text.includes(desc))).toBe(false);
    }
    expect(r.top).toHaveLength(5); // 3 stranded + Health fail + the routine failure: exactly the 5 real signals that clear the bar
  });
});
