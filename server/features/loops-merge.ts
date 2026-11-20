// Merges whatsup's ranked items (a) with Alef's own live todo.md scan (b): an item from (b)
// that matches an item from (a) on (project, normalized text) shows once, keeping whatsup's
// lens and score. Everything scan-only keeps its own dedup key as an id and lands in the
// "unranked" lens.
//
// `dedupKey` mirrors whatsup's own `lib/ids.py` (normalize -> lowercase, strip punctuation,
// collapse whitespace; dedup_key -> project + first 60 chars) closely enough to match its
// output for the same text, without depending on whatsup's exact sha1 id scheme.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import type { LoopsItem, LoopsLens, LoopsSourceKind } from "../../shared/features/loops.js";
import type { ScanItem } from "./loops-scan.js";
import type { WhatsupItem } from "./loops-whatsup.js";

const NON_WORD_RE = /[^\w\s]/g;
const WS_RE = /\s+/g;
const DEDUP_TEXT_CHARS = 60;

export function normalizeTaskText(text: string): string {
  return text.toLowerCase().replace(NON_WORD_RE, " ").replace(WS_RE, " ").trim();
}

export function dedupKey(project: string, task: string): string {
  return `${project.toLowerCase()}::${normalizeTaskText(task).slice(0, DEDUP_TEXT_CHARS)}`;
}

function scanItemId(key: string): string {
  return `scan-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

function isAbsPath(p: string | null): p is string {
  return p !== null && p.startsWith("/");
}

/** The project's directory a todo.md path implies: `<codeDir>/<project>/tasks/todo.md` -> `<codeDir>/<project>`. */
function projectDirFromTodoPath(todoPath: string): string {
  return dirname(dirname(todoPath));
}

/** True when `dir` exists and is a directory. Cached per-project by the caller. */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves a whatsup `project` slug to a real `<codeDir>/<project>` directory, or null when
 *  there is none (a vault/memory/live item whose project isn't an actual checked-out repo). */
async function resolveProjectDir(project: string, codeDir: string, cache: Map<string, string | null>): Promise<string | null> {
  const cached = cache.get(project);
  if (cached !== undefined) return cached;
  const candidate = join(codeDir, project);
  const result = (await isDirectory(candidate)) ? candidate : null;
  cache.set(project, result);
  return result;
}

/** Merges (a) whatsup items and (b) Alef's own todo.md scan into one deduped, ranked list. */
export async function mergeLoopsItems(
  whatsupItems: readonly WhatsupItem[],
  scanItems: readonly ScanItem[],
  whatsupGeneratedAt: string | null,
  codeDir: string,
): Promise<LoopsItem[]> {
  const scanByKey = new Map<string, ScanItem>();
  for (const s of scanItems) {
    const key = dedupKey(s.project, s.task);
    if (!scanByKey.has(key)) scanByKey.set(key, s); // first (top-of-file) wins on an in-scan dup
  }

  const projectDirCache = new Map<string, string | null>();
  const out: LoopsItem[] = [];
  const usedScanKeys = new Set<string>();

  for (const w of whatsupItems) {
    const key = dedupKey(w.project, w.task);
    const match = scanByKey.get(key);
    if (match) usedScanKeys.add(key);

    const sources: LoopsSourceKind[] = match ? ["whatsup", "scan"] : ["whatsup"];
    const openPath = match ? match.sourceFile : isAbsPath(w.sourceFile) ? w.sourceFile : null;
    const launchCwd = match ? projectDirFromTodoPath(match.sourceFile) : await resolveProjectDir(w.project, codeDir, projectDirCache);
    const updatedAt = match ? new Date(match.mtimeMs).toISOString() : whatsupGeneratedAt;

    out.push({
      id: w.id,
      task: w.task,
      project: w.project,
      lens: w.lens,
      score: w.score,
      sources,
      sourceType: w.sourceType,
      updatedAt,
      openPath,
      launchCwd,
    });
  }

  for (const [key, s] of scanByKey) {
    if (usedScanKeys.has(key)) continue;
    const lens: LoopsLens = "unranked";
    out.push({
      id: scanItemId(key),
      task: s.task,
      project: s.project,
      lens,
      score: 0,
      sources: ["scan"],
      sourceType: "todo_md",
      updatedAt: new Date(s.mtimeMs).toISOString(),
      openPath: s.sourceFile,
      launchCwd: projectDirFromTodoPath(s.sourceFile),
    });
  }

  return out;
}
