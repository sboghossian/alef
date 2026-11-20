// Wire types for the "sickness" feature: a minion (a session, or one of its subagents) gets sick
// when its own transcript shows one of three diseases, detected deterministically by
// server/features/sickness-lib.ts (no model calls, no network):
//
//   leaked-key     a credential-shaped value entered the transcript: read into context by a tool,
//                  echoed in the assistant's own text, or written through Write/Edit/Bash input.
//                  The value itself is never recorded: only its provider, a 10-hex sha256 prefix
//                  and a masked prefix such as "sk-or-v1-...". Stays open until someone treats it.
//   broken-build   a build/test run (npm test, tsc, vitest, pytest, cargo test, ...) failed: an
//                  is_error result, or failure text in the last 20 KB of its output (so a
//                  `npm test | tail` that exits 0 still counts). Healed when a later run of the
//                  same class passes; chronic when the transcript went quiet (2 h) still failing.
//   steering-page  a fetched web page contained text that tries to steer an agent (a vendored copy
//                  of ai-defence's instruction_override / role_hijack / hidden_unicode /
//                  output_exfiltration regexes). Regex only: it says the minion was EXPOSED, never
//                  that it was compromised or that the site is fake.
//
//   GET  /api/sickness                  → SicknessResponse (every case, counts, scan progress)
//   POST /api/sickness/:id/treated      → SicknessTreatResult (Alex marks a case treated; 📣
//                                         his report, Alef can't see the fix; idempotent, 404
//                                         for an unknown id, 409 for a healed case)
//   GET  /api/sickness/vault            → SicknessVaultResponse (vault notes holding key-shaped
//                                         strings; counts only, cached for a day)
//   GET  /api/sickness/insurance        → SicknessInsuranceResponse (trash batches, db backups)
//   WS  { type:"feature", feature:"sickness", payload: SicknessMessage }  new or changed cases
//   snapshot extras "sickness.open"     → SicknessOpenEntry[] (≤ SICKNESS_OPEN_CAP agents)
//
// `label`, `source.target` and every detail string are code-written or come from a transcript
// after sanitizing to one capped line; still render them with textContent only.

export const SICKNESS_FEATURE_ID = "sickness";
export const SICKNESS_OPEN_KEY = "sickness.open";
/** Snapshot extras carry at most this many sick agents (worst first, then most recent). */
export const SICKNESS_OPEN_CAP = 300;
/** The steering-page label, verbatim: exposure, never "compromised" or "fake". */
export const STEERING_LABEL = "exposed to a page that tries to steer agents";

export type SicknessKind = "leaked-key" | "broken-build" | "steering-page";
export const SICKNESS_KINDS: readonly SicknessKind[] = ["leaked-key", "broken-build", "steering-page"];

/** open: sick now (a leak, or a failing build still in play). healed: a later run of the same
 *  build class passed. chronic: the transcript went quiet while still failing. exposed: a
 *  steering page was read. treated: Alex marked it treated and no evidence newer than that
 *  has shown up (newer evidence reopens it; the treatment stays on the case as history). */
export type SicknessState = "open" | "healed" | "chronic" | "exposed" | "treated";
export const SICKNESS_STATES: readonly SicknessState[] = ["open", "healed", "chronic", "exposed", "treated"];
/** States that still make an agent sick (the snapshot's "sickness.open" and openSicknessCases()). */
export const SICK_STATES: readonly SicknessState[] = ["chronic", "open", "exposed"];

/** How the key got into the transcript. */
export type LeakVector = "read into context" | "echoed" | "written";
/** Web host flags: a raw IP, an IDN (punycode), or a lookalike of a well-known domain. */
export type HostFlag = "raw-ip" | "punycode" | "lookalike";

export interface SicknessSource {
  /** Tool name of the call that carried it ("Read", "Bash", "WebFetch", "mcp__…"; "assistant" for echoed text). */
  tool: string;
  /** Redacted path (home → "~"), redacted command, host or command class. One line, capped. */
  target: string;
}

