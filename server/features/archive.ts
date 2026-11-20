// Archive (fossils): every Claude Code session the vault remembers whose transcript Claude Code
// has pruned. Reads the frontmatter of ~/Documents/Code/alex_claude/10-Sessions/claude-code/*.md
// (READ-ONLY, first HEAD_BYTES of each file only), skips ids the world indexes live, and places the
// rest (archive-lib.ts). Topic groups come from the topics feature's rules and taxonomy, then its
// cached Jev answers. This feature never calls Jev itself: home/root sessions nothing placed are
// handed to the topics feature's rate-limited Jev queue (topics-link.ts) and re-placed once answered.
//
// Cost: a scan stats every note and re-reads only files whose mtime/size changed (in-memory cache),
// at boot and then at most every RESCAN_MS. Placement is recomputed from the cached parse when the
// live session set or the island set changes (cheap: no I/O besides two small owner files).

import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { ArchivedSession, ArchiveMessage, ArchiveSummary } from "../../shared/features/archive.js";
import { respondJson } from "../http.js";
import { buildArchive, worktreeAliasIslands, HEAD_BYTES, parseSessionNote, type ArchiveIndex, type ParseResult } from "./archive-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { parseAssignments, parseTaxonomy } from "./topics-lib.js";
import { topicsJevLink, type TopicsJevLink } from "./topics-link.js";
import { vaultRoot } from "../config.js";

const TICK_MS = 60_000;
export const RESCAN_MS = 10 * 60_000;

export interface ArchiveFeatureOptions {
  vaultDir?: string; // defaults to ~/Documents/Code/alex_claude (or $ALEF_VAULT_DIR)
  notesSubdir?: string; // defaults to 10-Sessions/claude-code
  groupsDir?: string; // defaults to ~/.claude/session-groups (taxonomy + assignments, read-only)
  homeDir?: string;
  now?: () => number;
  rescanMs?: number;
  link?: TopicsJevLink; // defaults to the server-wide topicsJevLink
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: ParseResult;
}

async function readHead(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** A read slower than this is abandoned for this scan (the note is retried on the next one). */
export const READ_TIMEOUT_MS = 2_000;

/** iCloud "dataless" file: evicted to the cloud, so opening it blocks on a download (or forever). */
export function isDataless(st: { size: number; blocks: number }): boolean {
  return st.size > 0 && st.blocks === 0;
}

/** Races `p` against `ms`; resolves to `TIMED_OUT` instead of waiting forever on a read that never
 *  settles (a dataless iCloud file, a FIFO with no writer, …). Exported so any other feature with
 *  the same "never let a slow read block something else" shape (alumni.ts's legacy-card write) can
 *  share one timeout budget and one symbol, instead of inventing its own. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
export const TIMED_OUT = Symbol("timed out");

export interface NoteCacheOptions {
  read?: (path: string) => Promise<string>;
  timeoutMs?: number;
}

/** The mtime-keyed parse cache on its own, so tests can count file reads. */
export class NoteCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Files actually opened and parsed (cache misses), since construction. */
  reads = 0;
  private readonly read: (path: string) => Promise<string>;
  private readonly timeoutMs: number;
  /** Notes whose earlier read timed out and has not settled yet: never opened again until it does (one fd at most). */
  private readonly stalled = new Set<string>();

  constructor(private readonly dir: string, opts: NoteCacheOptions = {}) {
    this.read = opts.read ?? readHead;
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** Stats every *.md (skipping "_…" hub files and folders), re-parses only changed files, forgets deleted ones. */
  async scan(): Promise<{ files: number; results: { file: string; result: ParseResult }[] }> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".md") && !n.startsWith("_")).sort();
    } catch {
      names = [];
    }
    const present = new Set(names);
    for (const k of this.entries.keys()) if (!present.has(k)) this.entries.delete(k);
    const results: { file: string; result: ParseResult }[] = [];
    let files = 0;
    for (const name of names) {
      const path = join(this.dir, name);
      let st;
      try {
        st = await stat(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      files++;
      const cached = this.entries.get(name);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        results.push({ file: name, result: cached.result });
        continue;
      }
      // Never open an evicted iCloud note, and never let one slow read stall the scan.
      // Neither outcome is cached, so the note is picked up once it is downloaded.
      if (isDataless(st)) {
        results.push({ file: name, result: { ok: false, reason: "not-downloaded" } });
        continue;
      }
      if (this.stalled.has(name)) {
        results.push({ file: name, result: { ok: false, reason: "read-timeout" } });
        continue;
      }
      let result: ParseResult;
      try {
        const pending = this.read(path);
        const text = await withTimeout(pending, this.timeoutMs);
        if (text === TIMED_OUT) {
          this.stalled.add(name);
          pending.then(
            () => this.stalled.delete(name),
            () => this.stalled.delete(name),
          );
          results.push({ file: name, result: { ok: false, reason: "read-timeout" } });
          continue;
        }
        result = parseSessionNote(text, name);
      } catch {
        result = { ok: false, reason: "no-frontmatter" };
      }
      this.reads++;
      this.entries.set(name, { mtimeMs: st.mtimeMs, size: st.size, result });
      results.push({ file: name, result });
    }
    return { files, results };
  }
}

