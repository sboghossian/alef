// Jev as president (round 10, item 3+4): every 30 min (and on demand via GET /api/president/
// refresh) gathers real signals — the open-loops board, failing/warn Health checks, stale
// todo.md items, open sickness cases (vision wave 2: "treat" a sick automation lineage,
// "research" a tripwire rule for a disease that keeps recurring) and dormant small districts —
// and asks Jev (TypeSafe, the same client council/ask-jev use) to rank them into at most a few
// proposals, in ONE batched call per refresh. NEVER launches anything itself: launch/merge are
// POSTs that only run from a user's click, and launch reuses the exact plan-mode path Loops ▶
// Launch already uses (`loops-launch.ts`'s `validateLaunch` + `worldPlanLoopsLauncher`, itself
// `talk.ts`'s `startWorldSession`) rather than a second one.
//
// SAFETY INVARIANT: always-live candidates never reach Jev or the board. Before ranking, every
// session candidate from every source is dropped (and logged) when its cwd is inside or contains
// a folder backing a *.dashable.dev host, or its text mentions HARD STOP / cutover / tunnel
// ingress / launchd / dashable / cloudflared. The host map is read at refresh time, read-only,
// through fork-lib's deny-list loader (the cloudflared ingress AND ~/.dashable/services.yml's
// dir->port->host map, plus the cwd of whatever listens on those ports); if it can't be read,
// every session candidate is dropped. A launch re-checks the same rules right before starting.
//
// Until the first refresh after boot has finished, launch/dismiss/merge answer 503: the board
// loaded from disk is visible, but `candidatesById` is still empty, so a 404 there would read
// as if the proposal were gone. A launch reports the folder's trust state (server/trust.ts).
//
// Persistence is two small JSON files beside world.db (write-tmp-then-rename, same pattern as
// cleanup-trash.ts's manifest): `data/president.json` (the last computed board, the dismiss
// cooldown map, the launch log and the ledger) and `data/district-merges.json` (the approved,
// display-only merge mapping — served by GET /api/district-merges and consumed once, at boot, by
// client/src/layout.ts).
//
// COMMENCEMENT (agent-city piece 5): the same refresh also builds graduation actions from the
// careers workers, the skills store's first fires, the tripwire hits and the open loops
// (president-lib.ts, code-written words), drops the unsafe ones, and asks Jev a "commencement"
// Choice question INSIDE the same batched call. At most MAX_COMMENCEMENT_PROPOSALS; "none" empties it.
// INVARIANTS:
//   - nothing launches, retires or writes without a click (the routes below are POSTs from the Inbox);
//   - every launch is plan mode (buildLoopsLaunchCommand via worldPlanLoopsLauncher);
//   - task text is written by code, never by Jev; the client never supplies cwd or task (the launch
//     route re-derives both from the stored candidate, and refuses a body that carries them);
//   - Alef itself never writes to launchd, hooks, skills or settings: schedule / hook / unload are
//     plan-mode sessions that show what they would do, run in ~/.alef-commencement only (an empty
//     0700 folder made at the first launch click, never $HOME); Retire writes data/careers.json only;
//   - one Jev call per refresh, as before.
// The ledger (president.json) records every proposal shown, the click that acted on it, and a
// launch's tmux session; each tick joins that to the session talk adopted into it, and the record
// line reads that session's verdict from the outcomes feature (never a model's score of itself).
//
// GOVERNANCE FEED (vision wave 3): a refresh in which Jev answered and the board changed goes out
// as one gov:jev item (which candidates it ranked, how many it proposed, p(none)); every click
// that took effect (launch, dismiss, merge, retire) goes out as one gov:click item, appended only
// after that click's own write or launch went through (governance-lib.ts writes the words).

import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISMISS_COOLDOWN_MS,
  HIRE_WINDOW_DAYS,
  MAX_COMMENCEMENT_PROPOSALS,
  MAX_MERGE_PROPOSALS,
  PRESIDENT_NOT_READY_ERROR,
  type DistrictMergeRecord,
  type DistrictMergesResponse,
  type LedgerOutcome,
  type PresidentActionResult,
  type PresidentBoard,
  type PresidentLedgerEntry,
  type PresidentMergeProposal,
  type PresidentMessage,
  type PresidentOrigin,
  type PresidentProposal,
} from "../../shared/features/president.js";
import { autonomyLevel } from "../../shared/autonomy.js";
import type { CareerWorker, CareersActionResult } from "../../shared/features/careers.js";
import type { OutcomeRecord } from "../../shared/features/outcomes.js";
import type { SicknessCase } from "../../shared/features/sickness.js";
import type { TalkBinding } from "../../shared/features/talk.js";
import { TRIPWIRES_HIT_CAP, type TripwireHit } from "../../shared/features/tripwires.js";
import { automationKey } from "../../shared/display.js";
import { callJev, isChoiceAnswer, TIMEOUT_MS, type FetchLike } from "../director.js";
import { isRecord, readJsonBody, respondJson } from "../http.js";
import { latestCareerWorkers, retireCareerWorker } from "./careers.js";
import { latestOutcomeRecords } from "./outcomes.js";
import { skillDebutsSince, type SkillDebuts } from "./skills.js";
import { loadTalkBindings } from "./talk.js";
import { recentTripwireHits } from "./tripwires.js";
import { folderTrust } from "../trust.js";
import { defaultDenySources, loadDenyRules, realOrResolved, realPortCwds, type PortCwdLookup } from "./fork-lib.js";
import {
  buildJevBody,
  buildMergeProposal,
  COMMENCEMENT_DIR_NAME,
  commencementDir,
  commencementSafetyReason,
  dormantSmallDistricts,
  droppedEntry,
  dropUnsafeCandidates,
  dropUnsafeCommencement,
  hireCandidates,
  hookCandidates,
  hookWindowLabel,
  linkLedgerSessions,
  localMinutesOfDay,
  noteActed,
  noteShown,
  parseLedger,
  presidentRecord,
  probabilitiesById,
  pruneDismissed,
  rankByJevProbabilities,
  rankByPriority,
  rankCommencementByJev,
  researchCandidatesFromCases,
  retireCandidates,
  ROUTINE_LABEL_RE,
  routineLiveReason,
  routineScripts,
  safetyReason,
  scheduleCandidates,
  selectMergeProposals,
  selectSessionProposals,
  sessionCandidatesFromHealth,
  sessionCandidatesFromLoops,
  toCommencementProposal,
  toSessionProposal,
  treatCandidatesFromCases,
  tripwireCovers,
  uniqueById,
  type AlwaysLiveMap,
  type CommencementCandidate,
  type DormantDistrictInput,
  type LoopCandidateInput,
  type SessionCandidate,
} from "./president-lib.js";
import { openSicknessCases } from "./sickness.js";
import { TRIPWIRE_DEFS } from "./tripwires-defs.js";
import { compileTripwires } from "./tripwires-lib.js";
import { computeCheapChecks, REAL_GATHERERS } from "./completeness.js";
import type { CompletenessCheck } from "../../shared/features/completeness.js";
import { DEFAULT_CODE_DIR, scanTodoFiles } from "./loops-scan.js";
import { DEFAULT_WHATSUP_TODOS_JSON, readWhatsupBoard } from "./loops-whatsup.js";
import { mergeLoopsItems } from "./loops-merge.js";
import type { LoopsItem } from "../../shared/features/loops.js";
import { appendToFeed } from "./feed.js";
import { boardSignature, jevRankingItem, presidentClickItem, type FeedDraft, type JevRanking } from "./governance-lib.js";
import { createLaunchOnce } from "./launch-once.js";
import { validateLaunch, worldPlanLoopsLauncher, type LoopsLauncher } from "./loops-launch.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import type { WorkspaceEntry } from "../../shared/workspace/scorer.js";
import { broadcastLines, noteInfluence, workspaceFor, type InfluenceNote } from "./workspace-state.js";
import { citableFinds, findAge, jevWebLogFor } from "./recall/jev-web.js";
import { realVoiceDeps } from "./voice-brain.js";

