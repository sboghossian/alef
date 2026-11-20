// Wire types for the "vault" feature: ten ways to look at Alex's Obsidian vault, ported
// from the "Alex's Brain" artifact into Alef's Mind group as one view with ten sections.
//
// The source is the graph feed the vault already builds for itself, hourly:
//   <vault>/60-Meta/graph-feed/manifest.json + shard-00..15.tsv
// one tab-separated row per note, 12 fields (see VaultNote). The server parses it once,
// aggregates server-side and hands the client a few KB per section — the whole feed is
// ~6.8MB over 32k rows, far too much to re-derive in the browser on every render.
//
// Read-only throughout. No route writes to the vault, and logs carry counts only, never
// note titles, paths or body text.
//
//   GET /api/vault/meta                      -> VaultMetaResponse
//   GET /api/vault/pulse                     -> VaultPulseResponse
//   GET /api/vault/growth                    -> VaultGrowthResponse
//   GET /api/vault/focus                     -> VaultFocusResponse
//   GET /api/vault/meetings                  -> VaultMeetingsResponse
//   GET /api/vault/projects                  -> VaultProjectsResponse
//   GET /api/vault/topics                    -> VaultTopicsResponse
//   GET /api/vault/people                    -> VaultPeopleResponse
//   GET /api/vault/sources                   -> VaultSourcesResponse
//   GET /api/vault/echoes?seed=<int>         -> VaultEchoesResponse
//   GET /api/vault/gaps                      -> VaultGapsResponse
//   GET /api/vault/notes?<one filter>        -> VaultNotesResponse
//   GET /api/vault/search?q=<words>          -> VaultSearchResponse (⌘K: projects, people, note titles)
//   GET /api/vault/climb?path=<note path>    -> VaultClimbResponse
//   GET /api/vault/synapses?path=<note path> -> VaultSynapsesResponse
//   GET /api/vault/firing?days=<1..14>       -> VaultFiringResponse
//   GET /api/vault/{atlas,flows,hubs,constellation}: see "the four map sections" below

export interface VaultError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------- the parsed feed

/** One note as the feed states it. Server-side shape; never sent whole to the client. */
export interface VaultNote {
  /** Stable 7-char hash of the path. Link targets reference this. */
  id: string;
  /** Vault-relative, with ".md". */
  path: string;
  /** "n" note, "a" attachment. */
  kind: "n" | "a";
  /** Frontmatter `type`, "" when the note has none. */
  type: string;
  /** Whole days since the epoch, or null when the note carries no date. */
  day: number | null;
  /** Local hour as the frontmatter wrote it, when the date had a time. */
  hour: number | null;
  project: string;
  umbrella: string;
  tags: readonly string[];
  /** Ids of resolved link targets. */
  links: readonly string[];
  /** Names of link targets that resolve to nothing — the "write next" list. */
  ghosts: readonly string[];
  /** Meeting length in minutes, from frontmatter `duration_min`. */
  minutes: number | null;
  /** People and company notes only: weekly mention counts, keyed by day/7. */
  mentionWeeks: ReadonlyMap<number, number> | null;
  /** People and company notes only: the last day anything mentioned them. */
  mentionLast: number | null;
  /** Id of the note one step up toward Home (its genus, project or folder index); null for Home
   *  itself and for feeds built before the vault wrote this column. */
  up: string | null;
  /** Which rule picked `up`: broader, parent, project, topic, mentions, folder, top, home. */
  upRule: string;
}

/** The feed is rebuilt hourly; past 3 hours something upstream (the Mac's auto-capture) has
 *  stopped. One threshold for the Vault and Brain headers and the Health check. */
export const FEED_STALE_MS = 3 * 3_600_000;

/** How fresh the feed is. Carried by every section so any one of them can say so. */
export interface VaultMeta {
  /** The manifest's own ISO timestamp: when the vault last rebuilt the feed. */
  generatedAt: string;
  /** When this server last parsed it. */
  parsedAt: string;
  notes: number;
  links: number;
  tags: number;
  shards: number;
  /** False while the first parse is still running; the client shows a loading state. */
  ready: boolean;
}

export interface VaultMetaResponse {
  ok: true;
  meta: VaultMeta;
}

// ---------------------------------------------------------------- small shared shapes

