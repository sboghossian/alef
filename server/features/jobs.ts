// "jobs": every minion has a job (learner, gatherer, builder, hacker, lawyer) or "no job evidence",
// with the signal behind it. The classifier and its precedence live in shared/features/jobs.ts;
// this module only gathers each minion's signals from what the server already holds in memory:
//
//   sessions   the index's row (cwd, first prompt, cnt_edit, cnt_research), its uses edges (skill:*,
//              mcp:* with call counts) and touched file edges, and the outcomes feature's record
//              (memory / lessons.md files it WROTE, landed git pushes)
//   subagents  latestSubagentRecords(): toolCounts, agentType, description, files, and the parent
//              session's cwd
//
// Two facts are not in those records, so they are proven from the transcript itself, for
// candidates only: which files a subagent WROTE (its `files` list mixes reads and writes), and
// which skills it ran (toolCounts only says "Skill x3"). Candidates: a subagent that wrote and
// touched a memory / lessons.md / SKILL.md / CASES.md file, or called Skill; a session that edited
// and touched a SKILL.md / CASES.md (outcomes already proves its memory and lessons writes). Proof
// reads are incremental (byte offsets in memory), newest minion first, and capped per tick; until a
// candidate is fully read its job is computed from the rest (the job can move up, e.g. builder →
// learner, never to a guess).
//
// Deterministic, no model call, no network, no file written. Transcript text is untrusted: only
// tool names and file_path / skill fields are matched, nothing is executed or logged.

import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  countJobs,
  isSkillOrCasesFile,
  jobOf,
  JOBS_BY_AGENT_PATH,
  JOBS_COUNTS_KEY,
  type JobEntry,
  type JobsByAgent,
  type JobsByAgentResponse,
  type JobsCounts,
  type JobSignals,
  type JobsMessage,
  type JobsResponse,
  type JobVerdict,
} from "../../shared/features/jobs.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import type { EdgeRow, SessionRow } from "../db.js";
import { respondJson } from "../http.js";
import { parseLine } from "../jsonl-events.js";
import { latestOutcomeRecords, readLineRange, type RangeRead } from "./outcomes.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { isLearningPath } from "./shelf-lib.js";
import { latestSubagentRecords } from "./subagents/index.js";
import { listSubagentFiles } from "./subagents/scan.js";

const TICK_MS = 30_000;
/** Transcript bytes read per tick for proofs (the 90 candidate transcripts were 238 MB on 2026-09-28). */
export const MAX_PROOF_BYTES_PER_TICK = 32 * 1024 * 1024;
const MAX_LEARNED = 20;
const MAX_SKILLS = 30;
const MAX_SKILL_NAME = 100;

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;
const WRITE_SET: ReadonlySet<string> = new Set(WRITE_TOOLS);
const GATHER_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as const;
/** A line worth parsing for a proof: a tool call to Skill or a write tool. */
const PROOF_NEEDLES = ['"Skill"', '"Edit"', '"Write"', '"MultiEdit"', '"NotebookEdit"'] as const;
/** The slash command a prompt opens with: Claude Code's <command-name>/x</command-name>, or a bare "/x …". */
const COMMAND_TAG = /^\s*(?:<command-message>[^<]{0,200}<\/command-message>\s*)?<command-name>\/([A-Za-z0-9][A-Za-z0-9:._-]{0,80})<\/command-name>/;
const LEADING_SLASH = /^\s*\/([a-z][a-z0-9:_-]{0,80})(?=\s|$)/;

/** memory/, lessons.md (shelf-lib's rule), SKILL.md or CASES.md. */
export function isLearningFile(abs: string): boolean {
  return isLearningPath(abs) || isSkillOrCasesFile(abs);
}

/** The slash command a session's first prompt runs ("upskill"), or null. */
export function slashCommandOf(title: string): string | null {
  return COMMAND_TAG.exec(title)?.[1] ?? LEADING_SLASH.exec(title)?.[1] ?? null;
}

function bump(rec: Record<string, number>, key: string, n = 1): void {
  rec[key] = (rec[key] ?? 0) + n;
}

function pick(counts: Readonly<Record<string, number>>, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of names) {
    const n = counts[k];
    if (typeof n === "number" && n > 0) out[k] = n;
  }
  return out;
}

/** What a transcript proves: learning files it wrote, skills it ran. */
export interface Proof {
  learned: readonly string[];
  skills: Readonly<Record<string, number>>;
}

