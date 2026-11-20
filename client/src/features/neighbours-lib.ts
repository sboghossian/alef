// Pure half of the client "neighbours" feature (no DOM): who a session worked alongside, and
// where it went, read only from signals the world already serves.
//   - co-workers: other sessions with a `touched` edge to the same `file:` object;
//   - crew: sessions on the same island whose first-to-last MESSAGE windows overlap AND that
//     share a `repo:` or `file:` object. The windows come from the server's neighbours feature
//     (user and assistant lines only), never from WorldAgent.startedAt / lastActive: the indexer
//     moves those on any timestamped line (queue-operation, frame-link…) or the file's mtime;
//   - trips: the session's `visited` edges (server/trips-lib.ts: its touched files in another
//     island's folder; a touch is a Read, Edit, Write, Glob or Grep, so "read or edited");
//   - messages: village SendMessage traffic whose two ends both resolved to sessions.
// A `repo:` touched edge is NOT a shared file: the indexer writes one for the git root of every
// session's cwd (server/indexer.ts), whether or not it touched anything, so it only feeds crews.
// Every row carries its evidence (file names, counts, dates). Nothing here is called a friend.

import type { MessageWindow } from "../../../shared/features/neighbours";
import type { VillageMessage } from "../../../shared/features/village";
import type { WorldAgent, WorldEdge } from "../../../shared/types";

export const FILE_PREFIX = "file:";
export const REPO_PREFIX = "repo:";
/** Rows shown per section; the heading says how many there are in all. */
export const SECTION_LIMIT = 5;
const FILES_NAMED_PER_ROW = 3;

/** Edges indexed once per edge-set change: every lookup below is a map read. */
export interface NeighbourIndex {
  /** session id → (file object id → its newest touch, ISO) */
  readonly filesOf: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** file object id → the sessions that touched it */
  readonly touchersOfFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** session id → repo object ids (the git root of its cwd) */
  readonly reposOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** repo object id → the sessions under it */
  readonly membersOfRepo: ReadonlyMap<string, ReadonlySet<string>>;
  /** session id → its trips, newest first */
  readonly tripsOf: ReadonlyMap<string, readonly Trip[]>;
}

export interface Coworker {
  agentId: string;
  /** Shared file paths ("file:" stripped), newest touch first. */
  files: string[];
  /** The newest touch either session made on any shared file. */
  at: string;
}

export interface Crew {
  agentId: string;
  /** Shared repo roots ("repo:" stripped), sorted. */
  repos: string[];
  /** How many files both sessions touched. */
  sharedFiles: number;
  overlapStart: string;
  overlapEnd: string;
  overlapMs: number;
}

export interface Trip {
  islandId: string;
  /** Newest touch there. */
  at: string;
  /** Sum of the touched-edge weights on that island's files. */
  touches: number;
}

export interface NeighbourMessage {
  id: string;
  /** "to": this session sent it; "from": this session received it. */
  direction: "to" | "from";
  counterpartId: string;
  at: string;
  preview: string;
}

export type AgentHome = Pick<WorldAgent, "id" | "islandId">;
/** A session's first and last user or assistant line (ISO), as the server serves them. */
export type ActiveWindow = Pick<MessageWindow, "first" | "last">;

const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function isMessageWindow(v: unknown): v is MessageWindow {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Partial<Record<keyof MessageWindow, unknown>>;
  return typeof w.id === "string" && isIso(w.first) && isIso(w.last);
}

/** The well-formed rows of an untrusted list (snapshot extras or a WS push); the rest are dropped, so those sessions get no crew. */
export function validWindows(list: unknown): MessageWindow[] {
  return Array.isArray(list) ? list.filter(isMessageWindow) : [];
}

function edgeKey(e: Pick<WorldEdge, "from" | "to" | "kind">): string {
  return `${e.from}\u0000${e.to}\u0000${e.kind}`;
}

/** The served edge set, one edge per (from, to, kind); a later copy wins. */
export function edgeMap(edges: Iterable<WorldEdge>): Map<string, WorldEdge> {
  const out = new Map<string, WorldEdge>();
  for (const e of edges) out.set(edgeKey(e), e);
  return out;
}

