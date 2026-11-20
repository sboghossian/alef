// Wire types and the pure classifier for the "jobs" feature: every minion (a session or one of its
// subagents) gets ONE job, with the named signal behind it, or "no job evidence". Deterministic,
// no model call. Shown next to the role (server/heuristics.ts deriveRole), never instead of it.
//
// Precedence, highest first (the first job with evidence wins, documented and tested):
//   lawyer    used an MCP server named legal-* (mcp__legal-data-hunter__search, …), ran a legal skill
//             (route-contract-*, route-legal-*, divorce-*, *-agreement-drafting, law-as-code-audit,
//             irac-prompt, oral-argument, lexwiki-learn), or works under legal-taxonomy / eulex-bench
//             (its cwd, or files it touched there: a subagent has no cwd of its own, and a home-dir
//             session's cwd says nothing about where it worked)
//   hacker    an adversarial reviewer: agent type code-reviewer or *grok-reviewer, a task description
//             that starts with "review" / "audit" or mentions security, adversarial or red team, or
//             ran the skill cso / security-review / code-review / review. Two of these signals
//             measured weak (2026-09-28, every description-only hacker verdict read against its
//             prompt: "audit…" 21 of 37 were fault-finding, "security" 0 of 3), so a reason that
//             rests on them carries 🧪 ("review…" was 13 of 13)
//   learner   WROTE (Edit / Write / MultiEdit / NotebookEdit) a memory file, a lessons.md, a SKILL.md
//             or a CASES.md, or ran /upskill, /learn or /skillify. Reading lessons does not count.
//   builder   at least one Edit / Write / MultiEdit / NotebookEdit, or a landed git push or a PR
//   gatherer  tool calls and no writes: Read, Grep, Glob, WebSearch, WebFetch, exa, firecrawl, or an
//             Explore agent
//   null      "no job evidence" (only Bash, only other MCP tools, or only talk): never guessed
//
//   GET /api/jobs                    → JobsResponse (every session and subagent, plus counts)
//   GET /api/jobs/by-agent           → JobsByAgentResponse (sessions only: subagents are fetched per panel;
//                                      not in the snapshot: one row per session made it hundreds of KB)
//   GET /api/jobs/:id                → JobEntry (a session id or a subagent id; 404 when unknown)
//   WS  { feature: "jobs", payload: JobsMessage }   counts + byAgent, when either changed
//   snapshot extras "jobs.counts"    → JobsCounts
//
// A reason names the signal and never quotes a task description (untrusted text); clients still
// render reasons with textContent only.

export const JOBS = ["lawyer", "hacker", "learner", "builder", "gatherer"] as const;
export type Job = (typeof JOBS)[number];
export const NO_JOB_EVIDENCE = "no job evidence";

export const JOBS_COUNTS_KEY = "jobs.counts";
export const JOBS_BY_AGENT_PATH = "/api/jobs/by-agent";

/** What a minion's own records say it did. Every field is a real, named signal. */
export interface JobSignals {
  /** MCP server → calls (mcp__<server>__<tool>). */
  mcp: Readonly<Record<string, number>>;
  /** Skill → invocations (the Skill tool, or the slash command a session's prompt starts with). */
  skills: Readonly<Record<string, number>>;
  /** Where it worked (for a subagent, its parent session's folder). */
  cwd: string | null;
  /** Files it touched (read or wrote) → tool calls; only used for where it worked. */
  touched: Readonly<Record<string, number>>;
  /** Subagents only: "general-purpose", "code-reviewer", "Explore", … */
  agentType: string | null;
  /** Subagents only: the task description its parent gave it. Untrusted; only matched, never quoted. */
  description: string | null;
  /** Files it WROTE that are memory, lessons.md, SKILL.md or CASES.md (absolute paths). */
  learned: readonly string[];
  /** Write-tool calls by tool (Edit, Write, …), or by "Edit/Write" when only the total is known. */
  writes: Readonly<Record<string, number>>;
  /** Landed git pushes and PRs it made, as display strings ("PR owner/repo#12", "push to owner/repo"). */
  ships: readonly string[];
  /** Read-only information calls by tool or tool group (Read, Grep, "WebFetch/WebSearch/Grep", …). */
  gathers: Readonly<Record<string, number>>;
}

export interface JobVerdict {
  job: Job | null;
  /** One line naming the signal: "used legal-data-hunter x12", or "no job evidence". */
  reason: string;
}

export type JobCounts = Record<Job | "none", number>;

export interface JobsCounts {
  sessions: JobCounts;
  /** null until the subagents feature has published its first records after boot. */
  subagents: JobCounts | null;
}

export interface JobEntry extends JobVerdict {
  id: string;
  kind: "session" | "subagent";
}