/** A note the client may list and open. */
export interface VaultNoteRef {
  id: string;
  /** Vault-relative, with ".md" — pass straight to /api/brain/note?path=. */
  path: string;
  /** Basename without the extension. */
  name: string;
  /** Top-level folder, "" for a note at the vault root. */
  folder: string;
  /** "YYYY-MM-DD", or null when undated. */
  day: string | null;
  /** Outbound plus inbound links. */
  links: number;
}

/** One stacked series. `parts` is index-aligned to its section's bucket list. */
export interface VaultSeries {
  key: string;
  parts: readonly number[];
}

/** A labelled count, for bar lists. */
export interface VaultCount {
  key: string;
  n: number;
}

// ---------------------------------------------------------------- pulse

export interface VaultDay {
  /** "YYYY-MM-DD". */
  day: string;
  n: number;
}

export interface VaultPulse {
  /** Dated notes per day, ascending, days with none omitted. */
  days: readonly VaultDay[];
  /** "YYYY-MM", oldest first, up to 18. */
  months: readonly string[];
  /** Top folders plus "Other", aligned to `months`. */
  stacks: readonly VaultSeries[];
  last7: number;
  prev7: number;
  activeDays30: number;
  streak: number;
  longestStreak: number;
  /** Busiest single day this year. */
  busiest: VaultDay | null;
}

export interface VaultPulseResponse {
  ok: true;
  meta: VaultMeta;
  pulse: VaultPulse;
}

// ---------------------------------------------------------------- growth

export interface VaultMilestone {
  /** The round note count being projected to. */
  at: number;
  /** Projected "YYYY-MM-DD", or null when the recent pace is zero or negative. */
  day: string | null;
}

export interface VaultGrowth {
  /** "YYYY-MM", oldest first, up to 48. */
  months: readonly string[];
  /** Cumulative per folder, aligned to `months`. */
  stacks: readonly VaultSeries[];
  /** Notes dated before the window, folded into the baseline. */
  baseline: number;
  total: number;
  undated: number;
  perDay30: number;
  d90: number;
  prev90: number;
  milestones: readonly VaultMilestone[];
  /** Fastest-growing folders over 90 days. */
  fastest: readonly VaultCount[];
}

export interface VaultGrowthResponse {
  ok: true;
  meta: VaultMeta;
  growth: VaultGrowth;
}

// ---------------------------------------------------------------- focus

/** Movement in a key's share of attention, in share points. */
export interface VaultShift {
  key: string;
  /** Share over the last 4 weeks, 0..1. */
  now: number;
  /** Share over the 4 weeks before those. */
  before: number;
}

export interface VaultFocus {
  /** Week-start days, "YYYY-MM-DD", oldest first, 26 of them. */
  weeks: readonly string[];
  /** Top series plus "other", aligned to `weeks`. */
  byProject: readonly VaultSeries[];
  byUmbrella: readonly VaultSeries[];
  touchedProjects: number;
  touchedUmbrellas: number;
  /** Mean distinct projects per active day over 30 days. */
  switchesPerDay: number;
  /** The biggest share this week. */
  top: { key: string; share: number } | null;
  shiftProjects: readonly VaultShift[];
  shiftUmbrellas: readonly VaultShift[];
}

export interface VaultFocusResponse {
  ok: true;
  meta: VaultMeta;
  focus: VaultFocus;
}

// ---------------------------------------------------------------- meetings

export interface VaultMeeting {
  path: string;
  name: string;
  /** "YYYY-MM-DD". */
  day: string;
  minutes: number;
  project: string;
}

export interface VaultMeetings {
  /** Week-start days, oldest first, 26 of them. */
  weeks: readonly string[];
  /** Hours per week, aligned to `weeks`. */
  hours: readonly number[];
  /** Meetings per week, aligned to `weeks`. */
  counts: readonly number[];
  /** Weekday-major counts over the last 12 months: 7 rows of (hourTo - hourFrom + 1). */
  grid: readonly number[];
  /** Monday is 0. */
  hourFrom: number;
  hourTo: number;
  hoursThisWeek: number;
  avgHours12w: number;
  countThisWeek: number;
  avgMinutes90: number;
  peak: { dow: number; hour: number; n: number } | null;
  /** Longest meetings over 30 days. */
  longest: readonly VaultMeeting[];
  /** Meeting hours per project over 90 days. */
  byProject: readonly { key: string; hours: number }[];
}

