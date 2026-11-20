// Pure, dependency-free heuristics: island slugging, role derivation, and the
// live/dormant rule. Kept separate from db/indexer so they're trivial to unit test.

import path from "node:path";
import type { AgentStatus } from "../shared/types.js";

export type Role = "builder" | "researcher" | "ops" | "writer" | "generalist";

/** Ported from claude-world's agent-personalities.js palette, remapped to our role taxonomy. */
export const ROLE_COLORS: Record<Role, string> = {
  builder: "#f97316", // orange — dockmaster (practical, integration-heavy)
  researcher: "#2563eb", // blue — librarian (curious, cross-referencing)
  ops: "#7c3aed", // purple — commander (decisive, runs the pipeline)
  writer: "#0891b2", // cyan — archivist (records, mostly prose)
  generalist: "#16a34a", // green — instructor (adaptive, no dominant tool)
};

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

/**
 * Assign a stable island id for a cwd. `existing` maps already-assigned
 * cwd -> islandId (persisted, so re-indexing never reshuffles an island's id).
 * When a new cwd's basename slug collides with a DIFFERENT cwd's island id,
 * disambiguate by prefixing the parent directory's slug.
 */
export function assignIslandId(cwd: string, existing: ReadonlyMap<string, string>, inUse: ReadonlySet<string> = new Set()): string {
  const current = existing.get(cwd);
  if (current) return current;

  // `inUse`: ids something still sits on (objects, sessions) though no cwd owns them any more — a
  // freed id is never handed to a new cwd, which would inherit whatever was left on it.
  const taken = (id: string): boolean => inUse.has(id) || [...existing.entries()].some(([otherCwd, other]) => other === id && otherCwd !== cwd);
  const base = slugify(path.basename(cwd) || cwd);
  if (!taken(base)) return base;

  const parent = slugify(path.basename(path.dirname(cwd)) || "root");
  let candidate = `${parent}-${base}`;
  let n = 2;
  while (taken(candidate)) {
    candidate = `${parent}-${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export interface RoleCounts {
  cntEdit: number;
  cntResearch: number;
  cntBash: number;
  cntTextOnly: number;
  cntAssistantTotal: number;
}

/**
 * Role heuristic from tool mix:
 *   - no tool calls at all -> writer (if it ever spoke) else generalist
 *   - most assistant turns were plain text even though some tools were used -> writer
 *   - otherwise the dominant tool bucket wins, tie-break order builder > researcher > ops
 */
export function deriveRole(c: RoleCounts): Role {
  const toolTotal = c.cntEdit + c.cntResearch + c.cntBash;
  if (toolTotal === 0) {
    return c.cntAssistantTotal > 0 ? "writer" : "generalist";
  }
  const turnsWithTools = c.cntAssistantTotal - c.cntTextOnly;
  if (c.cntAssistantTotal > 0 && c.cntTextOnly > turnsWithTools) {
    return "writer";
  }
  const max = Math.max(c.cntEdit, c.cntResearch, c.cntBash);
  if (c.cntEdit === max) return "builder";
  if (c.cntResearch === max) return "researcher";
  return "ops";
}

export const LIVE_WINDOW_MS = 120_000;

/**
 * A session is live if its jsonl file was modified within LIVE_WINDOW_MS,
 * OR a currently-running claude process reports a matching cwd.
 */
export function isLive(nowMs: number, jsonlMtimeMs: number, hasMatchingProcess: boolean): boolean {
  return hasMatchingProcess || nowMs - jsonlMtimeMs <= LIVE_WINDOW_MS;
}

/** A cwd running N claude processes marks only its N most recently written sessions live.
 *  Known gap: nothing ties a process to its own session, so when a newer session in the same cwd
 *  writes, an idle session whose process still runs reads dormant (and one whose process exited
 *  can read live; for an Alef launch that never started, discountUnstartedDispatches below closes
 *  that case). The resident's "ended" events (server/features/resident-lib.ts's WaitEvent)
 *  inherit that error; the fix is to match each process to its session (start time, --resume id). */
export function processVouchedSessions(
  sessions: ReadonlyArray<{ id: string; cwd: string; jsonlMtime: number }>,
  liveCwds: ReadonlyMap<string, number>,
): Set<string> {
  const byCwd = new Map<string, Array<{ id: string; jsonlMtime: number }>>();
  for (const s of sessions) {
    if (!liveCwds.has(s.cwd)) continue;
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }
  const ids = new Set<string>();
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => b.jsonlMtime - a.jsonlMtime);
    for (const s of list.slice(0, liveCwds.get(cwd) ?? 0)) ids.add(s.id);
  }
  return ids;
}

/** `live` (claude processes per cwd) minus the processes of Alef launches that never started: a
 *  talk binding still agentId-null whose folder has no session started since the launch (and not
 *  bound to another launch), e.g. one stuck on claude's folder-trust dialog. Such a process has
 *  no transcript of its own, so letting it vouch lent its liveness to an older, finished session
 *  in the same folder. A binding whose folder does have such a newer session may be running it
 *  (adoption can miss it), so it keeps vouching. Clamped per cwd; `unstarted` is how many
 *  processes were taken out. */
export function discountUnstartedDispatches(
  live: ReadonlyMap<string, number>,
  bindings: ReadonlyArray<{ cwd: string; agentId: string | null; startedAt: string }>,
  sessions: ReadonlyArray<{ id: string; cwd: string; startedAt: string }>,
): { live: Map<string, number>; unstarted: number } {
  const bound = new Set(bindings.flatMap((b) => (b.agentId === null ? [] : [b.agentId])));
  const pending = new Map<string, number>();
  for (const b of bindings) {
    if (b.agentId !== null) continue;
    const since = Date.parse(b.startedAt);
    if (!Number.isFinite(since)) continue;
    const maybeItsOwn = sessions.some((s) => s.cwd === b.cwd && !bound.has(s.id) && !(Date.parse(s.startedAt) < since));
    if (!maybeItsOwn) pending.set(b.cwd, (pending.get(b.cwd) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  let unstarted = 0;
  for (const [cwd, n] of live) {
    const d = Math.min(n, pending.get(cwd) ?? 0);
    unstarted += d;
    if (n > d) out.set(cwd, n - d);
  }
  return { live: out, unstarted };
}

/** Local (host timezone) calendar day, "YYYY-MM-DD". Used to bucket token spend so
 *  "tokensToday" never needs a rescan — the indexer bumps one counter per line. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type LastLineKind = "user" | "assistant_tool" | "assistant_text";

/** The indexer's per-session "what happened last" cursor, persisted so an incremental
 *  pass (which only sees new lines) can still tell whether a session is mid-question. */
export interface LastLineState {
  kind: LastLineKind;
  toolName: string | null; // set when kind === "assistant_tool"
  textIsQuestion: boolean; // set when kind === "assistant_text"
}

/** live AND (last tool_use is AskUserQuestion with no tool_result after it,
 *  OR last assistant line is text ending in "?" with no later user line). */
export function isAwaitingInput(status: AgentStatus, state: LastLineState): boolean {
  if (status !== "live") return false;
  if (state.kind === "assistant_tool") return state.toolName === "AskUserQuestion";
  if (state.kind === "assistant_text") return state.textIsQuestion;
  return false;
}

// Long opaque tokens (API keys, bearer tokens) — titles render in the UI, never show them.
const SECRET_PATTERNS: RegExp[] = [
  /\b[a-z]+_(?:live|test|sk|pk)_[A-Za-z0-9]{12,}\b/g, // croma_live_…, rk_live_…
  /\b(?:sk|pk|rk|gh[pousr]|xox[abprs])[-_][A-Za-z0-9_-]{16,}\b/g, // sk-…, ghp_…, ghs_…, xoxb-…
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids (20 chars: too short for the opaque rule below)
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys (may end in "-", so no trailing \b)
  /\b(?=[\w-]*\d)(?=[\w-]*[A-Z])[\w-]{32,}\b/g, // other long opaque tokens: mixed case + digits (lowercase URL slugs pass)
];

/** Replaces secret-looking tokens with "[redacted]"; keeps whitespace/newlines intact. */
export function redactSecrets(text: string): string {
  let t = text;
  for (const re of SECRET_PATTERNS) t = t.replace(re, "[redacted]");
  return t;
}

/** Human session title: strip tags, collapse whitespace, redact secret-looking tokens, cap at 80 chars. */
export function sanitizeTitle(raw: string): string {
  let t = redactSecrets(raw.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, " ").replace(/\s+/g, " ").trim());
  if (t.length > 80) t = t.slice(0, 79).trimEnd() + "…";
  return t || "(untitled session)";
}