export interface SicknessDetail {
  /** leaked-key: provider name ("OpenRouter", "Anthropic", …). */
  provider?: string;
  /** leaked-key: first 10 hex chars of sha256(value). Enough to tell two keys apart; never the key. */
  hash10?: string;
  /** leaked-key: the provider's fixed prefix only, e.g. "sk-or-v1-...". */
  masked?: string;
  vector?: LeakVector;
  /** broken-build: the build/test class, e.g. "npm test", "tsc", "vitest". */
  cmdClass?: string;
  /** steering-page: the page's host (null when the tool call had no URL). */
  host?: string | null;
  /** steering-page: the ai-defence pattern ids that matched (io_001, rh_001, hu_001, …). */
  patternIds?: string[];
  hostFlags?: HostFlag[];
}

export interface SicknessCase {
  /** Stable: kind + agent + the thing (key hash + vector, build class, host). Dedupes rescans. */
  id: string;
  kind: SicknessKind;
  state: SicknessState;
  /** The world agent (main session). A subagent's case counts for its parent session. */
  sessionId: string;
  subagentId: string | null;
  /** automationKey(session title) (shared/display.ts), e.g. "/yalla-brief"; null for hand-typed work. */
  lineage: string | null;
  /** Display name of the session's district, when the index knows it. */
  district: string | null;
  /** One code-written line. */
  label: string;
  source: SicknessSource;
  detail: SicknessDetail;
  /** Transcript time (ISO) of the first and last evidence. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** leaked-key: tool results / turns carrying the key; broken-build: failing runs; steering-page: pages. */
  occurrences: number;
  healedAt: string | null;
  /** The latest "Mark treated" on this case, or null. Absent on cases recorded before wave 2. */
  treatment?: SicknessTreatment | null;
}

/** A "Mark treated" click. Alex's own report (📣): Alef records that he says it is treated,
 *  it cannot see the fix. Appended to data/sickness.jsonl, never deleted. */
export interface SicknessTreatment {
  by: "alex";
  /** Server time (ISO) of the click. Evidence at or before it is covered by the treatment. */
  at: string;
}

/** POST /api/sickness/:id/treated. `already`: it was treated before this click (nothing written). */
export interface SicknessTreatResult {
  ok: boolean;
  error?: string;
  already?: boolean;
  case?: SicknessCase;
}

/** GET /api/sickness/vault: vault notes (under `dir`) whose text holds a key-shaped string, found
 *  with the same regex bank and placeholder rules as the transcript detector. Counts only: the
 *  server keeps 10-hex hashes to count distinct keys, never a value. Computed on the first GET of
 *  the day, then cached for 24 h. */
export interface SicknessVaultResponse {
  ok: true;
  /** The folder counted, relative to the vault, e.g. "10-Sessions". */
  dir: string;
  computedAt: string;
  notesScanned: number;
  notesWithKeys: number;
  /** Distinct key hashes across every note. */
  distinctKeys: number;
  /** provider → notes holding one of its keys, and its distinct keys. */
  byProvider: Record<string, { notes: number; keys: number }>;
  /** Notes not read: evicted to iCloud (never opened), a read over the timeout, or unreadable. */
  skipped: { notDownloaded: number; timedOut: number; unreadable: number };
}

/** GET /api/sickness/insurance: the only honest "insurance". Retires move files into
 *  ~/.alef-trash batches that Restore moves back; db migrations write a .bak copy first. */
export interface SicknessInsuranceResponse {
  ok: true;
  /** Trash batch manifests under ~/.alef-trash (cleanup's listTrash). */
  trashBatches: number;
  /** Items in those batches still retired (restorable). */
  retiredItems: number;
  /** *.bak files beside world.db (data/). */
  dbBackups: number;
}

export interface SicknessCounts {
  total: number;
  byKind: Record<SicknessKind, number>;
  byState: Record<SicknessState, number>;
  /** lineage (automationKey) → cases; "(none)" for cases with no lineage. */
  byLineage: Record<string, number>;
}

export interface SicknessScanProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** When the cold backfill first reached the end of every transcript; null while it runs. */
  finishedAt: string | null;
  /** Lines over the 2 MB cap, skipped unread. */
  linesSkipped: number;
}

