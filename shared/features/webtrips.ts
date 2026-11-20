// Wire types for the "webtrips" feature: who leaves the planet. Alef itself sends only Jev out
// (Ask Jev → "Search the web", server/features/websearch.ts), and every one of those trips is kept
// in data/jev-web.jsonl. Sessions browse on their own: each house counts its own web trips (and
// its subagents'), read from its transcripts. Read-only on transcripts; no new web calls.
//
//   GET /api/webtrips                     → WebTripsResponse (town totals + Jev's trips)
//   GET /api/webtrips/session/:sessionId  → WebTripsSessionResponse
//   snapshot extras "webtrips.jev"        → JevTrips

/** The tool families that count as a web trip (webtrips-lib.ts's webTripOf). */
export type TripTool = "WebSearch" | "WebFetch" | "exa" | "firecrawl" | "obscura" | "curl";
export const TRIP_TOOLS: readonly TripTool[] = ["WebSearch", "WebFetch", "exa", "firecrawl", "obscura", "curl"];

export interface WebTripHost {
  host: string;
  trips: number;
}

export interface SessionWebTrips {
  sessionId: string;
  /** Web trips by this session and its subagents. */
  trips: number;
  /** Of those, the ones its subagents made. */
  subagentTrips: number;
  /** Distinct named hosts (a search names none). */
  hosts: number;
  /** Most visited first, at most 5. */
  topHosts: WebTripHost[];
  byTool: Partial<Record<TripTool, number>>;
  /** Transcript time of the latest trip. */
  lastAt: string | null;
}

export interface WebTripsSessionResponse {
  ok: true;
  /** Every transcript of this session (its own and its subagents') has been read to its end. Until
   *  then `entry` is null: a half-counted session is never shown. */
  ready: boolean;
  entry: SessionWebTrips | null;
}

/** Jev's trips: the searches Alef ran for Alex (one line each in data/jev-web.jsonl). Counted
 *  from the day that file started, never before. */
export interface JevTrips {
  trips: number;
  since: string | null;
  last: string | null;
}

export interface WebTripsSummary {
  /** Every transcript on disk has been read to its end. */
  ready: boolean;
  transcripts: { main: number; mainWithTrips: number; subagent: number; subagentWithTrips: number };
  /** Sessions with at least one trip, their subagents' included. */
  sessionsWithTrips: number;
  trips: number;
  byTool: Partial<Record<TripTool, number>>;
  hosts: number;
  topHosts: WebTripHost[];
  jev: JevTrips;
}

export interface WebTripsResponse {
  ok: true;
  summary: WebTripsSummary;
}

export const WEBTRIPS_JEV_KEY = "webtrips.jev";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isJevTrips(v: unknown): v is JevTrips {
  return isRecord(v) && typeof v.trips === "number" && (v.since === null || typeof v.since === "string") && (v.last === null || typeof v.last === "string");
}

export function isSessionWebTrips(v: unknown): v is SessionWebTrips {
  return (
    isRecord(v) &&
    typeof v.sessionId === "string" &&
    typeof v.trips === "number" &&
    typeof v.subagentTrips === "number" &&
    typeof v.hosts === "number" &&
    Array.isArray(v.topHosts) &&
    isRecord(v.byTool)
  );
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The agent-panel line: "12 web trips · 4 hosts", "1 web trip · no named host", "No web trips". */
export function webTripsLine(e: Pick<SessionWebTrips, "trips" | "hosts">): string {
  if (e.trips === 0) return "No web trips";
  return `${plural(e.trips, "web trip", "web trips")} · ${e.hosts === 0 ? "no named host" : plural(e.hosts, "host", "hosts")}`;
}

/** The Ask Jev panel's line: "Jev's trips: 7 since 29 Sep" or "Jev's trips: none yet". */
export function jevTripsLine(j: JevTrips, fmtDay: (iso: string) => string): string {
  if (j.trips === 0 || !j.since) return "Jev's trips: none kept yet";
  return `Jev's trips: ${j.trips.toLocaleString("en-US")} since ${fmtDay(j.since)}, each one kept`;
}