/** Session id → its verdict. */
export type JobsByAgent = Record<string, JobVerdict>;

export interface JobsResponse {
  ok: true;
  /** ISO time of the tick that computed these; null before the first tick. */
  computedAt: string | null;
  counts: JobsCounts | null;
  sessions: JobEntry[];
  subagents: JobEntry[];
  /** Transcripts read to prove a learner write or a skill name (candidates only). */
  proofs: { candidates: number; pending: number; bytesLastTick: number };
}

export type JobsMessage = { kind: "jobs"; counts: JobsCounts; byAgent: JobsByAgent };

export interface JobsByAgentResponse {
  ok: true;
  byAgent: JobsByAgent;
}

// ── the rules ─────────────────────────────────────────────────────────────

const LEGAL_MCP = /^legal[-_]/i;
const LEGAL_SKILL = /^(?:route-contract-.+|route-legal-.+|divorce-.+|.+-agreement-drafting|law-as-code-audit|irac-prompt|oral-argument|lexwiki-learn)$/;
/** legal-taxonomy / eulex-bench, also the ~/.eulex-bench data folder. */
const LEGAL_PLACE = /(?:^|\/)\.?(legal-taxonomy|eulex-bench)(?:\/|$)/;
const HACKER_SKILLS: ReadonlySet<string> = new Set(["cso", "security-review", "code-review", "review"]);
const HACKER_STARTS = ["review", "audit"] as const;
const HACKER_WORDS = ["security", "adversarial", "red team", "red-team"] as const;
/** Measured below 80% precision (see the header): shown, but marked unvalidated. */
const WEAK_HACKER_WORDS: ReadonlySet<string> = new Set(["audit", "security"]);
export const UNVALIDATED_MARK = "🧪";
const LEARNER_SKILLS: ReadonlySet<string> = new Set(["upskill", "learn", "skillify"]);
const GATHER_MCP = /^(?:exa|firecrawl)/i;
const GATHER_SKILL = /^firecrawl(?:-|$)/;
const MAX_PARTS = 3;

/** A skill's own name: plugin prefix dropped ("anthropic-skills:docx" → "docx"), lowercased. */
export function bareSkill(name: string): string {
  const i = name.lastIndexOf(":");
  return (i === -1 ? name : name.slice(i + 1)).toLowerCase();
}

/** SKILL.md or CASES.md, any folder (the memory and lessons.md rule is shelf-lib's isLearningPath). */
export function isSkillOrCasesFile(abs: string): boolean {
  return /(?:^|\/)(?:SKILL|CASES)\.md$/.test(abs);
}

