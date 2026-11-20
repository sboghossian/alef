// The Alef resident: one long-lived agent that lives in ~/.alef-resident and evolves. It is a
// SANDBOXED ACTOR: its models never get tools, they only propose text, and this server validates
// that text and writes it through resident-sandbox.ts's `writeInHome` (the one write path, which
// refuses anything outside the home, symlinks included, and audits every write to writes.jsonl).
//
// Two loops, both on onTick (every 5 min, never overlapping):
//   - Jev tick: diffs the fleet since the last tick (started / finished / newly waiting); when
//     something changed, Jev (TypeSafe, the same `callJev` president/council use) judges the mood
//     and whether it's worth a line, and CODE writes the journal line. Jev down → log, skip.
//   - Hourly reflection: headless `claude -p --model haiku --tools ""` (council-synth.ts's
//     pattern: execFile + argv, prompt on stdin, timeout), plus `--no-session-persistence` so the
//     run never writes a transcript the indexer would show as an agent (verified: no .jsonl is
//     written; only an empty `memory/` dir appears under ~/.claude/projects). The model returns
//     strict JSON, validated by resident-lib's `parseReflection`; invalid → lastError, no writes.
//     The exit code is never trusted: success = a valid envelope AND the journal file's mtime
//     moved during this run. Spend is capped per day (default $0.50).
//
// Lesson tripwires (tripwires.ts): each new hit becomes one journal line (written by code, through
// the same sandbox, after any reflection so it never stands in for the reflection's own write), the
// hits journaled in the last 24h are kept in state.json, and the hourly prompt carries a fenced
// per-lesson roll-up of them (only when there is one).
//
// Proposals (session|skill|memory|note) show in the Inbox; approve/dismiss only change their
// status. v1 never acts on an approval — nothing is written outside the home, and "session"
// does not launch (its text came from a model that read fleet titles; Alex launches it).
// Kill switch: `enabled` in state.json, POST /api/resident/enabled.
//
// Governance feed (vision wave 3): a proposal the resident filed or withdrew, and Alex's
// approve/dismiss of one, each go out as one feed item (governance-lib.ts writes the words),
// appended only after its proposals.json write returned ok.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RESIDENT_SNAPSHOT_KEY,
  type ResidentActionResult,
  type ResidentMessage,
  type ResidentProposal,
  type ResidentState,
  type ResidentWrite,
} from "../../shared/features/resident.js";
import type { TripwireHit } from "../../shared/features/tripwires.js";
import type { SubagentRecord } from "../../shared/features/subagents.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type FetchLike } from "../director.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import {
  answeredEntries,
  appendWaitEvents,
  buildClaudeArgs,
  buildReflectPrompt,
  buildTickJevBody,
  canAffordRun,
  dayKey,
  dayNumber,
  DEFAULT_GOALS,
  diffFleet,
  endedEntries,
  endedSinceSnapshot,
  isDuplicateProposal,
  liveSnapshot,
  sameLiveSessions,
  envelopeCost,
  freshState,
  goalsMarkdown,
  hhmm,
  hhmmSince,
  isMood,
  isQuiet,
  JOURNAL_TAIL_LINES,
  localMidnightMs,
  MAX_RUN_USD,
  MAX_SKILLS,
  newlyWaitingEntries,
  observationLine,
  orderProposals,
  parseEnvelope,
  parseGoals,
  parsePersisted,
  parseProposals,
  parseReflection,
  PROMPT_JOURNAL_LINES,
  RECENT_WRITES,
  REFLECT_MS,
  reflectDueAt,
  waitingResolved,
  sampleFleet,
  spendToday,
  summarizeDistricts,
  summarizeSince,
  rememberTripwires,
  stoppedWaitingEntries,
  summarizeTripwires,
  tailLines,
  TICK_MS,
  TRIPWIRE_WINDOW_MS,
  tripwireJournalLines,
  type FleetDelta,
  type FleetSample,
  type PersistedState,
  type Reflection,
  type WaitEvent,
} from "./resident-lib.js";
import { appendToFeed } from "./feed.js";
import { residentClickItem, residentProposalItem, type FeedDraft } from "./governance-lib.js";
import { AUDIT_LOG, listInHome, mtimeInHome, readInHome, writeInHome } from "./resident-sandbox.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { latestSubagentRecords } from "./subagents/index.js";
import { recentTripwireHits } from "./tripwires.js";
import type { WorkspaceEntry } from "../../shared/workspace/scorer.js";
import { broadcastLines, noteInfluence, workspaceFor, type InfluenceNote } from "./workspace-state.js";

