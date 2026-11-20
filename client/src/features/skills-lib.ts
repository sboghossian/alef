// Pure helpers for the "skills" client feature: runtime validation of the loosely-typed
// payloads (snapshot extras, WS messages — both `unknown` on the wire, same defensiveness as
// todos.ts's parseTodoList), the per-session event cache's merge/cap logic, and the School
// tab's small bits of client-side reasoning (the Graveyard's real window, the candidate queue's
// empty-state reason, grouping repeated tripwire lessons). No DOM here.

import { isRecord } from "./fleet-overlay";
import type { FailureFixPairs, ResidentSkillsTrend, SkillEvent, SkillEventKind, SkillRevisions, StudyPipelineStatus } from "../../../shared/features/skills";
import type { TripwireHit, TripwireSeverity } from "../../../shared/features/tripwires";

const KINDS: readonly SkillEventKind[] = ["invoke", "slash", "suggested"];

/** Caps how many events one session's in-memory cache keeps (oldest dropped first) — a
 *  display list, not an audit log; the server is the source of truth. */
export const MAX_EVENTS_PER_SESSION = 200;

export function isSkillEvent(v: unknown): v is SkillEvent {
  return (
    isRecord(v) &&
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.skillName === "string" &&
    v.skillName.length > 0 &&
    typeof v.at === "string" &&
    typeof v.kind === "string" &&
    (KINDS as readonly string[]).includes(v.kind)
  );
}

/** Filters an unknown value (extras payload, WS message field) down to valid SkillEvents. */
export function parseSkillEvents(v: unknown): SkillEvent[] {
  return Array.isArray(v) ? v.filter(isSkillEvent) : [];
}

function eventKey(e: SkillEvent): string {
  return `${e.sessionId}\u0000${e.skillName}\u0000${e.kind}\u0000${e.at}`;
}

/** Merges `incoming` into `existing` (deduped by identity, sorted oldest-first to match the
 *  server's eventsForSession order), capped to MAX_EVENTS_PER_SESSION. */