const REFRESH_MS = 30 * 60_000;
/** How often the ledger is joined to adopted sessions and their outcomes (no Jev call: the refresh
 *  itself stays throttled to REFRESH_MS). */
const LEDGER_TICK_MS = 60_000;
/** When this server process started: what the tripwire hits (kept in memory) cover. */
const SERVER_STARTED_AT_MS = Date.now() - process.uptime() * 1000;
/** Body fields a launch never takes from a client: the server re-derives them from the candidate. */
const CLIENT_SUPPLIED_FIELDS: readonly string[] = ["cwd", "task", "prompt", "command"];
/** A routine script is read this far (enough for any launcher script; a log never reaches here). */
const ROUTINE_SCRIPT_MAX_BYTES = 64 * 1024;
const ROUTINE_SCRIPTS_MAX = 3;

/** The president's board (what snapshotExtras serves as "president.board"), for the Town square's
 *  server-side workspace (workspace.ts). Production builds one president; the last one built
 *  answers. Null until its board is loaded. */
let boardOf: (() => PresidentBoard | null) | null = null;
export function currentPresidentBoard(): PresidentBoard | null {
  return boardOf?.() ?? null;
}
/** The ledger (president.json: every proposal shown and the click on it), oldest first, for the
 *  Home view's "Jev decided lately". Null until president.json has been read. */
let ledgerOf: (() => readonly PresidentLedgerEntry[] | null) | null = null;
export function latestPresidentLedger(): readonly PresidentLedgerEntry[] | null {
  return ledgerOf?.() ?? null;
}

/** The start of a file under $HOME, or null: missing, unreadable, or an iCloud placeholder (reading
 *  one can hang: blocks 0 with a size, the dataless-file trap). Null reads as "couldn't be checked". */
async function readHead(path: string, homeDir: string): Promise<string | null> {
  if (!path.startsWith(`${homeDir}/`)) return null;
  try {
    const st = await stat(path);
    if (!st.isFile() || (st.size > 0 && st.blocks === 0)) return null;
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, ROUTINE_SCRIPT_MAX_BYTES));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** A routine's plist plus EVERY script it runs, read-only; null ("couldn't be checked": the unload
 *  is then not offered) when the plist or any of those scripts can't be read, one is outside $HOME,
 *  or routineScripts can't name them all (more than ROUTINE_SCRIPTS_MAX, a variable other than
 *  $HOME, an interpreter with no script file). */
