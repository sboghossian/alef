// The filesystem half of "cleanup" (P2): move a session's files into ~/.alef-trash and back.
//
// Safety, in order of importance:
//   - Only `<projectsDir>/<projDir>/<uuid>.jsonl` and a folder named exactly `<uuid>` beside it
//     are ever moved (cleanup-lib `retirablePathError`, checked on the realpath, and the entry
//     itself must not be a symlink). memory*, other names and anything outside are refused.
//   - Nothing is unlinked, ever. Retire and restore are `rename` only (same volume, atomic);
//     a cross-volume rename fails with EXDEV and is reported, never copied-then-deleted.
//   - The manifest (state "planned") is written BEFORE the first move and rewritten after each
//     one, so a crash mid-batch still leaves a record that restore understands.
//   - Restore never overwrites: every destination is checked absent first (409 otherwise).
// Every fs call goes through the injected `TrashDeps.fs`, and home/projectsDir are injected,
// so tests run entirely inside temp dirs.

import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ManifestItem, RestoreItemResult, RetireItemResult, TrashManifest } from "../../shared/features/cleanup.js";
import { BATCH_ID_RE, DATE_DIR_RE, isAllowedProjDir, isInsideDir, makeBatchId, parseManifest, retirablePathError, trashDateKey } from "./cleanup-lib.js";

export interface TrashFs {
  readdir(path: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true; mode?: number }): Promise<string | undefined>;
  readFile(path: string, enc: "utf8"): Promise<string>;
  writeFile(path: string, data: string, opts: { encoding: "utf8"; mode?: number; flag?: string }): Promise<void>;
  appendFile(path: string, data: string, opts: { encoding: "utf8"; mode?: number }): Promise<void>;
}

export const realTrashFs: TrashFs = {
  readdir: (p, o) => nodeFs.readdir(p, o),
  lstat: (p) => nodeFs.lstat(p),
  stat: (p) => nodeFs.stat(p),
  realpath: (p) => nodeFs.realpath(p),
  rename: (a, b) => nodeFs.rename(a, b),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  readFile: (p, e) => nodeFs.readFile(p, e),
  writeFile: (p, d, o) => nodeFs.writeFile(p, d, o),
  appendFile: (p, d, o) => nodeFs.appendFile(p, d, o),
};

export interface TrashDeps {
  home: string;
  projectsDir: string;
  fs: TrashFs;
  now(): Date;
}

