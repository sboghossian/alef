// Pure side of the "webtrips" feature: which tool calls leave the planet, and a per-session tally.
// The classifier reuses the sickness detectors' web-call classifier (sickness-lib.ts's webCallOf:
// a page fetch, and which host) and adds the calls that search the web without naming a host.
// Transcript lines are untrusted: parsed, never executed; only tool names and hostnames are kept.

import { TRIP_TOOLS, type SessionWebTrips, type TripTool, type WebTripHost } from "../../shared/features/webtrips.js";
import { isRecord } from "../http.js";
import { hostOfUrl, resultText, webCallOf } from "./sickness-lib.js";

/** One tool call that reached the web: its tool family and the hosts it named (none for a search). */
export interface WebTrip {
  tool: TripTool;
  hosts: string[];
}

const MAX_HOSTS_PER_CALL = 10;

/** Every remote host a call's `url` / `urls` name (loopback and non-http(s) dropped). */
function urlHosts(input: Record<string, unknown>): string[] {
  const urls: unknown[] = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])];
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const h = hostOfUrl(u);
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= MAX_HOSTS_PER_CALL) break;
  }
  return out;
}

/** A web trip, when this tool call leaves the Mac for the web; null otherwise.
 *  - WebSearch, and every exa and firecrawl call (they are web search/fetch services);
 *  - WebFetch and obscura's browser_navigate, unless they only reach this Mac (webCallOf's rule);
 *  - Bash curl/wget to a remote host (webCallOf's rule: quoted or echoed text never counts).
 *  obscura's markdown/snapshot/extract read the page navigate already fetched: not a new trip. */
export function webTripOf(name: string, input: Record<string, unknown>): WebTrip | null {
  if (name === "WebSearch") return { tool: "WebSearch", hosts: [] };
  if (name.startsWith("mcp__exa__")) return { tool: "exa", hosts: urlHosts(input) };
  if (name.startsWith("mcp__firecrawl")) return { tool: "firecrawl", hosts: urlHosts(input) };
  if (name === "WebFetch" || name === "mcp__obscura__browser_navigate") {
    const call = webCallOf(name, input, null);
    if (!call) return null; // this Mac's own servers are not the web
    return { tool: name === "WebFetch" ? "WebFetch" : "obscura", hosts: call.host ? [call.host] : [] };
  }
  if (name === "Bash") {
    const call = webCallOf(name, input, null);
    return call?.host ? { tool: "curl", hosts: [call.host] } : null;
  }
  return null;
}

/** Substrings one of which a line must hold before it is parsed (most lines hold none). */
const PREFILTER = ["WebSearch", "WebFetch", "mcp__exa__", "mcp__firecrawl", "mcp__obscura__browser_navigate", "curl", "wget"];

/** One trip found in a line: a key that is the same wherever the line is read from (the tool_use
 *  id), so a line seen by both the cold pass and the indexer counts once. */
export interface FoundTrip {
  key: string;
  at: string | null;
  trip: WebTrip;
}

/** The web trips in one raw transcript line (an assistant line's tool_use blocks). */
export function tripsInLine(raw: string | Buffer): FoundTrip[] {
  if (!raw.includes('"tool_use"') || !PREFILTER.some((p) => raw.includes(p))) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return [];
  }
  if (!isRecord(obj) || obj.type !== "assistant" || !isRecord(obj.message) || !Array.isArray(obj.message.content)) return [];
  const at = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
  const out: FoundTrip[] = [];
  obj.message.content.forEach((b: unknown, i: number) => {
    if (!isRecord(b) || b.type !== "tool_use" || typeof b.name !== "string") return;
    const trip = webTripOf(b.name, isRecord(b.input) ? b.input : {});
    if (!trip) return;
    const key = typeof b.id === "string" && b.id ? b.id : uuid ? `${uuid}#${i}` : null;
    if (key) out.push({ key, at, trip }); // no id and no line uuid: it could not be told apart from a re-read, so it is not counted
  });
  return out;
}

/** toolDenialKind values that mean the harness refused the call before it ran (Claude Code
 *  2.1.284's list, read from the installed CLI's source). "interrupted" and "cancelled" are left
 *  out: they can come from a call stopped mid-run, which may already have reached the web. */
const DENIED_KINDS: ReadonlySet<string> = new Set(["user-rejected", "permission-rule", "automode-blocked", "automode-unavailable", "automode-parsing-error"]);

/** The harness's refusal wording at the start of an is_error result, for transcripts written
 *  before toolDenialKind existed. After an optional `<tool_use_error>` and `Error: ` /
 *  `Error calling tool (Name): `. All but the last three are verified in CLI 2.1.284; "User
 *  rejected", "Hook … denied|blocked" and "PreToolUse:… hook" are the older wordings
 *  sickness-lib's NOT_A_RUN already treats as a denial. The two WebFetch lines are its
 *  domain check, which throws before the page is fetched. */