/** True when both maps hold the same edges with the same weight and time. */
export function sameEdges(a: ReadonlyMap<string, WorldEdge>, b: ReadonlyMap<string, WorldEdge>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, e] of a) {
    const other = b.get(key);
    if (!other || other.weight !== e.weight || other.at !== e.at) return false;
  }
  return true;
}

/** Drops every edge from a removed session. */
export function dropEdgesFrom(into: Map<string, WorldEdge>, agentIds: Iterable<string>): boolean {
  const gone = new Set(agentIds);
  let changed = false;
  for (const [key, e] of into) {
    if (!gone.has(e.from)) continue;
    into.delete(key);
    changed = true;
  }
  return changed;
}

function addTo<V>(map: Map<string, Set<V>>, key: string, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/**
 * One pass over the edges. Duplicates of a touched edge keep the newest time; of a visit, the last
 * copy. A `file:` object is also made from a Glob/Grep `path` (server/jsonl-events.ts), which can be
 * a folder: one that is a repo root in these edges, one of `folderPaths` (the island folders) or one
 * ending in "/" is not a file, so it never makes co-workers. Deeper folders can't be told apart here.
 */
export function indexEdges(edgeList: Iterable<WorldEdge>, folderPaths: Iterable<string> = []): NeighbourIndex {
  const edges = [...edgeList];
  const folders = new Set<string>(folderPaths);
  for (const e of edges) if (e.kind === "touched" && e.to.startsWith(REPO_PREFIX)) folders.add(e.to.slice(REPO_PREFIX.length));
  const filesOf = new Map<string, Map<string, string>>();
  const touchersOfFile = new Map<string, Set<string>>();
  const reposOf = new Map<string, Set<string>>();
  const membersOfRepo = new Map<string, Set<string>>();
  const visits = new Map<string, Map<string, Trip>>();
  for (const e of edges) {
    if (e.kind === "touched" && e.to.startsWith(FILE_PREFIX)) {
      const path = e.to.slice(FILE_PREFIX.length);
      if (path.endsWith("/") || folders.has(path)) continue;
      let files = filesOf.get(e.from);
      if (!files) filesOf.set(e.from, (files = new Map()));
      const prev = files.get(e.to);
      if (prev === undefined || e.at > prev) files.set(e.to, e.at);
      addTo(touchersOfFile, e.to, e.from);
    } else if (e.kind === "touched" && e.to.startsWith(REPO_PREFIX)) {
      addTo(reposOf, e.from, e.to);
      addTo(membersOfRepo, e.to, e.from);
    } else if (e.kind === "visited") {
      let mine = visits.get(e.from);
      if (!mine) visits.set(e.from, (mine = new Map()));
      mine.set(e.to, { islandId: e.to, at: e.at, touches: e.weight });
    }
  }
  const tripsOf = new Map<string, Trip[]>();
  for (const [id, byIsland] of visits) {
    tripsOf.set(id, [...byIsland.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.islandId < b.islandId ? -1 : 1)));
  }
  return { filesOf, touchersOfFile, reposOf, membersOfRepo, tripsOf };
}

const known = (isKnown: ((id: string) => boolean) | undefined, id: string): boolean => !isKnown || isKnown(id);

/** Sessions sharing at least one touched file with `agentId`: most shared files first, then newest. */
export function coworkers(agentId: string, index: NeighbourIndex, isKnown?: (id: string) => boolean): Coworker[] {
  const mine = index.filesOf.get(agentId);
  if (!mine) return [];
  const acc = new Map<string, Array<{ file: string; at: string }>>();
  for (const [fileId, myAt] of mine) {
    for (const other of index.touchersOfFile.get(fileId) ?? []) {
      if (other === agentId || !known(isKnown, other)) continue;
      const theirAt = index.filesOf.get(other)?.get(fileId) ?? myAt;
      const row = { file: fileId.slice(FILE_PREFIX.length), at: theirAt > myAt ? theirAt : myAt };
      const list = acc.get(other);
      if (list) list.push(row);
      else acc.set(other, [row]);
    }
  }
  const out: Coworker[] = [];
  for (const [id, rows] of acc) {
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.file < b.file ? -1 : 1));
    out.push({ agentId: id, files: rows.map((r) => r.file), at: rows[0]?.at ?? "" });
  }
  return out.sort((a, b) => b.files.length - a.files.length || (a.at < b.at ? 1 : a.at > b.at ? -1 : a.agentId < b.agentId ? -1 : 1));
}