export async function readRoutineText(homeDir: string, label: string): Promise<string | null> {
  if (!ROUTINE_LABEL_RE.test(label)) return null;
  const plist = await readHead(join(homeDir, "Library", "LaunchAgents", `${label}.plist`), homeDir);
  if (plist === null) return null;
  const scripts = routineScripts(plist, homeDir, ROUTINE_SCRIPTS_MAX);
  if (scripts === null) return null;
  const parts = [plist];
  for (const p of scripts) {
    const text = await readHead(p.startsWith("~/") ? join(homeDir, p.slice(2)) : p, homeDir); // null outside $HOME
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join("\n");
}
const REPO_CITY = "agent-world"; // this repo, for Health- and research-derived session proposals
/** president.json keeps this many launch records. */
const LAUNCH_LOG_CAP = 200;

const EMPTY_BOARD: PresidentBoard = { generatedAt: new Date(0).toISOString(), proposals: [], source: "rules" };

/** Real always-live map: fork-lib's deny list (both dashable configs, read-only, plus the cwd of
 *  whatever listens on their ports). Fails closed when it can't be read, and when it names no
 *  always-live folder at all (both configs gone or empty is a broken map on this Mac, not "no
 *  live hosts"). Injectable in tests so they never read the real ~/.cloudflared, ~/.dashable or lsof. */
export async function loadAlwaysLiveMap(homeDir: string, portCwds: PortCwdLookup = realPortCwds): Promise<AlwaysLiveMap> {
  const load = await loadDenyRules(defaultDenySources(homeDir), portCwds);
  if (!load.ok) return { ok: false, error: load.error };
  if (load.alwaysLiveDirs === 0) return { ok: false, error: "the dashable configs name no always-live folder (both missing or empty)" };
  return { ok: true, rules: load.rules };
}

/** The checkout Health/research sessions launch in. The live app runs from ~/.alef-live, whose
 *  data/ is a symlink into the dev checkout: a proposed session must work in that dev checkout,
 *  never in the live one, so follow data/ back to the git checkout it belongs to. */
export async function devRepoRoot(codeRoot: string): Promise<string> {
  try {
    const parent = dirname(await realpath(join(codeRoot, "data")));
    if (parent !== codeRoot && existsSync(join(parent, ".git"))) return parent;
  } catch {
    // no data/ here (a worktree, a fresh clone): this checkout is the one
  }
  return codeRoot;
}

/** One launched proposal, kept in president.json: the case ids ride along so a later
 *  session-outcomes verdict can close them ("treated by <session> -> PR #n") by joining the
 *  tmux name to the session it became (talk.bindings). */
export interface PresidentLaunchRecord {
  proposalId: string;
  origin: PresidentOrigin;
  caseIds: readonly string[];
  tmuxName: string | null;
  cwd: string;
  launchedAt: string; // ISO
}

/** Real gather: the same 3 exported building blocks loops.ts's own `rescan()` composes (its
 *  `board` variable is module-private, so this recomputes it from the same pieces rather than
 *  adding a cross-feature export to a file this package doesn't own). Injectable in tests so
 *  they never touch the real ~/Documents/Code or whatsup's todos.json. */
async function realGatherLoopItems(codeDir: string, whatsupPath: string): Promise<LoopsItem[]> {
  const [whatsup, scanned] = await Promise.all([
    readWhatsupBoard(whatsupPath).catch(() => ({ items: [], generatedAt: null, ok: false, error: "read failed" })),
    scanTodoFiles({ codeDir }).catch(() => []),
  ]);
  return mergeLoopsItems(whatsup.items, scanned, whatsup.generatedAt, codeDir).catch(() => []);
}

/** Real gather: reuses completeness.ts's own exported evaluator + gatherers rather than
 *  duplicating any check logic. Injectable in tests so they never shell out to ps/tmux/vitest. */
async function realGatherHealthChecks(ctx: FeatureContext, nowMs: number): Promise<CompletenessCheck[]> {
  async function tmuxAvailable(): Promise<boolean> {
    return (await REAL_GATHERERS.findTmux()) !== null;
  }
  return computeCheapChecks(ctx, { projectsDir: ctx.config.projectsDir, claudeDir: ctx.config.claudeDir, dbPath: ctx.config.dbPath }, nowMs, REAL_GATHERERS, tmuxAvailable);
}

export interface PresidentFeatureOptions {
  dataDir?: string;
  codeDir?: string;
  whatsupPath?: string;
  homeDir?: string;
  refreshMs?: number;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  launcher?: LoopsLauncher;
  /** Overrides where Health-derived session proposals launch (defaults to this repo's root). */
  repoCwd?: string;
  now?: () => number;
  /** The Town square Jev is shown (fenced) in its ranking state; defaults to the server-side
   *  workspace's broadcast (workspace-state.ts). Null: no fresh broadcast, nothing is added. */
  townSquare?: (nowMs: number) => readonly WorkspaceEntry[] | null;
  /** Where each proposal new to the board reports what Jev was shown; defaults to the workspace feature. */
  noteInfluence?: (n: InfluenceNote) => void;
  /** Defaults to `realGatherLoopItems`; tests inject a canned list instead of scanning disk. */
  gatherLoopItems?: (codeDir: string, whatsupPath: string) => Promise<LoopsItem[]>;
  /** Defaults to `realGatherHealthChecks`; tests inject a canned list instead of probing ps/tmux. */
  gatherHealthChecks?: (ctx: FeatureContext, nowMs: number) => Promise<CompletenessCheck[]>;
  /** Defaults to sickness.ts's `openSicknessCases()`; tests inject case fixtures. */
  sicknessCases?: () => readonly SicknessCase[];
  /** Defaults to `loadAlwaysLiveMap(homeDir)`; tests inject fixture configs. */
  loadAlwaysLive?: () => Promise<AlwaysLiveMap>;
  /** Defaults to careers.ts's settled worker list (null until careers computed one on settled inputs). */
  careerWorkers?: () => readonly CareerWorker[] | null;
  /** Defaults to skills.ts's first fires since a moment. */
  skillDebuts?: (ctx: FeatureContext, sinceMs: number) => Promise<SkillDebuts>;
  /** Defaults to tripwires.ts's in-memory hits. */
  tripwireHits?: () => readonly TripwireHit[];
  /** What those hits cover; defaults to this process's start. */
  serverStartedAtMs?: number;
  /** Defaults to talk's persisted bindings (the meta table): tmux name -> adopted session. */
  talkBindings?: (ctx: FeatureContext) => readonly TalkBinding[];
  /** Defaults to the outcomes feature's records: each session's verdict. */
  sessionOutcomes?: () => readonly Pick<OutcomeRecord, "sessionId" | "outcome">[];
  /** Defaults to careers.ts's retire path (the same one POST /api/careers/:key/retire runs). */
  retireWorker?: (ctx: FeatureContext, key: string) => Promise<{ status: number; body: CareersActionResult }>;
  /** Minutes since local midnight, for a schedule's median start time; tests pin a zone. */
  minutesOfDay?: (ms: number) => number;
  /** A routine's plist and the scripts it runs (null when unreadable); defaults to readRoutineText, read-only. */
  readRoutinePlist?: (label: string) => Promise<string | null>;
  /** Where governance decisions go; defaults to the live Feed (feed.ts appendToFeed). */
  feed?: (item: FeedDraft) => void;
  /** Jev's own kept web finds matched to session candidates (candidate id -> one line), fenced into
   *  its ranking state; defaults to realWebFinds. */
  webFinds?: (ctx: FeatureContext, candidates: readonly SessionCandidate[], nowMs: number) => Promise<ReadonlyMap<string, string>>;
}

/** At most this many candidates carry a web find in one request. */
const MAX_WEB_FINDS = 3;

/** Jev's kept web finds (data/jev-web.jsonl) for the session candidates, one line each: title, site
 *  and age, never the question. Only once the voice brain's credential scanner has vetted his files
 *  (no vetted taint: no finds, fail closed); a find that repeats a closed file's value, or that the
 *  credential rules flag (the log drops those on read), is never sent. At least 2 of a candidate's
 *  words must match. Nothing here makes a web call: it rides in the refresh's one TypeSafe request. */
export async function realWebFinds(ctx: FeatureContext, candidates: readonly SessionCandidate[], nowMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const creds = realVoiceDeps.recall?.credentials;
  if (!creds?.vetted() || candidates.length === 0) return out;
  const log = jevWebLogFor(ctx.config.dbPath);
  if (!log) return out;
  await log.refresh();
  const taint = creds.taint();
  for (const c of candidates) {
    if (out.size >= MAX_WEB_FINDS) break;
    const [f] = citableFinds(log.search(`${c.task} ${c.why}`, 3, 0.5), taint, 2, 1);
    if (f) out.set(c.id, `${f.title} (${f.host}, found ${findAge(f.at, nowMs)})`);
  }
  return out;
}

interface PresidentFile {
  board: PresidentBoard;
  dismissed: Record<string, number>;
  /** Absent in files written before vision wave 2. */
  launched?: PresidentLaunchRecord[];
  /** Absent in files written before commencement. */
  ledger?: PresidentLedgerEntry[];
  /** A routine whose unload session started from a retire card: routine label -> [tmux name, when (ms)]. */
  unloads?: Record<string, [string, number]>;
}
interface DistrictMergesFile {
  merges: DistrictMergeRecord[];
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function createPresidentFeature(opts: PresidentFeatureOptions = {}): ServerFeature {
  const codeDir = opts.codeDir ?? DEFAULT_CODE_DIR;
  const whatsupPath = opts.whatsupPath ?? DEFAULT_WHATSUP_TODOS_JSON;
  const homeDir = opts.homeDir ?? homedir();
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const launcher = opts.launcher ?? worldPlanLoopsLauncher;
  const now = opts.now ?? Date.now;
  const townSquareOf = opts.townSquare ?? ((nowMs: number) => workspaceFor("jev", nowMs));
  const webFindsOf = opts.webFinds ?? realWebFinds;
  const noteWorkspaceInfluence = opts.noteInfluence ?? noteInfluence;
  const gatherLoopItems = opts.gatherLoopItems ?? realGatherLoopItems;
  const gatherHealthChecks = opts.gatherHealthChecks ?? realGatherHealthChecks;
  const sicknessCases = opts.sicknessCases ?? openSicknessCases;
  const loadAlwaysLive = opts.loadAlwaysLive ?? (() => loadAlwaysLiveMap(homeDir));
  /** The always-live map, read now; any throw is an unreadable map (fail closed). */
  async function readLiveMap(): Promise<AlwaysLiveMap> {
    try {
      return await loadAlwaysLive();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  // server/features -> server -> repo root, same derivation as completeness.ts's REPO_ROOT.
  const codeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  let repoCwdResolved: Promise<string> | null = null;
  const repoCwdOf = (): Promise<string> => (opts.repoCwd !== undefined ? Promise.resolve(opts.repoCwd) : (repoCwdResolved ??= devRepoRoot(codeRoot)));
  const tripwires = compileTripwires(TRIPWIRE_DEFS);
  const careerWorkers = opts.careerWorkers ?? latestCareerWorkers;
  const skillDebuts = opts.skillDebuts ?? skillDebutsSince;
  const tripwireHits = opts.tripwireHits ?? recentTripwireHits;
  const serverStartedAtMs = opts.serverStartedAtMs ?? SERVER_STARTED_AT_MS;
  const talkBindings = opts.talkBindings ?? ((ctx: FeatureContext) => loadTalkBindings(ctx.db));
  const sessionOutcomes = opts.sessionOutcomes ?? latestOutcomeRecords;
  const retireWorker = opts.retireWorker ?? retireCareerWorker;
  const minutesOfDay = opts.minutesOfDay ?? localMinutesOfDay;
  const readRoutinePlist = opts.readRoutinePlist ?? ((label: string) => readRoutineText(homeDir, label));
  const feed = opts.feed ?? appendToFeed;
  /** Why a candidate's routine unload may not be offered (its plist vs the always-live map), or null. */
  async function routineReason(c: CommencementCandidate, map: AlwaysLiveMap): Promise<string | null> {
    return c.routine ? routineLiveReason(await readRoutinePlist(c.routine), map, homeDir) : null;
  }

  let board: PresidentBoard = EMPTY_BOARD;
  let dismissed = new Map<string, number>();
  let launched: PresidentLaunchRecord[] = [];
  let ledger: PresidentLedgerEntry[] = [];
  let unloads = new Map<string, [string, number]>();
  let merges: DistrictMergeRecord[] = [];
  let candidatesById = new Map<string, SessionCandidate>();
  let commencementById = new Map<string, CommencementCandidate>();
  /** Who put each proposal on the current board: Jev, or the rules fallback. */
  let rankedByOf = new Map<string, "jev" | "rules">();
  /** One launch per proposal: a second click while it starts, or within LAUNCH_REPEAT_WINDOW_MS after
   *  it started (the proposal has left the board by then), gets the same session back (launch-once.ts). */
  const launchOnce = createLaunchOnce(now);
  let lastRefreshAt = 0;
  let loaded = false;
  let inFlight: Promise<PresidentBoard> | null = null;
  /** False until the first refresh after boot has filled `candidatesById`. */
  let refreshedOnce = false;
  boardOf = () => (loaded ? board : null);
  /** True once president.json has been read (`loaded` flips before the read, to run it once). */
  let fileRead = false;
  ledgerOf = () => (fileRead ? ledger : null);
  /** Why the first refresh failed, while none has succeeded yet. */
  let firstRefreshError: string | null = null;

  function dataDirFor(ctx: FeatureContext): string {
    return opts.dataDir ?? dirname(ctx.config.dbPath);
  }
  function presidentFilePath(ctx: FeatureContext): string {
    return join(dataDirFor(ctx), "president.json");
  }
  function mergesFilePath(ctx: FeatureContext): string {
    return join(dataDirFor(ctx), "district-merges.json");
  }

  async function ensureLoaded(ctx: FeatureContext): Promise<void> {
    if (loaded) return;
    loaded = true;
    const file = await readJsonSafe<PresidentFile>(presidentFilePath(ctx), { board: EMPTY_BOARD, dismissed: {} });
    board = file.board;
    dismissed = new Map(Object.entries(file.dismissed));
    launched = Array.isArray(file.launched) ? file.launched : [];
    ledger = parseLedger(file.ledger);
    unloads = new Map(isRecord(file.unloads) ? Object.entries(file.unloads).filter((e): e is [string, [string, number]] => Array.isArray(e[1]) && typeof e[1][0] === "string" && typeof e[1][1] === "number") : []);
    const mergesFile = await readJsonSafe<DistrictMergesFile>(mergesFilePath(ctx), { merges: [] });
    merges = mergesFile.merges;
    fileRead = true;
  }

  /** president.json writes, one at a time (they share one .tmp path: the ledger tick and a click
   *  can land together). Each write takes the state as it is when its turn comes. */
  let presidentWrites: Promise<unknown> = Promise.resolve();
  function persistPresident(ctx: FeatureContext): Promise<void> {
    const run = presidentWrites.then(() => writeJsonAtomic(presidentFilePath(ctx), { board, dismissed: Object.fromEntries(dismissed), launched, ledger, unloads: Object.fromEntries(unloads) } satisfies PresidentFile));
    presidentWrites = run.catch(() => undefined);
    return run;
  }
  async function persistMerges(ctx: FeatureContext): Promise<void> {
    await writeJsonAtomic(mergesFilePath(ctx), { merges } satisfies DistrictMergesFile);
  }

  /** Set while the outcomes feature's records can't be read (warned once per streak). */
  let outcomesError: string | null = null;
  function recordNow(nowMs: number = now(), log?: FeatureContext["log"]): PresidentBoard["record"] {
    let verdicts = new Map<string, OutcomeRecord["outcome"]>();
    try {
      verdicts = new Map(sessionOutcomes().map((r) => [r.sessionId, r.outcome]));
      outcomesError = null;
    } catch (err) {
      // No verdicts this time: "shipped" counts only what is known, and the log says why.
      if (outcomesError === null) log?.warn("president", "outcomes unreadable: the record's shipped count only knows what it read before", String(err));
      outcomesError = String(err);
    }
    return presidentRecord(ledger, (id) => verdicts.get(id) ?? null, nowMs);
  }

  /** Every commencement candidate from real records (president-lib.ts builds the words). A source
   *  that isn't ready yields nothing, never a guess: careers before its first settled computation
   *  (the archive list loaded), skills while its history can't tell a first fire (skills.ts). */
  async function gatherCommencement(ctx: FeatureContext, nowMs: number, loops: readonly LoopCandidateInput[], levelOfRun: (id: string) => ReturnType<typeof autonomyLevel>["level"] | null): Promise<CommencementCandidate[]> {
    let workers: readonly CareerWorker[] = [];
    try {
      workers = careerWorkers() ?? [];
    } catch (err) {
      ctx.log.warn("president", "careers gather failed", String(err));
    }
    let skills: SkillDebuts | null = null;
    try {
      skills = await skillDebuts(ctx, nowMs - HIRE_WINDOW_DAYS * 86_400_000);
      if (!skills.ok) ctx.log.info("president", `no skill debuts this refresh: ${skills.reason ?? "?"}`);
    } catch (err) {
      ctx.log.warn("president", "skills gather failed", String(err));
    }
    let hits: readonly TripwireHit[] = [];
    try {
      hits = tripwireHits();
    } catch (err) {
      ctx.log.warn("president", "tripwires gather failed", String(err));
    }
    const describe = (slug: string): string => skills?.descriptions.get(slug) ?? "";
    return uniqueById([
      ...scheduleCandidates(workers, levelOfRun, homeDir, minutesOfDay),
      ...retireCandidates(workers, nowMs, homeDir),
      ...hireCandidates(workers, skills?.ok ? skills.debuts : [], describe, loops, nowMs, skills?.historyStartAt ?? null),
      ...hookCandidates(hits, hookWindowLabel(hits, serverStartedAtMs, TRIPWIRES_HIT_CAP), homeDir),
    ]);
  }

  /** Records a click in the ledger, refreshes the record the board carries, and returns the click's
   *  feed item (same time, same ranker as the ledger entry): the caller appends it only once the
   *  click's own write went through. */
  function noteClick(p: PresidentProposal, outcome: LedgerOutcome, tmuxName?: string): FeedDraft {
    const at = new Date(now()).toISOString();
    const rankedBy = rankedByOf.get(p.id) ?? board.source;
    ledger = noteActed(ledger, p, outcome, at, rankedBy, tmuxName);
    board = { ...board, record: recordNow() };
    return presidentClickItem(p, outcome, at, { rankedBy, tmuxName });
  }

  /** Joins launched ledger entries to the sessions talk adopted, and re-reads their verdicts.
   *  Persists and emits only when the ledger or the record changed. Never throws. */
  async function linkLedger(ctx: FeatureContext): Promise<void> {
    try {
      const linked = linkLedgerSessions(ledger, talkBindings(ctx));
      if (linked) ledger = linked;
      const record = recordNow(now(), ctx.log);
      if (!linked && JSON.stringify(record) === JSON.stringify(board.record)) return;
      board = { ...board, record };
      await persistPresident(ctx);
      ctx.emit({ kind: "board", board } satisfies PresidentMessage);
    } catch (err) {
      ctx.log.warn("president", "ledger link failed", String(err));
    }
  }

  /** The one recompute path: gathers real signals, asks Jev once (or falls back to rules),
   *  applies dismiss cooldown, and replaces `board`/`candidatesById`. Never throws — any
   *  gatherer failure just yields fewer candidates for that source. */
  async function refresh(ctx: FeatureContext): Promise<PresidentBoard> {
    const nowMs = now();
    dismissed = pruneDismissed(dismissed, nowMs);

    let loopItems: LoopsItem[] = [];
    try {
      loopItems = await gatherLoopItems(codeDir, whatsupPath);
    } catch (err) {
      ctx.log.warn("president", "loops gather failed", String(err));
    }

    let checks: CompletenessCheck[] = [];
    try {
      checks = await gatherHealthChecks(ctx, nowMs);
    } catch (err) {
      ctx.log.warn("president", "health gather failed", String(err));
    }

    let cases: readonly SicknessCase[] = [];
    try {
      cases = sicknessCases();
    } catch (err) {
      ctx.log.warn("president", "sickness gather failed", String(err));
    }

    const views = ctx.worldViews();
    const agentById = new Map(views.agents.map((a) => [a.id, a]));
    // openSicknessCases() serves cases as recorded; like GET /api/sickness, fill in a lineage the
    // index only learned after the case was recorded (automationKey of the session's first prompt).
    const placedCases = cases.map((c) => (c.lineage !== null ? c : { ...c, lineage: automationKey(agentById.get(c.sessionId)?.title ?? "") }));
    const repoCwd = await repoCwdOf();
    const loopInputs: LoopCandidateInput[] = loopItems.map((i) => ({ id: i.id, task: i.task, project: i.project, lens: i.lens, score: i.score, launchCwd: i.launchCwd, updatedAt: i.updatedAt }));
    const allCandidates = uniqueById([
      ...sessionCandidatesFromLoops(loopInputs, nowMs),
      ...sessionCandidatesFromHealth(
        checks.filter((c) => c.state === "warn" || c.state === "fail").map((c) => ({ id: c.id, label: c.label, detail: c.detail, state: c.state as "warn" | "fail" })),
        repoCwd,
        REPO_CITY,
      ),
      ...treatCandidatesFromCases(placedCases, (id) => agentById.get(id)?.cwd || null),
      ...researchCandidatesFromCases(placedCases, (c) => tripwireCovers(tripwires, c, homeDir, agentById.get(c.sessionId)?.cwd || homeDir), repoCwd, REPO_CITY),
    ]);

    // SAFETY: nothing that backs an always-live host reaches Jev or the board.
    const liveMap = await readLiveMap();
    const cwds = [...new Set(allCandidates.flatMap((c) => (c.launchCwd ? [c.launchCwd] : [])))];
    const realCwds = new Map<string, string>(await Promise.all(cwds.map(async (c) => [c, await realOrResolved(c)] as const)));
    const { kept: sessionCandidates, dropped } = dropUnsafeCandidates(allCandidates, liveMap, realCwds, homeDir);
    if (!liveMap.ok) ctx.log.warn("president", "always-live map unreadable, every session candidate dropped", liveMap.error);
    for (const d of dropped) ctx.log.info("president", `dropped ${d.id}: ${d.reason}`, d.task);

    // Commencement: graduation actions from the careers workers, the skills store, the tripwire hits and the open loops.
    const commencementAll = await gatherCommencement(ctx, nowMs, loopInputs, (id) => {
      const a = agentById.get(id);
      return a ? autonomyLevel(a).level : null;
    });
    const commencementCwds = [...new Set(commencementAll.flatMap((c) => (c.launchCwd && !realCwds.has(c.launchCwd) ? [c.launchCwd] : [])))];
    for (const c of commencementCwds) realCwds.set(c, await realOrResolved(c));
    const { kept: commencementSafe, dropped: commencementDropped } = dropUnsafeCommencement(commencementAll, liveMap, realCwds, homeDir);
    // A routine unload: the whole plist is checked against the always-live map too (a card whose
    // routine may back a live host is held back entirely: never proposed, listed in dropped).
    const commencementCandidates: CommencementCandidate[] = [];
    for (const c of commencementSafe) {
      const why = await routineReason(c, liveMap);
      if (why) commencementDropped.push(droppedEntry({ id: c.id, task: c.title }, `routine ${c.routine}: ${why}`));
      else commencementCandidates.push(c);
    }
    for (const d of commencementDropped) ctx.log.info("president", `dropped ${d.id}: ${d.reason}`, d.task);

    const dormantInputs: DormantDistrictInput[] = views.islands.map((i) => ({ id: i.id, agentCount: i.agentCount, lastActive: i.lastActive }));
    const alreadyMerged = new Set(merges.flatMap((m) => m.districts));
    const mergeCandidate = buildMergeProposal(dormantSmallDistricts(dormantInputs, nowMs), alreadyMerged);

    // The Town square's top 5 right now (vision wave 3): fenced context in Jev's state, the same
    // one call, and what each new proposal's influence record is matched against below.
    const townSquare = townSquareOf(nowMs);

    const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    let source: "jev" | "rules" = "rules";
    let rankedSessions = rankByPriority(sessionCandidates);
    let sessionsBy: "jev" | "rules" = "rules";
    let mergeApproved = mergeCandidate !== null;
    let mergeBy: "jev" | "rules" = "rules";
    let rankedCommencement = rankByPriority(commencementCandidates);
    let commencementBy: "jev" | "rules" = "rules";
    // What Jev answered, for the gov:jev feed item (null: that question wasn't answered by Jev).
    let sessionProbs: Record<string, number> | null = null;
    let commencementJev: { pNone: number | null; choseNone: boolean } | null = null;

    if (apiKey && (sessionCandidates.length > 0 || mergeCandidate || commencementCandidates.length > 0)) {
      try {
        // ONE call: the sessions, merge and commencement questions ride in the same batched request.
        let finds: ReadonlyMap<string, string> = new Map();
        try {
          finds = await webFindsOf(ctx, sessionCandidates, nowMs);
        } catch (err) {
          ctx.log.warn("president", "Jev's web finds could not be read", String(err));
        }
        const { body, idOfKey, commencementIdOfKey } = buildJevBody(sessionCandidates, mergeCandidate, commencementCandidates, broadcastLines(townSquare ?? [], nowMs), finds);
        const raw = await callJev(apiKey, body, opts.fetchImpl ?? (globalThis.fetch as FetchLike), opts.timeoutMs ?? TIMEOUT_MS);
        if (!isRecord(raw)) throw new Error("typesafe response not an object");
        const answers = raw.answers;
        if (!isRecord(answers)) throw new Error("typesafe response missing answers");
        const sessionsAnswer = answers.sessions;
        if (sessionCandidates.length > 0 && isChoiceAnswer(sessionsAnswer)) {
          sessionProbs = probabilitiesById(sessionsAnswer.probabilities, idOfKey);
          rankedSessions = rankByJevProbabilities(sessionCandidates, sessionProbs);
          source = "jev";
          sessionsBy = "jev";
        }
        if (mergeCandidate) {
          const mergeAnswer = answers.merge;
          if (isChoiceAnswer(mergeAnswer)) {
            mergeApproved = mergeAnswer.choice === "yes";
            source = "jev";
            mergeBy = "jev";
          }
        }
        const commencementAnswer = answers.commencement;
        if (commencementCandidates.length > 0 && isChoiceAnswer(commencementAnswer)) {
          rankedCommencement = rankCommencementByJev(commencementCandidates, commencementAnswer, commencementIdOfKey);
          const none = commencementAnswer.probabilities.none;
          commencementJev = { pNone: typeof none === "number" ? none : null, choseNone: commencementAnswer.choice === "none" };
          source = "jev";
          commencementBy = "jev";
        }
      } catch (err) {
        ctx.log.warn("president", "jev call failed, using rules fallback", String(err));
      }
    }

    const selectedSessions = selectSessionProposals(rankedSessions, dismissed, nowMs);
    candidatesById = new Map(selectedSessions.map((c) => [c.id, c]));
    const selectedCommencement = selectSessionProposals(rankedCommencement, dismissed, nowMs, MAX_COMMENCEMENT_PROPOSALS);
    commencementById = new Map(selectedCommencement.map((c) => [c.id, c]));
    for (const [id, [, at]] of unloads) if (nowMs - at >= DISMISS_COOLDOWN_MS) unloads.delete(id);
    refreshedOnce = true;
    const selectedMerges = mergeApproved && mergeCandidate ? selectMergeProposals([mergeCandidate], dismissed, nowMs, MAX_MERGE_PROPOSALS) : [];

    const shown: { proposal: PresidentProposal; rankedBy: "jev" | "rules" }[] = [
      ...selectedSessions.map((c) => ({ proposal: toSessionProposal(c), rankedBy: sessionsBy })),
      ...selectedMerges.map((m) => ({ proposal: m, rankedBy: mergeBy })),
      ...selectedCommencement.map((c) => {
        const unload = c.routine ? unloads.get(c.routine) : undefined;
        return { proposal: unload ? { ...toCommencementProposal(c), unloadStartedAs: unload[0] } : toCommencementProposal(c), rankedBy: commencementBy };
      }),
    ];
    // Each proposal new to the board reports the square it was ranked against (workspace.ts records it).
    const onBoard = new Set(board.proposals.map((p) => p.id));
    for (const x of shown) if (!onBoard.has(x.proposal.id)) noteWorkspaceInfluence({ source: "jev", at: nowMs, proposal: x.proposal, rankedBy: x.rankedBy, shown: townSquare });

    const nowIso = new Date(nowMs).toISOString();
    ledger = noteShown(ledger, shown, new Set(board.proposals.map((p) => p.id)), nowIso);
    rankedByOf = new Map(shown.map((x) => [x.proposal.id, x.rankedBy]));
    const shownBefore = boardSignature(board);
    board = {
      generatedAt: nowIso,
      proposals: shown.map((x) => x.proposal),
      source,
      dropped: [...dropped, ...commencementDropped],
      record: recordNow(nowMs, ctx.log),
    };
    lastRefreshAt = nowMs;
    await persistPresident(ctx);
    ctx.emit({ kind: "board", board } satisfies PresidentMessage);
    // One gov:jev item per refresh in which Jev answered AND the board it shows changed (who ranked
    // it, or which proposals in which order): the same answer every 30 min is no new decision.
    if (source === "jev" && boardSignature(board) !== shownBefore) {
      const ranking: JevRanking = {
        at: nowIso,
        sessions: sessionProbs && { candidates: sessionCandidates.length, proposed: selectedSessions.map((c) => ({ text: c.task, p: sessionProbs?.[c.id] ?? null })), pNone: sessionProbs.none ?? null },
        commencement: commencementJev && { candidates: commencementCandidates.length, proposed: selectedCommencement.length, ...commencementJev },
        merge: mergeBy === "jev" ? { proposed: selectedMerges.length > 0 } : null,
      };
      const item = jevRankingItem(ranking);
      if (item) feed(item);
    }
    return board;
  }

  async function ensureFresh(ctx: FeatureContext): Promise<PresidentBoard> {
    await ensureLoaded(ctx);
    if (inFlight) return inFlight;
    if (now() - lastRefreshAt < refreshMs && lastRefreshAt > 0) return board;
    inFlight = refresh(ctx)
      .catch((err: unknown) => {
        // Back off a whole refresh period, as when this ran every 30 min: the ledger tick runs every
        // minute and must never turn a failing refresh (maybe after its Jev call) into a call a minute.
        lastRefreshAt = now();
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Before the first refresh, answers 503 (and makes sure a refresh is on its way). */
  function notReady(res: Parameters<typeof respondJson>[0], ctx: FeatureContext): boolean {
    if (refreshedOnce) return false;
    if (!inFlight) lastRefreshAt = 0; // a click retries a failed first refresh now; only the tick backs off
    ensureFresh(ctx).catch((err: unknown) => {
      firstRefreshError = String(err);
      ctx.log.warn("president", "first refresh failed", String(err));
    });
    const error = firstRefreshError ? `Alef couldn't read your proposals after a restart (${firstRefreshError}). Try again in a few seconds.` : PRESIDENT_NOT_READY_ERROR;
    respondJson(res, 503, { ok: false, error } satisfies PresidentActionResult);
    return true;
  }

  function removeProposal(id: string): void {
    board = { ...board, proposals: board.proposals.filter((p) => p.id !== id) };
  }

  /** The proposal as shown for `id`: on the board, else cut from its stored candidate. */
  function proposalOf(id: string): PresidentProposal | null {
    const onBoard = board.proposals.find((p) => p.id === id);
    if (onBoard) return onBoard;
    const s = candidatesById.get(id);
    if (s) return toSessionProposal(s);
    const c = commencementById.get(id);
    return c ? toCommencementProposal(c) : null;
  }

  /** A launch/retire body may be empty or carry `confirm`; never a cwd, task or prompt (the server
   *  re-derives those from the stored candidate). Null when acceptable, else the 400 to answer. */
  async function refuseClientFields(req: IncomingMessage): Promise<{ body: unknown; error: string | null }> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return { body: null, error: "invalid JSON body" };
    }
    if (isRecord(body) && CLIENT_SUPPLIED_FIELDS.some((k) => Object.hasOwn(body, k))) {
      return { body, error: "Alef writes the task and picks the folder itself: this request must not carry cwd, task, prompt or command" };
    }
    return { body, error: null };
  }

  /** A commencement launch: schedule / hire / hook, or a retire's routine-unload session. Re-derives
   *  cwd and task from the stored candidate, re-validates them (validateLaunch), re-reads the
   *  always-live map, and starts the plan-mode launcher. */
  async function launchCommencement(ctx: FeatureContext, c: CommencementCandidate): Promise<{ ok: boolean; status: number; body: PresidentActionResult }> {
    if (c.launchCwd === null || c.task === "") return { ok: false, status: 400, body: { ok: false, error: "this proposal starts no session: use its Retire button" } };
    const started = c.routine ? unloads.get(c.routine) : undefined;
    if (started) return { ok: false, status: 409, body: { ok: false, error: `an unload session for ${c.routine} already started as ${started[0]}`, tmuxName: started[0] } };
    if (c.cwdKind === "commencement") {
      // Its own folder, made on this click (the only write before the launch besides president.json).
      try {
        await mkdir(commencementDir(homeDir), { mode: 0o700 });
      } catch (err) {
        if (!(isRecord(err) && err.code === "EEXIST")) return { ok: false, status: 500, body: { ok: false, error: `couldn't create ~/${COMMENCEMENT_DIR_NAME} (${String(err)})` } };
      }
    }
    const validated = await validateLaunch(homeDir, c.launchCwd, c.task);
    if (!validated.ok) return { ok: false, status: validated.status, body: { ok: false, error: validated.error } };
    // validateLaunch answers the realpath: a link at ~/.alef-commencement never passes for it.
    if (c.cwdKind === "commencement" && validated.cwd !== join(await realOrResolved(homeDir), COMMENCEMENT_DIR_NAME)) {
      return { ok: false, status: 403, body: { ok: false, error: `refusing: this action runs only in ~/${COMMENCEMENT_DIR_NAME}, a plain folder (it resolves elsewhere)` } };
    }
    const liveMap = await readLiveMap();
    const routineWhy = await routineReason(c, liveMap);
    const unsafe = commencementSafetyReason(c, liveMap, [...new Set([c.launchCwd, validated.cwd, await realOrResolved(validated.cwd)])], homeDir) ?? (routineWhy ? `routine ${c.routine}: ${routineWhy}` : null);
    if (unsafe) {
      ctx.log.warn("president", `refused launch ${c.id}: ${unsafe}`);
      removeProposal(c.id);
      commencementById.delete(c.id);
      board = { ...board, dropped: [...(board.dropped ?? []), droppedEntry({ id: c.id, task: c.title }, unsafe)] };
      await persistPresident(ctx);
      ctx.emit({ kind: "board", board } satisfies PresidentMessage);
      return { ok: false, status: 403, body: { ok: false, error: `Held back for safety: ${unsafe}` } };
    }
    const trust = await folderTrust(ctx.config.claudeJsonPath, validated.cwd);
    const result = await launcher(validated.cwd, validated.prompt, ctx);
    ctx.log.info("president", `launch ${c.action} ${c.id} -> ${result.tmuxName ?? result.error ?? "?"} (folder trust: ${trust})`);
    if (!result.ok) return { ok: false, status: 500, body: result };
    const tmux = result.tmuxName ?? "?";
    const news = noteClick(proposalOf(c.id) ?? toCommencementProposal(c), "launched", tmux);
    if (c.action === "retire" && c.routine && !c.retired) {
      // The unload session runs; the card stays so Retire can still be clicked, and says so.
      unloads.set(c.routine, [tmux, now()]);
      board = { ...board, proposals: board.proposals.map((p) => (p.id === c.id && p.kind === "commencement" ? { ...p, unloadStartedAs: tmux } : p)) };
    } else {
      if (c.routine) unloads.set(c.routine, [tmux, now()]); // an unload-only card: done once its session runs
      dismissed.set(c.id, now()); // launched: don't propose the same thing again on the next tick
      removeProposal(c.id);
      commencementById.delete(c.id);
    }
    await persistPresident(ctx);
    ctx.emit({ kind: "board", board } satisfies PresidentMessage);
    feed(news);
    return { ok: true, status: 200, body: { ...result, trust, cwd: validated.cwd } };
  }

  return {
    id: "president",
    tickIntervalMs: Math.min(refreshMs, LEDGER_TICK_MS),
    async onTick(ctx) {
      try {
        await ensureFresh(ctx); // throttled: a Jev call at most once per refreshMs
      } catch (err) {
        ctx.log.warn("president", "refresh failed", String(err));
      }
      await linkLedger(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/president/proposals",
        async handler(_req, res, ctx) {
          respondJson(res, 200, await ensureFresh(ctx) satisfies PresidentBoard);
        },
      },
      {
        method: "GET",
        path: "/api/president/refresh",
        async handler(_req, res, ctx) {
          await ensureLoaded(ctx);
          lastRefreshAt = 0; // forces the next ensureFresh past the throttle
          respondJson(res, 200, await ensureFresh(ctx) satisfies PresidentBoard);
        },
      },
      {
        method: "POST",
        path: "/api/president/proposals/:id/dismiss",
        async handler(_req, res, ctx, params) {
          await ensureLoaded(ctx);
          if (notReady(res, ctx)) return;
          const id = params.id ?? "";
          const proposal = proposalOf(id);
          if (!proposal) {
            // A second Dismiss (another tab, a retry) of the same proposal is not an error.
            if (dismissed.has(id)) return respondJson(res, 200, { ok: true } satisfies PresidentActionResult);
            return respondJson(res, 404, { ok: false, error: "unknown or expired proposal" } satisfies PresidentActionResult);
          }
          dismissed.set(id, now());
          const news = noteClick(proposal, "dismissed");
          removeProposal(id);
          candidatesById.delete(id);
          commencementById.delete(id);
          await persistPresident(ctx);
          ctx.log.info("president", `dismissed ${id}`);
          ctx.emit({ kind: "board", board } satisfies PresidentMessage);
          feed(news);
          respondJson(res, 200, { ok: true } satisfies PresidentActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/president/proposals/:id/launch",
        async handler(req, res, ctx, params) {
          const { error: bad } = await refuseClientFields(req);
          if (bad) return respondJson(res, 400, { ok: false, error: bad } satisfies PresidentActionResult);
          await ensureLoaded(ctx);
          if (notReady(res, ctx)) return;
          const id = params.id ?? "";
          // The proposal only leaves the board once the launcher resolves (~2s); a second click
          // before then, or just after, would start a second session. Keyed before the lookup, so a
          // repeat after the launch removed the proposal still gets its session, not a 404.
          const r = await launchOnce.run(`president:${id}`, async (): Promise<{ ok: boolean; status: number; body: PresidentActionResult }> => {
            const commencement = commencementById.get(id);
            if (commencement) return launchCommencement(ctx, commencement);
            const candidate = candidatesById.get(id);
            if (!candidate) return { ok: false, status: 404, body: { ok: false, error: "unknown or expired proposal" } };
            const validated = await validateLaunch(homeDir, candidate.launchCwd, candidate.task);
            if (!validated.ok) return { ok: false, status: validated.status, body: { ok: false, error: validated.error } };
            // SAFETY re-check right before starting anything: the always-live map is read again,
            // against the validated cwd and its realpath (the map may have changed since refresh).
            const unsafe = safetyReason(candidate, await readLiveMap(), [...new Set([candidate.launchCwd ?? validated.cwd, validated.cwd, await realOrResolved(validated.cwd)])], homeDir);
            if (unsafe) {
              ctx.log.warn("president", `refused launch ${candidate.id}: ${unsafe}`);
              removeProposal(candidate.id);
              candidatesById.delete(candidate.id);
              board = { ...board, dropped: [...(board.dropped ?? []), droppedEntry(candidate, unsafe)] };
              await persistPresident(ctx);
              ctx.emit({ kind: "board", board } satisfies PresidentMessage);
              return { ok: false, status: 403, body: { ok: false, error: `Held back for safety: ${unsafe}` } };
            }
            // Read before the launch: the new claude rewrites ~/.claude.json as it starts.
            const trust = await folderTrust(ctx.config.claudeJsonPath, validated.cwd);
            const result = await launcher(validated.cwd, validated.prompt, ctx);
            const cases = candidate.caseIds?.length ? ` (cases ${candidate.caseIds.join(", ")})` : "";
            ctx.log.info("president", `launch ${candidate.id} -> ${result.tmuxName ?? result.error ?? "?"} (folder trust: ${trust})${cases}`);
            if (!result.ok) return { ok: false, status: 500, body: result };
            const news = noteClick(proposalOf(candidate.id) ?? toSessionProposal(candidate), "launched", result.tmuxName);
            // Launched: don't propose the same thing again on the next tick.
            dismissed.set(candidate.id, now());
            removeProposal(candidate.id);
            candidatesById.delete(candidate.id);
            launched = [
              ...launched,
              { proposalId: candidate.id, origin: candidate.origin, caseIds: candidate.caseIds ?? [], tmuxName: result.tmuxName ?? null, cwd: validated.cwd, launchedAt: new Date(now()).toISOString() },
            ].slice(-LAUNCH_LOG_CAP);
            await persistPresident(ctx);
            ctx.emit({ kind: "board", board } satisfies PresidentMessage);
            feed(news);
            return { ok: true, status: 200, body: { ...result, trust, cwd: validated.cwd } };
          });
          respondJson(res, r.status, (r.reused ? { ...r.body, reused: true } : r.body) satisfies PresidentActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/president/proposals/:id/retire",
        async handler(req, res, ctx, params) {
          const { body, error: bad } = await refuseClientFields(req);
          if (bad) return respondJson(res, 400, { ok: false, error: bad } satisfies PresidentActionResult);
          if (!isRecord(body) || body.confirm !== true) return respondJson(res, 400, { ok: false, error: "confirm: true is required to retire a worker" } satisfies PresidentActionResult);
          await ensureLoaded(ctx);
          if (notReady(res, ctx)) return;
          const id = params.id ?? "";
          const r = await launchOnce.run(`president-retire:${id}`, async (): Promise<{ ok: boolean; status: number; body: PresidentActionResult }> => {
            const c = commencementById.get(id);
            if (!c || c.action !== "retire" || !c.retireKey) return { ok: false, status: 404, body: { ok: false, error: "unknown or expired retire proposal" } };
            // The careers feature's own retire path: it validates the key against its current
            // workers and writes data/careers.json, nothing else.
            const out = await retireWorker(ctx, c.retireKey);
            if (out.status === 200 || out.status === 404 || out.status === 409) {
              // Retired now, or already retired / gone: the card is done either way. Only a
              // retire this click made counts as acted on.
              const news = out.status === 200 ? noteClick(proposalOf(id) ?? toCommencementProposal(c), "retired") : null;
              dismissed.set(id, now());
              removeProposal(id);
              commencementById.delete(id);
              await persistPresident(ctx);
              ctx.emit({ kind: "board", board } satisfies PresidentMessage);
              if (news) feed(news);
            }
            ctx.log.info("president", `retire ${c.retireKey} (${id}) -> ${out.status}${out.body.error ? ` ${out.body.error}` : ""}`);
            if (out.body.ok) return { ok: true, status: 200, body: { ok: true } };
            const error = out.status === 409 ? `${c.retireKey} is already retired in the Tower` : out.status === 404 ? `the Tower no longer lists ${c.retireKey}` : (out.body.error ?? "couldn't retire it");
            return { ok: false, status: out.status, body: { ok: false, error } };
          });
          respondJson(res, r.status, (r.reused ? { ...r.body, reused: true } : r.body) satisfies PresidentActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/president/proposals/:id/merge",
        async handler(_req, res, ctx, params) {
          await ensureLoaded(ctx);
          if (notReady(res, ctx)) return;
          const id = params.id ?? "";
          const proposal = board.proposals.find((p) => p.id === id && p.kind === "merge") as PresidentMergeProposal | undefined;
          if (!proposal) return respondJson(res, 404, { ok: false, error: "unknown or expired merge proposal" } satisfies PresidentActionResult);
          const alreadyTaken = new Set(merges.flatMap((m) => m.districts));
          if (proposal.districts.some((d) => alreadyTaken.has(d))) {
            return respondJson(res, 409, { ok: false, error: "one of these districts is already merged elsewhere" } satisfies PresidentActionResult);
          }
          const record: DistrictMergeRecord = { id: proposal.id, districts: proposal.districts, into: proposal.into, sessions: proposal.sessions, why: proposal.why, approvedAt: new Date(now()).toISOString() };
          merges = [...merges, record];
          dismissed.set(id, now()); // approved, not just dismissed — but the same "don't re-propose" mechanism applies
          const news = noteClick(proposal, "merged");
          removeProposal(id);
          await Promise.all([persistMerges(ctx), persistPresident(ctx)]);
          ctx.emit({ kind: "merges", merges } satisfies PresidentMessage);
          ctx.emit({ kind: "board", board } satisfies PresidentMessage);
          feed(news);
          respondJson(res, 200, { ok: true, merge: record } satisfies PresidentActionResult);
        },
      },
      {
        method: "GET",
        path: "/api/district-merges",
        async handler(_req, res, ctx) {
          await ensureLoaded(ctx);
          respondJson(res, 200, { ok: true, merges } satisfies DistrictMergesResponse);
        },
      },
      {
        method: "POST",
        path: "/api/district-merges/:id/undo",
        async handler(_req, res, ctx, params) {
          await ensureLoaded(ctx);
          const id = params.id ?? "";
          const before = merges.length;
          merges = merges.filter((m) => m.id !== id);
          if (merges.length === before) return respondJson(res, 404, { ok: false, error: "unknown merge id" } satisfies PresidentActionResult);
          await persistMerges(ctx);
          ctx.emit({ kind: "merges", merges } satisfies PresidentMessage);
          respondJson(res, 200, { ok: true } satisfies PresidentActionResult);
        },
      },
    ],
    snapshotExtras(ctx) {
      if (!loaded) {
        // Fills in on the next snapshot; never block this one. A rejected refresh must not become an
        // unhandled rejection (it would end the server process).
        ensureFresh(ctx).catch((err: unknown) => ctx.log.warn("president", "refresh failed", String(err)));
        return {};
      }
      return { "president.board": board, "president.merges": merges };
    },
  };
}

export const presidentFeature = createPresidentFeature();