export interface VaultMeetingsResponse {
  ok: true;
  meta: VaultMeta;
  meetings: VaultMeetings;
}

// ---------------------------------------------------------------- projects

export interface VaultProject {
  slug: string;
  /** The most frequent umbrella among the project's notes, "unfiled" when none say. */
  umbrella: string;
  notes: number;
  /** "YYYY-MM-DD" of the newest note, or null. */
  last: string | null;
  n30: number;
  prev30: number;
  /** "20-Projects/<slug>/_index.md" when it exists, else null. */
  indexPath: string | null;
}

export interface VaultUmbrella {
  key: string;
  projects: number;
  notes: number;
  n30: number;
}

export interface VaultProjects {
  items: readonly VaultProject[];
  umbrellas: readonly VaultUmbrella[];
  active30: number;
  /** Notes under 10-Sessions that name a project. */
  sessionNotes: number;
  busiest: string | null;
  /** Big projects that have gone quiet: the ones worth noticing. */
  quiet: readonly VaultProject[];
}

export interface VaultProjectsResponse {
  ok: true;
  meta: VaultMeta;
  projects: VaultProjects;
}

// ---------------------------------------------------------------- topics

export interface VaultTag {
  /** Full tag, without the leading "#". */
  tag: string;
  /** Everything before the first "/", or "(plain)". */
  family: string;
  total: number;
  /** Notes per week, 26 of them, oldest first. */
  weeks: readonly number[];
  n30: number;
  /** The 30 days before those. */
  p30: number;
  /** Days 30..119. */
  p90: number;
  /** Rising score: n30 / (p90 / 3 + 1). */
  score: number;
}

export interface VaultTopics {
  families: readonly VaultCount[];
  items: readonly VaultTag[];
  rising: readonly VaultTag[];
  quiet: readonly VaultTag[];
}

export interface VaultTopicsResponse {
  ok: true;
  meta: VaultMeta;
  topics: VaultTopics;
}

// ---------------------------------------------------------------- people

/** Where someone sits: seen lately and often, or drifting. */
export type VaultBand = "inner" | "fading" | "occasional" | "dormant";

export interface VaultEntity {
  path: string;
  name: string;
  total: number;
  /** "YYYY-MM-DD" of the last mention, or null. */
  last: string | null;
  daysSince: number | null;
  n90: number;
  /** Mentions per month, 12 of them, oldest first. */
  months: readonly number[];
  band: VaultBand;
}

export interface VaultPeople {
  people: readonly VaultEntity[];
  companies: readonly VaultEntity[];
  withNote: number;
  seen30: number;
  inner: number;
  fading: number;
  /** Known well once, quiet for a while: worth a reconnect. */
  reconnect: readonly VaultEntity[];
  top90: readonly VaultEntity[];
}

export interface VaultPeopleResponse {
  ok: true;
  meta: VaultMeta;
  people: VaultPeople;
}

// ---------------------------------------------------------------- sources

export interface VaultSource {
  key: string;
  total: number;
  n30: number;
  /** Claude, ChatGPT, Cowork, Jarvis. Drives the AI-mix chart. */
  ai: boolean;
}

/** One band: sessions from a source that landed under an umbrella. */
export interface VaultFlow {
  from: string;
  to: string;
  n: number;
}

export interface VaultSources {
  sources: readonly VaultSource[];
  umbrellas: readonly VaultCount[];
  flows: readonly VaultFlow[];
  /** "YYYY-MM", oldest first, up to 18. */
  months: readonly string[];
  /** Sessions per source per month, aligned to `months`. */
  mix: readonly VaultSeries[];
  captured: number;
  /** Claude's share of AI sessions, 0..1, over 90 days and a year earlier. */
  claudeShare90: number;
  claudeSharePrev: number;
  topThisMonth: string | null;
}

export interface VaultSourcesResponse {
  ok: true;
  meta: VaultMeta;
  sources: VaultSources;
}

// ---------------------------------------------------------------- echoes

export interface VaultGem extends VaultNoteRef {
  /** Whole months since anything near this note moved. */
  quietMonths: number;
}

export interface VaultOnThisDay {
  /** "3 months ago", "2 years ago". */
  label: string;
  notes: readonly VaultNoteRef[];
}