/**
 * Sessions on `agentId`'s island whose first-to-last message window overlaps its own and that
 * share a repo or a file with it: the longest overlap first, then the most recent. A session with
 * no known window (none served yet) is never crew.
 */
export function crews(agentId: string, agents: ReadonlyMap<string, AgentHome>, windows: ReadonlyMap<string, ActiveWindow>, index: NeighbourIndex): Crew[] {
  const me = agents.get(agentId);
  const mine = windows.get(agentId);
  if (!me || !mine) return [];
  const myStart = Date.parse(mine.first);
  const myEnd = Date.parse(mine.last);
  if (!Number.isFinite(myStart) || !Number.isFinite(myEnd)) return [];
  const repos = new Map<string, string[]>();
  for (const repoId of index.reposOf.get(agentId) ?? []) {
    for (const other of index.membersOfRepo.get(repoId) ?? []) {
      const list = repos.get(other);
      if (list) list.push(repoId.slice(REPO_PREFIX.length));
      else repos.set(other, [repoId.slice(REPO_PREFIX.length)]);
    }
  }
  const files = new Map<string, number>();
  for (const fileId of index.filesOf.get(agentId)?.keys() ?? []) {
    for (const other of index.touchersOfFile.get(fileId) ?? []) files.set(other, (files.get(other) ?? 0) + 1);
  }
  const out: Crew[] = [];
  for (const id of new Set([...repos.keys(), ...files.keys()])) {
    if (id === agentId) continue;
    const other = agents.get(id);
    const theirs = windows.get(id);
    if (!other || !theirs || other.islandId !== me.islandId) continue;
    const start = Math.max(myStart, Date.parse(theirs.first));
    const end = Math.min(myEnd, Date.parse(theirs.last));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({
      agentId: id,
      repos: (repos.get(id) ?? []).sort(),
      sharedFiles: files.get(id) ?? 0,
      overlapStart: new Date(start).toISOString(),
      overlapEnd: new Date(end).toISOString(),
      overlapMs: end - start,
    });
  }
  return out.sort((a, b) => b.overlapMs - a.overlapMs || (a.overlapEnd < b.overlapEnd ? 1 : a.overlapEnd > b.overlapEnd ? -1 : a.agentId < b.agentId ? -1 : 1));
}

/** The session's visits to other islands, newest first. */
export function trips(agentId: string, index: NeighbourIndex): readonly Trip[] {
  return index.tripsOf.get(agentId) ?? [];
}

/** A "received" row this far before its "sent" copy, or less, can still be that copy (clock skew). */
const PAIR_SKEW_MS = 60_000;

interface MessageRow {
  m: VillageMessage;
  from: string;
  to: string;
}

/**
 * Messages this session sent to or got from another session, both ends resolved (an unresolved
 * name is never guessed). One real message can be observed twice, "sent" off the sender's call and
 * "received" off the receiver's transcript: each "received" row pairs with the latest unpaired
 * "sent" row with the same ends and text at or before it, and is then dropped. Two messages with the
 * same text stay two rows. Newest first.
 */
