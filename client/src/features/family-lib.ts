// Pure logic for "generations and crews" (vision wave 4). No DOM, no I/O: family-lib.test.ts runs
// it directly.
//
// FAMILY: a session and every subagent record whose parentSessionId is that session (GET
// /api/subagents, ?parent=<id> for one session), linked by parentAgentId: null = spawned by the
// session itself, set = spawned by that subagent. Generation 1 is the session, 2 its children, 3
// their children (the server's `depth` + 1). The drone panel draws it as a tree; the house panel's
// Subagents list uses the same order, so a grandchild is always drawn under its real parent.
//
// CREW ("shipped together"): 2+ DISTINCT sessions whose session-outcomes records name the same
// MERGED PR (owner/repo#n, from GET /api/outcomes rows' mergedPrs). It is the only "merge" signal
// Alef has: ✅ 0 of 204 transcripts continue another session. A subagent handing its result back to
// its parent is family, never a crew: subagents have no outcome record, only session rows are read
// here, and a session counts once per PR however often it names it. Anywhere neither signal
// exists, "merge" stays a metaphor and the UI says so. "No crew" is only said once the server's
// first scan of the records is done (GET /api/outcomes scan.coldDone): until then a session may be
// unread or its PRs unasked, so it is "not known yet" (a crew already found still shows).
//
// Descriptions and titles are untrusted: returned as data, rendered by the callers with textContent.

import { shipCrews, type CrewCounts, type SessionPrs, type ShipCrew } from "../../../shared/features/crews";
import type { OutcomeMergedPr } from "../../../shared/features/outcomes";
import type { SubagentRecord } from "../../../shared/features/subagents";
import { generationChain, prUrl } from "./census-lib";

// The crew count itself is shared with the vision ledger's crews probe (one function, one count).
export { crewCounts, shipCrews, type CrewCounts, type SessionPrs, type ShipCrew } from "../../../shared/features/crews";

// ---------------------------------------------------------------- family tree

export interface FamilyNode {
  record: SubagentRecord;
  children: FamilyNode[];
  /** Its parentAgentId names a subagent that isn't in the records (not loaded, or a cycle): it is
   *  drawn under the session instead. */
  orphan: boolean;
}

export interface Family {
  sessionId: string;
  /** The session's children, oldest first, each with its own subtree; orphans are listed here too. */
  roots: FamilyNode[];
  /** Subagent records in the family. */
  size: number;
  /** Headcount per depth (1 = a child of the session), as the server's `depth` says. */
  byDepth: Record<number, number>;
  /** 1 (the session) + the deepest depth; 1 when it spawned nothing. */
  generations: number;
}

function byStart(a: SubagentRecord, b: SubagentRecord): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The family of `sessionId` among `records` (any mix of sessions; duplicates by id collapse). */
export function familyOf(records: Iterable<SubagentRecord>, sessionId: string): Family {
  const members = new Map<string, SubagentRecord>();
  for (const r of records) if (r.parentSessionId === sessionId) members.set(r.id, r);
  const kids = new Map<string, SubagentRecord[]>();
  for (const r of members.values()) {
    const p = r.parentAgentId;
    if (p === null || p === r.id || !members.has(p)) continue;
    const list = kids.get(p);
    if (list) list.push(r);
    else kids.set(p, [r]);
  }
  for (const list of kids.values()) list.sort(byStart);

  const visited = new Set<string>();
  const build = (r: SubagentRecord, orphan: boolean): FamilyNode => {
    visited.add(r.id);
    const children: FamilyNode[] = [];
    for (const k of kids.get(r.id) ?? []) if (!visited.has(k.id)) children.push(build(k, false));
    return { record: r, children, orphan };
  };
  const sorted = [...members.values()].sort(byStart);
  const roots: FamilyNode[] = [];
  for (const r of sorted) if (r.parentAgentId === null && !visited.has(r.id)) roots.push(build(r, false));
  // Anything not reached from the session (its parent isn't loaded, or a parentAgentId cycle) is
  // still drawn, exactly once, under the session.
  for (const r of sorted) if (!visited.has(r.id)) roots.push(build(r, true));
  roots.sort((a, b) => byStart(a.record, b.record));

  const byDepth: Record<number, number> = {};
  let deepest = 0;
  for (const r of members.values()) {
    if (!Number.isInteger(r.depth) || r.depth < 1) continue;
    byDepth[r.depth] = (byDepth[r.depth] ?? 0) + 1;
    deepest = Math.max(deepest, r.depth);
  }
  return { sessionId, roots, size: members.size, byDepth, generations: 1 + deepest };
}

/** "3 generations: 1 session → 57 children → 4 grandchildren" (census-lib's words and order). */
export function generationLine(f: Family): string {
  if (f.size === 0) return "1 generation: no subagent of this session is on record.";
  const chain = generationChain({ total: f.size, since: null, byDepth: f.byDepth, generations: f.generations, parents: 1 });
  return `${f.generations} generation${f.generations === 1 ? "" : "s"}: ${chain.join(" → ")}`;
}

