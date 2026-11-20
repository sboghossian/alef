// Pure half of the server-side Town square (workspace.ts does the IO). Three jobs:
//   1. rows: the server's own records -> the Feed rows the shared scorer reads, built the way the
//      client builds its Feed from the same events (client/src/shell/feed.ts, features/
//      feed-bridge.ts, tripwires-lib.ts; parity-tested in server/test/workspace.test.ts);
//   2. computeWorkspace: the shared scorer, exactly as client/src/features/workspace-data.ts runs it;
//   3. influence: was a Jev proposal's or a resident journal entry's subject among the entries it
//      was shown? Matched by code (a topic key, a session, a district, or shared keywords), never
//      asked of a model, and recorded with the basis so every match can be audited.

import { agentTitle } from "../../shared/display.js";
import type { FeedItem as ServerFeedItem } from "../../shared/features/feed.js";
import type { PresidentBoard, PresidentProposal } from "../../shared/features/president.js";
import type { ResidentState } from "../../shared/features/resident.js";
import type { SicknessCase } from "../../shared/features/sickness.js";
import type { RunEnding, SubagentRecord } from "../../shared/features/subagents.js";
import type { StrandedDispatch } from "../../shared/features/talk.js";
import type { TripwireHit } from "../../shared/features/tripwires.js";
import type { VillageMessage } from "../../shared/features/village.js";
import type { InfluenceBasis, InfluenceRecord, InfluenceShare, InfluenceWindow, WorkspaceSourceCounts } from "../../shared/features/workspace.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import {
  gatherCandidates,
  routineId,
  selectWorkspace,
  type AgentLookup,
  type HealthSummary,
  type WorkspaceEntry,
  type WorkspaceFeedItem,
  type WorkspaceResult,
  type WorkspaceSlot,
  type WorkspaceSources,
} from "../../shared/workspace/scorer.js";
import { keywordTokens } from "./president-lib.js";
import { oneLine } from "./resident-lib.js";
import type { InfluenceNote } from "./workspace-state.js";

// ── 1. rows ──────────────────────────────────────────────────────────────────────────────────

/** Mirrors client/src/features/feed-bridge.ts's GRADUATION_TAGS: only these "graduation" items are
 *  real graduations; the rest (career moves sharing the wire kind) are plain "system" lines. */
const GRADUATION_TAGS: ReadonlySet<string> = new Set(["shipped", "delivered", "career-trusted"]);
/** A governance decision (vision wave 3, governance-feed: kind "decision", tag "gov:<source>"): the
 *  client bridge shows Jev's own ranking ("gov:jev") as a Jev decision and every other source (a
 *  click, a council verdict, the resident, a merge) as a system line. Mirrored here. */
const GOV_PREFIX = "gov:";

