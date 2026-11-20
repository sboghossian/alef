// "jobs": the classifier's precedence and reasons (shared/features/jobs.ts), the signals built from
// real data shapes (subagent records as GET /api/subagents serves them, session rows with cnt_* and
// uses / touched edges, outcome records), the transcript proofs for learner writes and skill names,
// the per-tick byte budget, the routes and the WS emit. Transcripts live in a temp projects dir.

import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobOf, JOBS_BY_AGENT_PATH, NO_JOB_EVIDENCE, type JobEntry, type JobsByAgentResponse, type JobSignals, type JobsMessage, type JobsResponse } from "../../shared/features/jobs.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import type { WorldDb } from "../db.js";
import { createJobsFeature, foldProofLine, newProof, sessionSignals, slashCommandOf, subagentNeedsProof, subagentSignals } from "../features/jobs.js";
import type { FeatureContext } from "../features/registry.js";
import { assistantLine, makeTempDb, makeTempProjectsDir, userLine } from "./helpers.js";

const HOME = "/Users/someone";
const AT = "2026-09-28T03:00:00.000Z";

function signals(p: Partial<JobSignals>): JobSignals {
  return { mcp: {}, skills: {}, cwd: null, touched: {}, agentType: null, description: null, learned: [], writes: {}, ships: [], gathers: {}, ...p };
}

function subagent(p: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    parentSessionId: "11111111-1111-4111-8111-111111111111",
    parentAgentId: null,
    workflowId: null,
    description: "work",
    agentType: "general-purpose",
    model: "claude-sonnet-5",
    status: "done",
    reason: null,
    startedAt: AT,
    lastActive: AT,
    tokens: 10,
    toolCounts: {},
    files: [],
    depth: 1,
    ...p,
  };
}

function outcome(sessionId: string, p: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return { sessionId, outcome: "unknown", reason: null, evidenceAt: null, lastActive: AT, toolCalls: 0, writes: 0, learnings: [], artifacts: [], prs: [], pushes: [], todos: null, ending: null, onDisk: true, pending: false, provisionalUntil: null, ...p };
}

function addSession(db: WorldDb, id: string, p: { cwd?: string; title?: string; edit?: number; research?: number; bash?: number; lastActive?: string } = {}): void {
  db.upsertSession({
    id,
    cwd: p.cwd ?? HOME,
    islandId: "home",
    title: p.title ?? "do the thing",
    startedAt: AT,
    lastActive: p.lastActive ?? AT,
    jsonlMtime: 0,
    messageCountDelta: 2,
    model: "claude-opus-5-5",
    cntEditDelta: p.edit ?? 0,
    cntResearchDelta: p.research ?? 0,
    cntBashDelta: p.bash ?? 0,
    cntTextOnlyDelta: 0,
    cntAssistantTotalDelta: 1,
  });
}

function edge(db: WorldDb, from: string, to: string, kind: "touched" | "uses", times = 1): void {
  for (let i = 0; i < times; i++) db.upsertEdge({ from, to, kind, at: AT });
}

let dbCounter = 0;
function fakeCtx(db: WorldDb, projectsDir: string, emitted: unknown[]): FeatureContext {
  const noop = (): void => {};
  return {
    featureId: "jobs",
    db,
    config: { projectsDir, dbPath: `jobs-test-${++dbCounter}` },
    emit: (p: unknown) => emitted.push(p),
    log: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as FeatureContext;
}

function get(feature: ReturnType<typeof createJobsFeature>, ctx: FeatureContext, path: string, params: Record<string, string> = {}): { status: number; body: unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
    end: (b?: string) => {
      body = b ?? "";
    },
  };
  const route = feature.routes?.find((r) => r.path === path);
  if (!route) throw new Error(`no route ${path}`);
  void route.handler({ url: path } as never, res as never, ctx, params);
  return { status, body: JSON.parse(body) as unknown };
}

/** A subagent transcript at the real layout: <project>/<session>/subagents/agent-<id>.jsonl. */
async function writeSubagentTranscript(projectsDir: string, parent: string, id: string, lines: string[]): Promise<string> {
  const dir = join(projectsDir, "-Users-someone", parent, "subagents");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `agent-${id}.jsonl`);
  await writeFile(path, lines.map((l) => `${l}\n`).join(""), "utf8");
  return path;
}

const tool = (name: string, input: Record<string, unknown>, cwd = HOME): string => assistantLine({ cwd, timestamp: AT, toolUses: [{ name, input }] });