export function sessionSignals(row: SessionRow, edges: readonly EdgeRow[], outcome: OutcomeRecord | null, proof: Proof | null): JobSignals {
  const mcp: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const touched: Record<string, number> = {};
  for (const e of edges) {
    if (e.kind === "uses" && e.to.startsWith("mcp:")) bump(mcp, e.to.slice(4), Math.max(1, e.weight));
    else if (e.kind === "uses" && e.to.startsWith("skill:")) bump(skills, e.to.slice(6), Math.max(1, e.weight));
    else if (e.kind === "touched" && e.to.startsWith("file:")) bump(touched, e.to.slice(5), Math.max(1, e.weight));
  }
  const filesTouched = Object.keys(touched).length;
  const slash = slashCommandOf(row.title);
  if (slash) bump(skills, slash);
  const gathers: Record<string, number> = {};
  if (row.cntResearch > 0) gathers["WebFetch/WebSearch/Grep"] = row.cntResearch;
  // With no edits, every touched file came from Read / Glob / Grep.
  if (row.cntEdit === 0 && filesTouched > 0) gathers["files read/searched"] = filesTouched;
  return {
    mcp,
    skills,
    cwd: row.cwd,
    touched,
    agentType: null,
    description: null,
    learned: [...(outcome?.learnings ?? []), ...(proof?.learned ?? [])],
    writes: row.cntEdit > 0 ? { "Edit/Write": row.cntEdit } : {},
    ships: (outcome?.pushes ?? []).map((repo) => `push to ${repo}`),
    gathers,
  };
}

export function subagentSignals(r: SubagentRecord, parentCwd: string | null, proof: Proof | null): JobSignals {
  const mcp: Record<string, number> = {};
  for (const [name, n] of Object.entries(r.toolCounts)) {
    if (!name.startsWith("mcp__")) continue;
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    const server = i === -1 ? rest : rest.slice(0, i);
    if (server) bump(mcp, server, n);
  }
  return {
    mcp,
    skills: proof?.skills ?? {},
    cwd: parentCwd,
    touched: Object.fromEntries(r.files.map((f) => [f.path, f.count])),
    agentType: r.agentType,
    description: r.description,
    learned: proof?.learned ?? [],
    writes: pick(r.toolCounts, WRITE_TOOLS),
    ships: [],
    gathers: pick(r.toolCounts, GATHER_TOOLS),
  };
}

export function subagentNeedsProof(r: SubagentRecord): boolean {
  if ((r.toolCounts.Skill ?? 0) > 0) return true;
  const writes = WRITE_TOOLS.reduce((n, t) => n + (r.toolCounts[t] ?? 0), 0);
  return writes > 0 && r.files.some((f) => isLearningFile(f.path));
}

export function sessionNeedsProof(row: SessionRow, edges: readonly EdgeRow[]): boolean {
  return row.cntEdit > 0 && edges.some((e) => e.kind === "touched" && e.to.startsWith("file:") && isSkillOrCasesFile(e.to.slice(5)));
}

/** Incremental proof over one transcript (in memory only; a restart reads it again). */
export interface ProofState {
  path: string;
  offset: number;
  skipping: boolean;
  /** Read to the end of the file as it was last seen. */
  complete: boolean;
  learned: Set<string>;
  skills: Map<string, number>;
}

export function newProof(path: string): ProofState {
  return { path, offset: 0, skipping: false, complete: false, learned: new Set(), skills: new Map() };
}

/** Folds one transcript line into a proof: learning files written, skills run. */
export function foldProofLine(p: ProofState, raw: string): void {
  if (!raw.includes('"tool_use"') || !PROOF_NEEDLES.some((n) => raw.includes(n))) return;
  const line = parseLine(raw);
  if (!line) return;
  for (const use of line.toolUses) {
    if (use.name === "Skill") {
      const s = use.input.skill;
      if (typeof s !== "string" || s.length === 0 || s.length > MAX_SKILL_NAME) continue;
      if (p.skills.has(s) || p.skills.size < MAX_SKILLS) p.skills.set(s, (p.skills.get(s) ?? 0) + 1);
    } else if (WRITE_SET.has(use.name)) {
      const f = typeof use.input.file_path === "string" ? use.input.file_path : typeof use.input.notebook_path === "string" ? use.input.notebook_path : null;
      const abs = f ? (isAbsolute(f) ? resolve(f) : line.cwd ? resolve(line.cwd, f) : null) : null;
      if (abs && isLearningFile(abs) && p.learned.size < MAX_LEARNED) p.learned.add(abs);
    }
  }
}

function proofOf(p: ProofState | undefined): Proof | null {
  return p ? { learned: [...p.learned], skills: Object.fromEntries(p.skills) } : null;
}

