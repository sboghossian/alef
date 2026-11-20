// Wire types for the "loops" feature (Round 8 H2): an open-loops board in the right
// sidebar's Loops tab, merging whatsup's ranked ~/Documents/Code/alex_claude
// todos.json with Alef's own live scan of every tasks/todo.md under ~/Documents/Code.
//
//   POST /api/loops/:id/open    -> LoopsActionResult (opens the source file in the editor)
//   POST /api/loops/:id/launch  -> LoopsActionResult (new claude --permission-mode plan session)
//   POST /api/loops/:id/done    -> LoopsActionResult (ticks that one line of its tasks/todo.md)
//   WS "loops" feature message  -> LoopsMessage (board changed since the last emit)
//   WorldSnapshot.extras["loops.board"] -> LoopsBoard (initial / mid-session snapshot)
//
// `task`/`project` text originates in todo.md files and whatsup's aggregation of vault +
// memory notes: untrusted data. Render it escaped, never execute it.
//
// Until the first scan after a restart has finished, open/launch answer 503 with
// LOOPS_NOT_READY_ERROR instead of a misleading 404 "unknown item".

import type { LaunchDetails } from "../types.js";
import type { FolderTrust } from "./trust.js";

export const LOOPS_NOT_READY_ERROR = "Alef is still reading your loops after a restart. Try again in a few seconds.";

/** whatsup's 4 ranked lenses, plus "unranked" for items Alef's own scan found that whatsup
 *  never ranked (no matching whatsup item). */
export type LoopsLens = "do_today" | "high_leverage" | "one_step" | "waiting" | "unranked";

/** Which side(s) of the merge produced an item. A merged (deduped) item carries both. */
export type LoopsSourceKind = "whatsup" | "scan";

export const LOOPS_LENS_ORDER: readonly LoopsLens[] = ["do_today", "high_leverage", "one_step", "waiting", "unranked"];

export const LOOPS_LENS_META: Readonly<Record<LoopsLens, { emoji: string; title: string }>> = {
  do_today: { emoji: "🔴", title: "Do today" },
  high_leverage: { emoji: "⚡", title: "High leverage" },
  one_step: { emoji: "✅", title: "One step from done" },
  waiting: { emoji: "⏳", title: "Waiting on others" },
  unranked: { emoji: "•", title: "Unranked" },
};

/** First-prompt length bound for a launched session (mirrors /api/dispatch's 1..4000). */
export const LOOPS_MAX_PROMPT_CHARS = 4000;
/** Both the live todo.md scan and the whatsup-file read are throttled to this, off the request path. */
export const LOOPS_RESCAN_MS = 60_000;
/** A todo.md not touched within this many days is a dormant project's backlog, not "what's up today". */
export const LOOPS_ACTIVE_DAYS = 45;
/** Keeps one big project's backlog from drowning the board (mirrors whatsup's PROJECT_CAP). */
export const LOOPS_PROJECT_CAP = 12;

export interface LoopsItem {
  /** Stable within one server process's lifetime; a whatsup item keeps whatsup's own id. */
  id: string;
  task: string;
  project: string;
  lens: LoopsLens;
  /** whatsup's 0-100 rank, or 0 for a scan-only ("unranked") item. */
  score: number;
  /** Which source(s) produced this item, for the UI's "via whatsup" / "via scan" badge. */
  sources: readonly LoopsSourceKind[];
  /** whatsup's source_type ("todo_md" | "vault" | "memory" | "memory_index" | "live"), or "todo_md" for a scan-only item. */
  sourceType: string;
  /** Best-effort recency: the source todo.md's mtime when known, else whatsup's own "generated" stamp. */
  updatedAt: string | null;
  /** Absolute path openable in the editor, or null when there is none (e.g. a live Linear/Gmail/Calendar item). */
  openPath: string | null;
  /** Absolute project directory a launch would run in, or null when none could be resolved safely. */
  launchCwd: string | null;
}

export interface LoopsBoard {
  generatedAt: string; // ISO, when this board was last (re)computed
  items: readonly LoopsItem[];
  /** Count of lens === "do_today", across the merged set. */
  badge: number;
  whatsupOk: boolean;
  whatsupError: string | null;
}

/** WS payload: the board changed since the last emit. */
export interface LoopsMessage {
  kind: "board";
  board: LoopsBoard;
}

export interface LoopsActionResult extends LaunchDetails {
  ok: boolean;
  error?: string;
  /** launch only: the tmux session name ("aw-<hex>") a confirmed launch started. */
  tmuxName?: string;
  /** launch only: whether Claude will stop on its folder-trust dialog in `cwd` (read before starting). */
  trust?: FolderTrust;
  /** launch only: the directory the session was started in. */
  cwd?: string;
  /** done only: the 1-based line of tasks/todo.md that was ticked. */
  line?: number;
}