describe("jobOf: precedence lawyer > hacker > learner > builder > gatherer", () => {
  const all = signals({
    mcp: { "legal-data-hunter": 12 },
    agentType: "code-reviewer",
    learned: ["/Users/someone/.claude/projects/-Users-someone/memory/feedback_x.md"],
    writes: { Edit: 3 },
    gathers: { Read: 10 },
  });

  it("each job wins over every job below it", () => {
    expect(jobOf(all)).toEqual({ job: "lawyer", reason: "used legal-data-hunter x12" });
    expect(jobOf({ ...all, mcp: {} }).job).toBe("hacker");
    expect(jobOf({ ...all, mcp: {}, agentType: null })).toEqual({ job: "learner", reason: "wrote memory/feedback_x.md" });
    expect(jobOf({ ...all, mcp: {}, agentType: null, learned: [] })).toEqual({ job: "builder", reason: "Edit x3" });
    expect(jobOf({ ...all, mcp: {}, agentType: null, learned: [], writes: {} })).toEqual({ job: "gatherer", reason: "Read x10; no writes" });
  });

  it("no named signal is never a job", () => {
    expect(jobOf(signals({}))).toEqual({ job: null, reason: NO_JOB_EVIDENCE });
    // Only Bash, only non-gathering MCP tools, only a non-job skill: still no evidence.
    expect(jobOf(signals({ mcp: { linear: 9 }, skills: { browse: 2 } }))).toEqual({ job: null, reason: NO_JOB_EVIDENCE });
  });

  it("is deterministic whatever order the counts arrive in", () => {
    const a = jobOf(signals({ gathers: { Read: 3, Grep: 3, WebFetch: 1 } }));
    const b = jobOf(signals({ gathers: { WebFetch: 1, Grep: 3, Read: 3 } }));
    expect(a).toEqual(b);
    expect(a.reason).toBe("Grep x3, Read x3, WebFetch x1; no writes");
  });

  it("lawyer: legal skills (plugin prefix dropped) and legal folders, the ~/.eulex-bench data folder included", () => {
    expect(jobOf(signals({ skills: { "route-contract-review": 1, browse: 3 } })).reason).toBe("ran /route-contract-review x1");
    expect(jobOf(signals({ skills: { "legal:founder-agreement-drafting": 2 } })).job).toBe("lawyer");
    expect(jobOf(signals({ skills: { "divorce-ct": 1 } })).job).toBe("lawyer");
    expect(jobOf(signals({ skills: { "route-council": 1 } })).job).toBeNull(); // not route-contract-* / route-legal-*
    expect(jobOf(signals({ cwd: "/Users/someone/Documents/Code/legal-taxonomy/data" })).reason).toBe("works in legal-taxonomy");
    expect(jobOf(signals({ cwd: "/Users/someone/.eulex-bench/bench" })).reason).toBe("works in eulex-bench");
    expect(jobOf(signals({ cwd: "/Users/someone/Documents/Code/legal-taxonomy-notes" })).job).toBeNull(); // a segment, not a prefix
    expect(jobOf(signals({ cwd: HOME, touched: { "/Users/someone/Documents/Code/legal-taxonomy/lib/sources.mjs": 12 }, writes: { Edit: 4 } }))).toEqual({
      job: "lawyer",
      reason: "touched legal-taxonomy files x12",
    });
  });

  it("hacker: the reason names the signal, never quotes the (untrusted) description", () => {
    const v = jobOf(signals({ description: 'Review <img src=x onerror="alert(1)"> now', writes: { Write: 1 } }));
    expect(v).toEqual({ job: "hacker", reason: 'task starts with "review"' });
    expect(jobOf(signals({ agentType: "grok:grok-reviewer" })).reason).toBe("agent type grok:grok-reviewer");
    expect(jobOf(signals({ skills: { "code-review": 2 } })).reason).toBe("ran /code-review x2");
    expect(jobOf(signals({ description: "R1-A red team loopholes" })).reason).toBe('task mentions "red team"');
  });

  it("hacker: the two signals that measured weak carry the unvalidated mark", () => {
    expect(jobOf(signals({ description: "Audit Aware issues" })).reason).toBe('task starts with "audit" 🧪');
    expect(jobOf(signals({ description: "v4: pricing, strip, security", writes: { Edit: 13 } })).reason).toBe('task mentions "security" 🧪');
    expect(jobOf(signals({ description: "review:census:correctness" })).reason).toBe('task starts with "review"');
    expect(jobOf(signals({ agentType: "code-reviewer", description: "audit the diff" })).reason).toBe('agent type code-reviewer; task starts with "audit" 🧪');
  });

  it("gatherer: exa, firecrawl and Explore count; Explore alone says so", () => {
    expect(jobOf(signals({ mcp: { exa: 25 }, gathers: { WebSearch: 27 } })).reason).toBe("WebSearch x27, exa x25; no writes");
    expect(jobOf(signals({ skills: { "firecrawl-scrape": 2 } })).reason).toBe("firecrawl-scrape x2; no writes");
    expect(jobOf(signals({ agentType: "Explore" })).reason).toBe("Explore agent; no writes");
  });

  it("builder: a landed push counts without an edit", () => {
    expect(jobOf(signals({ ships: ["push to acme-inc/acme-ai"] }))).toEqual({ job: "builder", reason: "push to acme-inc/acme-ai" });
  });
});