export const REFLECT_TIMEOUT_MS = 90_000;

/** The resident's state (what snapshotExtras serves as "resident.state"), for the Town square's
 *  server-side workspace (workspace.ts). Production builds one resident; the last one built answers.
 *  Null until state.json has been read. */
let stateOf: (() => ResidentState | null) | null = null;
export function currentResidentState(): ResidentState | null {
  return stateOf?.() ?? null;
}

export interface ReflectOutput {
  stdout: string;
  stderr: string;
  /** false when claude exited non-zero or was killed (stdout may still hold an envelope with a cost). */
  exitedOk: boolean;
}
/** Rejects only when claude could not be started at all (then nothing was spent). */
export type ReflectRunner = (prompt: string, opts: { cwd: string; timeoutMs: number }) => Promise<ReflectOutput>;

const CLAUDE_ARGS = buildClaudeArgs(MAX_RUN_USD);

/** Real runner: no shell (argv array), prompt over stdin, killed after timeoutMs, cwd = the home. */
export const realReflectRunner: ReflectRunner = (prompt, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile("claude", CLAUDE_ARGS, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr), exitedOk: !err });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(prompt);
    child.stdin?.end();
  });

export interface ResidentFeatureOptions {
  /** Defaults to ~/.alef-resident. Tests pass a temp dir. */
  homeDir?: string;
  /** `enabled` for a brand-new resident (no state.json yet). Production true; tests pass false. */
  defaultEnabled?: boolean;
  tickIntervalMs?: number;
  reflectEveryMs?: number;
  apiKey?: string;
  fetchImpl?: FetchLike;
  jevTimeoutMs?: number;
  runner?: ReflectRunner;
  reflectTimeoutMs?: number;
  now?: () => number;
  /** The Town square shown (fenced) in the reflection prompt; defaults to the server-side
   *  workspace's broadcast (workspace-state.ts). Null or empty: no block, no added cost. */
  townSquare?: (nowMs: number) => readonly WorkspaceEntry[] | null;
  /** Where each landed reflection reports what it was shown; defaults to the workspace feature. */
  noteInfluence?: (n: InfluenceNote) => void;
  /** Lesson-tripwire hits, newest first. Defaults to the running tripwires feature's. */
  tripwireHits?: () => readonly TripwireHit[];
  /** Subagent records for the "since last reflection" roll-up. Defaults to the running subagents
   *  feature's latest published copy (see `subagents/index.ts`'s `latestSubagentRecords`). */
  subagentRecords?: () => readonly SubagentRecord[];
  /** Where proposal decisions go; defaults to the live Feed (feed.ts appendToFeed). */
  feed?: (item: FeedDraft) => void;
}

