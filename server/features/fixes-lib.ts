// Pure half of the Fix queue (server/features/fixes.ts): turns what other features already
// computed into one ranked list of rows. No I/O and no clock of its own: every input, the time
// included, is passed in, so a test can build any queue from plain objects.

import { CHECK_META, type CheckDismissal, type CompletenessCheck } from "../../shared/features/completeness.js";
import {
  ABANDONED_WINDOW_DAYS,
  draftFixPrompt,
  emptyFixCounts,
  FIX_SEVERITY_ORDER,
  FIX_SOURCE_CAP,
  FIX_SOURCES,
  healthFixPrompt,
  loopFixPrompt,
  LOOPS_STALE_DAYS,
  sessionFixPrompt,
  vaultGhostFixPrompt,
  vaultProjectFixPrompt,
  type FixCounts,
  type FixLaunch,
  type FixRow,
  type FixSeverity,
  type FixSource,
} from "../../shared/features/fixes.js";
import type { LoopsBoard } from "../../shared/features/loops.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import { STEERING_LABEL, type SicknessCase } from "../../shared/features/sickness.js";
import type { VaultGaps } from "../../shared/features/vault.js";
import { displayTitle } from "../../shared/display.js";
import type { StoredLaunch } from "./fixes-store.js";

const DAY_MS = 86_400_000;

export interface SessionInfo {
  title: string;
  cwd: string;
  islandId: string;
}

/** Everything the queue is built from. A source whose owner hasn't computed once is null. */
export interface FixInputs {
  nowMs: number;
  health: readonly CompletenessCheck[] | null;
  sickness: readonly SicknessCase[] | null;
  gaps: VaultGaps | null;
  loops: LoopsBoard | null;
  outcomes: readonly OutcomeRecord[] | null;
  vaultDir: string;
  /** Alef's own repo: where a Health fix runs. */
  alefDir: string;
  cityForCwd(cwd: string): string | null;
  session(id: string): SessionInfo | null;
  /** A non-health row's snooze / won't fix in force (data/fixes.json). */
  dismissal(id: string): CheckDismissal | null;
  launch(id: string): StoredLaunch | null;
  /** The session talk's binding adopted for a world tmux session, or null. */
  sessionForTmux(tmuxName: string): string | null;
}

export interface FixQueue {
  rows: FixRow[];
  open: FixCounts;
  pending: FixSource[];
  /** Launches whose session id was just learned from a binding: the caller persists them. */
  newlyBound: { id: string; sessionId: string }[];
}

type Draft = Omit<FixRow, "state" | "dismissed" | "launch"> & { dismissed?: CheckDismissal | null };

function healthRows(checks: readonly CompletenessCheck[], alefDir: string, city: string | null): Draft[] {
  return checks
    .filter((c) => c.state === "fail" || c.state === "warn")
    .map((c): Draft => ({
      id: `health:${c.id}`,
      source: "health",
      title: CHECK_META[c.id]?.problem ?? c.label, // what is wrong, never its passing label (FN-9)
      evidence: c.why ? `${c.detail} · ${c.why}` : c.detail,
      cityId: city,
      cwd: alefDir,
      severity: c.state === "fail" ? "high" : "medium",
      since: null,
      prompt: healthFixPrompt(c),
      loopId: null,
      dismissed: c.dismissed ?? null,
    }));
}

function sicknessTitle(c: SicknessCase): string {
  if (c.kind === "leaked-key") return `Leaked ${c.detail.provider ?? "API"} key (${c.detail.masked ?? "masked"})`;
  if (c.kind === "broken-build") return `Broken build: ${c.detail.cmdClass ?? c.source.target}`;
  return `Agent ${STEERING_LABEL}${c.detail.host ? ` (${c.detail.host})` : ""}`;
}

function sicknessRows(cases: readonly SicknessCase[], inp: FixInputs): Draft[] {
  return cases.map((c): Draft => {
    const s = inp.session(c.sessionId);
    const title = sicknessTitle(c);
    const evidence = `${c.label} · ${c.occurrences} occurrence${c.occurrences === 1 ? "" : "s"}, ${c.state}${c.district ? ` · ${c.district}` : ""}`;
    // The doctor invariant (client/src/features/sickness-lib.ts): never a key value, a hash or the case id.
    return {
      id: `sickness:${c.id}`,
      source: "sickness",
      title,
      evidence,
      cityId: s?.islandId ?? null,
      cwd: s?.cwd ?? null,
      severity: c.kind === "leaked-key" ? "high" : "medium",
      since: c.firstSeenAt,
      prompt: draftFixPrompt({ title, evidence: `${evidence} (session ${c.sessionId})`, where: s?.cwd ?? null }),
      loopId: null,
    };
  });
}

function vaultRows(g: VaultGaps, inp: FixInputs): Draft[] {
  const city = inp.cityForCwd(inp.vaultDir);
  const projects: Draft[] = g.missingProjects.map((slug) => ({
    id: `vault-project:${slug}`,
    source: "vault-project",
    title: `Project "${slug}" has no index note`,
    evidence: `notes are filed under "${slug}", but 20-Projects/${slug}/_index.md does not exist`,
    cityId: city,
    cwd: inp.vaultDir,
    severity: "low",
    since: null,
    prompt: vaultProjectFixPrompt(slug, inp.vaultDir),
    loopId: null,
  }));
  const ghosts: Draft[] = g.writeNext.map((x) => ({
    id: `vault-ghost:${x.key}`,
    source: "vault-ghost",
    title: `Write "${x.key}"`,
    evidence: `${x.n} ${x.n === 1 ? "note links" : "notes link"} to it, and it doesn't exist`,
    cityId: city,
    cwd: inp.vaultDir,
    severity: "low",
    since: null,
    prompt: vaultGhostFixPrompt(x.key, x.n, inp.vaultDir),
    loopId: null,
  }));
  return [...projects, ...ghosts];
}