describe("signals from real data shapes", () => {
  it("a subagent record as /api/subagents serves it: legal MCP calls are summed per server", () => {
    const r = subagent({ id: "a48294115f6eaf900", toolCounts: { Edit: 3, Read: 10, "mcp__legal-data-hunter__search": 4, "mcp__legal-data-hunter__get_document": 2, mcp__linear__get_issue: 3 } });
    const s = subagentSignals(r, HOME, null);
    expect(s.mcp).toEqual({ "legal-data-hunter": 6, linear: 3 });
    expect(s.writes).toEqual({ Edit: 3 });
    expect(s.gathers).toEqual({ Read: 10 });
    expect(jobOf(s)).toEqual({ job: "lawyer", reason: "used legal-data-hunter x6" });
  });

  it("a subagent's files mix reads and writes, so they are never read as a learner write", () => {
    const r = subagent({
      id: "a327fa4470e2107dd",
      description: "build:lesson-tripwires",
      toolCounts: { Bash: 151, Read: 2, Write: 11, Edit: 14, StructuredOutput: 1 },
      files: [
        { path: "/Users/someone/.alef-worktrees/lesson-tripwires/server/features/tripwires-lib.ts", count: 5 },
        { path: "/Users/someone/Documents/Code/agent-world/tasks/lessons.md", count: 1 },
      ],
    });
    expect(subagentNeedsProof(r)).toBe(true); // a candidate: its transcript decides
    expect(jobOf(subagentSignals(r, HOME, null))).toEqual({ job: "builder", reason: "Edit x14, Write x11" });
  });

  it("a subagent with a Skill call is a proof candidate; one that only read memory is not", () => {
    expect(subagentNeedsProof(subagent({ id: "a1", toolCounts: { Skill: 1 } }))).toBe(true);
    expect(subagentNeedsProof(subagent({ id: "a2", toolCounts: { Read: 4 }, files: [{ path: "/Users/someone/.claude/projects/-Users-someone/memory/x.md", count: 4 }] }))).toBe(false);
  });

  it("a session row: uses edges (with call counts), touched files, cnt_* and its outcome record", async () => {
    const db = await makeTempDb(await makeTempProjectsDir());
    const id = "22222222-2222-4222-8222-222222222222";
    addSession(db, id, { research: 3 });
    edge(db, id, "mcp:legal-graph", "uses", 2);
    edge(db, id, "skill:browse", "uses");
    edge(db, id, "file:/Users/someone/notes/a.md", "touched", 3);
    edge(db, id, "repo:/Users/someone/code", "touched");
    const row = db.getSession(id);
    if (!row) throw new Error("no row");
    const s = sessionSignals(row, db.listEdges().filter((e) => e.from === id), outcome(id, { pushes: ["sboghossian/agent-world"] }), null);
    expect(s.mcp).toEqual({ "legal-graph": 2 });
    expect(s.skills).toEqual({ browse: 1 });
    expect(s.touched).toEqual({ "/Users/someone/notes/a.md": 3 });
    expect(s.gathers).toEqual({ "WebFetch/WebSearch/Grep": 3, "files read/searched": 1 });
    expect(s.ships).toEqual(["push to sboghossian/agent-world"]);
    expect(jobOf(s)).toEqual({ job: "lawyer", reason: "used legal-graph x2" });
  });

  it("slash commands: Claude Code's command tags or a bare leading /name, never a path", () => {
    expect(slashCommandOf("<command-message>upskill</command-message>\n<command-name>/upskill</command-name>")).toBe("upskill");
    expect(slashCommandOf("/skillify this session")).toBe("skillify");
    expect(slashCommandOf("/Users/someone/shot.png what is this")).toBeNull();
    expect(slashCommandOf("/tmp/x.log explain")).toBeNull();
    expect(slashCommandOf("You are the autonomous authoring step of Alex's `/upskill` loop")).toBeNull();
  });

  it("proof lines: writes to memory / lessons.md / SKILL.md / CASES.md and Skill names; reads never count", () => {
    const p = newProof("/x.jsonl");
    foldProofLine(p, tool("Read", { file_path: "/Users/someone/code/tasks/lessons.md" }));
    foldProofLine(p, tool("Edit", { file_path: "/Users/someone/code/server/a.ts" }));
    expect(p.learned.size).toBe(0);
    foldProofLine(p, tool("Write", { file_path: "/Users/someone/.claude/skills/cli-forge/SKILL.md" }));
    foldProofLine(p, tool("Edit", { file_path: "tasks/lessons.md" }, "/Users/someone/code")); // relative → its line's cwd
    foldProofLine(p, tool("Skill", { skill: "upskill" }));
    foldProofLine(p, tool("Skill", { skill: "upskill" }));
    foldProofLine(p, "not json {\"tool_use\" \"Skill\"");
    expect([...p.learned].sort()).toEqual(["/Users/someone/.claude/skills/cli-forge/SKILL.md", "/Users/someone/code/tasks/lessons.md"]);
    expect(Object.fromEntries(p.skills)).toEqual({ upskill: 2 });
  });
});