function byCountThenName(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/** Positive counts, most first, then by name (so the reason is deterministic). */
function ranked(rec: Readonly<Record<string, number>>, keep: (k: string) => boolean = () => true): Array<[string, number]> {
  return Object.entries(rec)
    .filter(([k, n]) => n > 0 && keep(k))
    .sort(byCountThenName);
}

function counted(list: ReadonlyArray<[string, number]>, prefix = ""): string {
  return list
    .slice(0, MAX_PARTS)
    .map(([k, n]) => `${prefix}${k} x${n}`)
    .join(", ");
}

/** The last two segments of a path: "memory/feedback_x.md", "cli-forge/SKILL.md". */
export function shortPath(abs: string): string {
  return abs.split("/").filter(Boolean).slice(-2).join("/");
}

function lawyer(s: JobSignals): string[] {
  const out: string[] = [];
  const mcp = ranked(s.mcp, (k) => LEGAL_MCP.test(k));
  if (mcp.length) out.push(`used ${counted(mcp)}`);
  const skills = ranked(s.skills, (k) => LEGAL_SKILL.test(bareSkill(k)));
  if (skills.length) out.push(`ran ${counted(skills, "/")}`);
  const m = s.cwd ? LEGAL_PLACE.exec(s.cwd) : null;
  if (m?.[1]) out.push(`works in ${m[1]}`);
  else {
    const places: Record<string, number> = {};
    for (const [path, n] of Object.entries(s.touched)) {
      const place = LEGAL_PLACE.exec(path)?.[1];
      if (place && n > 0) places[place] = (places[place] ?? 0) + n;
    }
    const top = ranked(places)[0];
    if (top) out.push(`touched ${top[0]} files x${top[1]}`);
  }
  return out;
}

function hacker(s: JobSignals): string[] {
  const out: string[] = [];
  const type = s.agentType ?? "";
  if (type === "code-reviewer" || type.endsWith("grok-reviewer")) out.push(`agent type ${type}`);
  const d = (s.description ?? "").trim().toLowerCase();
  const weak = (w: string): string => (WEAK_HACKER_WORDS.has(w) ? ` ${UNVALIDATED_MARK}` : "");
  const start = HACKER_STARTS.find((w) => d.startsWith(w));
  if (start) out.push(`task starts with "${start}"${weak(start)}`);
  const word = HACKER_WORDS.find((w) => d.includes(w));
  if (word) out.push(`task mentions "${word}"${weak(word)}`);
  const skills = ranked(s.skills, (k) => HACKER_SKILLS.has(bareSkill(k)));
  if (skills.length) out.push(`ran ${counted(skills, "/")}`);
  return out;
}

function learner(s: JobSignals): string[] {
  const out: string[] = [];
  const files = [...new Set(s.learned)].sort();
  if (files[0]) out.push(`wrote ${shortPath(files[0])}${files.length > 1 ? ` +${files.length - 1} more` : ""}`);
  const skills = ranked(s.skills, (k) => LEARNER_SKILLS.has(bareSkill(k)));
  if (skills.length) out.push(`ran ${counted(skills, "/")}`);
  return out;
}

function builder(s: JobSignals): string[] {
  const out: string[] = [];
  const writes = ranked(s.writes);
  if (writes.length) out.push(counted(writes));
  if (s.ships.length) out.push([...s.ships].slice(0, 2).join(", ") + (s.ships.length > 2 ? ` +${s.ships.length - 2} more` : ""));
  return out;
}

function gatherer(s: JobSignals): string[] {
  const calls: Array<[string, number]> = [...ranked(s.gathers), ...ranked(s.mcp, (k) => GATHER_MCP.test(k)), ...ranked(s.skills, (k) => GATHER_SKILL.test(bareSkill(k)))];
  const out: string[] = [];
  if (calls.length) out.push(counted(calls.sort(byCountThenName)));
  if (s.agentType === "Explore") out.push("Explore agent");
  if (out.length) out.push("no writes");
  return out;
}

const RULES: ReadonlyArray<[Job, (s: JobSignals) => string[]]> = [
  ["lawyer", lawyer],
  ["hacker", hacker],
  ["learner", learner],
  ["builder", builder],
  ["gatherer", gatherer],
];

/** The minion's job and the signal behind it. Pure and deterministic: same signals, same verdict. */
export function jobOf(s: JobSignals): JobVerdict {
  for (const [job, rule] of RULES) {
    const parts = rule(s);
    if (parts.length) return { job, reason: parts.join("; ") };
  }
  return { job: null, reason: NO_JOB_EVIDENCE };
}

export function emptyJobCounts(): JobCounts {
  return { lawyer: 0, hacker: 0, learner: 0, builder: 0, gatherer: 0, none: 0 };
}

export function countJobs(verdicts: Iterable<JobVerdict>): JobCounts {
  const c = emptyJobCounts();
  for (const v of verdicts) c[v.job ?? "none"] += 1;
  return c;
}

// ── parsing off the wire (the client trusts nothing it parses) ────────────

const MAX_REASON = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isJob(v: unknown): v is Job {
  return typeof v === "string" && (JOBS as readonly string[]).includes(v);
}

export function parseJobVerdict(v: unknown): JobVerdict | null {
  if (!isRecord(v) || typeof v.reason !== "string") return null;
  if (v.job !== null && !isJob(v.job)) return null;
  return { job: v.job, reason: v.reason.slice(0, MAX_REASON) };
}

export function parseJobEntry(v: unknown): JobEntry | null {
  const verdict = parseJobVerdict(v);
  if (!verdict || !isRecord(v) || typeof v.id !== "string" || (v.kind !== "session" && v.kind !== "subagent")) return null;
  return { id: v.id, kind: v.kind, ...verdict };
}

export function parseJobsByAgent(v: unknown): JobsByAgent {
  if (!isRecord(v)) return {};
  const out: JobsByAgent = {};
  for (const [id, raw] of Object.entries(v)) {
    const verdict = parseJobVerdict(raw);
    if (verdict && id.length > 0 && id.length <= 64 && id !== "__proto__") out[id] = verdict;
  }
  return out;
}

function parseCounts(v: unknown): JobCounts | null {
  if (!isRecord(v)) return null;
  const c = emptyJobCounts();
  for (const k of [...JOBS, "none"] as const) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    c[k] = n;
  }
  return c;
}

export function parseJobsCounts(v: unknown): JobsCounts | null {
  if (!isRecord(v)) return null;
  const sessions = parseCounts(v.sessions);
  if (!sessions) return null;
  return { sessions, subagents: v.subagents === null ? null : parseCounts(v.subagents) };
}

export function parseJobsMessage(v: unknown): JobsMessage | null {
  if (!isRecord(v) || v.kind !== "jobs") return null;
  const counts = parseJobsCounts(v.counts);
  return counts ? { kind: "jobs", counts, byAgent: parseJobsByAgent(v.byAgent) } : null;
}