function msOr(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * The server feed ring (server/features/feed.ts) -> Feed rows, plus its routine runs (the scorer's
 * `serverFeed`, as on the client). Per kind, the row the client makes of the same event:
 * activity/caption (shell/feed.ts activityToFeed, split on the stage tag), a Jev decision, an
 * approval (open until its "approval-resolved" item arrives), a server tripwire (serverTripwireToFeed),
 * a graduation (feed-bridge.ts graduationToFeed), and a Mac action as "system" (client mac.ts).
 */
export function ringRows(items: readonly ServerFeedItem[]): { feed: WorkspaceFeedItem[]; routines: ServerFeedItem[] } {
  const resolved = new Set(items.filter((i) => i.kind === "approval-resolved").map((i) => i.id.replace(/^approval-resolved:/, "")));
  const feed: WorkspaceFeedItem[] = [];
  const routines: ServerFeedItem[] = [];
  for (const i of items) {
    if (i.kind === "routine") {
      routines.push(i);
      continue;
    }
    const at = Date.parse(i.at);
    if (!Number.isFinite(at)) continue;
    // A decision's first subject can be a place ("island:…"), never a session: the client skips those too.
    const agentId = i.agentId && !i.agentId.includes(":") ? i.agentId : undefined;
    switch (i.kind) {
      case "activity":
        feed.push({ id: i.id, kind: i.tag === "reason" || i.tag === "plan" ? "caption" : "activity", at, title: i.title, agentId });
        break;
      case "decision": {
        const gov = i.tag !== null && i.tag.startsWith(GOV_PREFIX);
        feed.push({ id: gov ? `srv:${i.id}` : i.id, kind: gov && i.tag !== `${GOV_PREFIX}jev` ? "system" : "decision", at, title: i.title, agentId });
        break;
      }
      case "approval": {
        const id = i.id.replace(/^approval:/, "");
        feed.push({ id: `ap:${id}`, kind: "approval", at, title: i.title, agentId, approval: { id }, ...(resolved.has(id) ? { outcome: "answered" } : {}) });
        break;
      }
      case "approval-resolved":
        break;
      case "mac":
        feed.push({ id: i.id, kind: "system", at, title: i.title, agentId });
        break;
      case "tripwire":
        feed.push({ id: `srv:${i.id}`, kind: "tripwire", at, title: i.title, agentId });
        break;
      case "graduation":
        feed.push({ id: i.id, kind: i.tag !== null && GRADUATION_TAGS.has(i.tag) ? "graduation" : "system", at, title: i.title, agentId });
        break;
    }
  }
  return { feed, routines };
}

/** Sessions waiting on Alex now (shell/feed.ts awaitingToFeed). */
export function awaitingRows(agents: readonly WorldAgent[], nowMs: number): WorkspaceFeedItem[] {
  return agents
    .filter((a) => a.awaitingInput === true)
    .map((a) => ({ id: `wait:${a.id}:${a.lastActive}`, kind: "awaiting", at: msOr(a.lastActive, nowMs), title: `${agentTitle(a)} is waiting for your reply`, agentId: a.id, cityId: a.islandId }));
}

/** A live session repeating a written lesson (client/src/features/tripwires-lib.ts hitToFeedItem). */
export function tripwireRows(hits: readonly TripwireHit[], nowMs: number): WorkspaceFeedItem[] {
  return hits.map((h) => ({ id: `tw:${h.id}`, kind: "tripwire", at: msOr(h.at, nowMs), title: `Repeats a lesson: ${h.lesson}`, agentId: h.sessionId }));
}

/** Open sickness cases (sickness.ts openSicknessCases), at their last evidence: info, like the
 *  client's clinic lines (the scorer's 2 h window drops the old ones). The label is the case's own
 *  code-written line; the client words its clinic line from the same case (sickness-lib.ts). */
export function sicknessRows(cases: readonly SicknessCase[]): WorkspaceFeedItem[] {
  return cases.flatMap((c) => {
    const at = Date.parse(c.lastSeenAt);
    return Number.isFinite(at) ? [{ id: `sickness:${c.id}:sick`, kind: "system" as const, at, title: `Sick: ${c.label}`, agentId: c.sessionId }] : [];
  });
}

/** Everything the server knows, read now by workspace.ts. */
export interface ServerWorkspaceInput {
  ring: readonly ServerFeedItem[];
  agents: readonly WorldAgent[];
  islands: readonly Pick<Island, "id" | "path">[];
  messages: readonly VillageMessage[];
  subagents: readonly SubagentRecord[];
  runEndings: readonly RunEnding[];
  resident: ResidentState | null;
  stranded: readonly StrandedDispatch[];
  health: HealthSummary | null;
  presidentBoard: PresidentBoard | null;
  tripwireHits: readonly TripwireHit[];
  sickness: readonly SicknessCase[];
}

/** The same WorkspaceSources shape the client hands the scorer (client/src/features/workspace-data.ts). */
export function serverWorkspaceSources(i: ServerWorkspaceInput, nowMs: number): { sources: WorkspaceSources; counts: WorkspaceSourceCounts } {
  const ring = ringRows(i.ring);
  const awaiting = awaitingRows(i.agents, nowMs);
  const sources: WorkspaceSources = {
    feed: [...ring.feed, ...awaiting, ...tripwireRows(i.tripwireHits, nowMs), ...sicknessRows(i.sickness)],
    messages: i.messages,
    subagents: i.subagents,
    runEndings: i.runEndings,
    resident: i.resident,
    serverFeed: ring.routines,
    stranded: i.stranded,
    islands: i.islands.map((x) => ({ id: x.id, path: x.path })),
    health: i.health,
    presidentBoard: i.presidentBoard,
  };
  const counts: WorkspaceSourceCounts = {
    ring: ring.feed.length,
    awaiting: awaiting.length,
    messages: i.messages.length,
    subagents: i.subagents.length,
    runEndings: i.runEndings.length,
    routineRuns: ring.routines.length,
    stranded: i.stranded.length,
    tripwireHits: i.tripwireHits.length,
    sickness: i.sickness.length,
    health: i.health !== null,
    presidentBoard: i.presidentBoard !== null,
    resident: i.resident !== null,
  };
  return { sources, counts };
}

// ── 2. the scorer, as the client runs it ─────────────────────────────────────────────────────

/** One run: every candidate, then the slot (hysteresis carried in `prev`). The client's
 *  WorkspaceData.update does exactly this; the parity test holds the two together. */
export function computeWorkspace(sources: WorkspaceSources, lookup: AgentLookup, prev: WorkspaceSlot, nowMs: number): WorkspaceResult {
  const { observed, candidates } = gatherCandidates(sources, lookup, nowMs);
  return selectWorkspace(candidates, prev, nowMs, observed);
}

// ── 3. influence ─────────────────────────────────────────────────────────────────────────────

/** Words every town line shares (on top of president-lib's STOPWORDS), including the scorer's own
 *  boilerplate ("failed: …", "Launch waiting on you: … - empty prompt") and its failure reasons
 *  ("interrupted (cause unknown)", "API Error: …"): two of these in common says nothing about
 *  sharing a subject. Every "words" match records its words, so a bad one can be audited. */
const TOWN_WORDS: ReadonlySet<string> = new Set(
  (
    "session sessions live waiting wait reply replied failed failing failure fails error errors exit running runs run started start ended finished done " +
    "district districts town square hour hours minute minutes today yesterday noticed active quiet busy steady stuck subagent subagents agent agents " +
    "handed back launch launched launches health check checks propose proposes proposal proposals resident journal alex world alef fleet " +
    "workflow workflows automation automated routine routines message messages build builds test tests repeats lesson lessons fix " +
    "interrupted cause unknown reason overloaded timeout timed killed stopped exited empty prompt prompts dialog screen unrecognized menu " +
    "repo repos code folder folders path open opened still again new"
  ).split(" "),
);

/** Distinct lowercase keywords of 4+ letters, minus filler and town-generic words. */
export function subjectWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of keywordTokens(text)) if (!TOWN_WORDS.has(w)) out.add(w);
  return out;
}