export function neighbourMessages(agentId: string, messages: readonly VillageMessage[], isKnown?: (id: string) => boolean): NeighbourMessage[] {
  const rows: MessageRow[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    const from = m.fromSessionId;
    const to = m.toSessionId;
    if (from === null || to === null || from === to || seen.has(m.id)) continue;
    if (from !== agentId && to !== agentId) continue;
    if (!known(isKnown, from === agentId ? to : from)) continue;
    seen.add(m.id);
    rows.push({ m, from, to });
  }
  rows.sort((a, b) => (a.m.at < b.m.at ? -1 : a.m.at > b.m.at ? 1 : a.m.id < b.m.id ? -1 : 1));
  const keyOf = (r: MessageRow): string => `${r.from}\u0000${r.to}\u0000${r.m.preview}`;
  const toRow = ({ m, from, to }: MessageRow): NeighbourMessage => ({
    id: m.id,
    direction: from === agentId ? "to" : "from",
    counterpartId: from === agentId ? to : from,
    at: m.at,
    preview: m.preview,
  });
  // Every "sent" row is shown; its send times (ascending) wait for a "received" copy.
  const unpairedSent = new Map<string, number[]>();
  const out: NeighbourMessage[] = [];
  for (const r of rows) {
    if (r.m.direction !== "sent") continue;
    const sends = unpairedSent.get(keyOf(r));
    if (sends) sends.push(Date.parse(r.m.at));
    else unpairedSent.set(keyOf(r), [Date.parse(r.m.at)]);
    out.push(toRow(r));
  }
  // A "received" row is shown only when no unpaired "sent" copy exists at or before it (plus skew).
  for (const r of rows) {
    if (r.m.direction !== "received") continue;
    const sends = unpairedSent.get(keyOf(r)) ?? [];
    const latest = Date.parse(r.m.at) + PAIR_SKEW_MS;
    let i = sends.length - 1;
    while (i >= 0 && (sends[i] ?? Infinity) > latest) i--;
    if (i >= 0) sends.splice(i, 1);
    else out.push(toRow(r));
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
}

export interface PairCount {
  pairs: number;
  sessions: number;
}

function countPairs(groups: Iterable<ReadonlySet<string>>): PairCount {
  const pairs = new Set<string>();
  for (const members of groups) {
    const ids = [...members].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.add(`${ids[i]}\u0000${ids[j]}`);
  }
  const sessions = new Set<string>();
  for (const p of pairs) for (const id of p.split("\u0000")) sessions.add(id);
  return { pairs: pairs.size, sessions: sessions.size };
}

// Measurement only (the PR's recount against the vision plan's figure); the panel never calls these.

/** Session pairs that share at least one touched FILE, and the sessions in any such pair (what the panel shows). */
export function coworkerPairCount(index: NeighbourIndex): PairCount {
  return countPairs(index.touchersOfFile.values());
}

/** Pairs that share any touched object, a file OR a repo root: the vision plan's 877 / 118 count (03:21Z). */
export function sharedTouchPairCount(index: NeighbourIndex): PairCount {
  return countPairs([...index.touchersOfFile.values(), ...index.membersOfRepo.values()]);
}

// ---------------------------------------------------------------- rows for the agent panel

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "09-26" in local time; "?" for a bad timestamp. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "09-26 14:05" in local time. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : `${shortDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "45m", "2h 10m", "3d 4h"; "under 1m" below a minute. */
export function formatSpan(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under 1m";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return min % 60 ? `${hours}h ${min % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export interface NeighbourRow {
  text: string;
  /** Short evidence tag shown on the right ("3 shared files", "×4"). */
  tag: string;
  /** Hover text: the full evidence (every shared file path, the overlap window). */
  hover: string;
}

export interface NeighbourSection {
  id: "coworkers" | "crew" | "trips" | "messages";
  heading: string;
  rows: NeighbourRow[];
}

export interface SectionInput {
  index: NeighbourIndex;
  agents: ReadonlyMap<string, AgentHome>;
  /** Session id → its first and last message; a session missing here is never crew. */
  windows: ReadonlyMap<string, ActiveWindow>;
  messages: readonly VillageMessage[];
  /** The shown title of a session the store knows, else null (it is then left out). */
  titleOf: (id: string) => string | null;
  /** The shown name of an island the store knows, else null. A `visited` edge to anything else
   *  (the pre-#47 invented agent -> agent visits) is not a trip and is left out. */
  islandName: (id: string) => string | null;
  /** ?redact=1: message text becomes "…" (applied after pairing, so counts stay real). */
  redactPreviews?: boolean;
}

function heading(base: string, total: number): string {
  return total > SECTION_LIMIT ? `${base} · top ${SECTION_LIMIT} of ${total}` : base;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The agent panel's sections for `agentId`. A section with nothing real in it is left out, and a
 * session with no co-workers, crew, trips or messages gets an empty list (the panel shows nothing).
 */
export function neighbourSections(agentId: string, input: SectionInput): NeighbourSection[] {
  const isKnown = (id: string): boolean => input.titleOf(id) !== null;
  const title = (id: string): string => input.titleOf(id) ?? id.slice(0, 8);
  const out: NeighbourSection[] = [];

  const cw = coworkers(agentId, input.index, isKnown);
  if (cw.length) {
    out.push({
      id: "coworkers",
      heading: heading("Worked alongside (shared files)", cw.length),
      rows: cw.slice(0, SECTION_LIMIT).map((c) => {
        const named = c.files.slice(0, FILES_NAMED_PER_ROW).map(basename).join(", ");
        const more = c.files.length > FILES_NAMED_PER_ROW ? ` +${c.files.length - FILES_NAMED_PER_ROW} more` : "";
        return {
          text: `${title(c.agentId)} · ${named}${more} · last ${shortDate(c.at)}`,
          tag: plural(c.files.length, "shared file"),
          hover: `Both sessions touched (read or edited):\n${c.files.join("\n")}`,
        };
      }),
    });
  }

  const crew = crews(agentId, input.agents, input.windows, input.index).filter((c) => isKnown(c.agentId));
  if (crew.length) {
    out.push({
      id: "crew",
      heading: heading("Crew (same district, overlapping hours)", crew.length),
      rows: crew.slice(0, SECTION_LIMIT).map((c) => {
        const via = [c.repos.length ? `same repo ${c.repos.map(basename).join(", ")}` : "", c.sharedFiles ? plural(c.sharedFiles, "shared file") : ""]
          .filter(Boolean)
          .join(" + ");
        const days = shortDate(c.overlapStart) === shortDate(c.overlapEnd) ? shortDate(c.overlapEnd) : `${shortDate(c.overlapStart)} → ${shortDate(c.overlapEnd)}`;
        return {
          text: `${title(c.agentId)} · ${via} · ${days}`,
          tag: formatSpan(c.overlapMs),
          hover: `Both sessions were active (first to last message) from ${shortDateTime(c.overlapStart)} to ${shortDateTime(c.overlapEnd)}.${c.repos.length ? `\nSame repo: ${c.repos.join(", ")}` : ""}`,
        };
      }),
    });
  }

  // A visit to the session's own (current) island is no trip: a re-homed session's stale edge until the next snapshot.
  const home = input.agents.get(agentId)?.islandId;
  const tr = trips(agentId, input.index).flatMap((t) => {
    const name = t.islandId === home ? null : input.islandName(t.islandId);
    return name === null ? [] : [{ ...t, name }];
  });
  if (tr.length) {
    out.push({
      id: "trips",
      heading: heading("Trips (read or edited files in another district)", tr.length),
      rows: tr.slice(0, SECTION_LIMIT).map((t) => ({
        text: `${t.name} · last ${shortDate(t.at)}`,
        tag: `×${t.touches}`,
        hover: `${plural(t.touches, "file touch", "file touches")} in ${t.name}'s folder, the newest ${shortDateTime(t.at)}`,
      })),
    });
  }

  const msgs = neighbourMessages(agentId, input.messages, isKnown);
  if (msgs.length) {
    out.push({
      id: "messages",
      heading: heading("Messages with other sessions", msgs.length),
      rows: msgs.slice(0, SECTION_LIMIT).map((m) => ({
        text: `${m.direction === "to" ? "to" : "from"} ${title(m.counterpartId)}: ${input.redactPreviews ? "…" : m.preview}`,
        tag: shortDateTime(m.at),
        hover: `${m.direction === "to" ? "Sent to" : "Received from"} ${title(m.counterpartId)} at ${shortDateTime(m.at)}`,
      })),
    });
  }
  return out;
}