export interface SicknessResponse {
  ok: true;
  /** The detector bank's version: bumping it rescans every transcript. */
  version: number;
  /** Kinds that are detected but not served (precision below the bar); their cases are withheld. */
  disabledKinds: SicknessKind[];
  counts: SicknessCounts;
  scan: SicknessScanProgress;
  /** Newest lastSeenAt first. */
  cases: SicknessCase[];
}

export interface SicknessMessage {
  kind: "cases";
  cases: SicknessCase[];
}

/** One sick agent in the snapshot. */
export interface SicknessOpenEntry {
  agentId: string;
  kinds: SicknessKind[];
  /** chronic > open > exposed. */
  worst: SicknessState;
  caseIds: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Validates one untrusted case off the wire (a WS payload or the GET body). */
export function isSicknessCase(v: unknown): v is SicknessCase {
  if (!isRecord(v) || !isRecord(v.source) || !isRecord(v.detail)) return false;
  return (
    isStr(v.id) &&
    isStr(v.kind) &&
    (SICKNESS_KINDS as readonly string[]).includes(v.kind) &&
    isStr(v.state) &&
    (SICKNESS_STATES as readonly string[]).includes(v.state) &&
    isStr(v.sessionId) &&
    (v.subagentId === null || isStr(v.subagentId)) &&
    (v.lineage === null || isStr(v.lineage)) &&
    (v.district === null || isStr(v.district)) &&
    isStr(v.label) &&
    isStr(v.source.tool) &&
    isStr(v.source.target) &&
    isStr(v.firstSeenAt) &&
    isStr(v.lastSeenAt) &&
    typeof v.occurrences === "number" &&
    (v.healedAt === null || isStr(v.healedAt)) &&
    (v.treatment === undefined || v.treatment === null || isSicknessTreatment(v.treatment))
  );
}

export function isSicknessTreatment(v: unknown): v is SicknessTreatment {
  return isRecord(v) && v.by === "alex" && isStr(v.at);
}

/** A POST /api/sickness/:id/treated body off the wire (null when it isn't one). */
export function parseSicknessTreatResult(v: unknown): SicknessTreatResult | null {
  if (!isRecord(v) || typeof v.ok !== "boolean") return null;
  return {
    ok: v.ok,
    error: isStr(v.error) ? v.error : undefined,
    already: v.already === true,
    case: isSicknessCase(v.case) ? v.case : undefined,
  };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function parseSicknessVault(v: unknown): SicknessVaultResponse | null {
  if (!isRecord(v) || v.ok !== true || !isStr(v.dir) || !isStr(v.computedAt) || !isRecord(v.byProvider) || !isRecord(v.skipped)) return null;
  if (!isCount(v.notesScanned) || !isCount(v.notesWithKeys) || !isCount(v.distinctKeys)) return null;
  const s = v.skipped;
  if (!isCount(s.notDownloaded) || !isCount(s.timedOut) || !isCount(s.unreadable)) return null;
  const byProvider: Record<string, { notes: number; keys: number }> = {};
  for (const [k, p] of Object.entries(v.byProvider)) {
    if (!isRecord(p) || !isCount(p.notes) || !isCount(p.keys)) return null;
    byProvider[k] = { notes: p.notes, keys: p.keys };
  }
  return {
    ok: true,
    dir: v.dir,
    computedAt: v.computedAt,
    notesScanned: v.notesScanned,
    notesWithKeys: v.notesWithKeys,
    distinctKeys: v.distinctKeys,
    byProvider,
    skipped: { notDownloaded: s.notDownloaded, timedOut: s.timedOut, unreadable: s.unreadable },
  };
}

export function parseSicknessInsurance(v: unknown): SicknessInsuranceResponse | null {
  if (!isRecord(v) || v.ok !== true || !isCount(v.trashBatches) || !isCount(v.retiredItems) || !isCount(v.dbBackups)) return null;
  return { ok: true, trashBatches: v.trashBatches, retiredItems: v.retiredItems, dbBackups: v.dbBackups };
}

/** GET /api/sickness off the wire: its cases, counts and scan progress (null when malformed). */
export function parseSicknessResponse(v: unknown): SicknessResponse | null {
  if (!isRecord(v) || v.ok !== true || typeof v.version !== "number" || !isRecord(v.counts) || !isRecord(v.scan) || !Array.isArray(v.cases)) return null;
  const c = v.counts;
  const sc = v.scan;
  if (typeof c.total !== "number" || !isRecord(c.byKind) || !isRecord(c.byState) || !isRecord(c.byLineage)) return null;
  if (!isCount(sc.filesDone) || !isCount(sc.filesTotal) || !isCount(sc.bytesDone) || !isCount(sc.bytesTotal) || !isCount(sc.linesSkipped)) return null;
  if (!(sc.finishedAt === null || isStr(sc.finishedAt))) return null;
  const num = (r: Record<string, unknown>, k: string): number => (typeof r[k] === "number" ? (r[k] as number) : 0);
  const byLineage: Record<string, number> = {};
  for (const [k, n] of Object.entries(c.byLineage)) if (typeof n === "number") byLineage[k] = n;
  return {
    ok: true,
    version: v.version,
    disabledKinds: Array.isArray(v.disabledKinds) ? v.disabledKinds.filter((k): k is SicknessKind => isStr(k) && (SICKNESS_KINDS as readonly string[]).includes(k)) : [],
    counts: {
      total: c.total,
      byKind: Object.fromEntries(SICKNESS_KINDS.map((k) => [k, num(c.byKind as Record<string, unknown>, k)])) as Record<SicknessKind, number>,
      byState: Object.fromEntries(SICKNESS_STATES.map((s) => [s, num(c.byState as Record<string, unknown>, s)])) as Record<SicknessState, number>,
      byLineage,
    },
    scan: { filesDone: sc.filesDone, filesTotal: sc.filesTotal, bytesDone: sc.bytesDone, bytesTotal: sc.bytesTotal, finishedAt: sc.finishedAt, linesSkipped: sc.linesSkipped },
    cases: parseSicknessCases(v.cases),
  };
}

export function parseSicknessCases(v: unknown): SicknessCase[] {
  return Array.isArray(v) ? v.filter(isSicknessCase) : [];
}

export function isSicknessOpenEntry(v: unknown): v is SicknessOpenEntry {
  return (
    isRecord(v) &&
    isStr(v.agentId) &&
    Array.isArray(v.kinds) &&
    v.kinds.every((k) => isStr(k) && (SICKNESS_KINDS as readonly string[]).includes(k)) &&
    isStr(v.worst) &&
    (SICK_STATES as readonly string[]).includes(v.worst) &&
    Array.isArray(v.caseIds) &&
    v.caseIds.every(isStr)
  );
}

export function parseSicknessOpen(v: unknown): SicknessOpenEntry[] {
  return Array.isArray(v) ? v.filter(isSicknessOpenEntry) : [];
}

const WORST_RANK: Record<SicknessState, number> = { chronic: 0, open: 1, exposed: 2, treated: 3, healed: 4 };

/** Sick agents for the snapshot's "sickness.open": one entry per session (a subagent's cases count
 *  for its parent), worst state first, then most recent; at most `cap`. Shared so the client groups
 *  its live case list (GET /api/sickness + pushes) exactly as the server groups the snapshot. */
export function openEntries(cases: readonly SicknessCase[], cap: number): SicknessOpenEntry[] {
  const by = new Map<string, { kinds: Set<SicknessKind>; worst: SicknessState; ids: string[]; last: string }>();
  for (const c of cases) {
    if (!(SICK_STATES as readonly string[]).includes(c.state)) continue;
    const e = by.get(c.sessionId) ?? { kinds: new Set<SicknessKind>(), worst: c.state, ids: [], last: c.lastSeenAt };
    e.kinds.add(c.kind);
    if (WORST_RANK[c.state] < WORST_RANK[e.worst]) e.worst = c.state;
    e.ids.push(c.id);
    if (c.lastSeenAt > e.last) e.last = c.lastSeenAt;
    by.set(c.sessionId, e);
  }
  return [...by.entries()]
    .sort(([, a], [, b]) => WORST_RANK[a.worst] - WORST_RANK[b.worst] || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, cap)
    .map(([agentId, e]) => ({ agentId, kinds: SICKNESS_KINDS.filter((k) => e.kinds.has(k)), worst: e.worst, caseIds: e.ids.slice(0, 50) }));
}
