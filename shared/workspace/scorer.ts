// The Town square as a GLOBAL WORKSPACE (Global Workspace Theory, Baars / Dehaene): many
// specialist processes (sessions, subagents, routines, Jev, the resident) produce signals, they
// compete for one small shared slot, and only what clears a salience threshold is "broadcast":
// the top 5 of what the whole system should know right now, each with the reason it got in.
// Everything else stays in the full chronological log (the Feed tab, the Town square's Log).
//
// Pure and deterministic: no DOM, no clock (callers pass `now`), no IO. Two halves:
//   1. adapters: every real signal source → WorkspaceCandidate (Feed items, cross-session
//      messages, subagent hand-backs and failures, automated runs that failed, server routine
//      runs, the resident's proposals + journal);
//   2. the scorer: group near-identical candidates, score each group, fill ≤ 5 slots.
//
// salience(group) = urgency × recency × novelty × breadth
//   urgency  waiting on Alex 100 > failure 60 > tripwire 45 > message 30 > info 12
//            (so info only clears the bar when ≥ 4 districts share it: 12 × 1.75 = 21)
//   recency  0.5 ^ (age of the group's newest member / 30 min); 1 while a wait or approval is
//            still open (unanswered): the Feed pins those until answered, and so does the slot
//   novelty  near-identical items (same topic: normalized text, or an adapter's explicit key)
//            form ONE group. Members < 2 min apart are one event seen twice (a message's sender
//            and receiver copies, a hand-back seen as a message and as a subagent record); each
//            later occurrence is a repeat, and repeats decay too:
//              repeats = Σ over occurrences of 0.5 ^ (gap to the newest / 30 min)
//              n = repeats / districts;  novelty = max(0.25, 0.75 ^ (n − 1))
//            (dividing by districts: the same thing in several districts is breadth, not a rerun)
//   breadth  1 + 0.25 × (districts − 1), districts capped at 5 (so ×1 … ×2)
// The slot: a group ENTERS at ≥ 20 and, once in, stays until it falls under 14 (hysteresis), so
// an item on the edge doesn't bounce. When more than 5 qualify, the 5 best win, with an
// incumbent's score counted ×1.15 so a newcomer has to clearly beat it to take its place.
// Recency is exponential, so decay alone never reorders two groups (their ratio is constant):
// only new evidence does. Nothing older than 2 h can reach 14 (100 × 2 × 0.5^4 = 12.5), so
// candidates are windowed to 2 h (open waits and approvals excepted: they don't decay).
//
// Shared (vision wave 3, gwt-broadcast): the client (client/src/features/workspace-lib.ts
// re-exports this file) and the server (server/features/workspace.ts) run this one scorer, so the
// same inputs give the same top 5 on both sides. Nothing here may import client or server code.

import { autonomyLevel } from "../autonomy.js";
import { agentTitle } from "../display.js";
import { checkLine, isPinnable, type CompletenessCheck } from "../features/completeness.js";
import { isResidentProposal, type ResidentState } from "../features/resident.js";
import type { FeedItem as ServerFeedItem } from "../features/feed.js";
import type { PresidentBoard, PresidentProposal } from "../features/president.js";
import type { RunEnding, SubagentRecord } from "../features/subagents.js";
import type { StrandedBlockedOn, StrandedDispatch } from "../features/talk.js";
import type { VillageMessage } from "../features/village.js";
import type { Island, WorldAgent } from "../types.js";

/** The live Feed's kinds (client/src/shell/feed-types.ts FEED_KINDS). */
export type WorkspaceFeedKind = "approval" | "awaiting" | "tripwire" | "decision" | "graduation" | "activity" | "caption" | "routine" | "report" | "system";

/** What the scorer reads of one Feed item: the client's FeedItem (client/src/shell/feed-types.ts)
 *  is passed as is, and the server builds these from its own records (server/features/
 *  workspace-lib.ts). Structural on purpose: a kind added to the client Feed stops the client's
 *  call into gatherCandidates from compiling until it is listed above and scored below. */
export interface WorkspaceFeedItem {
  id: string;
  kind: WorkspaceFeedKind;
  /** ms epoch of the real event. */
  at: number;
  title: string;
  agentId?: string;
  cityId?: string;
  approval?: { readonly id: string };
  /** Set once an approval or a wait was answered or left the queue. */
  outcome?: string;
}

export type WorkspaceUrgency = "waiting" | "failure" | "tripwire" | "message" | "info";