export function trashRootOf(home: string): string {
  return join(home, ".alef-trash");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** {legacy: "..."} when this id has a status, else {} (never a "legacy: undefined" key). */
function legacyField(status: ReadonlyMap<string, string>, id: string): { legacy?: string } {
  const legacy = status.get(id);
  return legacy === undefined ? {} : { legacy };
}

async function exists(fs: TrashFs, p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Real, guarded paths of one session's files. */
export interface LocatedSession {
  id: string;
  projDir: string;
  jsonl: string;
  dir: string | null;
  jsonlMtimeMs: number;
  bytes: number;
}

async function dirBytes(fs: TrashFs, dir: string, depth = 0): Promise<number> {
  if (depth > 8) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(fs, p, depth + 1);
    else if (e.isFile()) {
      try {
        total += (await fs.lstat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

/** Recursive size of a folder (symlinks not followed). */
export function folderBytes(fs: TrashFs, dir: string): Promise<number> {
  return dirBytes(fs, dir);
}

/** Checks one path on the realpath and on the entry itself (never a symlink). */
async function guardedPath(fs: TrashFs, realRoot: string, p: string, id: string, kind: "file" | "dir"): Promise<string> {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink()) throw new Error("refusing a symlink");
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new Error(`not a ${kind}`);
  const real = await fs.realpath(p);
  const err = retirablePathError(realRoot, real, id);
  if (err) throw new Error(err);
  return real;
}

/**
 * Finds `<projectsDir>/<projDir>/<id>.jsonl` (and the `<id>/` folder beside it) and returns their
 * real, guarded paths. Throws with a readable reason when absent or refused.
 */
export async function locateSession(deps: TrashDeps, id: string): Promise<LocatedSession> {
  const { fs } = deps;
  const realRoot = await fs.realpath(deps.projectsDir);
  const dirs = await fs.readdir(realRoot, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory() || !isAllowedProjDir(d.name)) continue;
    const candidate = join(realRoot, d.name, `${id}.jsonl`);
    if (!(await exists(fs, candidate))) continue;
    const jsonl = await guardedPath(fs, realRoot, candidate, id, "file");
    const st = await fs.lstat(jsonl);
    let dir: string | null = null;
    const dirCandidate = join(realRoot, d.name, id);
    if (await exists(fs, dirCandidate)) dir = await guardedPath(fs, realRoot, dirCandidate, id, "dir");
    const bytes = st.size + (dir ? await dirBytes(fs, dir) : 0);
    return { id, projDir: d.name, jsonl, dir, jsonlMtimeMs: st.mtimeMs, bytes };
  }
  throw new Error("session file not found in ~/.claude/projects");
}

async function writeManifest(fs: TrashFs, batchDir: string, m: TrashManifest): Promise<void> {
  const file = join(batchDir, "manifest.json");
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file); // replaces only our own manifest
}

async function appendLog(deps: TrashDeps, entry: Record<string, unknown>): Promise<void> {
  try {
    await deps.fs.appendFile(join(trashRootOf(deps.home), "log.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* the log is a convenience; the manifest is the record */
  }
}

export interface RetireRequestItem {
  id: string;
  title: string;
  cwd: string;
  messageCount: number;
  lastActive: string;
}

/** Re-checked per id at action time; returns a refusal reason or null. */
export type RetireGuard = (id: string, jsonlMtimeMs: number) => Promise<string | null> | string | null;

/** alumni.ts's writeLegacy, called once the live-guard has passed for `ids` (a leading subset of
 *  the batch), before the first rename. Returns one of three statuses per id: "legacy card: written"
 *  (a certain success), "legacy card: not written (<reason>)" (a certain failure — nothing was
 *  written), or "legacy card: unknown (<reason>)" (the write raced past its own timeout without being
 *  cancelled, so it may still land later — treated like "written" below, since retireSessions must
 *  void it too if the move doesn't complete). A throw is treated the same as every id getting
 *  "not written" (see the catch around its call below). */
export type LegacyWriter = (ids: readonly string[], batchId: string) => Promise<ReadonlyMap<string, string>>;

/** What `LegacyVoider` actually did, so the retire response never claims a void that isn't on disk:
 *  "written" — the "voided" line is on disk; "queued" — its append raced past its own timeout and
 *  is still in flight, NOT yet on disk (behind the card's write on alumni.ts's per-path chain, or in
 *  the next generation file, which GET folds after the card's — never ahead of the card either way);
 *  "failed" — nothing was appended (a card that landed still stands). */
export type LegacyVoidOutcome = { state: "written" } | { state: "queued" | "failed"; reason: string };

/** alumni.ts's voidLegacy: a compensating call for ids whose card `writeLegacy` wrote (or may still
 *  write) but whose move then did NOT complete (a late guard refusal, a rename failure, a throw
 *  anywhere below the write). Always best-effort from this function's side: its outcome only picks
 *  the `legacy` label, and a throw here is treated as "failed", never widening what retire moves. */
export type LegacyVoider = (ids: readonly string[], batchId: string) => Promise<LegacyVoidOutcome>;

export interface RetireOutcome {
  batchId: string;
  batchDir: string;
  results: RetireItemResult[];
}

/**
 * Moves each session's files into `~/.alef-trash/<date>/<batchId>/<projDir>/`. Per id: locate +
 * path guards, then the live guard. `writeLegacy`, when given, runs once every guard in this batch
 * has passed and before the manifest (and so before the first rename) — the same "record before
 * the irreversible part" order the manifest itself follows. A legacy failure is caught here and
 * never blocks or widens what gets moved: every planned id just gets an explanatory `legacy`
 * status instead of a written card. The manifest is on disk before the first rename.
 *
 * SAFETY INVARIANT (extended): a card is written (or, per LegacyWriter's "unknown" status, MAY be
 * written later) only after the FIRST guard passes, but the move itself can still fail after that —
 * the move-time guard re-check, a rename error, "already in the trash batch", a failed
 * mkdir/manifest write, or the trash-inside-projects refusal (which throws the whole batch).
 * Everything from the card write onward runs inside a try/finally so that on every one of those
 * exits, any id whose card was written OR might still be written but whose item never reached
 * "retired" gets `voidLegacy` called for it (never blocking, same as `writeLegacy`), and its
 * result's `legacy` is rewritten to say what that void actually did on disk: "legacy card: voided
 * (not moved)" only once the void line is written, "legacy card: void queued (not moved; <reason>)"
 * while it is still in flight, and "legacy card: void failed (<reason>)" when nothing was appended —
 * so a card is never left standing SILENTLY for a session that never actually left
 * ~/.claude/projects, even one whose write only lands after this function has already returned.
 * Ordering: alumni.ts stores its lazily-seeded write state before the card's append starts and never
 * counts a timed-out ("unknown") card toward rotation, so the void never re-reads alumni.jsonl and
 * queues on the same per-path promise chain behind the card's write (a late card lands BEFORE its
 * void). It goes to the next generation file only when a confirmed write (a "written" card, already
 * on disk) filled the card's, and GET folds that file after the card's.
 */
export async function retireSessions(deps: TrashDeps, items: readonly RetireRequestItem[], guard: RetireGuard, writeLegacy?: LegacyWriter, voidLegacy?: LegacyVoider): Promise<RetireOutcome> {
  const { fs } = deps;
  const now = deps.now();
  const batchId = makeBatchId(now, randomBytes(3).toString("hex"));
  const date = trashDateKey(now);
  const root = trashRootOf(deps.home);
  const batchDir = join(root, date, batchId);
  const results: RetireItemResult[] = [];

  // 1. Locate + guard everything first (no side effect yet).
  const planned: { located: LocatedSession; item: ManifestItem }[] = [];
  const realProjects = await fs.realpath(deps.projectsDir);
  for (const req of items) {
    try {
      const located = await locateSession(deps, req.id);
      const refusal = await guard(req.id, located.jsonlMtimeMs);
      if (refusal) {
        results.push({ id: req.id, ok: false, error: `protected: ${refusal}`, bytes: located.bytes });
        continue;
      }
      const from = [located.jsonl, ...(located.dir ? [located.dir] : [])];
      const to = from.map((p) => join(batchDir, located.projDir, basename(p)));
      planned.push({
        located,
        item: { sessionId: req.id, title: req.title, cwd: req.cwd, messageCount: req.messageCount, lastActive: req.lastActive, from, to, bytes: located.bytes, state: "planned" },
      });
    } catch (err) {
      results.push({ id: req.id, ok: false, error: errText(err), bytes: 0 });
    }
  }
  if (planned.length === 0) return { batchId, batchDir, results };

  // Every guard in this batch has passed: write a legacy card now, before anything moves. Never
  // lets a legacy failure reach the retire itself.
  let legacyStatus: ReadonlyMap<string, string> = new Map();
  if (writeLegacy) {
    try {
      legacyStatus = await writeLegacy(planned.map((p) => p.item.sessionId), batchId);
    } catch (err) {
      legacyStatus = new Map(planned.map((p) => [p.item.sessionId, `legacy card: not written (${errText(err)})`]));
    }
  }

  // From here on, ANY planned id whose card was written must get voided if it does not end up
  // "retired" — see the finally block below. try/finally so that runs on every exit, including a
  // throw (the trash-root check just below, a manifest write failure, …).
  try {
    // The trash must never sit inside ~/.claude/projects (a move there would be no move at all).
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (isInsideDir(realProjects, await fs.realpath(root))) throw new Error("the trash folder resolves inside ~/.claude/projects; refusing");

    // 2. Manifest first: a crash after this point leaves a restorable record.
    const manifest: TrashManifest = { batchId, date, at: now.toISOString(), items: planned.map((p) => p.item) };
    await fs.mkdir(batchDir, { recursive: true, mode: 0o700 });
    await writeManifest(fs, batchDir, manifest);

    // 3. Move, one session at a time. The jsonl goes first; if the folder then fails, the jsonl
    //    goes back so a session is never half in the trash.
    for (const { located, item } of planned) {
      try {
        const st = await fs.lstat(located.jsonl);
        const late = await guard(item.sessionId, st.mtimeMs);
        if (late) throw new Error(`protected: ${late}`);
        for (const t of item.to) if (await exists(fs, t)) throw new Error("already in the trash batch");
        await fs.mkdir(join(batchDir, located.projDir), { recursive: true, mode: 0o700 });
        await fs.rename(item.from[0] ?? "", item.to[0] ?? "");
        if (item.from.length > 1) {
          try {
            await fs.rename(item.from[1] ?? "", item.to[1] ?? "");
          } catch (err) {
            await fs.rename(item.to[0] ?? "", item.from[0] ?? "");
            throw err;
          }
        }
        item.state = "retired";
        results.push({ id: item.sessionId, ok: true, bytes: item.bytes, ...legacyField(legacyStatus, item.sessionId) });
      } catch (err) {
        // If something did reach the trash (a rollback that failed too), keep it "planned":
        // restore then moves back whatever moved.
        let moved = false;
        for (const t of item.to) if (await exists(fs, t)) moved = true;
        item.state = moved ? "planned" : "failed";
        item.error = errText(err);
        results.push({ id: item.sessionId, ok: false, error: item.error, bytes: item.bytes, ...legacyField(legacyStatus, item.sessionId) });
      }
      await writeManifest(fs, batchDir, manifest);
    }
    await appendLog(deps, { at: now.toISOString(), action: "retire", batchId, ids: manifest.items.filter((i) => i.state === "retired").map((i) => i.sessionId) });
    return { batchId, batchDir, results };
  } finally {
    // A card may have been written (writeLegacy said so, "written") or may STILL land later (an
    // append that raced past its timeout without being cancelled reports "unknown", not "not
    // written" — alumni.ts's AmbiguousWriteError) — either way, an item that never reached "retired"
    // must get voided: whatever stopped it happened after the card could already exist, so the Hall
    // must never show it. This covers a late guard refusal, a rename failure, and a whole-batch throw
    // (every planned item is still in its initial "planned" state when that happens). A void with no
    // matching card is harmless (currentAlumni only ever looks at each session's LAST event), so
    // voiding an "unknown" id is always safe even when its card never actually lands. The void is
    // best effort; its outcome only decides which honest `legacy` label each result gets.
    const toVoid = planned
      .filter((p) => p.item.state !== "retired")
      .filter((p) => {
        const status = legacyStatus.get(p.item.sessionId);
        return status === "legacy card: written" || (status?.startsWith("legacy card: unknown ") ?? false);
      })
      .map((p) => p.item.sessionId);
    if (toVoid.length > 0) {
      // The label says what is actually on disk: "voided" only once the void line is written.
      let label = "legacy card: void failed (no voider wired)";
      if (voidLegacy) {
        try {
          const v = await voidLegacy(toVoid, batchId);
          label = v.state === "written" ? "legacy card: voided (not moved)" : v.state === "queued" ? `legacy card: void queued (not moved; ${v.reason})` : `legacy card: void failed (${v.reason})`;
        } catch (err) {
          // best effort: the manifest (and its "failed"/"planned" state) is what restore trusts
          label = `legacy card: void failed (${errText(err)})`;
        }
      }
      const voided = new Set(toVoid);
      for (const r of results) if (voided.has(r.id) && r.legacy !== undefined) r.legacy = label;
    }
  }
}

/** Every batch in the trash, newest first. Malformed manifests are skipped. */
export async function listTrash(deps: TrashDeps): Promise<TrashManifest[]> {
  const { fs } = deps;
  const root = trashRootOf(deps.home);
  const out: TrashManifest[] = [];
  let dates: Dirent[];
  try {
    dates = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dates) {
    if (!d.isDirectory() || !DATE_DIR_RE.test(d.name)) continue;
    let batches: Dirent[];
    try {
      batches = await fs.readdir(join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const b of batches) {
      if (!b.isDirectory() || !BATCH_ID_RE.test(b.name)) continue;
      try {
        const m = parseManifest(JSON.parse(await fs.readFile(join(root, d.name, b.name, "manifest.json"), "utf8")));
        if (m && m.batchId === b.name && m.date === d.name) out.push(m);
      } catch {
        /* unreadable manifest: leave it alone */
      }
    }
  }
  return out.sort((a, b) => (a.batchId < b.batchId ? 1 : -1));
}

export class RestoreConflict extends Error {}

/**
 * Moves a batch's items (all, or `ids`) back where they came from. Never overwrites: every
 * destination must be absent, or that item is refused with a conflict. Paths in the manifest are
 * untrusted (the trash is user-writable), so both ends are re-checked against the guards.
 */
export async function restoreBatch(deps: TrashDeps, batchId: string, ids: readonly string[] | null): Promise<{ results: RestoreItemResult[]; restoredIds: string[] }> {
  const { fs } = deps;
  if (!BATCH_ID_RE.test(batchId)) throw new Error("bad batch id");
  const manifest = (await listTrash(deps)).find((m) => m.batchId === batchId);
  if (!manifest) throw new Error("no such trash batch");
  const root = trashRootOf(deps.home);
  const batchDir = join(root, manifest.date, manifest.batchId);
  const realBatch = await fs.realpath(batchDir);
  const realProjects = await fs.realpath(deps.projectsDir);
  const results: RestoreItemResult[] = [];
  const restoredIds: string[] = [];
  const wanted = ids ? new Set(ids) : null;

  for (const item of manifest.items) {
    if (wanted && !wanted.has(item.sessionId)) continue;
    if (item.state === "restored" || item.state === "failed") {
      if (wanted) results.push({ id: item.sessionId, ok: false, error: item.state === "restored" ? "already restored" : "it never left ~/.claude/projects" });
      continue;
    }
    try {
      // "planned" (a crash between the manifest and the move): whatever did move, move back.
      const pairs: { from: string; to: string }[] = [];
      for (let i = 0; i < item.from.length; i++) {
        const from = item.from[i] ?? "";
        const to = item.to[i] ?? "";
        const err = retirablePathError(realProjects, from, item.sessionId);
        if (err) throw new Error(`manifest path refused: ${err}`);
        if (basename(from) !== basename(to) || dirname(dirname(to)) !== batchDir) throw new Error("manifest trash path refused");
        if (await exists(fs, dirname(to))) {
          if (!isInsideDir(realBatch, await fs.realpath(dirname(to)))) throw new Error("manifest trash path escapes its batch");
        }
        const parent = dirname(from);
        if (await exists(fs, parent)) {
          if ((await fs.realpath(parent)) !== parent) throw new Error("its project folder is now a symlink; refusing");
        }
        if (!(await exists(fs, to))) {
          if (item.state === "planned") continue; // this part never moved
          throw new Error("its files are no longer in the trash");
        }
        const st = await fs.lstat(to);
        if (st.isSymbolicLink()) throw new Error("refusing a symlink in the trash");
        if (await exists(fs, from)) throw new RestoreConflict("a file with that name is back in ~/.claude/projects; not overwriting it");
        pairs.push({ from, to });
      }
      // All-or-nothing: if a later part fails, move the earlier ones back into the trash so the
      // item stays "retired" and a retry starts clean (otherwise the .jsonl would sit restored
      // while its <id>/ folder is stranded, and every retry would refuse the "conflict").
      const moved: { from: string; to: string }[] = [];
      try {
        for (const p of pairs) {
          await fs.mkdir(dirname(p.from), { recursive: true });
          await fs.rename(p.to, p.from);
          moved.push(p);
        }
      } catch (err) {
        for (const p of moved.reverse()) await fs.rename(p.from, p.to);
        throw err;
      }
      item.state = "restored";
      restoredIds.push(item.sessionId);
      results.push({ id: item.sessionId, ok: true });
    } catch (err) {
      results.push({ id: item.sessionId, ok: false, error: errText(err) });
    }
  }
  await writeManifest(fs, batchDir, manifest);
  await appendLog(deps, { at: deps.now().toISOString(), action: "restore", batchId, ids: restoredIds });
  return { results, restoredIds };
}

/** Saves a tmux pane's scrollback as text in the trash, never overwriting. Returns the path. */
export async function saveTmuxScrollback(deps: TrashDeps, name: string, text: string): Promise<string> {
  const dir = join(trashRootOf(deps.home), trashDateKey(deps.now()), "tmux");
  await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 100; i++) {
    const file = join(dir, i === 0 ? `${name}.txt` : `${name}-${i}.txt`);
    try {
      await deps.fs.writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("too many scrollback files with that name today");
}
