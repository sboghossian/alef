// Pure validation + a read-only scan behind the CLI station: agent-authored CLIs registered at
// ~/.claude/clis/<name>/cli.json. The schema is owned by the /cli-forge skill's _registry.py
// (field names are fixed there — "another component, Alef's CLI station, reads this exact
// shape"); this mirrors that contract, not the other way round. Never writes an entry: another
// agent (cli-forge) creates them. Unit-tested in server/test/cli-station-lib.test.ts.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliAuthor, CliEntry } from "../../shared/features/cli-station.js";
import { isRecord } from "../http.js";

/** Matches a real registry entry dir name; excludes dotdirs/underscored helpers (_registry.py,
 *  __pycache__), same convention as skills-inventory.ts's SKILL_DIR_RE. */
export const CLI_DIR_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const CLI_JSON_READ_CAP = 16 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_AUTHORS: readonly CliAuthor[] = ["agent", "alex"];

/** Schema-only check of one cli.json's parsed body against _registry.py's REQUIRED_FIELDS:
 *  name/tool/purpose/entry/language/created/author/tests, all required, tests nullable, author
 *  one of "agent"|"alex", created "YYYY-MM-DD". Does NOT check that `entry`/`tests` paths
 *  exist on disk — that's _registry.py's `validate` command; this only decides whether the CLI
 *  station can show the row. */
export function validateCliEntry(data: unknown): CliEntry | null {
  if (!isRecord(data)) return null;
  const { name, tool, purpose, entry, language, created, author, tests } = data;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof tool !== "string") return null;
  if (typeof purpose !== "string") return null;
  if (typeof entry !== "string" || entry.length === 0) return null;
  if (typeof language !== "string" || language.length === 0) return null;
  if (typeof created !== "string" || !DATE_RE.test(created)) return null;
  if (typeof author !== "string" || !VALID_AUTHORS.includes(author as CliAuthor)) return null;
  if (tests !== null && typeof tests !== "string") return null;
  return { name, tool, purpose, entry, language, created, author: author as CliAuthor, tests };
}

export interface CliRegistryScan {
  registryPresent: boolean;
  clis: CliEntry[];
  invalidCount: number;
}

/** ~/.claude/clis/<name>/cli.json, one per directory. A directory with no cli.json is skipped
 *  (nothing to validate, not an error); a cli.json that fails to parse or fails the schema
 *  counts toward `invalidCount` instead of appearing in `clis`. `registryPresent: false` only
 *  when the ~/.claude/clis directory itself can't be listed. Sorted by name. A read error other
 *  than "not there" (the folder, or a cli.json) also goes to `onError`: the list may be short. */
export async function scanCliRegistry(clisDir: string, onError?: (err: unknown) => void): Promise<CliRegistryScan> {
  const report = (err: unknown): void => {
    if (!(err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EISDIR"))) onError?.(err);
  };
  let names: string[];
  try {
    names = await readdir(clisDir);
  } catch (err) {
    report(err);
    return { registryPresent: false, clis: [], invalidCount: 0 };
  }
  const dirs = names.filter((n) => CLI_DIR_RE.test(n));
  const clis: CliEntry[] = [];
  let invalidCount = 0;
  await Promise.all(
    dirs.map(async (dir) => {
      let raw: string;
      try {
        raw = (await readFile(join(clisDir, dir, "cli.json"), "utf8")).slice(0, CLI_JSON_READ_CAP);
      } catch (err) {
        report(err); // no cli.json in this dir (ENOENT/ENOTDIR): not a registry entry, not an error
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        invalidCount += 1;
        return;
      }
      const entry = validateCliEntry(parsed);
      if (entry) clis.push(entry);
      else invalidCount += 1;
    }),
  );
  clis.sort((a, b) => a.name.localeCompare(b.name));
  return { registryPresent: true, clis, invalidCount };
}