export function mergeEvents(existing: readonly SkillEvent[], incoming: readonly SkillEvent[]): SkillEvent[] {
  const byKey = new Map<string, SkillEvent>();
  for (const e of existing) byKey.set(eventKey(e), e);
  for (const e of incoming) byKey.set(eventKey(e), e);
  const merged = [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged.length > MAX_EVENTS_PER_SESSION ? merged.slice(merged.length - MAX_EVENTS_PER_SESSION) : merged;
}

/** Buckets a flat event list by session id, e.g. the "skills.recent" snapshot extra. */
export function bucketBySession(events: readonly SkillEvent[]): Map<string, SkillEvent[]> {
  const out = new Map<string, SkillEvent[]>();
  for (const e of events) {
    const list = out.get(e.sessionId);
    if (list) list.push(e);
    else out.set(e.sessionId, [e]);
  }
  return out;
}

/** Short past-tense label for a badge next to an event. */
export function skillKindLabel(kind: SkillEventKind): string {
  if (kind === "invoke") return "ran";
  if (kind === "slash") return "typed";
  return "suggested";
}

// ---------------------------------------------------------------- School tab

/** The School tab's element/tab id (the skill study pipeline; it was labelled "Institute" before
 *  the Institute of Truth took that name), unchanged from its original "Candidates" name so old
 *  deep links and saved tab state keep working — only the visible label changed. */
export const INSTITUTE_TAB_ID = "candidates";

export type SkillsTabId = "top" | "graveyard" | typeof INSTITUTE_TAB_ID;

/** The Skills panel's tabs, in order. "School" is where skills are studied; the "Institute of
 *  Truth" is the second brain (the memory buildings), never a label here. */
export const SKILLS_TABS: ReadonlyArray<{ id: SkillsTabId; label: string }> = [
  { id: "top", label: "Top used" },
  { id: "graveyard", label: "Graveyard" },
  { id: INSTITUTE_TAB_ID, label: "School" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
export const GRAVEYARD_WINDOW_DAYS = 90;

/** The Graveyard tab's real "0 fires" window label. skills-aggregate.ts always buckets
 *  fired90d over a nominal 90 days; when the store's own recorded history
 *  (`historyStartAt`, from SkillsStore.firstEventAt()) is younger than that, "0 fires in 90
 *  days" overstates how long a skill has really gone unused. Falls back to the nominal label
 *  when there's no history yet or it's already at least 90 days deep. */
export function graveyardWindowLabel(historyStartAt: string | null, nowMs: number): string {
  const fallback = `0 fires in ${GRAVEYARD_WINDOW_DAYS} days`;
  if (historyStartAt === null) return fallback;
  const startMs = Date.parse(historyStartAt);
  if (!Number.isFinite(startMs)) return fallback;
  const historyDays = Math.max(0, Math.floor((nowMs - startMs) / DAY_MS));
  if (historyDays >= GRAVEYARD_WINDOW_DAYS) return fallback;
  const since = new Date(startMs).toISOString().slice(0, 10);
  return `0 fires since ${since} (${historyDays} day${historyDays === 1 ? "" : "s"} of history)`;
}

/** Why the candidate queue is empty right now: a broken pipeline (recent study runs failing,
 *  or it has never succeeded) reads differently from a healthy one that simply has nothing new
 *  to propose. Only meaningful when the queue actually IS empty; callers check that first. */
export function candidateEmptyReason(study: StudyPipelineStatus): string {
  if (study.stats === null) return `No candidates — the study pipeline has never run (${study.line}).`;
  if (study.stats.forksLaunched === 0) return `No candidates — the study pipeline hasn't launched a study run yet (${study.line}).`;
  // lastRunAt (a "fork launched" line) and lastSuccessAt (a later "fork: claude exited rc=0"
  // line) are two different timestamps from the SAME run and are almost never equal, even when
  // that run succeeded — comparing them here made the healthy branch unreachable. Judge the
  // pipeline by the outcome of the last completed run instead.
  const failing = study.stats.lastExitRc === null || study.stats.lastExitRc !== 0;
  return failing ? `No candidates — the study pipeline is failing: ${study.line}` : "No candidates queued right now — nothing has cleared the leverage bar since the last successful run.";
}

export interface RepeatingLesson {
  tripwireId: string;
  /** The most recent hit's lesson text (untrusted — render with textContent). */
  lesson: string;
  hitCount: number;
  severity: TripwireSeverity;
}

/** Groups tripwire hits by tripwireId and keeps only the ones repeated `minHits`+ times —
 *  a lesson the fleet already wrote down that a live session keeps tripping anyway, worth
 *  treating as its own "study item" rather than a one-off. A hit is one session + lesson, so
 *  `hitCount` is a number of sessions. The server keeps its newest TRIPWIRES_HIT_CAP hits across
 *  restarts (data/tripwires.jsonl, server/features/tripwires.ts), so this counts over those, never
 *  a true all-time count. Sorted by hit count desc. */
export function repeatingLessons(hits: readonly TripwireHit[], minHits = 3): RepeatingLesson[] {
  const byId = new Map<string, TripwireHit[]>();
  for (const hit of hits) {
    const list = byId.get(hit.tripwireId);
    if (list) list.push(hit);
    else byId.set(hit.tripwireId, [hit]);
  }
  const out: RepeatingLesson[] = [];
  for (const [tripwireId, list] of byId) {
    if (list.length < minHits) continue;
    const latest = list.reduce((a, b) => (a.at > b.at ? a : b));
    out.push({ tripwireId, lesson: latest.lesson, hitCount: list.length, severity: latest.severity });
  }
  return out.sort((a, b) => b.hitCount - a.hitCount || a.tripwireId.localeCompare(b.tripwireId));
}

// ---------------------------------------------------------------- measured change (School tab)
// Headlines for the "Getting better?" block: every count with its window, and a failed read said
// as one, never as a 0.

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function revisionsLine(r: SkillRevisions): string {
  if (!r.ok) return `Couldn't read skills-repo's git log: ${r.error ?? "unknown error"}.`;
  const window = `in the last ${r.days} days (since ${r.since.slice(0, 10)}; git log on skills-repo, read-only)`;
  if (r.commits === 0) return `No SKILL.md changed ${window}.`;
  return `${count(r.commits, "commit")} changed the SKILL.md of ${count(r.skillCount, "skill")} ${window}. One sync commit can carry several edits.`;
}

export function pairsLine(p: FailureFixPairs): string {
  const extras: string[] = [];
  if (p.uncommitted > 0) extras.push(`${count(p.uncommitted, "more entry", "more entries")} on disk, not committed yet`);
  if (p.outsideRepo > 0) extras.push(`${count(p.outsideRepo, "entry", "entries")} in skills outside skills-repo (their history isn't read)`);
  if (p.truncated) extras.push(`capped at the newest commits of the first skills read`);
  const tail = extras.length ? ` ${extras.join("; ")}.` : "";
  if (!p.ok) return `Couldn't read the failure-mode history: ${p.error ?? "unknown error"}.${tail}`;
  const since = p.historySince ? ` since ${p.historySince.slice(0, 10)}` : "";
  return `${count(p.logged, "failure mode")} logged in a skills-repo commit${since}; ${p.followed} followed by a later SKILL.md revision (a later edit to the skill, not proof it fixed that failure).${tail}`;
}

export function residentSkillsLine(r: ResidentSkillsTrend): string {
  if (!r.ok) return `Couldn't read the resident's home: ${r.error ?? "unknown error"}.`;
  const audit = r.auditSince ? `its audit log since ${r.auditSince.slice(0, 10)}` : "its audit log is empty";
  if (r.written === 0) return `The resident has written 0 skills in its sandbox (${audit}).`;
  const journal = r.journalDays > 0 ? `${count(r.journalDays, "journal day")} read since ${r.journalSince ?? "?"}` : "no journal yet";
  return `The resident wrote ${count(r.written, "skill")} in its sandbox; ${r.cited} named again in a later reflection or proposal (${journal}; ${audit}).`;
}
