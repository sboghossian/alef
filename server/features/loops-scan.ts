// Live scan (b): every tasks/todo.md directly under ~/Documents/Code/*/, unchecked
// `- [ ]` items only. Mirrors whatsup's own noise rules (see ~/Documents/Code/whatsup/lib/
// sources.py): 45-day recency by file mtime, and a "Deferred"/someday/backlog/... heading
// skips its whole section, same as a Done/Completed/Archived one.
//
// Deliberately shallow: only `<codeDir>/<project>/tasks/todo.md` is checked (one stat per
// top-level directory), never a recursive walk — so node_modules/.git/deep trees are never
// descended into. A linked git worktree (a `.git` *file*, not a directory, per `git worktree
// add`) is skipped outright: it duplicates its primary clone's todo.md under a different path.
//
// Per-file stat/read is wrapped in a timeout: an iCloud-evicted ("dataless") file's stat/read
// can hang indefinitely (see project memory: dataless files hang build chains), and this scan
// runs unattended, off the request path — a single stuck file must never wedge it.

import type { Stats } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOOPS_ACTIVE_DAYS, LOOPS_PROJECT_CAP } from "../../shared/features/loops.js";

export const DEFAULT_CODE_DIR = join(homedir(), "Documents", "Code");

const STAT_TIMEOUT_MS = 3000;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

export interface ScanItem {
  task: string;
  project: string;
  section: string;
  sourceFile: string; // absolute path to the todo.md
  mtimeMs: number;
}

export interface ScanOptions {
  codeDir: string;
  activeDays: number;
  projectCap: number;
  now: () => number;
  statTimeoutMs: number;
}

// --- markdown parsing (mirrors whatsup/lib/sources.py's checkbox/heading regexes) ----------

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*```/;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const CODE_TICK_RE = /`([^`]+)`/g;
const BOLD_ITALIC_RE = /[*_]{1,2}/g;

const DONE_HEADING_RE = /\b(done|completed?|shipped|archive[d]?|changelog|history|resolved)\b/i;
// whatsup's DEFERRED_HEADINGS plus the literal "deferred" the task spec calls out by name.
const DEFERRED_HEADING_RE =
  /\b(deferred|someday|backlog|icebox|future|later|maybe|nice to have|parking lot|wishlist|stretch|v[2-9]|phase [3-9]|ideas?)\b/i;

function cleanText(raw: string): string {
  const noLinks = raw.replace(MD_LINK_RE, "$1");
  const noTicks = noLinks.replace(CODE_TICK_RE, "$1");
  const noEmphasis = noTicks.replace(BOLD_ITALIC_RE, "");
  return noEmphasis.trim().replace(/\.+$/, "");
}

/** Every unchecked, non-deferred, non-done item of one todo.md, with its 0-based line number
 *  (the one walk both the scan and "Mark done" use, so they always agree on what an item is). */
export function uncheckedTodoLines(text: string): { line: number; task: string; section: string }[] {
  const out: { line: number; task: string; section: string }[] = [];
  let section = "";
  let inFence = false;
  let skipSection = false;
  text.split(/\r?\n/).forEach((rawLine, line) => {
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = HEADING_RE.exec(rawLine);
    if (heading) {
      section = heading[2] ?? "";
      skipSection = DONE_HEADING_RE.test(section) || DEFERRED_HEADING_RE.test(section);
      return;
    }
    if (skipSection) return;
    const box = CHECKBOX_RE.exec(rawLine);
    if (!box || box[1] !== " ") return;
    const cleaned = cleanText(box[2] ?? "");
    if (cleaned.length >= 4) out.push({ line, task: cleaned, section });
  });
  return out;
}

/** Parses one todo.md's text into its unchecked, non-deferred, non-done items. */
export function parseTodoMd(text: string, project: string, sourceFile: string, mtimeMs: number): ScanItem[] {
  return uncheckedTodoLines(text).map(({ task, section }) => ({ task, project, section, sourceFile, mtimeMs }));
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(fallback);
      },
    );
  });
}

/** True when `dir/.git` is a *file* (a linked git worktree or a submodule checkout points its
 *  .git at the real one this way), never a directory (a normal clone). */
async function isLinkedWorktree(dir: string, timeoutMs: number): Promise<boolean> {
  const st = await withTimeout<Stats | null>(lstat(join(dir, ".git")), timeoutMs, null);
  return st !== null && st.isFile();
}

/** Every `<codeDir>/<project>/tasks/todo.md` touched within `activeDays`, unchecked items only,
 *  capped at `projectCap` per project. Read-only; never throws (a missing codeDir -> []). */
export async function scanTodoFiles(opts: Partial<ScanOptions> = {}): Promise<ScanItem[]> {
  const codeDir = opts.codeDir ?? DEFAULT_CODE_DIR;
  const activeDays = opts.activeDays ?? LOOPS_ACTIVE_DAYS;
  const projectCap = opts.projectCap ?? LOOPS_PROJECT_CAP;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.statTimeoutMs ?? STAT_TIMEOUT_MS;

  let entries;
  try {
    entries = await readdir(codeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const cutoffMs = now() - activeDays * 86_400_000;
  const out: ScanItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (SKIP_DIR_NAMES.has(name) || name.startsWith(".")) continue;
    const projectDir = join(codeDir, name);
    if (await isLinkedWorktree(projectDir, timeoutMs)) continue;

    const todoPath = join(projectDir, "tasks", "todo.md");
    const st = await withTimeout<Stats | null>(stat(todoPath), timeoutMs, null);
    if (!st || !st.isFile() || st.mtimeMs < cutoffMs) continue;

    const text = await withTimeout<string | null>(readFile(todoPath, "utf8"), timeoutMs, null);
    if (text === null) continue;

    out.push(...parseTodoMd(text, name, todoPath, st.mtimeMs).slice(0, projectCap));
  }
  return out;
}