/** Shared keywords needed for a "words" match. */
export const MIN_SHARED_WORDS = 2;
/** A proposal counts once per this window, however often it re-enters the board. */
export const PROPOSAL_RECORD_WINDOW_MS = 24 * 60 * 60_000;
const SUBJECT_MAX = 200;

interface Subjects {
  keys: ReadonlySet<string>;
  sessions: ReadonlySet<string>;
  districts: ReadonlySet<string>;
  words: ReadonlySet<string>;
}

function proposalLine(p: PresidentProposal): string {
  return p.kind === "session" ? p.task : p.kind === "commencement" ? p.title : `merge ${p.districts.join(", ")} into ${p.into}`;
}

/** What a proposal is about, in the terms workspace entries carry. `sessionOfCase` maps a sickness
 *  case id to its session (sickness.ts openSicknessCases). */
export function proposalSubjects(p: PresidentProposal, sessionOfCase: (caseId: string) => string | undefined): Subjects {
  if (p.kind === "merge") return { keys: new Set(), sessions: new Set(), districts: new Set(p.districts), words: new Set() };
  if (p.kind === "commencement") {
    return { keys: new Set(p.routine ? [`routine-failed:${routineId(p.routine)}`] : []), sessions: new Set(), districts: new Set(), words: subjectWords(`${p.subject} ${p.title}`) };
  }
  const keys = p.origin === "health" && p.id.startsWith("health-") ? [`health:${p.id.slice("health-".length)}`] : [];
  const sessions = (p.caseIds ?? []).flatMap((id) => {
    const s = sessionOfCase(id);
    return s ? [s] : [];
  });
  return { keys: new Set(keys), sessions: new Set(sessions), districts: new Set(), words: subjectWords(p.task) };
}

const BASIS_RANK: Readonly<Record<InfluenceBasis, number>> = { topic: 3, session: 2, district: 1, words: 0 };

/** The strongest basis on which `subjects` matches any of `shown`, the keys of every entry it
 *  matched, and (for a words match) the shared keywords. */
export function matchSubjects(subjects: Subjects, shown: readonly WorkspaceEntry[]): { basis: InfluenceBasis | null; matched: string[]; words: string[] } {
  let basis: InfluenceBasis | null = null;
  const matched: string[] = [];
  const words = new Set<string>();
  for (const e of shown) {
    let b: InfluenceBasis | null = null;
    if (subjects.keys.has(e.key)) b = "topic";
    else if (e.agentIds.some((id) => subjects.sessions.has(id))) b = "session";
    else if (e.districts.some((d) => subjects.districts.has(d))) b = "district";
    else {
      const shared = [...subjectWords(e.text)].filter((w) => subjects.words.has(w));
      if (shared.length >= MIN_SHARED_WORDS) {
        b = "words";
        for (const w of shared) words.add(w);
      }
    }
    if (b === null) continue;
    matched.push(e.key);
    if (basis === null || BASIS_RANK[b] > BASIS_RANK[basis]) basis = b;
  }
  return { basis, matched, words: basis === "words" ? [...words].sort() : [] };
}