/** Reads what is new in `p.path`, at most `budget` bytes. Returns the bytes read. */
async function advanceProof(p: ProofState, budget: number): Promise<number> {
  let size: number;
  try {
    size = (await stat(p.path)).size;
  } catch {
    p.complete = true; // pruned: keep what was proven
    return 0;
  }
  if (size < p.offset) Object.assign(p, newProof(p.path)); // rewritten: start over
  if (p.offset >= size) {
    p.complete = true;
    return 0;
  }
  const start = p.offset;
  let r: RangeRead;
  try {
    r = await readLineRange(p.path, start, Math.min(size, start + budget), p.skipping, (raw) => foldProofLine(p, raw));
  } catch {
    return 0; // unreadable right now: tried again next tick
  }
  p.offset = r.consumed;
  p.skipping = r.skipping;
  if (r.skipping) p.offset = r.readTo;
  else if (r.consumed === start && r.readTo - start >= budget) {
    p.offset = r.readTo; // one line longer than a whole budget: skipped, never parsed
    p.skipping = true;
  }
  p.complete = p.offset >= size;
  return r.readTo - start;
}

/** The running feature's last computed counts (the vision ledger's jobs probe), or null before the
 *  first compute. */
let latestCounts: { at: string; counts: JobsCounts } | null = null;
export function latestJobsCounts(): { at: string; counts: JobsCounts } | null {
  return latestCounts;
}

export interface JobsFeatureOptions {
  subagentRecords?: () => readonly SubagentRecord[] | null;
  outcomeRecords?: () => readonly OutcomeRecord[];
  /** agentId → transcript path, for subagent proofs. */
  subagentFiles?: (projectsDir: string) => Promise<ReadonlyArray<{ agentId: string; path: string }>>;
  maxProofBytesPerTick?: number;
  now?: () => number;
}

interface Computed {
  at: string;
  sessions: Map<string, JobVerdict>;
  subagents: Map<string, JobVerdict>;
  counts: JobsCounts;
  byAgent: JobsByAgent;
}

