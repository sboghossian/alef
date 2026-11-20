// Pure-ish logic + read-only fs scans behind the three memory buildings (episodic archive,
// semantic library, procedural workshop). Every scanner is best-effort: a missing/unreadable
// directory or file is skipped, never thrown — the feature (memory-layers.ts) turns the result
// into "no data" (null), never a silent 0. Unit-tested in server/test/memory-layers-lib.test.ts.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfidenceMark, RecallIndexStats, SemanticStats } from "../../shared/features/memory-layers.js";

const MD_READ_CAP = 64 * 1024;
const SKILL_MD_READ_CAP = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_DAYS = 60;

// ---------------------------------------------------------------- confidence markers
// Mirrors ~/.claude/hooks/memory-claim-lint.py's classify(): same three regexes, same
// precedence (verified, then hypothesis, then reported), so "confidence mix" here means the
// same thing it means in that audit.

const VERIFIED_RE = /✅|\bverified\b/i;
const REPORTED_RE = /📣|\breported\b|\bper \w+\b|\bsaid\b/i;
const HYPOTHESIS_RE = /🧪|\bhypothes|\blikely\b|\bprobably\b|\bshould be\b|\bmay be\b/i;

export function classifyConfidence(text: string): ConfidenceMark {
  if (VERIFIED_RE.test(text)) return "verified";
  if (HYPOTHESIS_RE.test(text)) return "hypothesis";
  if (REPORTED_RE.test(text)) return "reported";
  return "unmarked";
}

// ---------------------------------------------------------------- frontmatter + staleness

/** A YAML frontmatter scalar field ("key: value", optionally quoted), or null when the block
 *  or the key is missing. Good enough for the flat fields memory files actually use (name,
 *  description, modified), also when nested one level under `metadata:` as the memory files
 *  write it; not a YAML parser. */
export function frontmatterField(content: string, key: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm?.[1]) return null;
  const m = new RegExp(`^[ \\t]*${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(fm[1]);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** `modified` (frontmatter) wins when parseable; otherwise the file's own mtime. */
export function isStale(modifiedIso: string | null, mtimeMs: number, nowMs: number, staleDays = STALE_DAYS): boolean {
  const parsed = modifiedIso ? Date.parse(modifiedIso) : NaN;
  const effective = Number.isFinite(parsed) ? parsed : mtimeMs;
  return nowMs - effective >= staleDays * DAY_MS;
}

// ---------------------------------------------------------------- episodic: transcripts

export interface JsonlCounts {
  total: number;
  /** Of `total`, the ones under a "subagents" directory anywhere in their path. */
  subagents: number;
}

async function walkJsonl(dir: string, insideSubagents: boolean, acc: JsonlCounts): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdirectory: skip it, don't fail the whole walk
  }
  await Promise.all(
    entries.map(async (e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walkJsonl(full, insideSubagents || e.name === "subagents", acc);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        acc.total += 1;
        if (insideSubagents) acc.subagents += 1;
      }
    }),
  );
}

/** Recursive count of every `*.jsonl` under `projectsDir` (session transcripts and, nested under
 *  any "subagents" directory, subagent sidechains). Null when the dir itself doesn't exist. */
export async function countJsonlFiles(projectsDir: string): Promise<JsonlCounts | null> {
  try {
    await stat(projectsDir);
  } catch {
    return null;
  }
  const acc: JsonlCounts = { total: 0, subagents: 0 };
  await walkJsonl(projectsDir, false, acc);
  return acc;
}

/** hermes-loop's FTS5 index (recall.py's DB_PATH = ~/.gstack/memory/sessions.db). */
export async function readRecallIndexStats(dbPath: string): Promise<RecallIndexStats> {
  try {
    const s = await stat(dbPath);
    return { present: true, sizeBytes: s.size, lastIndexedAt: s.mtime.toISOString() };
  } catch {
    return { present: false, sizeBytes: null, lastIndexedAt: null };
  }
}

// ---------------------------------------------------------------- semantic: memory files

export interface SemanticScanDeps {
  memoryDir: string;
  now: number;
  staleDays?: number;
}

const EMPTY_CONFIDENCE: Record<ConfidenceMark, number> = { verified: 0, reported: 0, hypothesis: 0, unmarked: 0 };

/** Top-level `*.md` in `memoryDir`, excluding MEMORY.md itself (matches memory-claim-lint.py's
 *  non-recursive `MEM.glob("*.md")`). Null `fileCount` = the memory dir itself is unreadable. */
export async function scanSemanticMemory(deps: SemanticScanDeps): Promise<SemanticStats> {
  const staleDays = deps.staleDays ?? STALE_DAYS;
  let names: string[];
  try {
    names = await readdir(deps.memoryDir);
  } catch {
    return { fileCount: null, confidence: { ...EMPTY_CONFIDENCE }, staleDays, staleCount: 0 };
  }
  const files = names.filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
  const confidence: Record<ConfidenceMark, number> = { ...EMPTY_CONFIDENCE };
  let staleCount = 0;
  await Promise.all(
    files.map(async (name) => {
      const full = join(deps.memoryDir, name);
      let content: string;
      try {
        content = (await readFile(full, "utf8")).slice(0, MD_READ_CAP);
      } catch {
        return; // listed but unreadable: still counted in fileCount, not in confidence/stale
      }
      confidence[classifyConfidence(content)] += 1;
      let mtimeMs = deps.now;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {
        /* stat failed right after a successful read: keep "now" (never counts as stale) */
      }
      if (isStale(frontmatterField(content, "modified"), mtimeMs, deps.now, staleDays)) staleCount += 1;
    }),
  );
  return { fileCount: files.length, confidence, staleDays, staleCount };
}

// ---------------------------------------------------------------- procedural: skill patches

const FAILURE_HEADING_RE = /^##\s*Known failure modes.*$/im;
const HEADING_RE = /^##\s/m;

/** Bullet lines under a skill's "## Known failure modes (auto-logged)" heading (the section
 *  ~/.claude/hooks/learning-loop.py appends to, capped at 12 there) — 0 when the heading is
 *  absent or empty. */
export function countKnownFailureModeEntries(skillMd: string): number {
  const m = FAILURE_HEADING_RE.exec(skillMd);
  if (!m) return 0;
  const rest = skillMd.slice(m.index + m[0].length);
  const next = HEADING_RE.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  return section.split("\n").filter((l) => /^\s*-\s+/.test(l)).length;
}

export interface SkillPatchCounts {
  patchedSkillCount: number;
  patchEntryCount: number;
}

/** Reads each (deduped) SKILL.md path and totals "Known failure modes" entries. Callers pass
 *  the `.path` of an already-scanned skill inventory (skills-inventory.ts) so this never
 *  re-discovers what's installed, only reads it. */
export async function scanSkillPatches(skillMdPaths: readonly string[]): Promise<SkillPatchCounts> {
  const unique = [...new Set(skillMdPaths)];
  let patchedSkillCount = 0;
  let patchEntryCount = 0;
  await Promise.all(
    unique.map(async (path) => {
      let content: string;
      try {
        content = (await readFile(path, "utf8")).slice(0, SKILL_MD_READ_CAP);
      } catch {
        return;
      }
      const n = countKnownFailureModeEntries(content);
      if (n > 0) {
        patchedSkillCount += 1;
        patchEntryCount += n;
      }
    }),
  );
  return { patchedSkillCount, patchEntryCount };
}