export interface TreeRow {
  record: SubagentRecord;
  /** Its level in the drawn tree: 1 = under the session, 2 = under a child, … */
  level: number;
  /** The subagent whose panel is open. */
  focus: boolean;
  orphan: boolean;
  /** Its own children in the family, drawn or not. */
  kids: number;
}

/**
 * The rows to draw, in tree order (each node right before its children, siblings oldest first),
 * at most `limit` of them. Which ones, when the family is bigger: the focused subagent's line
 * (its ancestors, itself: always), then its children, running ones, every node that has children
 * and those children (so the generations show), then the rest in tree order. A row is only ever
 * drawn with all its ancestors, so it always sits under its real parent. `hidden` = not drawn.
 */
export function treeRows(f: Family, opts: { focusId?: string | null; limit: number }): { rows: TreeRow[]; hidden: number } {
  interface Placed {
    node: FamilyNode;
    level: number;
    parent: string | null;
  }
  const order: Placed[] = [];
  const placed = new Map<string, Placed>();
  const walk = (node: FamilyNode, level: number, parent: string | null): void => {
    const p = { node, level, parent };
    order.push(p);
    placed.set(node.record.id, p);
    for (const c of node.children) walk(c, level + 1, node.record.id);
  };
  for (const r of f.roots) walk(r, 1, null);

  const lineOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null = id; cur !== null && out.length <= order.length; cur = placed.get(cur)?.parent ?? null) {
      if (!placed.has(cur)) break;
      out.push(cur);
    }
    return out;
  };
  const keep = new Set<string>();
  const focus = opts.focusId && placed.has(opts.focusId) ? opts.focusId : null;
  if (focus) for (const id of lineOf(focus)) keep.add(id);
  const offer = (id: string): void => {
    const need = lineOf(id).filter((x) => !keep.has(x));
    if (need.length > 0 && keep.size + need.length <= opts.limit) for (const x of need) keep.add(x);
  };
  if (focus) for (const c of placed.get(focus)?.node.children ?? []) offer(c.record.id);
  for (const p of order) if (p.node.record.status === "running") offer(p.node.record.id);
  for (const p of order) {
    if (p.node.children.length === 0) continue;
    offer(p.node.record.id);
    for (const c of p.node.children) offer(c.record.id);
  }
  for (const p of order) offer(p.node.record.id);

  const rows = order
    .filter((p) => keep.has(p.node.record.id))
    .map((p) => ({ record: p.node.record, level: p.level, focus: p.node.record.id === focus, orphan: p.node.orphan, kids: p.node.children.length }));
  return { rows, hidden: order.length - rows.length };
}

// ---------------------------------------------------------------- crews (shipped together)

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMergedPr(v: unknown): OutcomeMergedPr | null {
  // Same shape as the server's normalizeRepo: owner/repo, neither part all dots ("../x" is no repo).
  if (!isRecord(v) || typeof v.repo !== "string" || !REPO_RE.test(v.repo) || v.repo.split("/").some((part) => /^\.+$/.test(part))) return null;
  if (typeof v.number !== "number" || !Number.isInteger(v.number) || v.number < 1 || v.number > 999_999_999) return null;
  const mergedAt = typeof v.mergedAt === "string" && ISO_RE.test(v.mergedAt) ? v.mergedAt : null;
  return { repo: v.repo.toLowerCase(), number: v.number, mergedAt };
}

/** A GET /api/outcomes body → each session's merged PRs. Null when it isn't that shape, or when a
 *  row has no mergedPrs list (a server from before crews): then crews are unknown, never "none".
 *  Malformed PR entries are dropped (a repo that isn't owner/repo can't become a link). */
export function parseOutcomePrs(body: unknown): SessionPrs[] | null {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.outcomes)) return null;
  const out: SessionPrs[] = [];
  for (const row of body.outcomes) {
    if (!isRecord(row) || typeof row.sessionId !== "string" || row.sessionId.length === 0 || row.sessionId.length > 64) continue;
    if (!Array.isArray(row.mergedPrs)) return null;
    out.push({ sessionId: row.sessionId, mergedPrs: row.mergedPrs.map(parseMergedPr).filter((p): p is OutcomeMergedPr => p !== null) });
  }
  return out;
}

/** How far the server's first scan of the outcome records is (GET /api/outcomes `scan`). It runs
 *  after every store restart (a fresh install, a store version bump): until it is done, a session
 *  may have no row yet, or a row whose PRs gh wasn't asked about yet. */