function loopRows(board: LoopsBoard, inp: FixInputs): Draft[] {
  const cutoff = inp.nowMs - LOOPS_STALE_DAYS * DAY_MS;
  const out: Draft[] = [];
  for (const item of board.items) {
    if (item.lens === "waiting" || !item.updatedAt) continue;
    const at = Date.parse(item.updatedAt);
    if (!(at <= cutoff)) continue;
    const days = Math.floor((inp.nowMs - at) / DAY_MS);
    const tickable = item.sources.includes("scan") && item.openPath !== null;
    out.push({
      id: `loop:${item.id}`,
      source: "loop",
      title: item.task,
      evidence: `${item.project}: open in its ${item.sourceType === "todo_md" ? "tasks/todo.md" : item.sourceType}, not touched in ${days} days`,
      cityId: item.launchCwd ? inp.cityForCwd(item.launchCwd) : null,
      cwd: item.launchCwd,
      severity: item.lens === "do_today" ? "medium" : "low",
      since: item.updatedAt,
      prompt: loopFixPrompt({ task: item.task, project: item.project, days, cwd: item.launchCwd }),
      loopId: tickable ? item.id : null,
    });
  }
  return out;
}

function abandonedRows(records: readonly OutcomeRecord[], inp: FixInputs): Draft[] {
  const cutoff = inp.nowMs - ABANDONED_WINDOW_DAYS * DAY_MS;
  const out: Draft[] = [];
  for (const r of records) {
    if (r.outcome !== "abandoned" || !(Date.parse(r.lastActive) >= cutoff)) continue;
    const s = inp.session(r.sessionId);
    const title = s ? displayTitle(s.title) || "an untitled session" : "a session no longer indexed";
    out.push({
      id: `abandoned:${r.sessionId}`,
      source: "abandoned",
      title: `Abandoned: ${title}`,
      evidence: r.reason ?? "dormant 24h+ while its last turn waited on you",
      cityId: s?.islandId ?? null,
      cwd: s?.cwd ?? null,
      severity: "low",
      since: r.lastActive,
      prompt: sessionFixPrompt({ title, sessionId: r.sessionId, outcome: "abandoned", reason: r.reason, cwd: s?.cwd ?? null }),
      loopId: null,
    });
  }
  return out;
}

const SEVERITY_RANK: Record<FixSeverity, number> = Object.fromEntries(FIX_SEVERITY_ORDER.map((s, i) => [s, i])) as Record<FixSeverity, number>;

/** Set-aside rows last, then the worst first, then the newest. */
export function compareRows(a: FixRow, b: FixRow): number {
  const aside = Number(a.dismissed !== null) - Number(b.dismissed !== null);
  if (aside !== 0) return aside;
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  return (b.since ? Date.parse(b.since) : 0) - (a.since ? Date.parse(a.since) : 0) || a.id.localeCompare(b.id);
}

export function buildFixQueue(inp: FixInputs): FixQueue {
  const pending: FixSource[] = [];
  const drafts: Draft[] = [];
  if (inp.health) drafts.push(...healthRows(inp.health, inp.alefDir, inp.cityForCwd(inp.alefDir)));
  else pending.push("health");
  if (inp.sickness) drafts.push(...sicknessRows(inp.sickness, inp));
  else pending.push("sickness");
  if (inp.gaps) drafts.push(...vaultRows(inp.gaps, inp));
  else pending.push("vault-project", "vault-ghost");
  if (inp.loops) drafts.push(...loopRows(inp.loops, inp));
  else pending.push("loop");
  if (inp.outcomes) drafts.push(...abandonedRows(inp.outcomes, inp));
  else pending.push("abandoned");

  const outcomeOf = new Map((inp.outcomes ?? []).map((r) => [r.sessionId, r]));
  const newlyBound: { id: string; sessionId: string }[] = [];
  const open = emptyFixCounts();
  const rows: FixRow[] = drafts.map((d) => {
    const dismissed = d.source === "health" ? (d.dismissed ?? null) : inp.dismissal(d.id);
    const stored = inp.launch(d.id);
    let launch: FixLaunch | null = null;
    if (stored) {
      let sessionId = stored.sessionId;
      if (!sessionId && stored.tmuxName) {
        sessionId = inp.sessionForTmux(stored.tmuxName);
        if (sessionId) newlyBound.push({ id: d.id, sessionId });
      }
      const rec = sessionId ? outcomeOf.get(sessionId) : undefined;
      launch = { at: stored.at, tmuxName: stored.tmuxName, sessionId, outcome: rec?.outcome ?? null, outcomeReason: rec?.reason ?? null };
    }
    const state = dismissed ? (dismissed.kind === "snooze" ? "snoozed" : "wont-fix") : launch ? "launched" : "open";
    if (!dismissed) open[d.source] += 1;
    return { ...d, dismissed, launch, state };
  });

  rows.sort(compareRows);
  const shown = new Map<FixSource, number>(FIX_SOURCES.map((s) => [s, 0]));
  const capped = rows.filter((r) => {
    const n = (shown.get(r.source) ?? 0) + 1;
    shown.set(r.source, n);
    return n <= FIX_SOURCE_CAP;
  });
  return { rows: capped, open, pending, newlyBound };
}

export function openTotal(open: FixCounts): number {
  return FIX_SOURCES.reduce((n, s) => n + open[s], 0);
}
