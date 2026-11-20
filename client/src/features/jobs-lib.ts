// Pure helpers for the "jobs" client feature (jobs.ts): the client's copy of each minion's job and
// the text a chip shows. No DOM here, so it is unit-tested directly.

import { NO_JOB_EVIDENCE, parseJobEntry, type Job, type JobsByAgent, type JobVerdict } from "../../../shared/features/jobs";

/** How long a verdict fetched one by one (a subagent, or a session newer than the last push) is reused. */
export const FETCHED_TTL_MS = 60_000;

/** The rule behind each job, for the chip's tooltip (shared/features/jobs.ts has the precedence). */
export const JOB_RULES: Record<Job, string> = {
  lawyer: "Lawyer: used a legal-* MCP server, ran a legal skill, or worked in legal-taxonomy / eulex-bench.",
  hacker: "Hacker: an adversarial reviewer (code-reviewer or grok-reviewer agent, a review / audit / security / red-team task, or a review skill).",
  learner: "Learner: wrote a memory file, a lessons.md, a SKILL.md or a CASES.md, or ran /upskill, /learn or /skillify.",
  builder: "Builder: made at least one Edit / Write, or a landed git push.",
  gatherer: "Gatherer: read and searched (Read, Grep, Glob, web, exa, firecrawl, Explore) and wrote nothing.",
};
const PRECEDENCE = "When several fit: lawyer > hacker > learner > builder > gatherer. Computed from the minion's own records, no model.";
const NOT_KNOWN = "job not computed yet";

export interface ChipView {
  /** CSS modifier: the job, "none" (no evidence) or "unknown" (not computed / unreachable). */
  kind: Job | "none" | "unknown";
  label: string;
  /** The signal behind it; empty when there is none to show. */
  reason: string;
  title: string;
}

/** What the chip shows for a verdict; null = the server has no verdict for this id (yet). */
export function chipView(v: JobVerdict | null): ChipView {
  if (!v) return { kind: "unknown", label: NOT_KNOWN, reason: "", title: "The server has not computed a job for this minion yet (it recomputes every 30 s)." };
  if (!v.job) return { kind: "none", label: NO_JOB_EVIDENCE, reason: "", title: `No named signal for any job: a job is never guessed. ${PRECEDENCE}` };
  return { kind: v.job, label: v.job, reason: v.reason, title: `${JOB_RULES[v.job]}\n${PRECEDENCE}` };
}

/** A fetched /api/jobs/:id body → verdict, or null for anything malformed (or a 404, which getJson turns into null). */
export function verdictFromEntry(body: unknown): JobVerdict | null {
  const e = parseJobEntry(body);
  return e ? { job: e.job, reason: e.reason } : null;
}

/** Sessions come whole from the snapshot / WS push (authoritative); anything else is fetched by id and reused for a minute. */
export class JobCache {
  private sessions: JobsByAgent = {};
  private readonly fetched = new Map<string, { v: JobVerdict; at: number }>();

  setSessions(byAgent: JobsByAgent): void {
    this.sessions = byAgent;
  }

  put(id: string, v: JobVerdict, nowMs: number): void {
    this.fetched.set(id, { v, at: nowMs });
  }

  /** undefined = not known here: fetch it. */
  get(id: string, nowMs: number): JobVerdict | undefined {
    if (Object.hasOwn(this.sessions, id)) return this.sessions[id];
    const f = this.fetched.get(id);
    if (f && nowMs - f.at < FETCHED_TTL_MS) return f.v;
    return undefined;
  }
}