export interface RecordsScan {
  /** scan.coldDone is true: every dormant transcript was read and every PR asked about once. */
  done: boolean;
  /** Transcripts and PRs still to go after the server's last tick; null before its first tick
   *  (its counts are 0 then, not "nothing left") or when the body doesn't say. */
  left: { sessions: number; prChecks: number } | null;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The scan in a GET /api/outcomes body. Missing or malformed is never "done". */
export function parseRecordsScan(body: unknown): RecordsScan {
  const scan = isRecord(body) && isRecord(body.scan) ? body.scan : null;
  if (!scan) return { done: false, left: null };
  const left = isRecord(scan.lastTick) && isCount(scan.pendingSessions) && isCount(scan.pendingPrChecks) ? { sessions: scan.pendingSessions, prChecks: scan.pendingPrChecks } : null;
  return { done: scan.coldDone === true, left };
}

export interface CrewView {
  repo: string;
  number: number;
  /** Built from repo + number alone (census-lib prUrl), never from text a record carries. */
  url: string;
  mergedAt: string | null;
  /** The other sessions, sorted. */
  partners: string[];
}

/** The crews `sessionId` belongs to, in shipCrews' order. */
export function crewsFor(sessionId: string, crews: readonly ShipCrew[]): CrewView[] {
  return crews
    .filter((c) => c.sessions.includes(sessionId))
    .map((c) => ({ repo: c.repo, number: c.number, url: prUrl(c.repo, c.number), mergedAt: c.mergedAt, partners: c.sessions.filter((s) => s !== sessionId) }));
}

export interface CrewsHeld {
  /** When this was read (ms). */
  at: number;
  rows: SessionPrs[];
  crews: ShipCrew[];
  /** The server's scan as that same read said it: "no crew" is only claimed when it is done. */
  scan: RecordsScan;
}

/**
 * The client's copy of the crews (outcomes.ts reads GET /api/outcomes through it): when to read
 * again, and what to show meanwhile. A read is due when nothing is held, the copy is older than
 * the TTL, or a verdict changed since the read that produced it began (invalidate() during a read
 * in flight keeps it due afterwards: that read may predate the change). One read at a time. A
 * failed or unparsable read keeps the last good copy (and is retried after the TTL); with none,
 * `held` stays null and `unknown` says why.
 */
export class CrewCache {
  held: CrewsHeld | null = null;
  /** True once a read failed and there is no good copy: the crews are unknown, never "none". */
  unknown = false;
  private loading = false;
  private stale = false;
  private gen = 0;
  private readGen = 0;
  private lastTry = -Infinity;

  constructor(private readonly ttlMs = 60_000) {}

  due(nowMs: number): boolean {
    if (this.loading) return false;
    if (this.stale) return true;
    const last = this.held ? Math.max(this.held.at, this.lastTry) : this.lastTry;
    return nowMs - last >= this.ttlMs;
  }

  begin(nowMs: number): void {
    this.loading = true;
    this.readGen = this.gen;
    this.lastTry = nowMs;
    this.stale = false;
  }

  /** `body`: what GET /api/outcomes returned (null when the request failed). */
  settle(body: unknown, nowMs: number): void {
    this.loading = false;
    const rows = parseOutcomePrs(body);
    if (rows) {
      this.held = { at: nowMs, rows, crews: shipCrews(rows), scan: parseRecordsScan(body) };
      this.unknown = false;
    } else if (!this.held) this.unknown = true;
    if (this.gen !== this.readGen) this.stale = true;
  }

  invalidate(): void {
    this.gen += 1;
    this.stale = true;
  }
}

/** Hover text for the section: what a crew is, and why "merge" is otherwise a metaphor. */
export const CREW_RULE =
  "A crew is 2 or more sessions whose own transcripts name the same merged PR (session outcomes). It is the only 'merge' signal Alef has: no transcript continues another session, and a subagent handing its result back to its parent is family (its drones), not a merge.";

const SCANNING = "the server's first scan of the outcome records";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The line for a session in no crew. `merged` = its merged PRs; null = it has no outcome record.
 *  Scoped to the records: a merge they can't see (`gh pr merge $n`, a bare `gh pr merge`) leaves
 *  no sighting, so "no crew" is only ever claimed for what is on record, and only once the scan
 *  that fills them is done (before that, a missing row or merged PR is not known yet). */
export function noCrewText(merged: number | null, scan: RecordsScan): string {
  if (!scan.done) {
    const parts: string[] = [];
    if (scan.left && scan.left.sessions > 0) parts.push(`${plural(scan.left.sessions, "transcript")} left to read`);
    if (scan.left && scan.left.prChecks > 0) parts.push(`${plural(scan.left.prChecks, "PR")} left to check`);
    return `Not known yet: ${SCANNING} is still running${parts.length ? ` (${parts.join(", ")})` : ""}, so a crew may still turn up.`;
  }
  if (merged === null) return "No outcome record for this session, so no crew.";
  if (merged === 0) return "No merged PR, so no crew: merging with another session stays a metaphor here.";
  return `No other session's outcome record names ${merged === 1 ? "its merged PR" : `any of its ${merged} merged PRs`}, so no crew on record.`;
}

/** "1 crew town-wide: 2 sessions shipped a merged PR with another." / "No crews town-wide: …";
 *  while the server's first scan runs, a count "so far" and never "no crews". */
export function townCrewLine(c: CrewCounts, scan: RecordsScan): string {
  if (!scan.done && c.crews === 0) return `Crews town-wide: not known until ${SCANNING} ends.`;
  if (c.crews === 0) return "No crews town-wide: no merged PR is named by two sessions.";
  const line = `${plural(c.crews, "crew")} town-wide${scan.done ? "" : " so far"}: ${plural(c.sessions, "session")} shipped a merged PR with another.`;
  return scan.done ? line : `${line} The server's first scan of the outcome records is still running.`;
}