export const URGENCY_WEIGHT: Readonly<Record<WorkspaceUrgency, number>> = { waiting: 100, failure: 60, tripwire: 45, message: 30, info: 12 };
export const URGENCY_LABEL: Readonly<Record<WorkspaceUrgency, string>> = {
  waiting: "waiting on you",
  failure: "failure",
  tripwire: "tripwire",
  message: "message",
  info: "info",
};
export const URGENCY_EMOJI: Readonly<Record<WorkspaceUrgency, string>> = { waiting: "⏳", failure: "❌", tripwire: "🪤", message: "💬", info: "ℹ️" };
const URGENCY_RANK: Readonly<Record<WorkspaceUrgency, number>> = { waiting: 4, failure: 3, tripwire: 2, message: 1, info: 0 };

export const WORKSPACE = {
  halfLifeMs: 30 * 60_000,
  enter: 20,
  exit: 14,
  slots: 5,
  incumbentEdge: 1.15,
  echoMs: 2 * 60_000,
  repeatBase: 0.75,
  noveltyFloor: 0.25,
  breadthStep: 0.25,
  breadthMaxDistricts: 5,
  windowMs: 2 * 60 * 60_000,
} as const;

export interface WorkspaceCandidate {
  /** Stable per real observation (the source's own id, prefixed by source). */
  id: string;
  urgency: WorkspaceUrgency;
  /** Where it came from, one word for the reason line: "subagent", "message", "Jev", "PR"… */
  origin: string;
  /** ms epoch of the real event. */
  at: number;
  /** One line. Untrusted (titles, previews, model output): escape wherever it becomes HTML. */
  text: string;
  /** Near-identical grouping key. Default: urgency + normalized text. */
  topic?: string;
  /** Still waiting on Alex (an unanswered wait or approval): no decay, never windowed out. */
  open?: boolean;
  /** Sessions it is about, most relevant first (the first one is the click target). */
  agentIds: readonly string[];
  /** Districts (island ids) it touches: its breadth. */
  districts: readonly string[];
}

/** What the adapters need to know about a session: its district, a short display name, and
 *  whether it is an automated run (no human turn of its own: shared/autonomy.ts level ≥ 3). */
export interface WorkspaceAgent {
  islandId: string;
  name: string;
  automated?: boolean;
}
export type AgentLookup = (agentId: string) => WorkspaceAgent | undefined;

const NAME_MAX = 40;

type LookupAgent = Pick<WorldAgent, "islandId" | "title" | "displayName" | "cwd" | "messageCount">;

/** A session as the workspace names it: its display title (or its folder), ≤ 40 chars. */
export function workspaceAgent(a: LookupAgent): WorkspaceAgent {
  const t = agentTitle(a) || a.cwd.split("/").filter(Boolean).pop() || "a session";
  return { islandId: a.islandId, name: t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t, automated: autonomyLevel(a).level >= 3 };
}

/** The lookup every caller uses: read the agents map at call time (the store replaces it on a snapshot). */
export function agentLookup(agents: () => ReadonlyMap<string, LookupAgent>): AgentLookup {
  return (id) => {
    const a = agents().get(id);
    return a ? workspaceAgent(a) : undefined;
  };
}

/** What strandedCandidates needs of a real island: its id and its real cwd path (client/src/state.ts's
 *  `store.islands`, or `WorldSnapshot.islands` in the standalone script). */
export type WorkspaceIsland = Pick<Island, "id" | "path">;

/** The Health checklist's current summary (client/src/features/completeness.ts's `currentHealthSummary()`):
 *  the same checks `server/features/completeness.ts` computes, plus `generatedAt` — set by the reader
 *  (the client, or the standalone script) when it saw the summary, since the wire shape
 *  (`WorldSnapshot.extras["completeness.summary"]`) carries no timestamp of its own. */
export interface HealthSummary {
  generatedAt: string; // ISO
  checks: readonly CompletenessCheck[];
}

// ---------------------------------------------------------------- helpers

/** Lower-cased, ids / hashes / numbers → "#", punctuation → space: "near-identical" text. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, "#")
    .replace(/\d+(?:[.:,]\d+)*/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim()
    .slice(0, 96);
}

function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function unique(list: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of list) if (v && !out.includes(v)) out.push(v);
  return out;
}

function districtsOf(agentIds: readonly string[], lookup: AgentLookup, extra: readonly (string | undefined)[] = []): string[] {
  return unique([...agentIds.map((id) => lookup(id)?.islandId), ...extra]);
}

function parseMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** A subagent record is workflow plumbing, not town news, when a workflow spawned it
 *  (`workflowId`) or it is the generic runner type workflows use (`agentType`). `undefined` (no
 *  record on hand, e.g. a hand-back message whose subagent record wasn't found) is never
 *  demoted: demotion only ever fires off a real record, never a guess. */
function isWorkflowSubagent(r: Pick<SubagentRecord, "workflowId" | "agentType"> | undefined): boolean {
  return r !== undefined && (r.workflowId !== null || r.agentType === "workflow-subagent");
}

/** "just now", "12m ago", "1h 5m ago". */
export function agoText(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

// ---------------------------------------------------------------- adapters: real sources → candidates

/** Failure wording in routine / system lines ("X failed (exit 1)", "🖥️ Mac: … (failed)"). */
const FAILURE_RE = /\bfail(?:ed|ure|s)?\b|\berror\b|\bexit -?[1-9]\d*\b/i;
/** A PR opened or merged, as its activity line shows it (server/activity.ts's bashSummary). */
const PR_RE = /^Bash: gh pr (?:create|merge)\b/;
/** The client Feed's routine line id (shell/feed.ts routineRunsToFeed): "rt:<launchd label>:end:<ms>". */
const FEED_ROUTINE_ID_RE = /^rt:(.+):end:\d+$/;
/** The server feed's routine run id (server/features/feed.ts): "routine:<automation id>:done:<at>". */
const SERVER_ROUTINE_ID_RE = /^routine:([^:]+):done:/;

/** A launchd label as the server's automation id (server/features/automations.ts). */
export function routineId(label: string): string {
  return label.replace(/^com\.stephane\./, "").replace(/^dev\.dashable\./, "");
}

/** One routine's failure, whichever copy reports it (the Feed tab's line or the server feed's run):
 *  the two are worded differently ("dev.dashable.x failed (exit 1)" / "x failed (exit 1)"). */
function routineFailureTopic(id: string): string {
  return `routine-failed:${id}`;
}

const HANDBACK_RE = /^\[Subagent hand-back\]/;

/**
 * One item of the live Feed (shell/feed.ts) → a candidate. This is the generic publish hook: any
 * feature that pushes a FeedItem (ctx.feed.push) is a candidate, including `kind: "tripwire"`.
 * An approval or a wait that has been answered is no longer salient (null).
 */
export function feedCandidate(item: WorkspaceFeedItem, lookup: AgentLookup): WorkspaceCandidate | null {
  if ((item.kind === "approval" || item.kind === "awaiting") && item.outcome !== undefined) return null;
  const agentIds = item.agentId ? [item.agentId] : [];
  const base = { id: `feed:${item.id}`, at: item.at, text: oneLine(item.title), agentIds, districts: districtsOf(agentIds, lookup, [item.cityId]) };
  switch (item.kind) {
    case "approval": // one per request: two sessions asking the same thing are two things to answer
      return { ...base, urgency: "waiting", origin: "approval", topic: `ap:${item.approval?.id ?? item.id}`, open: true };
    case "awaiting":
      return { ...base, urgency: "waiting", origin: "waiting", topic: item.agentId ? `wait:${item.agentId}` : undefined, open: true };
    case "tripwire":
      return { ...base, urgency: "tripwire", origin: "tripwire" };
    case "routine":
    case "system": {
      if (!FAILURE_RE.test(item.title)) return { ...base, urgency: "info", origin: item.kind };
      const label = item.kind === "routine" ? FEED_ROUTINE_ID_RE.exec(item.id)?.[1] : undefined;
      return { ...base, urgency: "failure", origin: item.kind, topic: label ? routineFailureTopic(routineId(label)) : undefined };
    }
    case "report": // free-text summaries ("…one build failed") are not failures themselves
      return { ...base, urgency: "info", origin: "report" };
    case "activity":
    case "caption":
      // A PR line keeps its number in its topic (normalizeText would fold "merge 24" and "merge 26" together).
      return PR_RE.test(item.title) ? { ...base, urgency: "message", origin: "PR", topic: `pr:${base.text.toLowerCase()}` } : { ...base, urgency: "info", origin: item.kind };
    case "decision":
      return { ...base, urgency: "info", origin: "Jev" };
    case "graduation":
      // One shared topic: one merge (one district) can't clear the entry bar (12 < 20), but a
      // wave of them across ≥ 4 districts within the window does (12 × 1.75 = 21) — the same
      // breadth rule every other info signal gets, not a graduation-specific threshold.
      return { ...base, urgency: "info", origin: "graduation", topic: "graduation" };
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Cross-session messages (server/features/village.ts) → candidates. A `<agent-message>` from one
 * of this session's subagents is a hand-back, grouped with that subagent's record (topic
 * `sub:<id>`) so the two are one event, not a repeat.
 */
export function messageCandidates(messages: readonly VillageMessage[], subagents: ReadonlyMap<string, SubagentRecord>, lookup: AgentLookup): WorkspaceCandidate[] {
  const label = (sessionId: string | null, raw: string): string => {
    if (sessionId) return lookup(sessionId)?.name ?? `session ${shortId(sessionId)}`;
    const sub = subagents.get(raw);
    return sub ? `subagent "${oneLine(sub.description, 40)}"` : raw;
  };
  const out: WorkspaceCandidate[] = [];
  for (const m of messages) {
    const at = parseMs(m.at);
    const fromSub = subagents.get(m.fromRaw);
    if (m.direction === "received" && (fromSub || HANDBACK_RE.test(m.preview))) {
      const parent = m.toSessionId ?? fromSub?.parentSessionId ?? null;
      const agentIds = unique([parent]);
      // A workflow's own hand-back to itself is that workflow's plumbing, not town news (its
      // review/fix rounds fire dozens of these); a hand-back from an ad-hoc Agent-tool subagent
      // still is. Only demoted with a real record on hand — never a guess.
      const workflow = isWorkflowSubagent(fromSub);
      out.push({
        id: `msg:${m.id}`,
        urgency: workflow ? "info" : "message",
        origin: workflow ? "workflow" : "subagent",
        at,
        text: `handed back: ${fromSub ? oneLine(fromSub.description, 100) : `subagent ${shortId(m.fromRaw)}`}`,
        topic: `sub:${m.fromRaw}`,
        agentIds,
        districts: districtsOf(agentIds, lookup),
      });
      continue;
    }
    const agentIds = unique([m.fromSessionId ?? subagents.get(m.fromRaw)?.parentSessionId, m.toSessionId ?? subagents.get(m.toRaw)?.parentSessionId]);
    out.push({
      id: `msg:${m.id}`,
      urgency: "message",
      origin: "message",
      at,
      text: oneLine(`${label(m.fromSessionId, m.fromRaw)} → ${label(m.toSessionId, m.toRaw)}: ${m.preview}`),
      topic: `msg:${normalizeText(m.preview)}`,
      agentIds,
      districts: districtsOf(agentIds, lookup),
    });
  }
  return out;
}

/** Finished subagents (shared/features/subagents.ts): a hand-back is a message, a failure a failure
 *  (with its reason: "API Error: …", "cut off: …", the parent's words), a stop (a user interrupt, the
 *  parent stopping it) only info: Alex or the parent did it on purpose. A "done" hand-back from
 *  a workflow's own subagent is demoted to info (workflow plumbing, not town news); a failure never
 *  is — a workflow round failing is still real news. */
export function subagentCandidates(records: Iterable<SubagentRecord>, lookup: AgentLookup): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = [];
  for (const r of records) {
    if (r.status !== "done" && r.status !== "failed" && r.status !== "stopped") continue;
    const desc = oneLine(r.description, 100);
    const agentIds = [r.parentSessionId];
    const base = { id: `sub:${r.id}:${r.status}`, at: parseMs(r.lastActive), topic: `sub:${r.id}`, agentIds, districts: districtsOf(agentIds, lookup) };
    if (r.status === "failed") out.push({ ...base, origin: "subagent", urgency: "failure", text: `failed: ${desc}${r.reason ? ` · ${oneLine(r.reason, 80)}` : ""}` });
    else if (r.status === "stopped") out.push({ ...base, origin: "subagent", urgency: "info", text: `stopped: ${desc}` });
    else {
      const workflow = isWorkflowSubagent(r);
      out.push({ ...base, origin: workflow ? "workflow" : "subagent", urgency: workflow ? "info" : "message", text: `handed back: ${desc}` });
    }
  }
  return out;
}

/**
 * Automated sessions whose transcript ended failed or stopped (server/features/subagents/endings.ts:
 * an API error, a turn cut off mid-way, an interrupt; never a keyword guess). Automated = no human
 * turn of its own (autonomy level ≥ 3) or a headless `claude -p` transcript; an interactive session is
 * left out (Alex was there), and so is a session the world doesn't show.
 */
export function runCandidates(endings: Iterable<RunEnding>, lookup: AgentLookup): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = [];
  for (const e of endings) {
    const a = lookup(e.sessionId);
    if (!a || !(a.automated === true || e.headless)) continue;
    const failed = e.status === "failed";
    out.push({
      id: `run:${e.sessionId}:${e.status}:${e.at}`,
      urgency: failed ? "failure" : "info",
      origin: "automation",
      at: parseMs(e.at),
      text: `${a.name} ${e.status}: ${oneLine(e.reason, 100)}`,
      topic: `run:${e.sessionId}`,
      agentIds: [e.sessionId],
      districts: [a.islandId],
    });
  }
  return out;
}

const EXIT_RE = /^exit (-?\d+)$/;

/** Routine runs from the server feed (server/features/feed.ts: "<name> ran", detail "exit N"). */
export function routineCandidates(items: readonly ServerFeedItem[]): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = [];
  for (const i of items) {
    if (i.kind !== "routine") continue;
    const m = EXIT_RE.exec(i.detail ?? "");
    const code = m?.[1] === undefined ? null : Number(m[1]);
    const failed = code !== null && code !== 0;
    const name = i.title.replace(/ ran$/, "");
    const id = SERVER_ROUTINE_ID_RE.exec(i.id)?.[1];
    out.push({
      id: `srv:${i.id}`,
      urgency: failed ? "failure" : "info",
      origin: "routine",
      at: parseMs(i.at),
      text: failed ? `${name} failed (exit ${code})` : oneLine(i.detail ? `${i.title} · ${i.detail}` : i.title),
      // The Feed tab's own line for the same failure (shell/feed.ts) shares this topic: one group.
      topic: failed && id ? routineFailureTopic(id) : undefined,
      agentIds: [],
      districts: [],
    });
  }
  return out;
}

const JOURNAL_HEADER_RE = /^#{1,6}\s*(\d{1,2}):(\d{2})\b/;
const JOURNAL_BULLET_RE = /^[-*]\s*(\d{1,2}):(\d{2})\s*[·:–-]\s*(.+)$/;

/** HH:MM on `now`'s local day; a time more than 5 min ahead of `now` is yesterday's. */
function localTimeToday(now: number, h: number, m: number): number {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > now + 5 * 60_000) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * The resident (shared/features/resident.ts): open proposals are messages to Alex; journal
 * entries are info. A journal line only counts when its time is known ("## 18:17 · reflection"
 * above it, or "- 19:22 · …" on it); an undated line is never given a guessed time.
 */
export function residentCandidates(state: ResidentState | null, now: number): WorkspaceCandidate[] {
  if (!state || !state.enabled) return [];
  const out: WorkspaceCandidate[] = [];
  const proposals: readonly unknown[] = Array.isArray(state.proposals) ? state.proposals : [];
  for (const p of proposals) {
    if (!isResidentProposal(p) || p.status !== "open") continue;
    out.push({ id: `res:p:${p.id}`, urgency: "message", origin: "resident", at: parseMs(p.at), text: `resident proposes: ${oneLine(p.title, 110)}`, agentIds: [], districts: [] });
  }
  let at: number | null = null;
  for (const raw of Array.isArray(state.journalTail) ? state.journalTail : []) {
    const line = raw.trim();
    if (!line) continue;
    const header = JOURNAL_HEADER_RE.exec(line);
    if (header) {
      at = localTimeToday(now, Number(header[1]), Number(header[2]));
      continue;
    }
    const bullet = JOURNAL_BULLET_RE.exec(line);
    const lineAt = bullet ? localTimeToday(now, Number(bullet[1]), Number(bullet[2])) : at;
    if (lineAt === null) continue;
    const text = oneLine(bullet?.[3] ?? line);
    out.push({ id: `res:j:${lineAt}:${normalizeText(text).slice(0, 32)}`, urgency: "info", origin: "resident", at: lineAt, text: `resident: ${text}`, agentIds: [], districts: [] });
  }
  return out;
}

/** One line per StrandedBlockedOn, matching the wording the spec uses ("trust dialog", "empty
 *  prompt", …) — a shorter, in-line-friendly phrasing than the Inbox's own STRANDED_LABELS. */
const STRANDED_REASON: Readonly<Record<StrandedBlockedOn, string>> = {
  trust: "trust dialog",
  chrome: "Chrome dialog",
  menu: "menu",
  "empty-prompt": "empty prompt",
  exited: "exited",
  unknown: "unrecognized screen",
};

/** The real island whose cwd path is the longest prefix of `cwd` — the same "canonical repo"
 *  idea as server/features/usage.ts's islandForCwd, done here in pure client code since a
 *  stranded launch has no session/island of its own yet (its agentId is still null). */
function islandForCwd(cwd: string, islands: readonly WorkspaceIsland[]): string | undefined {
  let best: WorkspaceIsland | undefined;
  for (const isl of islands) {
    if (!isl.path) continue;
    const withSlash = isl.path.endsWith("/") ? isl.path : `${isl.path}/`;
    if ((cwd === isl.path || cwd.startsWith(withSlash)) && (!best || isl.path.length > best.path.length)) best = isl;
  }
  return best?.id;
}

/**
 * A launch/dispatch stuck at a screen only Alex can clear (talk.stranded, shared/features/
 * talk.ts): always "waiting" and always `open` — like an unanswered wait or approval, it does not
 * decay, because nothing about it changes until Alex acts (or the launch times out and drops
 * out of talk.stranded on its own).
 */
export function strandedCandidates(stranded: readonly StrandedDispatch[], islands: readonly WorkspaceIsland[]): WorkspaceCandidate[] {
  return stranded.map((s) => {
    const islandId = islandForCwd(s.cwd, islands);
    const head = s.promptHead ? oneLine(s.promptHead, 80) : "(no prompt on record)";
    return {
      id: `stranded:${s.tmuxName}`,
      urgency: "waiting",
      origin: "launch",
      at: parseMs(s.startedAt),
      text: `Launch waiting on you: ${head} - ${STRANDED_REASON[s.blockedOn]}`,
      topic: `stranded:${s.tmuxName}`,
      open: true,
      agentIds: [],
      districts: islandId ? [islandId] : [],
    };
  });
}

/**
 * The Health checklist (shared/features/completeness.ts): a failing check is a failure, a
 * warning is info (it's real, but it isn't blocking); a passing or unknown check says nothing —
 * only what's wrong is town news. A failing check that turns to pass simply stops being produced
 * here, so it drops out of the workspace on its own, the same as a resolved wait — true as long
 * as `summary` itself is kept current (completeness.ts's onSnapshot/onMessage re-run this on
 * every real server recompute, not just once at page load).
 *
 * A check snoozed or marked won't fix in Health (`dismissed`) isn't pinned either; Health keeps
 * listing it, muted.
 *
 * A `fail` is `open: true`, like an unanswered wait: it doesn't decay while it's still being
 * reported, and doesn't show an invented age either — its salience never depends on `at`.
 */
export function healthCandidates(summary: HealthSummary | null): WorkspaceCandidate[] {
  if (!summary) return [];
  const at = parseMs(summary.generatedAt);
  const out: WorkspaceCandidate[] = [];
  for (const c of summary.checks) {
    if (!isPinnable(c)) continue; // passing, unmeasured, or snoozed / won't fix in Health
    const fail = c.state === "fail";
    out.push({
      id: `health:${c.id}`,
      urgency: fail ? "failure" : "info",
      origin: "Health",
      at,
      text: `Health: ${checkLine(c)}`,
      topic: `health:${c.id}`,
      open: fail,
      agentIds: [],
      districts: [],
    });
  }
  return out;
}

/** The same display text the Inbox's "Jev proposes" section shows (client/src/features/
 *  president-lib.ts's row renderers), as one line. */
function proposalTitle(p: PresidentProposal): string {
  return p.kind === "session" ? p.task : p.kind === "commencement" ? p.title : `merge ${p.districts.length} districts into ${p.into}`;
}

/** Jev's current proposal board (shared/features/president.ts): each open proposal is info —
 *  Alex can act on it from the Inbox, but nothing here is broken or blocking. */
export function presidentCandidates(board: PresidentBoard | null): WorkspaceCandidate[] {
  if (!board) return [];
  const at = parseMs(board.generatedAt);
  return board.proposals.map((p) => ({
    id: `pres:${p.id}`,
    urgency: "info",
    origin: "Jev",
    at,
    text: `Jev proposes: ${oneLine(proposalTitle(p), 110)}`,
    topic: `pres:${p.id}`,
    agentIds: [],
    districts: [],
  }));
}

export interface WorkspaceSources {
  /** The live Feed's items (FeedStore.list()): activity, captions, Jev, waits, approvals, routines, reports, tripwires… */
  feed: readonly WorkspaceFeedItem[];
  /** Cross-session messages (village.messages). */
  messages: readonly VillageMessage[];
  /** Subagent records (subagents.recent). */
  subagents: readonly SubagentRecord[];
  /** Sessions whose transcript ended failed or stopped (subagents.runs). */
  runEndings: readonly RunEnding[];
  resident: ResidentState | null;
  /** Server feed items the client has no other source for (routine runs with exit codes). */
  serverFeed: readonly ServerFeedItem[];
  /** Launches/dispatches stuck at a screen only Alex can clear (talk.stranded). */
  stranded: readonly StrandedDispatch[];
  /** Real islands (id + cwd path), to place a stranded launch by its longest-prefix district. */
  islands: readonly WorkspaceIsland[];
  /** The Health checklist's current summary (completeness.summary), null before the first tick. */
  health: HealthSummary | null;
  /** Jev's current proposal board (president.board), null before the first tick. */
  presidentBoard: PresidentBoard | null;
}

export interface GatheredCandidates {
  /** Every candidate any source produced. */
  observed: number;
  /** The ones inside the 2 h window (older ones can't reach the threshold). */
  candidates: WorkspaceCandidate[];
}

export function gatherCandidates(src: WorkspaceSources, lookup: AgentLookup, now: number): GatheredCandidates {
  const subagents = new Map(src.subagents.map((r) => [r.id, r] as const));
  const all: WorkspaceCandidate[] = [
    ...src.feed.map((i) => feedCandidate(i, lookup)).filter((c): c is WorkspaceCandidate => c !== null),
    ...messageCandidates(src.messages, subagents, lookup),
    ...subagentCandidates(src.subagents, lookup),
    ...runCandidates(src.runEndings, lookup),
    ...routineCandidates(src.serverFeed),
    ...residentCandidates(src.resident, now),
    ...strandedCandidates(src.stranded, src.islands),
    ...healthCandidates(src.health),
    ...presidentCandidates(src.presidentBoard),
  ];
  const candidates = all.filter((c) => Number.isFinite(c.at) && (c.open === true || now - c.at <= WORKSPACE.windowMs) && c.text.length > 0);
  return { observed: all.length, candidates };
}

// ---------------------------------------------------------------- the scorer

export function topicOf(c: WorkspaceCandidate): string {
  return c.topic ?? `${c.urgency}|${normalizeText(c.text)}`;
}

export interface WorkspaceGroup {
  key: string;
  /** Newest first. */
  members: WorkspaceCandidate[];
}

/** Near-identical candidates (same topic) → one group each, in a stable order. */
export function groupCandidates(candidates: readonly WorkspaceCandidate[]): WorkspaceGroup[] {
  const byKey = new Map<string, WorkspaceCandidate[]>();
  for (const c of candidates) {
    const key = topicOf(c);
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }
  return [...byKey.entries()]
    .map(([key, members]) => ({ key, members: [...members].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Occurrence times (the newest of each echo cluster), oldest first. A cluster is every member
 *  less than `echoMs` after the cluster's first member. */
export function occurrenceTimes(times: readonly number[], echoMs: number = WORKSPACE.echoMs): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  let anchor: number | null = null;
  for (const t of sorted) {
    if (anchor !== null && t - anchor < echoMs) {
      out[out.length - 1] = t;
      continue;
    }
    anchor = t;
    out.push(t);
  }
  return out;
}

export interface Salience {
  score: number;
  urgency: WorkspaceUrgency;
  /** The member the slot shows: the most urgent one seen within 2 min of the newest. */
  lead: WorkspaceCandidate;
  newestAt: number;
  weight: number;
  recency: number;
  novelty: number;
  breadth: number;
  occurrences: number;
  /** Decayed repeat count (see the header). */
  repeats: number;
  districts: string[];
  agentIds: string[];
}

export function salience(group: WorkspaceGroup, now: number): Salience {
  const members = group.members;
  const newest = members[0];
  if (!newest) throw new Error("salience: empty group");
  const newestAt = newest.at;
  let lead = newest;
  for (const m of members) {
    if (newestAt - m.at >= WORKSPACE.echoMs) break;
    if (URGENCY_RANK[m.urgency] > URGENCY_RANK[lead.urgency]) lead = m;
  }
  const weight = URGENCY_WEIGHT[lead.urgency];
  const recency = members.some((m) => m.open === true) ? 1 : 0.5 ** (Math.max(0, now - newestAt) / WORKSPACE.halfLifeMs);
  const occurrences = occurrenceTimes(members.map((m) => m.at));
  const repeats = occurrences.reduce((sum, t) => sum + 0.5 ** ((newestAt - t) / WORKSPACE.halfLifeMs), 0);
  const districts = unique(members.flatMap((m) => m.districts));
  const perDistrict = repeats / Math.max(1, districts.length);
  const novelty = Math.max(WORKSPACE.noveltyFloor, WORKSPACE.repeatBase ** Math.max(0, perDistrict - 1));
  const breadth = 1 + WORKSPACE.breadthStep * (Math.min(Math.max(districts.length, 1), WORKSPACE.breadthMaxDistricts) - 1);
  return {
    score: weight * recency * novelty * breadth,
    urgency: lead.urgency,
    lead,
    newestAt,
    weight,
    recency,
    novelty,
    breadth,
    occurrences: occurrences.length,
    repeats,
    districts,
    agentIds: unique([...lead.agentIds, ...members.flatMap((m) => m.agentIds)]),
  };
}

/** Which groups are in the slot, and since when (ms). The only state carried between runs. */
export type WorkspaceSlot = Readonly<Record<string, number>>;

export interface WorkspaceEntry {
  key: string;
  urgency: WorkspaceUrgency;
  origin: string;
  text: string;
  at: number;
  score: number;
  /** In only because of hysteresis: under the enter threshold, above the exit one. */
  held: boolean;
  since: number;
  occurrences: number;
  districts: string[];
  agentIds: string[];
  /** One line: why it cleared the threshold. */
  reason: string;
}

export interface WorkspaceCounts {
  /** Candidates the sources produced. */
  observed: number;
  /** Inside the 2 h window. */
  candidates: number;
  /** After merging near-identical ones. */
  groups: number;
  shown: number;
  /** Groups under the threshold (enter, or exit for an incumbent). */
  belowThreshold: number;
  /** Groups urgent or broad enough to clear the enter bar at all (urgency × breadth ≥ 20, i.e.
   *  when fresh and first seen). Most signals are info that never can: this says how many compete. */
  contenders: number;
  /** Groups over the threshold that lost the slot to 5 stronger ones. */
  crowdedOut: number;
}

export interface WorkspaceResult {
  top: WorkspaceEntry[];
  slot: WorkspaceSlot;
  counts: WorkspaceCounts;
}

export function reasonText(s: Pick<Salience, "urgency" | "score" | "districts" | "occurrences">, origin: string, ageMs: number, held: boolean): string {
  const parts = [URGENCY_LABEL[s.urgency], origin, agoText(ageMs)];
  if (s.districts.length > 1) parts.push(`${s.districts.length} districts`);
  if (s.occurrences > 1) parts.push(`seen ${s.occurrences}×`);
  const bar = held ? `holding, ≥ ${WORKSPACE.exit}` : `≥ ${WORKSPACE.enter}`;
  // Floored, so a shown number never overstates the comparison (19.98 reads 19, not 20).
  return `${parts.join(" · ")} → ${Math.floor(s.score)} (${bar})`;
}

/**
 * Fills the slot: groups whose score clears the threshold (enter for newcomers, exit for groups
 * already in `prev`), the best `WORKSPACE.slots` of them with incumbents counted ×1.15, shown
 * most salient first. Deterministic for the same (candidates, prev, now).
 */
export function selectWorkspace(candidates: readonly WorkspaceCandidate[], prev: WorkspaceSlot, now: number, observed = candidates.length): WorkspaceResult {
  const scored = groupCandidates(candidates).map((g) => ({ g, s: salience(g, now), incumbent: prev[g.key] !== undefined }));
  const eligible = scored.filter((x) => x.s.score >= (x.incumbent ? WORKSPACE.exit : WORKSPACE.enter));
  const effective = (x: (typeof scored)[number]): number => x.s.score * (x.incumbent ? WORKSPACE.incumbentEdge : 1);
  const chosen = [...eligible].sort((a, b) => effective(b) - effective(a) || (a.g.key < b.g.key ? -1 : 1)).slice(0, WORKSPACE.slots);
  chosen.sort((a, b) => b.s.score - a.s.score || (a.g.key < b.g.key ? -1 : 1));
  const slot: Record<string, number> = {};
  const top = chosen.map(({ g, s }): WorkspaceEntry => {
    const since = prev[g.key] ?? now;
    slot[g.key] = since;
    const held = s.score < WORKSPACE.enter;
    return {
      key: g.key,
      urgency: s.urgency,
      origin: s.lead.origin,
      text: s.lead.text,
      at: s.newestAt,
      score: s.score,
      held,
      since,
      occurrences: s.occurrences,
      districts: s.districts,
      agentIds: s.agentIds,
      reason: reasonText(s, s.lead.origin, now - s.newestAt, held),
    };
  });
  return {
    top,
    slot,
    counts: {
      observed,
      candidates: candidates.length,
      groups: scored.length,
      shown: top.length,
      belowThreshold: scored.length - eligible.length,
      contenders: scored.filter((x) => x.s.weight * x.s.breadth >= WORKSPACE.enter).length,
      crowdedOut: eligible.length - chosen.length,
    },
  };
}

export const EMPTY_WORKSPACE: WorkspaceResult = { top: [], slot: {}, counts: { observed: 0, candidates: 0, groups: 0, shown: 0, belowThreshold: 0, contenders: 0, crowdedOut: 0 } };