export interface VaultEchoes {
  /** Well-linked notes nothing has touched in a long while. */
  gems: readonly VaultGem[];
  onThisDay: readonly VaultOnThisDay[];
  /** A random walk along links, starting from a gem. */
  wander: readonly VaultNoteRef[];
  /** Echo the seed back so "again" can ask for a different one. */
  seed: number;
}

export interface VaultEchoesResponse {
  ok: true;
  meta: VaultMeta;
  echoes: VaultEchoes;
}

// ---------------------------------------------------------------- gaps

/** Notes whose names collapse to the same string — probably the same thing twice. */
export interface VaultDuplicate {
  key: string;
  paths: readonly string[];
}

export interface VaultGaps {
  notes: number;
  linked: number;
  orphans: number;
  /** Distinct link targets that resolve to nothing. */
  ghostTotal: number;
  untyped: number;
  projectsMissingNote: number;
  /** The most-wanted missing notes: unresolved targets by how many notes point at them, two or
   *  more, counting only Alex's own notes (imports and web clips left out). */
  writeNext: readonly VaultCount[];
  orphansByFolder: readonly VaultCount[];
  duplicates: readonly VaultDuplicate[];
  missingProjects: readonly string[];
  untypedByFolder: readonly VaultCount[];
  /** Notes with no genus, project or folder index: their only step up is Home itself. Null when
   *  the feed predates the climb column. */
  unanchored: number | null;
  unanchoredByFolder: readonly VaultCount[];
}

export interface VaultGapsResponse {
  ok: true;
  meta: VaultMeta;
  gaps: VaultGaps;
}

// ---------------------------------------------------------------- climb

/** One step of a climb: a note and the rule that led up to it from the step before. */
export interface VaultClimbStep {
  path: string;
  /** "" for the note the climb starts from. */
  rule: string;
}

/** A note's chain up to Home, Wikipedia first-link style. `end` says how it stopped: "root" at Home,
 *  "loop" when a step comes back to a note already on the chain, "dead-end" when a step points at a
 *  note the feed does not hold, "unknown" when the feed has no such note or no climb column. */
export interface VaultClimb {
  steps: readonly VaultClimbStep[];
  end: "root" | "loop" | "dead-end" | "unknown";
}

export interface VaultClimbResponse {
  ok: true;
  climb: VaultClimb;
}

// ---------------------------------------------------------------- synapses

/** One synapse of a note: the note at the other end and its weight (0..1, symmetric-normalised). */
export interface VaultSynapse {
  path: string;
  w: number;
}

export interface VaultSynapsesResponse {
  ok: true;
  /** False when the vault has no synapse cache yet (brain_synapses.py has not run). */
  ready: boolean;
  synapses: readonly VaultSynapse[];
}

/** One note firing now. hop 0 = dated in the window (it fired itself); hop 1 = activation from those. */
export interface VaultFiringNote {
  path: string;
  act: number;
  hop: 0 | 1;
  /** For hop 1: the note whose signal was strongest. */
  via: string | null;
}

export interface VaultFiring {
  days: number;
  seeds: number;
  notes: readonly VaultFiringNote[];
}

export interface VaultFiringResponse {
  ok: true;
  ready: boolean;
  firing: VaultFiring;
}

// ---------------------------------------------------------------- drill lists

/** What a note list was asked for, echoed back so the client can label it. */
export interface VaultNotesQuery {
  /** "unanchored" takes a folder: the notes in it whose only step up is Home. */
  kind: "day" | "tag" | "project" | "umbrella" | "folder" | "ghost" | "type" | "unanchored";
  value: string;
}

export interface VaultNotesResponse {
  ok: true;
  query: VaultNotesQuery;
  notes: readonly VaultNoteRef[];
  /** How many matched before the cap. */
  total: number;
  truncated: boolean;
}

// ---------------------------------------------------------------- the four map sections
//
//   GET /api/vault/atlas?path=<a/b>           -> VaultAtlasResponse
//   GET /api/vault/flows?mode=folders|umbrellas -> VaultFlowsResponse
//   GET /api/vault/hubs                       -> VaultHubsResponse
//   GET /api/vault/constellation              -> VaultConstellationResponse

/** One subfolder cell in the Atlas treemap. */
export interface VaultAtlasFolder {
  name: string;
  /** Vault-relative, with a trailing "/". */
  dir: string;
  /** Notes anywhere under it. */
  count: number;
  /** Of those, dated in the last 7 days. */
  recent: number;
}