/** One note -> its record. */
export function influenceRecord(n: InfluenceNote, sessionOfCase: (caseId: string) => string | undefined): InfluenceRecord {
  const at = new Date(n.at).toISOString();
  const shown = n.shown ?? [];
  if (n.source === "jev") {
    const m = matchSubjects(proposalSubjects(n.proposal, sessionOfCase), shown);
    return {
      id: `jev:${n.proposal.id}:${at}`,
      source: "jev",
      at,
      proposalId: n.proposal.id,
      subject: oneLine(proposalLine(n.proposal), SUBJECT_MAX),
      rankedBy: n.rankedBy,
      shown: n.shown ? n.shown.length : null,
      about: m.basis !== null,
      ...m,
    };
  }
  const m = matchSubjects({ keys: new Set(), sessions: new Set(), districts: new Set(), words: subjectWords(n.journal) }, shown);
  return { id: `resident:${at}`, source: "resident", at, subject: oneLine(n.journal, SUBJECT_MAX), shown: n.shown ? n.shown.length : null, about: m.basis !== null, ...m };
}

/** True when this proposal already has a record less than PROPOSAL_RECORD_WINDOW_MS old. */
export function recordedRecently(records: readonly InfluenceRecord[], proposalId: string, atMs: number): boolean {
  return records.some((r) => r.proposalId === proposalId && atMs - Date.parse(r.at) < PROPOSAL_RECORD_WINDOW_MS);
}

const BASES: readonly InfluenceBasis[] = ["topic", "session", "district", "words"];

export function influenceShare(records: readonly InfluenceRecord[]): InfluenceShare {
  const byBasis = Object.fromEntries(BASES.map((b) => [b, 0])) as Record<InfluenceBasis, number>;
  let withBroadcast = 0;
  let about = 0;
  for (const r of records) {
    if (r.shown !== null && r.shown > 0) withBroadcast++;
    if (r.about && r.basis) {
      about++;
      byBasis[r.basis]++;
    }
  }
  return { records: records.length, withBroadcast, about, share: withBroadcast > 0 ? about / withBroadcast : null, byBasis };
}

export function influenceWindow(records: readonly InfluenceRecord[]): InfluenceWindow {
  return {
    jev: influenceShare(records.filter((r) => r.source === "jev" && r.rankedBy === "jev")),
    rules: influenceShare(records.filter((r) => r.source === "jev" && r.rankedBy === "rules")),
    resident: influenceShare(records.filter((r) => r.source === "resident")),
  };
}

export const INFLUENCE_METHOD =
  "Per Jev proposal (once per 24 h) and per resident reflection: the entries of the Town square it was shown (minus its own), and whether its subject matched one: " +
  "the same topic key (a Health check, a routine's failure), a shared session (a treated sickness case), a shared district (a merge), or at least 2 shared distinctive keywords. " +
  "share = about / withBroadcast. Proposals the rules fallback ranked never read the broadcast: they are the baseline. A match says the subject was in the square, not that the square caused it.";

// ── persistence (the jsonl lines workspace.ts appends) ──────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isInfluenceRecord(v: unknown): v is InfluenceRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.source === "jev" || o.source === "resident") &&
    typeof o.at === "string" &&
    Number.isFinite(Date.parse(o.at)) &&
    typeof o.subject === "string" &&
    (o.proposalId === undefined || typeof o.proposalId === "string") &&
    (o.rankedBy === undefined || o.rankedBy === "jev" || o.rankedBy === "rules") &&
    (o.shown === null || (typeof o.shown === "number" && o.shown >= 0)) &&
    typeof o.about === "boolean" &&
    (o.basis === null || (typeof o.basis === "string" && (BASES as readonly string[]).includes(o.basis))) &&
    isStringArray(o.matched) &&
    isStringArray(o.words)
  );
}

/** A jsonl file's text -> its valid records, one per id (a later line wins), oldest first. */
export function parseInfluenceLines(text: string): InfluenceRecord[] {
  const byId = new Map<string, InfluenceRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (isInfluenceRecord(v)) {
      byId.delete(v.id);
      byId.set(v.id, v);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
