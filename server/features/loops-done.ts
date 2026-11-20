// "Mark done" on a loop (the Fix queue's loops rows): ticks the ONE `- [ ]` line of tasks/todo.md the
// item came from, and nothing else in the file. The line is found again by the scan's own walk
// (uncheckedTodoLines), so a heading, a fence or a deferred section reads exactly as the scan read
// it. Refused, with nothing written, when the text matches no open line or more than one (two
// identical todos: which one is meant can't be told), or when the file changed between the read
// and the write. Written through a temp file and a rename, so a crash never leaves half a file.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dedupKey } from "./loops-merge.js";
import { uncheckedTodoLines } from "./loops-scan.js";

export type TickResult = { ok: true; text: string; line: number } | { ok: false; error: string };

/** `text` with the open item that is `task` ticked ("- [ ]" → "- [x]"), keeping the file's own line
 *  endings. "Is" means the same dedup key the Loops merge matched it on (whatsup words a merged
 *  item its own way). Pure, for tests. */
export function tickTodoLine(text: string, task: string): TickResult {
  const want = dedupKey("", task);
  const hits = uncheckedTodoLines(text).filter((l) => dedupKey("", l.task) === want);
  if (hits.length === 0) return { ok: false, error: "that todo is no longer open in its todo.md" };
  if (hits.length > 1) return { ok: false, error: `that todo is in its todo.md ${hits.length} times, so it was not ticked; tick the one you mean by hand` };
  const line = hits[0]!.line;
  const parts = text.split(/(\r?\n)/); // even indexes are lines, odd ones their endings
  const raw = parts[line * 2];
  if (raw === undefined) return { ok: false, error: "that todo's line could not be found again" };
  const ticked = raw.replace(/\[ \]/, "[x]");
  if (ticked === raw) return { ok: false, error: "that todo's checkbox could not be found again" };
  parts[line * 2] = ticked;
  return { ok: true, text: parts.join(""), line: line + 1 };
}

/** Ticks `task` in the todo.md at `path` (already validated inside the home directory). */
export async function markTodoDone(path: string, task: string): Promise<TickResult> {
  if (basename(path) !== "todo.md") return { ok: false, error: "only a tasks/todo.md line can be marked done here" };
  let before;
  let text;
  try {
    before = await stat(path);
    text = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, error: `could not read the todo.md: ${String(err)}` };
  }
  const result = tickTodoLine(text, task);
  if (!result.ok) return result;
  const tmp = join(dirname(path), `.todo.md.${process.pid}.tmp`);
  try {
    const now = await stat(path);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) return { ok: false, error: "the todo.md changed while it was being ticked; try again" };
    await writeFile(tmp, result.text, { encoding: "utf8", mode: before.mode & 0o777 });
    await rename(tmp, path);
  } catch (err) {
    return { ok: false, error: `could not write the todo.md: ${String(err)}` };
  }
  return result;
}