/** Atlas: one folder of the vault, its subfolders and its own notes. */
export interface VaultAtlas {
  /** The folder's path segments; [] is the vault root. A path that does not exist falls back to its deepest existing parent. */
  path: readonly string[];
  name: string;
  dir: string;
  count: number;
  recent: number;
  /** "YYYY-MM-DD" of its newest dated note, or null. */
  last: string | null;
  subfolders: readonly VaultAtlasFolder[];
  /** Notes sitting directly in this folder (not in a subfolder). */
  loose: number;
  /** The most linked of those loose notes, for the treemap's note cells. */
  notes: readonly VaultNoteRef[];
  /** Most linked anywhere under this folder. */
  mostLinked: readonly VaultNoteRef[];
  /** Newest dated anywhere under this folder. */
  newest: readonly VaultNoteRef[];
}

export interface VaultAtlasResponse {
  ok: true;
  meta: VaultMeta;
  atlas: VaultAtlas;
}

export type VaultFlowsMode = "folders" | "umbrellas";

/** Flows: links between areas of the vault, as a matrix for a chord diagram. */
export interface VaultFlows {
  mode: VaultFlowsMode;
  /** Group names, biggest first; the last is "Other" when the long tail was folded. */
  names: readonly string[];
  /** Notes per group, index-aligned to names. */
  notes: readonly number[];
  /** matrix[a][b]: links from a note in group a to a note in group b. */
  matrix: readonly (readonly number[])[];
  /** Links in either direction between a group and every other group. */
  cross: readonly number[];
  /** Links that stay inside a group. */
  self: readonly number[];
}

export interface VaultFlowsResponse {
  ok: true;
  meta: VaultMeta;
  flows: VaultFlows;
}

/** One note on the Hubs scatter. */
export interface VaultHub {
  id: string;
  path: string;
  name: string;
  folder: string;
  /** Outbound plus inbound links. */
  links: number;
  /** Distinct areas (folder, or folder/subfolder for the big four) its links touch. */
  areas: number;
}

/** Hubs: which notes hold the vault together. */
export interface VaultHubs {
  /** Notes with 3+ links. */
  total: number;
  /** Of those, touching 5+ areas. */
  bridges: number;
  /** The most linked of them, for the scatter. */
  points: readonly VaultHub[];
  /** Highest areas x log2(links + 1). */
  keystones: readonly VaultHub[];
  /** 30+ links, one area only. */
  silos: readonly VaultHub[];
}

export interface VaultHubsResponse {
  ok: true;
  meta: VaultMeta;
  hubs: VaultHubs;
}

/** One project on the Constellation map. x, y and r share one unit: the map's side is 1. */
export interface VaultStar {
  slug: string;
  umbrella: string;
  notes: number;
  x: number;
  y: number;
  r: number;
}

export interface VaultTie {
  /** Indices into stars. */
  a: number;
  b: number;
  /** Notes both projects' sessions link to. */
  w: number;
}

/** Constellation: projects as a network, tied by the notes their sessions share. */
export interface VaultConstellation {
  stars: readonly VaultStar[];
  /** The backbone that is drawn: each project's 4 strongest ties, plus any of 20+. */
  ties: readonly VaultTie[];
  /** Umbrellas in colour order. */
  umbrellas: readonly string[];
  strongest: readonly { a: string; b: string; w: number }[];
  connected: readonly { slug: string; w: number }[];
  /** Projects with 5+ notes and no tie at all. */
  islands: readonly { slug: string; notes: number }[];
}

export interface VaultConstellationResponse {
  ok: true;
  meta: VaultMeta;
  constellation: VaultConstellation;
}

// ---------------------------------------------------------------- ⌘K search

/** What a ⌘K hit is: a project slug (its _index note, when there is one), a person or company
 *  note, or any other note, matched on its file name. */
export type VaultSearchKind = "project" | "person" | "company" | "note";

export interface VaultSearchHit {
  kind: VaultSearchKind;
  /** The project slug, or the note's file name without ".md". */
  name: string;
  /** Vault-relative note to open; "" for a project with no _index note. */
  path: string;
  /** Top-level folder, or for a project how many notes carry it ("42 notes"). */
  meta: string;
}

export interface VaultSearchResponse {
  ok: true;
  q: string;
  hits: readonly VaultSearchHit[];
}