export function createJobsFeature(opts: JobsFeatureOptions = {}): ServerFeature {
  const getSubagents = opts.subagentRecords ?? latestSubagentRecords;
  const getOutcomes = opts.outcomeRecords ?? latestOutcomeRecords;
  const listFiles = opts.subagentFiles ?? (async (dir: string) => (await listSubagentFiles(dir)).map((f) => ({ agentId: f.agentId, path: f.path })));
  const maxBytes = opts.maxProofBytesPerTick ?? MAX_PROOF_BYTES_PER_TICK;
  const now = opts.now ?? Date.now;

  let computed: Computed | null = null;
  let sentJson = "";
  const proofs = new Map<string, ProofState>(); // minion id → proof
  let subagentPaths = new Map<string, string>();
  /** Candidates whose transcript a listing did not find (pruned): never a reason to list again. */
  const notOnDisk = new Set<string>();
  let candidates = 0;
  let bytesLastTick = 0;

  function compute(ctx: FeatureContext): Computed {
    const rows = ctx.db.listSessions();
    const edgesBy = new Map<string, EdgeRow[]>();
    for (const e of ctx.db.listEdges()) {
      const list = edgesBy.get(e.from);
      if (list) list.push(e);
      else edgesBy.set(e.from, [e]);
    }
    const outcomes = new Map(getOutcomes().map((o) => [o.sessionId, o]));
    const sessions = new Map<string, JobVerdict>();
    const cwdOf = new Map<string, string>();
    for (const row of rows) {
      cwdOf.set(row.id, row.cwd);
      sessions.set(row.id, jobOf(sessionSignals(row, edgesBy.get(row.id) ?? [], outcomes.get(row.id) ?? null, proofOf(proofs.get(row.id)))));
    }
    const subs = getSubagents();
    const subagents = new Map<string, JobVerdict>();
    for (const r of subs ?? []) subagents.set(r.id, jobOf(subagentSignals(r, cwdOf.get(r.parentSessionId) ?? null, proofOf(proofs.get(r.id)))));
    const byAgent: JobsByAgent = {};
    for (const [id, v] of sessions) byAgent[id] = v;
    return {
      at: new Date(now()).toISOString(),
      sessions,
      subagents,
      counts: { sessions: countJobs(sessions.values()), subagents: subs ? countJobs(subagents.values()) : null },
      byAgent,
    };
  }

  function ensure(ctx: FeatureContext): Computed {
    computed ??= compute(ctx);
    return computed;
  }

  /** Candidates newest first, each with its transcript path (null when not found). */
  async function proofWork(ctx: FeatureContext): Promise<ProofState[]> {
    const rows = ctx.db.listSessions();
    const edgesBy = new Map<string, EdgeRow[]>();
    for (const e of ctx.db.listEdges()) {
      if (e.kind !== "touched") continue;
      const list = edgesBy.get(e.from);
      if (list) list.push(e);
      else edgesBy.set(e.from, [e]);
    }
    const want: Array<{ id: string; at: string; path: () => string | null }> = [];
    const sessionPaths = new Map<string, string>();
    for (const f of ctx.db.listFileOffsets()) sessionPaths.set(basename(f.path, ".jsonl"), f.path);
    for (const row of rows) {
      if (sessionNeedsProof(row, edgesBy.get(row.id) ?? [])) want.push({ id: row.id, at: row.lastActive, path: () => sessionPaths.get(row.id) ?? null });
    }
    const subs = (getSubagents() ?? []).filter(subagentNeedsProof);
    const unknown = subs.filter((r) => !subagentPaths.has(r.id) && !notOnDisk.has(r.id));
    if (unknown.length) {
      try {
        subagentPaths = new Map((await listFiles(ctx.config.projectsDir)).map((f) => [f.agentId, f.path]));
        for (const r of unknown) if (!subagentPaths.has(r.id)) notOnDisk.add(r.id);
      } catch (err) {
        ctx.log.warn("jobs", "listing subagent transcripts failed", String(err));
      }
    }
    for (const r of subs) want.push({ id: r.id, at: r.lastActive, path: () => subagentPaths.get(r.id) ?? null });
    candidates = want.length;
    want.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const out: ProofState[] = [];
    for (const w of want) {
      const path = w.path();
      if (!path) continue; // transcript pruned: no proof, the job comes from the record alone
      let p = proofs.get(w.id);
      if (!p || p.path !== path) {
        p = newProof(path);
        proofs.set(w.id, p);
      }
      out.push(p);
    }
    return out;
  }

  function publish(ctx: FeatureContext, next: Computed): void {
    computed = next;
    latestCounts = { at: next.at, counts: next.counts };
    const msg: JobsMessage = { kind: "jobs", counts: next.counts, byAgent: next.byAgent };
    const json = JSON.stringify(msg);
    if (json === sentJson) return;
    sentJson = json;
    ctx.emit(msg);
  }

  function entries(m: Map<string, JobVerdict>, kind: JobEntry["kind"]): JobEntry[] {
    return [...m].map(([id, v]) => ({ id, kind, job: v.job, reason: v.reason }));
  }

  return {
    id: "jobs",
    tickIntervalMs: TICK_MS,
    routes: [
      {
        method: "GET",
        path: "/api/jobs",
        handler(_req, res, ctx) {
          const c = ensure(ctx);
          const pending = [...proofs.values()].filter((p) => !p.complete).length;
          const body: JobsResponse = {
            ok: true,
            computedAt: c.at,
            counts: c.counts,
            sessions: entries(c.sessions, "session"),
            subagents: entries(c.subagents, "subagent"),
            proofs: { candidates, pending, bytesLastTick },
          };
          respondJson(res, 200, body);
        },
      },
      {
        // Before /api/jobs/:id, which would otherwise take "by-agent" for an id.
        method: "GET",
        path: JOBS_BY_AGENT_PATH,
        handler(_req, res, ctx) {
          respondJson(res, 200, { ok: true, byAgent: ensure(ctx).byAgent } satisfies JobsByAgentResponse);
        },
      },
      {
        method: "GET",
        path: "/api/jobs/:id",
        handler(_req, res, ctx, params) {
          const c = ensure(ctx);
          const id = params.id ?? "";
          const s = c.sessions.get(id);
          const v = s ?? c.subagents.get(id);
          if (!v) {
            respondJson(res, 404, { ok: false, error: "no such session or subagent" });
            return;
          }
          const body: JobEntry = { id, kind: s ? "session" : "subagent", job: v.job, reason: v.reason };
          respondJson(res, 200, body);
        },
      },
    ],
    async onTick(ctx) {
      let budget = maxBytes;
      for (const p of await proofWork(ctx)) {
        if (budget <= 0) break;
        budget -= await advanceProof(p, budget);
      }
      bytesLastTick = maxBytes - Math.max(0, budget);
      publish(ctx, compute(ctx));
    },
    snapshotExtras(ctx) {
      const c = ensure(ctx);
      return { [JOBS_COUNTS_KEY]: c.counts };
    },
  };
}

export const jobsFeature: ServerFeature = createJobsFeature();
