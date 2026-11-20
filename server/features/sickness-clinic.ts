// Read-only numbers for the Clinic header (client/src/features/sickness.ts), served by
// server/features/sickness.ts:
//
//   VaultKeyCounter   how many vault notes under 10-Sessions hold a key-shaped string. Same regex
//                     bank and placeholder rules as the transcript detector (findKeys), so a note
//                     counts only for what a transcript would count. Runs on the first GET of the
//                     day (never on a timer), then serves its cached counts for 24 h.
//   countInsurance    the only honest "insurance": trash batches Restore can move back
//                     (cleanup-trash listTrash) and the db backups migrations wrote (data/*.bak).
//
// SECRET INVARIANT: findKeys() returns a provider, a 10-hex hash and a masked prefix, never a
// value. The hashes live only inside one compute() call, to count distinct keys; what is cached
// and served is counts. Nothing here writes a file.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SicknessInsuranceResponse, SicknessVaultResponse } from "../../shared/features/sickness.js";
import { isDataless, READ_TIMEOUT_MS } from "./archive.js";
import { listTrash, realTrashFs } from "./cleanup-trash.js";
import { findKeys, KEY_PREFILTER } from "./sickness-lib.js";

export const VAULT_SUBDIR = "10-Sessions";
export const VAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Folder depth walked under the subdir (10-Sessions/claude-code/<note> is depth 1). */
const MAX_DEPTH = 6;

export interface NoteStat {
  size: number;
  blocks: number;
  isFile(): boolean;
}

export interface VaultKeyCounterOptions {
  vaultDir: string;
  subdir?: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** Test seams: the real fs by default. */
  read?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<NoteStat>;
}

const TIMED_OUT = Symbol("timed out");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Every *.md under `dir`, depth-capped. Dot entries and symlinks are skipped (never followed). */
async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) out.push(...(await markdownFiles(p, depth + 1)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

export class VaultKeyCounter {
  private cached: SicknessVaultResponse | null = null;
  private running: Promise<SicknessVaultResponse> | null = null;
  private readonly subdir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly read: (path: string) => Promise<string>;
  private readonly statOf: (path: string) => Promise<NoteStat>;
  /** Notes compute() actually opened, since construction (tests count cache hits with it). */
  reads = 0;

  constructor(private readonly opts: VaultKeyCounterOptions) {
    this.subdir = opts.subdir ?? VAULT_SUBDIR;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? VAULT_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
    this.read = opts.read ?? ((p) => readFile(p, "utf8"));
    this.statOf = opts.stat ?? ((p) => stat(p));
  }

  /** The cached counts while they are under a day old; otherwise one shared recompute. */
  get(): Promise<SicknessVaultResponse> {
    const c = this.cached;
    if (c && this.now() - Date.parse(c.computedAt) < this.ttlMs) return Promise.resolve(c);
    this.running ??= this.compute()
      .then((r) => {
        this.cached = r;
        return r;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async compute(): Promise<SicknessVaultResponse> {
    const files = await markdownFiles(join(this.opts.vaultDir, this.subdir));
    const skipped = { notDownloaded: 0, timedOut: 0, unreadable: 0 };
    const allKeys = new Set<string>();
    const providers = new Map<string, { notes: number; keys: Set<string> }>();
    let notesScanned = 0;
    let notesWithKeys = 0;
    for (const path of files) {
      let st: NoteStat;
      try {
        st = await this.statOf(path);
      } catch {
        skipped.unreadable++;
        continue;
      }
      if (!st.isFile()) continue;
      // Never open an evicted iCloud note: the open blocks on a download (or forever).
      if (isDataless(st)) {
        skipped.notDownloaded++;
        continue;
      }
      let text: string | typeof TIMED_OUT;
      try {
        this.reads++;
        text = await withTimeout(this.read(path), this.timeoutMs);
      } catch {
        skipped.unreadable++;
        continue;
      }
      if (text === TIMED_OUT) {
        skipped.timedOut++;
        continue;
      }
      notesScanned++;
      const body = text;
      if (!KEY_PREFILTER.some((n) => body.includes(n))) continue;
      const hits = findKeys(body);
      if (hits.length === 0) continue;
      notesWithKeys++;
      const seenHere = new Set<string>();
      for (const k of hits) {
        allKeys.add(k.hash10);
        const p = providers.get(k.provider) ?? { notes: 0, keys: new Set<string>() };
        p.keys.add(k.hash10);
        if (!seenHere.has(k.provider)) {
          seenHere.add(k.provider);
          p.notes++;
        }
        providers.set(k.provider, p);
      }
    }
    const byProvider: Record<string, { notes: number; keys: number }> = {};
    for (const [name, p] of [...providers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) byProvider[name] = { notes: p.notes, keys: p.keys.size };
    return {
      ok: true,
      dir: this.subdir,
      computedAt: new Date(this.now()).toISOString(),
      notesScanned,
      notesWithKeys,
      distinctKeys: allKeys.size,
      byProvider,
      skipped,
    };
  }
}

/** Trash batches (and the items in them still restorable) plus the db backups beside world.db. */
export async function countInsurance(o: { home: string; projectsDir: string; backupsDir: string }): Promise<SicknessInsuranceResponse> {
  const manifests = await listTrash({ home: o.home, projectsDir: o.projectsDir, fs: realTrashFs, now: () => new Date() });
  const retiredItems = manifests.reduce((n, m) => n + m.items.filter((i) => i.state === "retired").length, 0);
  let dbBackups = 0;
  try {
    dbBackups = (await readdir(o.backupsDir)).filter((n) => n.endsWith(".bak")).length;
  } catch {
    dbBackups = 0;
  }
  return { ok: true, trashBatches: manifests.length, retiredItems, dbBackups };
}