export function createResidentFeature(opts: ResidentFeatureOptions = {}): ServerFeature {
  const home = opts.homeDir ?? join(homedir(), ".alef-resident");
  const defaultEnabled = opts.defaultEnabled ?? true;
  const reflectEveryMs = opts.reflectEveryMs ?? REFLECT_MS;
  const runner = opts.runner ?? realReflectRunner;
  const townSquareOf = opts.townSquare ?? ((nowMs: number) => workspaceFor("resident", nowMs));
  const noteWorkspaceInfluence = opts.noteInfluence ?? noteInfluence;
  const now = opts.now ?? Date.now;
  const tripwireHits = opts.tripwireHits ?? recentTripwireHits;
  const subagentRecords = opts.subagentRecords ?? latestSubagentRecords;
  const feed = opts.feed ?? appendToFeed;

  let persisted: PersistedState | null = null; // null until loaded
  /** Did the fleet change since the last reflection? Starts true so a restart reflects on schedule. */
  let changedSinceReflect = true;
  let seeded = false;
  let goals: string[] = [];
  let skills: string[] = [];
  let journalTail: string[] = [];
  let recentWrites: ResidentWrite[] = [];
  let proposals: ResidentProposal[] = [];
  let prevSample: FleetSample | null = null;
  let loading: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  /** Tripwire hit ids journaled since boot (state.json keeps only the last 24h, newest first, capped). */
  const journaledTripwires = new Set<string>();

  /** Every mutation runs one at a time (tick, toggle, approve/dismiss). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  function journalRel(ms: number): string {
    return `journal/${dayKey(ms)}.md`;
  }

  async function refreshDerived(): Promise<void> {
    const nowMs = now();
    goals = parseGoals((await readInHome(home, "goals.md")) ?? "");
    skills = (await listInHome(home, "skills")).map((n) => n.replace(/\.md$/, "")).slice(0, MAX_SKILLS);
    journalTail = tailLines((await readInHome(home, journalRel(nowMs), 32 * 1024)) ?? "", JOURNAL_TAIL_LINES);
    const audit = (await readInHome(home, AUDIT_LOG, 16 * 1024)) ?? "";
    recentWrites = tailLines(audit, RECENT_WRITES + 1)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter((w): w is ResidentWrite => isRecord(w) && typeof w.at === "string" && typeof w.path === "string" && typeof w.bytes === "number" && typeof w.reason === "string")
      .slice(-RECENT_WRITES);
    let raw: unknown = null;
    try {
      raw = JSON.parse((await readInHome(home, "proposals.json")) ?? "[]");
    } catch {
      raw = null;
    }
    proposals = orderProposals(parseProposals(raw));
  }

  /** refreshDerived for the mutation paths: a sandbox refusal (a planted symlink) is recorded, not thrown. */
  async function refresh(ctx: FeatureContext): Promise<void> {
    try {
      await refreshDerived();
    } catch (err) {
      ctx.log.warn("resident", "refresh failed", String(err));
      if (persisted) persisted.lastError = `read refused: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Read-only: never creates the home (the first enabled tick or a toggle does). */
  async function ensureLoaded(ctx: FeatureContext): Promise<void> {
    if (persisted) return;
    loading ??= (async () => {
      const fallback = freshState(now(), defaultEnabled);
      let text: string | null = null;
      try {
        text = await readInHome(home, "state.json");
        await refreshDerived();
      } catch (err) {
        ctx.log.warn("resident", "load failed", String(err));
      }
      let raw: unknown = null;
      try {
        raw = text === null ? null : JSON.parse(text);
      } catch {
        raw = null;
      }
      seeded = text !== null;
      persisted = parsePersisted(raw, fallback);
    })();
    await loading;
  }

  function state(): ResidentState {
    const s = persisted ?? freshState(now(), defaultEnabled);
    const nowMs = now();
    return {
      name: s.name,
      enabled: s.enabled,
      bornAt: s.bornAt,
      day: dayNumber(s.bornAt, nowMs),
      lastTickAt: s.lastTickAt,
      lastReflectAt: s.lastReflectAt,
      lastError: s.lastError,
      goals: goals.length ? goals : [...DEFAULT_GOALS],
      skills,
      journalTail,
      recentWrites,
      proposals,
      spend: { todayUsd: Math.round(spendToday(s, nowMs) * 10_000) / 10_000, capUsd: s.capUsd },
    };
  }

  stateOf = () => (persisted ? state() : null);

  function emit(ctx: FeatureContext): void {
    ctx.emit({ kind: "state", state: state() } satisfies ResidentMessage);
  }

  /** Writes through the sandbox; a refusal is logged and recorded, never thrown. */
  async function write(ctx: FeatureContext, rel: string, content: string, reason: string, mode: "replace" | "append" = "replace"): Promise<boolean> {
    const r = await writeInHome(home, rel, content, reason, mode, now);
    if (!r.ok) {
      ctx.log.warn("resident", `write refused: ${rel}`, r.error);
      if (persisted) persisted.lastError = `write refused (${rel}): ${r.error}`;
    }
    return r.ok;
  }

  async function saveState(ctx: FeatureContext, reason: string): Promise<void> {
    if (persisted) await write(ctx, "state.json", `${JSON.stringify(persisted, null, 2)}\n`, reason);
  }

  async function appendJournal(ctx: FeatureContext, atMs: number, text: string, reason: string): Promise<boolean> {
    const rel = journalRel(atMs);
    const exists = (await mtimeInHome(home, rel)) !== null;
    const header = exists ? "" : `# ${dayKey(atMs)} · day ${dayNumber(persisted?.bornAt ?? "", atMs)}\n\n`;
    return write(ctx, rel, `${header}${text}\n`, reason, "append");
  }

  async function seedIfNeeded(ctx: FeatureContext): Promise<void> {
    if (seeded || !persisted) return;
    seeded = true;
    const nowMs = now();
    await saveState(ctx, "moved in: first state");
    if ((await readInHome(home, "goals.md")) === null) await write(ctx, "goals.md", goalsMarkdown(DEFAULT_GOALS), "moved in: seed goals");
    await appendJournal(ctx, nowMs, `- ${hhmm(nowMs)} · Moved into Alef.`, "moved in: first journal line");
  }

  async function jevObserve(ctx: FeatureContext, delta: FleetDelta, nowMs: number): Promise<void> {
    const apiKey = opts.apiKey ?? ctx.config.typesafeApiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) return; // Jev unavailable: skip quietly, same as president's rules path
    const fetchImpl = opts.fetchImpl ?? ctx.config.typesafeFetchImpl ?? (globalThis.fetch as FetchLike);
    let answers: Record<string, unknown>;
    try {
      const raw = await callJev(apiKey, buildTickJevBody(delta), fetchImpl, opts.jevTimeoutMs ?? TIMEOUT_MS);
      if (!isRecord(raw) || !isRecord(raw.answers)) throw new Error("typesafe response missing answers");
      answers = raw.answers;
    } catch (err) {
      ctx.log.warn("resident", "jev tick failed, skipping", String(err));
      return;
    }
    const mood = answers.mood;
    const noteworthy = answers.noteworthy;
    if (!isChoiceAnswer(mood) || !isMood(mood.choice) || !isChoiceAnswer(noteworthy)) {
      ctx.log.warn("resident", "jev tick: unexpected answer shape, skipping");
      return;
    }
    if (noteworthy.choice !== "yes") return;
    await appendJournal(ctx, nowMs, observationLine(nowMs, delta, mood.choice, mood.confidence), `jev tick: ${mood.choice}`);
  }

  /** One journal append for the tripwire hits it hasn't written down yet (a lesson a live session
   *  repeated), remembered in state.json so a server restart (which re-reports a live subagent's
   *  hits) never journals one twice. No model call and no change to the reflection cadence. */
  async function journalTripwires(ctx: FeatureContext, s: PersistedState, nowMs: number): Promise<void> {
    const known = new Set(s.tripwires.map((r) => r.id));
    const fresh = tripwireHits()
      .filter((h) => !known.has(h.id) && !journaledTripwires.has(h.id) && nowMs - Date.parse(h.at) <= TRIPWIRE_WINDOW_MS)
      .reverse();
    if (fresh.length === 0) return;
    for (const h of fresh) journaledTripwires.add(h.id);
    if (journaledTripwires.size > 2000) for (const id of [...journaledTripwires].slice(0, journaledTripwires.size - 2000)) journaledTripwires.delete(id);
    s.tripwires = rememberTripwires(s.tripwires, fresh, nowMs);
    await appendJournal(ctx, nowMs, tripwireJournalLines(fresh).join("\n"), `tripwires: ${fresh.length} repeated lesson(s)`);
    await saveState(ctx, "tripwires journaled");
  }

  function reflectDue(s: PersistedState, nowMs: number): boolean {
    const last = Math.max(Date.parse(s.lastReflectAt ?? "") || 0, Date.parse(s.lastReflectAttemptAt ?? "") || 0);
    return reflectDueAt(last, nowMs, changedSinceReflect, reflectEveryMs);
  }

  async function applyReflection(ctx: FeatureContext, r: Reflection, atMs: number): Promise<boolean> {
    // A malformed withdraw id costs only itself (resident-lib's parseReflection already dropped
    // it): journaled normally, just with the drop recorded on the audited write and logged, never
    // thrown away with the rest of the hour's reflection.
    if (r.droppedWithdraw.length) ctx.log.warn("resident", `dropped ${r.droppedWithdraw.length} invalid withdraw id(s)`, r.droppedWithdraw);
    const journalReason = r.droppedWithdraw.length ? `hourly reflection (dropped ${r.droppedWithdraw.length} invalid withdraw id${r.droppedWithdraw.length === 1 ? "" : "s"})` : "hourly reflection";
    let ok = await appendJournal(ctx, atMs, `\n## ${hhmm(atMs)} · reflection\n\n${r.journal}\n`, journalReason);
    ok = (await write(ctx, "goals.md", goalsMarkdown(r.goals), "hourly reflection: goals")) && ok;
    if (r.skill && (skills.includes(r.skill.slug) || skills.length < MAX_SKILLS)) {
      ok = (await write(ctx, `skills/${r.skill.slug}.md`, `# ${r.skill.name}\n\n${r.skill.body}\n`, `new skill: ${r.skill.name}`)) && ok;
    }
    const withdrawn = new Set(r.withdraw.filter((id) => proposals.some((p) => p.id === id && p.status === "open")));
    if (withdrawn.size) {
      const next = orderProposals(proposals.map((p) => (withdrawn.has(p.id) ? { ...p, status: "dismissed" as const } : p)));
      const gone = proposals.filter((p) => withdrawn.has(p.id));
      const saved = await write(ctx, "proposals.json", `${JSON.stringify(next, null, 2)}\n`, `withdrew: ${gone.map((p) => p.title).join("; ")}`);
      ok = saved && ok;
      proposals = next;
      if (saved) for (const p of gone) feed(residentProposalItem(p, "withdrew", new Date(atMs).toISOString()));
    }
    const seen = proposals.map((p) => p.title);
    const fresh = r.proposals.filter((p) => !isDuplicateProposal(p.title, seen) && seen.push(p.title) > 0);
    if (fresh.length) {
      const iso = new Date(atMs).toISOString();
      const added: ResidentProposal[] = fresh.map((p, i) => ({ id: `rp-${atMs.toString(36)}-${i}`, at: iso, kind: p.kind, title: p.title, why: p.why, status: "open" }));
      const next = orderProposals([...added, ...proposals]);
      const saved = await write(ctx, "proposals.json", `${JSON.stringify(next, null, 2)}\n`, `proposed: ${added.map((p) => p.title).join("; ")}`);
      ok = saved && ok;
      if (saved) proposals = next; // before the feed item: GET /api/resident is not serialized behind this tick
      if (saved) for (const p of added) feed(residentProposalItem(p, "filed", iso));
    }
    return ok;
  }

  async function reflect(ctx: FeatureContext, s: PersistedState, nowMs: number, fleet: FleetSample, islands: readonly Island[], agents: readonly WorldAgent[]): Promise<void> {
    const today = spendToday(s, nowMs);
    if (!canAffordRun(today, s.capUsd)) {
      const msg = `over the daily cap ($${today.toFixed(3)} of $${s.capUsd.toFixed(2)}): reflection skipped`;
      if (s.lastError !== msg) {
        s.lastError = msg;
        await appendJournal(ctx, nowMs, `- ${hhmm(nowMs)} · Skipped my reflection: I hit today's budget.`, "budget cap reached");
      }
      s.lastReflectAttemptAt = new Date(nowMs).toISOString();
      return;
    }
    const journal = tailLines((await readInHome(home, journalRel(nowMs), 32 * 1024)) ?? "", PROMPT_JOURNAL_LINES);
    let live = 0;
    let waiting = 0;
    for (const e of fleet.values()) {
      if (e.live) live++;
      if (e.waiting) waiting++;
    }
    const districts = summarizeDistricts(islands, [...fleet.values()], nowMs);
    const tripwires = summarizeTripwires(rememberTripwires(s.tripwires, tripwireHits(), nowMs), nowMs);
    // Read BEFORE this reflection may update lastReflectAt below: the last SUCCESSFUL reflection
    // (this field is only ever set on success), else local midnight — never diffFleet's in-memory
    // prevSample, which has no memory across a restart.
    const lastReflectMs = s.lastReflectAt ? Date.parse(s.lastReflectAt) : NaN;
    const sinceMs = Number.isFinite(lastReflectMs) ? lastReflectMs : localMidnightMs(nowMs);
    const since = summarizeSince({ agents, islands, subagents: subagentRecords() ?? [], waitEvents: s.waitEvents, waitEventsDropped: s.waitEventsDropped, sinceMs, nowMs });
    const sinceLabel = `${hhmmSince(sinceMs, nowMs)} → ${hhmm(nowMs)}`;
    const townSquare = townSquareOf(nowMs);
    const prompt = buildReflectPrompt({
      name: s.name,
      day: dayNumber(s.bornAt, nowMs),
      goals: goals.length ? goals : DEFAULT_GOALS,
      skills,
      journal,
      fleet: { live, waiting, total: fleet.size },
      since,
      sinceLabel,
      proposals,
      districts,
      tripwires,
      townSquare: broadcastLines(townSquare ?? [], nowMs),
    });
    s.lastReflectAttemptAt = new Date(nowMs).toISOString();
    const startedMs = now();
    let out: ReflectOutput;
    try {
      out = await runner(prompt, { cwd: home, timeoutMs: opts.reflectTimeoutMs ?? REFLECT_TIMEOUT_MS });
    } catch (err) {
      s.lastError = `claude could not start: ${String(err)}`;
      return;
    }
    // Count the money first: a run that failed validation still cost something.
    const cost = envelopeCost(out.stdout, prompt.length);
    s.spend = { day: dayKey(nowMs), usd: today + cost };
    const env = parseEnvelope(out.stdout, prompt.length);
    if (!env.ok) {
      s.lastError = `reflection failed: ${env.error}${out.exitedOk ? "" : " (claude exited non-zero)"}`;
      return;
    }
    const parsed = parseReflection(env.value.text);
    if (!parsed.ok) {
      s.lastError = `invalid reflection, nothing written: ${parsed.error}`;
      return;
    }
    s.lastError = null; // a sandbox refusal inside applyReflection sets it again
    const wrote = await applyReflection(ctx, parsed.value, nowMs);
    // Verify the artifact, never the exit code: the journal must exist and have moved this run.
    const mtime = await mtimeInHome(home, journalRel(nowMs));
    if (!wrote || mtime === null || mtime < startedMs - 1000) {
      s.lastError = s.lastError ?? "reflection ran but the journal was not written this run";
      return;
    }
    s.lastReflectAt = new Date(nowMs).toISOString();
    // Only a landed journal entry counts toward the Town square's influence share.
    noteWorkspaceInfluence({ source: "resident", at: nowMs, journal: parsed.value.journal, shown: townSquare });
    changedSinceReflect = false; // only a reflection that actually landed resets the cadence
    s.waitEvents = []; // …and only then: a failed attempt must never lose a noticed wait/answer
    s.waitEventsDropped = 0;
    s.lastError = null;
  }

  async function tick(ctx: FeatureContext): Promise<void> {
    await ensureLoaded(ctx);
    await serial(async () => {
      const s = persisted;
      if (!s || !s.enabled) return;
      await seedIfNeeded(ctx);
      const nowMs = now();
      const { agents, islands } = ctx.worldViews();
      const sample = sampleFleet(agents);
      const delta = diffFleet(prevSample, sample);
      const began = newlyWaitingEntries(prevSample, sample);
      const resolved = answeredEntries(prevSample, sample);
      const stopped = stoppedWaitingEntries(prevSample, sample);
      // No previous sample (first tick after a boot or a re-enable): nothing ticked in between, so
      // diff against the live set state.json kept instead, and stamp each end as a range. Without
      // it, a session a process kept live while idle that ended in the gap (its lastActive hours
      // old) would vanish, and the next reflection would claim nothing ended.
      const gapFrom = prevSample ? null : s.lastLive;
      const ended = prevSample ? endedEntries(prevSample, sample) : endedSinceSnapshot(gapFrom, sample);
      if (waitingResolved(prevSample, sample)) changedSinceReflect = true;
      prevSample = sample;
      const iso = new Date(nowMs).toISOString();
      s.lastTickAt = iso;
      const live = liveSnapshot(sample, nowMs);
      const liveChanged = !sameLiveSessions(s.lastLive, live);
      s.lastLive = live; // every save from here on carries this tick's live set
      if (began.length || resolved.length || stopped.length || ended.length) {
        const seenLiveAt = gapFrom?.at;
        const additions: WaitEvent[] = [
          ...began.map((w): WaitEvent => ({ at: iso, kind: "waiting", title: w.title, islandId: w.islandId, sessionId: w.sessionId })),
          ...resolved.map((w): WaitEvent => ({ at: iso, kind: "answered", title: w.title, islandId: w.islandId, sessionId: w.sessionId })),
          ...stopped.map((w): WaitEvent => ({ at: iso, kind: "stopped_waiting", title: w.title, islandId: w.islandId, sessionId: w.sessionId })),
          ...ended.map((e): WaitEvent => ({ at: iso, kind: "ended", title: e.title, islandId: e.islandId, sessionId: e.sessionId, ...(seenLiveAt ? { seenLiveAt } : {}) })),
        ];
        const { events, dropped } = appendWaitEvents(s.waitEvents, additions);
        s.waitEvents = events;
        s.waitEventsDropped += dropped;
        // Persisted right away (not only after the next reflection) so a restart before the next
        // hourly reflection never loses a wait/answer/end a tick already noticed.
        await saveState(ctx, "wait or end event noticed");
      } else if (liveChanged) {
        // Only when the live SET changed (a start, mostly): saving every tick would put a line in
        // the audit log every 5 minutes. The saved `at` can lag, which only widens a gap's range.
        await saveState(ctx, "live sessions changed");
      }
      if (!isQuiet(delta)) {
        changedSinceReflect = true;
        await jevObserve(ctx, delta, nowMs);
      }
      if (reflectDue(s, nowMs)) {
        await reflect(ctx, s, nowMs, sample, islands, agents);
        await saveState(ctx, "after reflection");
      }
      await journalTripwires(ctx, s, nowMs);
      await refresh(ctx);
      emit(ctx);
    });
  }

  async function decide(ctx: FeatureContext, id: string, status: "approved" | "dismissed"): Promise<{ status: number; body: ResidentActionResult }> {
    await ensureLoaded(ctx);
    return serial(async () => {
      const p = proposals.find((x) => x.id === id && x.status === "open");
      if (!p) return { status: 404, body: { ok: false, error: "unknown or already decided proposal" } };
      const next = orderProposals(proposals.map((x) => (x.id === id ? { ...x, status } : x)));
      if (!(await write(ctx, "proposals.json", `${JSON.stringify(next, null, 2)}\n`, `${status}: ${p.title}`))) {
        return { status: 500, body: { ok: false, error: "could not save proposals" } };
      }
      feed(residentClickItem(p, status, new Date(now()).toISOString()));
      await refresh(ctx);
      emit(ctx);
      return { status: 200, body: { ok: true, state: state() } };
    });
  }

  return {
    id: "resident",
    tickIntervalMs: opts.tickIntervalMs ?? TICK_MS,
    onTick: tick,
    routes: [
      {
        method: "GET",
        path: "/api/resident",
        async handler(_req, res, ctx) {
          await ensureLoaded(ctx);
          respondJson(res, 200, state());
        },
      },
      {
        method: "POST",
        path: "/api/resident/enabled",
        async handler(req, res, ctx) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return respondJson(res, 400, { ok: false, error: "invalid JSON body" } satisfies ResidentActionResult);
          }
          if (!isRecord(body) || typeof body.enabled !== "boolean") {
            return respondJson(res, 400, { ok: false, error: "body must be {enabled: boolean}" } satisfies ResidentActionResult);
          }
          const enabled = body.enabled;
          await ensureLoaded(ctx);
          await serial(async () => {
            if (!persisted) return;
            const wasEnabled = persisted.enabled;
            persisted.enabled = enabled;
            // A disabled tick returns before `prevSample = sample`, so the in-memory sample can be
            // stale by the whole time it was off. Diffing a fresh sample against it on re-enable
            // would misdate every wait/answer change from the disabled period to this instant, and
            // could even misfire an "answered"/"stopped waiting" pair for something that changed
            // while nobody was looking. Starting from null makes the next tick a boot-like first
            // sample: no invented wait/answer transitions, and the sessions that stopped being
            // live while it was off are diffed against the saved `lastLive` and reported as ended
            // somewhere inside the off period, as a range, never at this instant.
            if (enabled && !wasEnabled) prevSample = null;
            await saveState(ctx, enabled ? "switched on" : "switched off (kill switch)");
            await refresh(ctx);
          });
          ctx.log.info("resident", enabled ? "enabled" : "disabled (kill switch)");
          emit(ctx);
          respondJson(res, 200, { ok: true, state: state() } satisfies ResidentActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/resident/proposals/:id/approve",
        async handler(_req, res, ctx, params) {
          const r = await decide(ctx, params.id ?? "", "approved");
          respondJson(res, r.status, r.body);
        },
      },
      {
        method: "POST",
        path: "/api/resident/proposals/:id/dismiss",
        async handler(_req, res, ctx, params) {
          const r = await decide(ctx, params.id ?? "", "dismissed");
          respondJson(res, r.status, r.body);
        },
      },
    ],
    snapshotExtras(ctx) {
      if (!persisted) {
        void ensureLoaded(ctx); // fills in on the next snapshot; never block this one
        return {};
      }
      return { [RESIDENT_SNAPSHOT_KEY]: state() };
    },
  };
}

export const residentFeature = createResidentFeature();
