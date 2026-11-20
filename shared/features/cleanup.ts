// Wire types for the "cleanup" feature (P2, "Retire & tidy up"). Retiring a session MOVES its
// files (<uuid>.jsonl + the <uuid>/ folder beside it) from ~/.claude/projects into
// ~/.alef-trash/<date>/<batchId>/ with a manifest. Nothing is ever deleted, restore is one click,
// and every action comes from an explicit user click (never a timer, Jev or an agent).

export type SessionBucketId = "empty" | "headless" | "tiny" | "dormant";
export type BucketId = SessionBucketId | "worktree" | "tmux";

export const RETIRE_MAX_IDS = 200;
export const TINY_CHIPS = [3, 5, 10] as const;
export const DORMANT_CHIPS = [14, 30, 90] as const;
export const DEFAULT_TINY = 5;
export const DEFAULT_DORMANT_DAYS = 90;
/** A session written to in the last 30 min is never retired, whatever else says. */
export const RECENT_ACTIVITY_MS = 30 * 60_000;
/** tmux names Alef creates (talk/dispatch). The only sessions the tmux bucket ever closes. */
export const ALEF_TMUX_RE = /^aw-[a-z0-9]{4,16}$/;

/** One session file set that could leave ~/.claude/projects. */
export interface CleanupSessionItem {
  id: string;
  title: string;
  cwd: string;
  islandId: string;
  /** The project folder name under ~/.claude/projects. */
  projDir: string;
  lastActive: string; // ISO ("" when unknown)
  messageCount: number;
  /** jsonl bytes + the recursive size of the <uuid>/ folder. */
  bytes: number;
  reason: string;
  /** Set when a live-guard hits: shown greyed with this reason, never selectable. */
  protected?: string;
}

export interface CleanupTmuxItem {
  name: string;
  command: string;
  dead: boolean;
  reason: string;
  protected?: string;
}

export interface CleanupWorktreeItem {
  path: string;
  repo: string | null;
  name: string;
  /** The fork record id when Alef made it (removal goes through POST /api/fork/remove). */
  forkId: string | null;
  reason: string;
  protected?: string;
}

export interface CandidateBuckets {
  empty: CleanupSessionItem[];
  headless: CleanupSessionItem[];
  tiny: CleanupSessionItem[];
  dormant: CleanupSessionItem[];
  worktree: CleanupWorktreeItem[];
  tmux: CleanupTmuxItem[];
  /** Over the four session buckets (each session sits in one bucket only). `bytes` and
   *  `count` cover selectable items; protected ones are counted apart. */
  totals: { bytes: number; count: number; protectedCount: number };
}

export interface CandidatesResponse {
  ok: true;
  generatedAt: string;
  params: { tiny: number; dormantDays: number };
  buckets: CandidateBuckets;
}

export interface RetireItemResult {
  id: string;
  ok: boolean;
  error?: string;
  bytes: number;
  /** alumni.ts's legacy card: "legacy card: written" / "unknown (<reason>)" / "not written (<reason>)";
   *  for a card whose move then failed, "legacy card: voided (not moved)" / "void queued (not moved;
   *  <reason>)" / "void failed (<reason>)" (cleanup-trash.ts's retireSessions). Absent when its
   *  live-guard never passed (no attempt was made) or no legacy writer is wired at all. */
  legacy?: string;
}

export type RetireResult = { ok: true; batchId: string; results: RetireItemResult[] } | { ok: false; error: string };

/** One retired session as recorded in <batch>/manifest.json. `from[i]` moved to `to[i]`. */
export interface ManifestItem {
  sessionId: string;
  title: string;
  cwd: string;
  messageCount: number;
  lastActive: string;
  from: string[];
  to: string[];
  bytes: number;
  /** "planned" is written before any move, so a crash mid-way still leaves a readable record. */
  state: "planned" | "retired" | "failed" | "restored";
  error?: string;
}

export interface TrashManifest {
  batchId: string;
  date: string; // YYYY-MM-DD, the trash sub-folder
  at: string; // ISO
  items: ManifestItem[];
}

export interface TrashListResponse {
  ok: true;
  root: string;
  batches: TrashManifest[];
}

export interface RestoreItemResult {
  id: string;
  ok: boolean;
  error?: string;
}

export type RestoreResult = { ok: true; batchId: string; results: RestoreItemResult[] } | { ok: false; error: string };

export type TmuxCloseResult = { ok: true; name: string; savedTo: string } | { ok: false; error: string };

/** Payload of `{type:"feature", feature:"cleanup"}` messages. */
export interface CleanupMessage {
  kind: "retired" | "restored" | "tmux-closed";
  ids: string[];
}