const DENIED_TEXT =
  /^\s*(?:<tool_use_error>\s*)?(?:Error(?: calling tool(?: \([^)\n]{0,120}\))?)?:\s*)?(?:The user doesn't want to proceed with this tool use|Claude requested permissions to use \S+, but you haven't granted it yet|Permission to use \S+ [^\n]{0,300}?denied|Permission for this action (?:was|has been) denied|Execution stopped by PreToolUse hook|Tool permission request failed|Claude Code is unable to fetch from |Unable to verify if domain \S+ is safe to fetch|User rejected|Hook \S+ (?:denied|blocked)|PreToolUse:\S+ hook)/;

/** The tool_use ids that one raw transcript line says were refused before they ran (a user
 *  line's tool_result blocks): denied by a permission rule, a hook, the user, the auto-mode
 *  classifier, a headless run with no allow rule, or WebFetch's domain check. Such a call never
 *  left the Mac, so it is not a web trip. A call that ran and failed (curl could not resolve the
 *  host) still is. */
export function deniedCallsInLine(raw: string | Buffer): string[] {
  if (!raw.includes('"tool_result"') || !(raw.includes('"toolDenialKind"') || raw.includes('"is_error":true'))) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return [];
  }
  if (!isRecord(obj) || obj.type !== "user" || !isRecord(obj.message) || !Array.isArray(obj.message.content)) return [];
  const byKind = typeof obj.toolDenialKind === "string" && DENIED_KINDS.has(obj.toolDenialKind);
  const out: string[] = [];
  for (const b of obj.message.content) {
    if (!isRecord(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string" || !b.tool_use_id) continue;
    if (byKind || (b.is_error === true && DENIED_TEXT.test(resultText(b.content).slice(0, 400)))) out.push(b.tool_use_id);
  }
  return out;
}

/** What one counted trip added, so a denial read later can take it back. */
interface CountedTrip {
  trip: WebTrip;
  sub: boolean;
  at: string | null;
}

/** A session's tally (its own transcript and its subagents'). */
export interface TripTally {
  trips: number;
  own: number;
  sub: number;
  byTool: Map<TripTool, number>;
  hosts: Map<string, number>;
  lastAt: string | null;
  /** Keys already read: what the trip added, or null when it was refused (never counted). */
  seen: Map<string, CountedTrip | null>;
  /** Refused calls whose tool_use has not been read yet (the two paths can split a session). */
  denied: Set<string>;
}

export function newTally(): TripTally {
  return { trips: 0, own: 0, sub: 0, byTool: new Map(), hosts: new Map(), lastAt: null, seen: new Map(), denied: new Set() };
}

/** Adds one trip unless its key was read already or its call was refused; true when it was new. */
export function addTrip(t: TripTally, found: FoundTrip, fromSubagent: boolean): boolean {
  if (t.seen.has(found.key)) return false;
  if (t.denied.delete(found.key)) {
    t.seen.set(found.key, null);
    return false;
  }
  t.seen.set(found.key, { trip: found.trip, sub: fromSubagent, at: found.at });
  t.trips += 1;
  if (fromSubagent) t.sub += 1;
  else t.own += 1;
  t.byTool.set(found.trip.tool, (t.byTool.get(found.trip.tool) ?? 0) + 1);
  for (const h of found.trip.hosts) t.hosts.set(h, (t.hosts.get(h) ?? 0) + 1);
  if (found.at && (!t.lastAt || found.at > t.lastAt)) t.lastAt = found.at;
  return true;
}

const decrement = <K>(m: Map<K, number>, k: K): void => {
  const n = (m.get(k) ?? 0) - 1;
  if (n > 0) m.set(k, n);
  else m.delete(k);
};

/** A refused call: takes its trip back if it was counted (true), else makes sure it never is. */
export function denyTrip(t: TripTally, key: string): boolean {
  const counted = t.seen.get(key);
  if (counted === undefined) {
    t.denied.add(key);
    return false;
  }
  if (counted === null) return false; // taken back already
  t.seen.set(key, null);
  t.trips -= 1;
  if (counted.sub) t.sub -= 1;
  else t.own -= 1;
  decrement(t.byTool, counted.trip.tool);
  for (const h of counted.trip.hosts) decrement(t.hosts, h);
  if (counted.at !== null && counted.at === t.lastAt) {
    t.lastAt = null;
    for (const c of t.seen.values()) if (c?.at && (!t.lastAt || c.at > t.lastAt)) t.lastAt = c.at;
  }
  return true;
}

/** Hosts by visits, most first (ties by name), at most `n`. */
export function topHosts(hosts: ReadonlyMap<string, number>, n: number): WebTripHost[] {
  return [...hosts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([host, trips]) => ({ host, trips }));
}

export function byToolRecord(m: ReadonlyMap<TripTool, number>): Partial<Record<TripTool, number>> {
  const out: Partial<Record<TripTool, number>> = {};
  for (const tool of TRIP_TOOLS) {
    const n = m.get(tool);
    if (n) out[tool] = n;
  }
  return out;
}

export function toEntry(sessionId: string, t: TripTally): SessionWebTrips {
  return {
    sessionId,
    trips: t.trips,
    subagentTrips: t.sub,
    hosts: t.hosts.size,
    topHosts: topHosts(t.hosts, 5),
    byTool: byToolRecord(t.byTool),
    lastAt: t.lastAt,
  };
}