describe("the jobs feature", () => {
  const PARENT = "33333333-3333-4333-8333-333333333333";

  it("proves a subagent's learner write from its transcript; the lesson-tripwires builder stays builder", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    addSession(db, PARENT, { edit: 1 });
    const memory = "/Users/someone/.claude/projects/-Users-someone/memory/feedback_x.md";
    await writeSubagentTranscript(dir, PARENT, "alearner0001", [userLine({ cwd: HOME, timestamp: AT, text: "compact memory" }), tool("Read", { file_path: memory }), tool("Write", { file_path: memory })]);
    await writeSubagentTranscript(dir, PARENT, "abuilder0001", [
      userLine({ cwd: HOME, timestamp: AT, text: "build:lesson-tripwires" }),
      tool("Read", { file_path: "/Users/someone/code/tasks/lessons.md" }),
      tool("Edit", { file_path: "/Users/someone/code/server/features/tripwires-lib.ts" }),
    ]);
    const subs = [
      subagent({ id: "alearner0001", parentSessionId: PARENT, description: "Compact 4 memory files", toolCounts: { Read: 1, Write: 1 }, files: [{ path: memory, count: 2 }] }),
      subagent({
        id: "abuilder0001",
        parentSessionId: PARENT,
        description: "build:lesson-tripwires",
        toolCounts: { Read: 1, Edit: 1 },
        files: [
          { path: "/Users/someone/code/server/features/tripwires-lib.ts", count: 1 },
          { path: "/Users/someone/code/tasks/lessons.md", count: 1 },
        ],
      }),
    ];
    const emitted: unknown[] = [];
    const feature = createJobsFeature({ subagentRecords: () => subs, outcomeRecords: () => [] });
    const ctx = fakeCtx(db, dir, emitted);
    // Before the first tick (no transcript read yet): computed from the records alone.
    expect(get(feature, ctx, "/api/jobs/:id", { id: "alearner0001" }).body).toEqual({ id: "alearner0001", kind: "subagent", job: "builder", reason: "Write x1" });
    await feature.onTick?.(ctx);
    expect(get(feature, ctx, "/api/jobs/:id", { id: "alearner0001" }).body).toEqual({ id: "alearner0001", kind: "subagent", job: "learner", reason: "wrote memory/feedback_x.md" });
    expect(get(feature, ctx, "/api/jobs/:id", { id: "abuilder0001" }).body).toEqual({ id: "abuilder0001", kind: "subagent", job: "builder", reason: "Edit x1" });
    const all = get(feature, ctx, "/api/jobs").body as JobsResponse;
    expect(all.proofs).toMatchObject({ candidates: 2, pending: 0 });
    expect(all.counts?.subagents).toEqual({ lawyer: 0, hacker: 0, learner: 1, builder: 1, gatherer: 0, none: 0 });
  });

  it("learns a subagent's skill names from its transcript (a /code-review subagent is a hacker)", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    await writeSubagentTranscript(dir, PARENT, "askill000001", [tool("Skill", { skill: "code-review" }), tool("Read", { file_path: "/Users/someone/code/a.ts" })]);
    const subs = [subagent({ id: "askill000001", parentSessionId: PARENT, toolCounts: { Skill: 1, Read: 1 } })];
    const feature = createJobsFeature({ subagentRecords: () => subs, outcomeRecords: () => [] });
    const ctx = fakeCtx(db, dir, []);
    await feature.onTick?.(ctx);
    expect((get(feature, ctx, "/api/jobs/:id", { id: "askill000001" }).body as JobEntry).reason).toBe("ran /code-review x1");
  });

  it("sessions: outcome learnings, a proven SKILL.md write, a read-only SKILL.md, lessons read while editing, a slash command, legal folders, nothing", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const ids = {
      memory: "44444444-4444-4444-8444-444444444401",
      skillWrite: "44444444-4444-4444-8444-444444444402",
      skillRead: "44444444-4444-4444-8444-444444444403",
      readLessons: "44444444-4444-4444-8444-444444444404",
      slash: "44444444-4444-4444-8444-444444444405",
      legal: "44444444-4444-4444-8444-444444444406",
      eulex: "44444444-4444-4444-8444-444444444407",
      gather: "44444444-4444-4444-8444-444444444408",
      bashOnly: "44444444-4444-4444-8444-444444444409",
    };
    const skill = "/Users/someone/.claude/skills/pick-model/SKILL.md";
    addSession(db, ids.memory, { edit: 5 });
    for (const [id, lines] of [
      [ids.skillWrite, [tool("Read", { file_path: skill }), tool("Edit", { file_path: skill })]],
      [ids.skillRead, [tool("Read", { file_path: skill }), tool("Edit", { file_path: "/Users/someone/code/a.ts" })]],
    ] as const) {
      addSession(db, id, { edit: 1 });
      edge(db, id, `file:${skill}`, "touched");
      const path = join(dir, "-Users-someone", `${id}.jsonl`);
      await mkdir(join(dir, "-Users-someone"), { recursive: true });
      await writeFile(path, lines.map((l) => `${l}\n`).join(""), "utf8");
      db.setFileOffset({ path, size: 0, mtime: 0, byteOffset: 0, malformedCount: 0 });
    }
    addSession(db, ids.readLessons, { edit: 2 });
    edge(db, ids.readLessons, "file:/Users/someone/code/tasks/lessons.md", "touched");
    addSession(db, ids.slash, { title: "<command-message>upskill</command-message> <command-name>/upskill</command-name>", bash: 3 });
    addSession(db, ids.legal, { edit: 4 });
    edge(db, ids.legal, "file:/Users/someone/Documents/Code/legal-taxonomy/scripts/jev-edges.mjs", "touched", 9);
    addSession(db, ids.eulex, { cwd: "/Users/someone/.eulex-bench/bench", bash: 4 });
    addSession(db, ids.gather);
    edge(db, ids.gather, "mcp:exa", "uses", 2);
    edge(db, ids.gather, "file:/Users/someone/notes/a.md", "touched");
    addSession(db, ids.bashOnly, { bash: 40 });

    const outcomes = [outcome(ids.memory, { learnings: ["/Users/someone/.claude/projects/-Users-someone/memory/project_a.md", "/Users/someone/code/lessons.md"] })];
    const feature = createJobsFeature({ subagentRecords: () => null, outcomeRecords: () => outcomes });
    const ctx = fakeCtx(db, dir, []);
    await feature.onTick?.(ctx);
    const job = (id: string): unknown => get(feature, ctx, "/api/jobs/:id", { id }).body;
    expect(job(ids.memory)).toMatchObject({ kind: "session", job: "learner", reason: "wrote memory/project_a.md +1 more" });
    expect(job(ids.skillWrite)).toMatchObject({ job: "learner", reason: "wrote pick-model/SKILL.md" });
    expect(job(ids.skillRead)).toMatchObject({ job: "builder", reason: "Edit/Write x1" });
    expect(job(ids.readLessons)).toMatchObject({ job: "builder", reason: "Edit/Write x2" });
    expect(job(ids.slash)).toMatchObject({ job: "learner", reason: "ran /upskill x1" });
    expect(job(ids.legal)).toMatchObject({ job: "lawyer", reason: "touched legal-taxonomy files x9" });
    expect(job(ids.eulex)).toMatchObject({ job: "lawyer", reason: "works in eulex-bench" });
    expect(job(ids.gather)).toMatchObject({ job: "gatherer", reason: "exa x2, files read/searched x1; no writes" });
    expect(job(ids.bashOnly)).toMatchObject({ job: null, reason: NO_JOB_EVIDENCE });
    const all = get(feature, ctx, "/api/jobs").body as JobsResponse;
    expect(all.counts).toEqual({ sessions: { lawyer: 2, hacker: 0, learner: 3, builder: 2, gatherer: 1, none: 1 }, subagents: null });
    expect(get(feature, ctx, "/api/jobs/:id", { id: "nope" }).status).toBe(404);
  });

  it("reads proofs within the per-tick byte budget, over several ticks, and only new bytes after that", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const memory = "/Users/someone/.claude/projects/-Users-someone/memory/m.md";
    const filler = Array.from({ length: 40 }, (_, i) => tool("Read", { file_path: `/Users/someone/code/f${i}.ts` }));
    await writeSubagentTranscript(dir, PARENT, "abudget00001", [...filler, tool("Write", { file_path: memory })]);
    const subs = [subagent({ id: "abudget00001", parentSessionId: PARENT, toolCounts: { Read: 40, Write: 1 }, files: [{ path: memory, count: 1 }] })];
    const feature = createJobsFeature({ subagentRecords: () => subs, outcomeRecords: () => [], maxProofBytesPerTick: 4096 });
    const ctx = fakeCtx(db, dir, []);
    await feature.onTick?.(ctx);
    let all = get(feature, ctx, "/api/jobs").body as JobsResponse;
    expect(all.proofs.pending).toBe(1);
    expect(all.proofs.bytesLastTick).toBeLessThanOrEqual(4096);
    expect(all.subagents[0]?.job).toBe("builder");
    for (let i = 0; i < 20 && all.proofs.pending > 0; i++) {
      await feature.onTick?.(ctx);
      all = get(feature, ctx, "/api/jobs").body as JobsResponse;
    }
    expect(all.proofs.pending).toBe(0);
    expect(all.subagents[0]).toMatchObject({ job: "learner", reason: "wrote memory/m.md" });
    await feature.onTick?.(ctx);
    expect((get(feature, ctx, "/api/jobs").body as JobsResponse).proofs.bytesLastTick).toBe(0); // nothing new
  });

  it("emits counts + byAgent only when they change; counts ride the snapshot, byAgent its own GET", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const id = "55555555-5555-4555-8555-555555555555";
    addSession(db, id, { edit: 1 });
    const emitted: unknown[] = [];
    const feature = createJobsFeature({ subagentRecords: () => [], outcomeRecords: () => [] });
    const ctx = fakeCtx(db, dir, emitted);
    await feature.onTick?.(ctx);
    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(1);
    const msg = emitted[0] as JobsMessage;
    expect(msg.kind).toBe("jobs");
    expect(msg.byAgent[id]).toEqual({ job: "builder", reason: "Edit/Write x1" });
    expect(msg.counts.subagents).toEqual({ lawyer: 0, hacker: 0, learner: 0, builder: 0, gatherer: 0, none: 0 });
    edge(db, id, "mcp:legal-data-hunter", "uses");
    await feature.onTick?.(ctx);
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as JobsMessage).byAgent[id]?.job).toBe("lawyer");
    const extras = feature.snapshotExtras?.(ctx) ?? {};
    expect(Object.keys(extras)).toEqual(["jobs.counts"]); // one row per session: not in /api/world
    const route = feature.routes?.find((r) => r.path === JOBS_BY_AGENT_PATH);
    let body = "";
    const res = { writeHead: () => res, end: (d: Buffer) => (body = d.toString()) } as unknown as ServerResponse;
    await route?.handler({} as IncomingMessage, res, ctx, {});
    expect((JSON.parse(body) as JobsByAgentResponse).byAgent[id]?.job).toBe("lawyer");
  });

  it("a candidate whose transcript is gone keeps the verdict its record supports, and is not re-listed every tick", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    let listings = 0;
    const subs = [subagent({ id: "apruned00001", toolCounts: { Skill: 2, Read: 3 } })];
    const feature = createJobsFeature({
      subagentRecords: () => subs,
      outcomeRecords: () => [],
      subagentFiles: async () => {
        listings += 1;
        return [];
      },
    });
    const ctx = fakeCtx(db, dir, []);
    await feature.onTick?.(ctx);
    await feature.onTick?.(ctx);
    expect(listings).toBe(1);
    expect(get(feature, ctx, "/api/jobs/:id", { id: "apruned00001" }).body).toMatchObject({ job: "gatherer", reason: "Read x3; no writes" });
  });
});
