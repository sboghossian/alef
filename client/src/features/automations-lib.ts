// Pure helpers for the ⚡ Automations modal: grouping, emoji, status dot, countdown, the
// "run finished?" check and which reader style a doc gets. Tested in automations-lib.test.ts.
// Also home to workflowPrompt/cityForOutputDir (round 11, package D): the routines feature
// (client/src/features/routines.ts) reuses both for its own drag/"→ prompt" rows, since a
// routine is the same underlying automation once merged with /api/automations.

import type { Automation } from "../../../shared/features/automations";
import type { Island } from "../../../shared/types";

export type AutomationGroup = "instant" | "rituals" | "growth" | "brain" | "dev";

export const GROUPS: ReadonlyArray<{ id: AutomationGroup; label: string; emoji: string }> = [
  { id: "instant", label: "Instant", emoji: "⚡" },
  { id: "rituals", label: "Daily rituals", emoji: "☀️" },
  { id: "growth", label: "Growth", emoji: "📈" },
  { id: "brain", label: "Brain", emoji: "🧠" },
  { id: "dev", label: "Dev", emoji: "🛠️" },
];

const RITUAL_RE = /brief|recap|sweep|artifact-ritual|morning|whats-up|networth/;
const GROWTH_RE = /linkedin|^ig-|plg|growth|lead|acme|x-post|otterly|scout|eulex|bench|seo/;
const BRAIN_RE = /brain|vault|capture|knowledge|memory|connection|upskill|ingest|lexwiki|recall/;

export function groupOf(a: Pick<Automation, "id">): Exclude<AutomationGroup, "instant"> {
  if (RITUAL_RE.test(a.id)) return "rituals";
  if (GROWTH_RE.test(a.id)) return "growth";
  if (BRAIN_RE.test(a.id)) return "brain";
  return "dev";
}

const EMOJI: Record<string, string> = {
  "yalla-brief": "🗞️",
  "daily-recap": "📊",
  "inbox-sweep": "📬",
  "artifact-ritual": "🧾",
  "ig-innovation": "📸",
  "linkedin-post": "💼",
  "plg-ritual": "📈",
  "eulex-bench": "⚖️",
  "divorce-ct": "⚖️",
  scout: "🔭",
  "vault-sync": "🔄",
  "brain-sync": "🔄",
  "brain-nurture": "🌱",
  "auto-capture": "📥",
  "capture-triage": "🗂️",
  "connection-synthesis": "🕸️",
  "knowledge-learner": "📚",
  upskill: "🎓",
  "prune-sessions": "✂️",
  "rotate-logs": "🗃️",
  "worktree-janitor": "🧹",
  bridge: "🌉",
  cso: "🛡️",
  boris: "🤖",
  retro: "🔁",
  networth: "💰",
};

export function emojiOf(a: Pick<Automation, "id">): string {
  return EMOJI[a.id] ?? GROUPS.find((g) => g.id === groupOf(a))?.emoji ?? "⚙️";
}

export type RunStatus = "running" | "ok" | "failed" | "never";

export function statusOf(a: Pick<Automation, "running" | "lastExitStatus" | "lastRunAt">): { status: RunStatus; label: string } {
  if (a.running) return { status: "running", label: "running now" };
  if (a.lastExitStatus === null && a.lastRunAt === null) return { status: "never", label: "no runs seen" };
  if (a.lastExitStatus === null || a.lastExitStatus === 0) return { status: "ok", label: "last run ok" };
  if (a.lastExitStatus < 0) return { status: "failed", label: `killed (signal ${-a.lastExitStatus})` };
  return { status: "failed", label: `failed (exit ${a.lastExitStatus})` };
}

/** "in 2h 14m", "in 45s", "due now"; null when there is no next run. */
export function countdown(nextRunAt: string | null, now: number): string | null {
  if (!nextRunAt) return null;
  const t = Date.parse(nextRunAt);
  if (Number.isNaN(t)) return null;
  let s = Math.round((t - now) / 1000);
  if (s <= 0) return "due now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m ${s}s`;
  return `in ${s}s`;
}

/** First sentence-ish of a (possibly very long) skill description. */
export function shortDescription(desc: string | null, max = 150): string {
  if (!desc) return "";
  const one = desc.replace(/\s+/g, " ").trim();
  const cut = /^(.{20,}?[.!?])\s/.exec(one)?.[1] ?? one;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

/** After "Run now" at `startedAt`: has a newer, non-running run landed? */
export function runFinished(a: Pick<Automation, "running" | "lastRunAt">, startedAt: number): boolean {
  if (a.running || !a.lastRunAt) return false;
  return Date.parse(a.lastRunAt) >= startedAt - 5_000;
}

export type ReaderStyle = "newspaper" | "cards" | "doc";

/** yalla-brief reads as a comic newspaper, daily-recap as cards, everything else as a doc. */
export function readerStyle(id: string): ReaderStyle {
  if (id === "yalla-brief") return "newspaper";
  if (id === "daily-recap") return "cards";
  return "doc";
}

// ── round 11, package D: routines/automations → prompt box (drag or "→ prompt") ─────────────

/** The ready-to-send prompt for a routine/automation row: its real skill command when known
 *  (the exact slash command a run would invoke — literally the steps it runs), else a plain
 *  instruction built only from its own real name + description. Never invents a workflow that
 *  isn't in the data. */
export function workflowPrompt(a: Pick<Automation, "name" | "description" | "dispatchCommand">): string {
  if (a.dispatchCommand) return a.dispatchCommand;
  const name = a.name.trim();
  return a.description ? `Run ${name}: ${a.description}` : `Run ${name}.`;
}

/** Which real city (island) a routine/automation's output belongs to, by matching its output
 *  directory against known island paths — the most specific (longest) match wins, so a vault
 *  subfolder never loses to a shorter, unrelated prefix. Null when nothing matches (e.g. it
 *  writes under ~/.claude, which isn't a project city at all). */
export function cityForOutputDir(outputDir: string | null, islands: readonly Pick<Island, "id" | "path">[]): string | null {
  if (!outputDir) return null;
  const dir = outputDir.replace(/\/+$/, "");
  let best: { id: string; len: number } | null = null;
  for (const i of islands) {
    if (!i.path) continue;
    const p = i.path.replace(/\/+$/, "");
    if (!p || (dir !== p && !dir.startsWith(`${p}/`))) continue;
    if (!best || p.length > best.len) best = { id: i.id, len: p.length };
  }
  return best?.id ?? null;
}

/** Grouped + sorted: next run soonest first, never-scheduled last, then by name. */
export function groupAutomations(list: readonly Automation[]): Map<Exclude<AutomationGroup, "instant">, Automation[]> {
  const out = new Map<Exclude<AutomationGroup, "instant">, Automation[]>();
  for (const a of list) {
    const g = groupOf(a);
    const arr = out.get(g) ?? [];
    arr.push(a);
    out.set(g, arr);
  }
  const key = (a: Automation): number => (a.nextRunAt ? Date.parse(a.nextRunAt) : Number.MAX_SAFE_INTEGER);
  for (const arr of out.values()) arr.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
  return out;
}