export interface ArchiveFeature extends ServerFeature {
  /** The archived sessions as of the last scan, for other features (voice-brain's retrieval).
   *  Never waits and never scans ([] until this feature's own first scan lands): a scan run on
   *  another feature's ctx would emit its summary under that feature's id. */
  archivedSessions(): readonly ArchivedSession[];
}

/** The running feature's last built session list (careers reads it), or null before the first
 *  build. Read-only: the array is the one the archive built and serves at GET /api/archive. */
let latestSessions: readonly ArchivedSession[] | null = null;
export function latestArchivedSessions(): readonly ArchivedSession[] | null {
  return latestSessions;
}

export function createArchiveFeature(opts: ArchiveFeatureOptions = {}): ArchiveFeature {
  const home = opts.homeDir ?? homedir();
  const vaultDir = opts.vaultDir ?? vaultRoot(home);
  const notesSubdir = opts.notesSubdir ?? join("10-Sessions", "claude-code");
  const notesDir = join(vaultDir, notesSubdir);
  const groupsDir = opts.groupsDir ?? join(home, ".claude", "session-groups");
  const now = opts.now ?? Date.now;
  const rescanMs = opts.rescanMs ?? RESCAN_MS;
  const cache = new NoteCache(notesDir);
  const link = opts.link ?? topicsJevLink;

  let scanned: Awaited<ReturnType<NoteCache["scan"]>> | null = null;
  let scannedAt = -Infinity;
  let scanVersion = 0;
  let index: ArchiveIndex | null = null;
  let signature = "";
  let running: Promise<ArchiveIndex | null> | null = null;

  async function recompute(ctx: FeatureContext): Promise<ArchiveIndex | null> {
    if (!scanned || now() - scannedAt >= rescanMs) {
      const t0 = Date.now();
      scanned = await cache.scan();
      scannedAt = now();
      scanVersion++;
      ctx.log.info("archive", `scanned ${scanned.files} vault session notes in ${Date.now() - t0}ms (${cache.reads} parsed so far)`);
    }
    const { agents, islands } = ctx.worldViews();
    const worktreeIslands = worktreeAliasIslands(ctx.db.listCwdAliases());
    const ids = (xs: readonly { id: string }[]): string => xs.map((x) => x.id).sort().join(",");
    const taxonomyPath = join(groupsDir, "taxonomy.json");
    const assignmentsPath = join(groupsDir, "assignments.json");
    const sig = [scanVersion, ids(agents), ids(islands), JSON.stringify([...worktreeIslands]), await mtime(taxonomyPath), await mtime(assignmentsPath), link.version].join("|");
    if (index && sig === signature) return index;
    const [taxonomyRaw, assignmentsRaw] = await Promise.all([readJson(taxonomyPath), readJson(assignmentsPath)]);

    const notes = scanned.results.flatMap((r) => (r.result.ok ? [r.result.note] : []));
    const { needJev, ...next } = buildArchive({
      notes,
      files: scanned.files,
      skipped: scanned.results.length - notes.length,
      liveIds: new Set(agents.map((a) => a.id.toLowerCase())),
      islands: islands.map((i) => ({ id: i.id, name: i.name, path: i.path })),
      worktreeIslands,
      taxonomy: parseTaxonomy(taxonomyRaw),
      assignments: parseAssignments(assignmentsRaw),
      homeDir: home,
      notesDir: relative(vaultDir, notesDir) || basename(notesDir),
      vault: basename(vaultDir),
      jev: link.jev,
      now: now(),
    });
    link.archived = needJev;
    const changed = !index || JSON.stringify({ ...index.summary, generatedAt: "" }) !== JSON.stringify({ ...next.summary, generatedAt: "" });
    if (!changed && index) next.summary.generatedAt = index.summary.generatedAt; // clients refetch on a new generatedAt
    index = next;
    latestSessions = next.sessions;
    signature = sig;
    if (changed) ctx.emit({ kind: "summary", summary: next.summary } satisfies ArchiveMessage);
    return index;
  }

  function refresh(ctx: FeatureContext): Promise<ArchiveIndex | null> {
    if (running) return running;
    running = recompute(ctx)
      .catch((err: unknown) => {
        ctx.log.error("archive", "recompute failed", String(err));
        return index;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    id: "archive",
    archivedSessions() {
      return index?.sessions ?? [];
    },
    tickIntervalMs: TICK_MS,
    async onTick(ctx) {
      await refresh(ctx);
    },
    routes: [
      {
        method: "GET",
        path: "/api/archive",
        async handler(_req, res, ctx) {
          // Serve what we have; a rescan (every 10 min, a full vault read) runs in the background.
          const served = index ?? undefined;
          const pending = refresh(ctx);
          const idx = served ?? (await pending);
          if (!idx) return respondJson(res, 503, { ok: false, error: "archive not scanned yet" });
          respondJson(res, 200, idx);
        },
      },
    ],
    snapshotExtras(ctx): Record<string, unknown> {
      if (!index) {
        void refresh(ctx); // first snapshot after boot: fills in for the next one (and emits)
        return {};
      }
      return { "archive.summary": index.summary satisfies ArchiveSummary };
    },
  };
}

export const archiveFeature = createArchiveFeature();
