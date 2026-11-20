// "wake-recall": the Institute of Truth (the town's second brain: vault, memory files, recall
// index) and which sessions really read from it the moment they woke up. Read-only: it never
// writes a file, and it never touches ~/.claude, the vault or the memory dir beyond reading.
//
// Two sources, never both for the same session (so nothing is counted twice):
//   - COLD: every main transcript on disk when this feature first ran ("boot-known") has its first
//     256 KB read on the tick (a per-tick byte budget, cached by path + size; a file already past
//     256 KB is never read again, a smaller one is re-read whole when it grows);
//   - LIVE: a session first seen after that gets the indexer's raw new lines (onIndexPass), folded
//     while they end inside the same 256 KB. A boot-known session's index lines are ignored.
// wake-recall-lib.ts does the parsing; note CONTENTS are never kept, only vault-relative paths.
//
// NO REPLAY STORM: exactly one AgentActivity (stage "brain") is broadcast per NEW session that
// really got notes, when its wake lands; never for history (boot-known sessions), never twice,
// never for a session that got nothing, never for a wake stamped more than 10 min before boot.
//
//   GET /api/wake-recall                     → WakeRecallResponse
//   GET /api/wake-recall/session/:sessionId  → WakeRecallSessionResponse
//   WS  feature "wake-recall"                → WakeRecallMessage (changed entries, after the cold pass)
//   snapshot extras "wake-recall.summary"    → WakeRecallSummary

import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AgentActivity } from "../../shared/types.js";
import {
  WAKE_HEAD_BYTES,
  WAKE_RECALL_SUMMARY_KEY,
  type WakeRecallEntry,
  type WakeRecallMessage,
  type WakeRecallResponse,
  type WakeRecallSessionResponse,
  type WakeRecallSummary,
} from "../../shared/features/wake-recall.js";
import { respondJson } from "../http.js";
import type { FeatureContext, ServerFeature } from "./registry.js";
import { listSessionFiles } from "./subagents/scan.js";
import { foldIndexLines, newWakeRecord, recordFromHead, sameEntry, toEntry, wakeSummary, wakeTotals, type VaultRoots, type WakeRecord } from "./wake-recall-lib.js";
import { vaultRoot as defaultVaultRoot } from "../config.js";

/** Cold-read bytes per tick: ~210 transcripts × 256 KB is ~54 MB, so the first pass takes 2 ticks. */
export const WAKE_BUDGET_BYTES = 32 * 1024 * 1024;
/** A wake stamped this long before boot is history, even in a file first seen after boot. */
const REPLAY_GUARD_MS = 10 * 60_000;
/** At most this many wake activities per index pass (a burst of real new sessions is still bounded). */
const ANNOUNCE_CAP = 20;
/** Entries per WS message; GET /api/wake-recall is complete. */
const EMIT_CAP = 100;
const VAULT_COUNT_TTL_MS = 10 * 60_000;
/** Directory entries visited while counting vault notes (31k .md files today). */
const VAULT_WALK_CAP = 400_000;
/** Main transcripts are <uuid>.jsonl (listSessionFiles' rule); the indexer passes any top-level .jsonl. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The running feature's summary as of its last tick (the vision ledger's wake-recall probe), or
 *  null before the first tick. */
let latestSummary: WakeRecallSummary | null = null;
export function latestWakeRecallSummary(): WakeRecallSummary | null {
  return latestSummary;
}

export interface WakeRecallFeatureOptions {
  home?: string;
  vaultRoot?: string;
  /** ~/.claude/projects/<home with / → ->/memory (a symlink into the vault on this Mac). */
  memoryDir?: string;
  now?: () => number;
  tickIntervalMs?: number;
  budgetBytes?: number;
}

interface FileState {
  path: string;
  size: number;
}

function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** .md files under `root`, skipping dot-folders and node_modules; symlinks are not followed. */
export async function countVaultNotes(root: string, cap = VAULT_WALK_CAP): Promise<number | null> {
  let notes = 0;
  let visited = 0;
  const stack = [root];
  let first = true;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      if (first) return null; // the vault itself is unreadable: no data, never 0
      continue;
    }
    first = false;
    for (const e of entries) {
      if (++visited > cap) return notes;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) notes += 1;
    }
  }
  return notes;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function createWakeRecallFeature(opts: WakeRecallFeatureOptions = {}): ServerFeature {
  const home = opts.home ?? homedir();
  const vaultRoot = opts.vaultRoot ?? defaultVaultRoot(home);
  const memoryDir = opts.memoryDir ?? join(home, ".claude", "projects", home.replace(/[\\/]/g, "-"), "memory");
  const now = opts.now ?? Date.now;
  const budget = opts.budgetBytes ?? WAKE_BUDGET_BYTES;

  const records = new Map<string, WakeRecord>();
  const files = new Map<string, FileState>(); // cold cache: sessionId → what its record was read from
  const served = new Map<string, WakeRecallEntry>(); // last entry each session was served/pushed as
  const announced = new Set<string>();
  /** Boot-known transcripts whose head couldn't be read (they don't hold the cold pass back). */
  const unreadable = new Set<string>();
  let bootKnown: Set<string> | null = null;
  let lastListing = new Set<string>();
  let bootAt = 0;
  let booting: Promise<void> | null = null;
  let roots: VaultRoots = { home, vaultRoot, aliases: [] };
  let ready = false;
  let vaultNotes: number | null = null;
  let vaultCountedAt = -Infinity;

  /** First call: the boot listing (who is history) and the vault roots. Everything awaits it. */
  function ensureBooted(ctx: FeatureContext): Promise<void> {
    booting ??= (async () => {
      bootAt = now();
      const listed = await listSessionFiles(ctx.config.projectsDir);
      bootKnown = new Set(listed.map((f) => f.sessionId));
      lastListing = new Set(bootKnown);
      // The memory dir is a symlink into the vault on this Mac: its notes are vault notes too.
      let to = "memory";
      try {
        const [realVault, realMemory] = await Promise.all([realpath(vaultRoot), realpath(memoryDir)]);
        const rel = relative(realVault, realMemory);
        if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) to = rel.split(sep).join("/");
      } catch {
        // no memory dir (or no vault): its paths keep the "memory/" label
      }
      roots = { home, vaultRoot, aliases: [{ from: memoryDir, to }] };
      ctx.log.info("wake-recall", `boot: ${bootKnown.size} transcript(s) on disk are history; their heads are read on the tick`);
    })();
    return booting;
  }

  function entries(): WakeRecallEntry[] {
    return [...records.values()].map(toEntry);
  }

  function summary(): WakeRecallSummary {
    return { ready, totals: wakeTotals(entries(), localMidnight(now())), vaultNotes };
  }

  /** Pushes entries whose served fields changed. Nothing is pushed before the cold pass is done
   *  (the clients read the whole state from GET / the snapshot); `force` pushes the summary alone. */
  function publish(ctx: FeatureContext, ids: Iterable<string>, force = false): void {
    if (!ready) return;
    const changed: WakeRecallEntry[] = [];
    for (const id of ids) {
      const rec = records.get(id);
      if (!rec) continue;
      const e = toEntry(rec);
      if (sameEntry(served.get(id), e)) continue;
      served.set(id, e);
      changed.push(e);
    }
    if (changed.length === 0 && !force) return;
    ctx.emit({ kind: "entries", entries: changed.slice(0, EMIT_CAP), summary: summary() } satisfies WakeRecallMessage);
  }

  async function refreshVault(nowMs: number): Promise<void> {
    if (nowMs - vaultCountedAt < VAULT_COUNT_TTL_MS) return;
    vaultCountedAt = nowMs;
    vaultNotes = await countVaultNotes(vaultRoot);
  }

  return {
    id: "wake-recall",
    tickIntervalMs: opts.tickIntervalMs ?? 15_000,
    routes: [
      {
        method: "GET",
        path: "/api/wake-recall",
        async handler(_req, res, ctx) {
          await ensureBooted(ctx);
          const list = entries().sort((a, b) => (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));
          respondJson(res, 200, { ok: true, headBytes: WAKE_HEAD_BYTES, bootAt: new Date(bootAt).toISOString(), ...summary(), sessions: list } satisfies WakeRecallResponse);
        },
      },
      {
        method: "GET",
        path: "/api/wake-recall/session/:sessionId",
        async handler(_req, res, ctx, params) {
          await ensureBooted(ctx);
          const rec = records.get(params.sessionId ?? "");
          respondJson(res, 200, { ok: true, ready, entry: rec ? toEntry(rec) : null } satisfies WakeRecallSessionResponse);
        },
      },
    ],
    async onIndexPass(ctx, newLinesBySession) {
      await ensureBooted(ctx);
      const known = bootKnown ?? new Set<string>();
      const touched: string[] = [];
      const wakes: AgentActivity[] = [];
      for (const [sessionId, lines] of newLinesBySession) {
        if (known.has(sessionId) || !SESSION_ID_RE.test(sessionId)) continue; // history (the cold pass owns it), or not a main transcript
        const rec = records.get(sessionId) ?? newWakeRecord(sessionId, true);
        records.set(sessionId, rec);
        foldIndexLines(rec, lines, roots);
        touched.push(sessionId);
        if (rec.notes.length === 0 || announced.has(sessionId)) continue;
        const at = Date.parse(rec.wokeAt ?? "");
        announced.add(sessionId); // decided once, whether or not it is broadcast
        if (!Number.isFinite(at) || at < bootAt - REPLAY_GUARD_MS || wakes.length >= ANNOUNCE_CAP) continue;
        wakes.push({
          id: `wake:${sessionId}`,
          agentId: sessionId,
          at: rec.wokeAt as string,
          stage: "brain",
          toolName: (rec.hook ?? "memory-recall").replace(/\.[a-z]+$/i, ""),
          targetObjectId: null,
          summary: wakeSummary(rec.notes.length),
        });
      }
      if (wakes.length > 0) {
        ctx.broadcast({ type: "activity", activities: wakes });
        ctx.log.info("wake-recall", `${wakes.length} new session(s) woke with vault notes`);
      }
      publish(ctx, touched);
    },
    async onTick(ctx) {
      await ensureBooted(ctx);
      const known = bootKnown ?? new Set<string>();
      const nowMs = now();
      const listed = await listSessionFiles(ctx.config.projectsDir);
      const onDisk = new Map(listed.map((f) => [f.sessionId, f.path]));
      // A transcript that was on disk and is gone now (pruned): its record goes too.
      const gone: string[] = [];
      for (const id of lastListing) if (!onDisk.has(id)) gone.push(id);
      for (const id of gone) {
        records.delete(id);
        files.delete(id);
        served.delete(id);
        unreadable.delete(id);
      }
      lastListing = new Set(onDisk.keys());

      // Cold pass over the boot-known heads: unread ones first, then small ones that grew.
      const todo: Array<{ id: string; path: string; size: number }> = [];
      let pendingFirstRead = 0;
      for (const id of known) {
        const path = onDisk.get(id);
        if (!path) continue;
        const cached = files.get(id);
        if (cached && cached.path === path && cached.size >= WAKE_HEAD_BYTES) continue; // head can't change
        let size: number;
        try {
          size = (await stat(path)).size;
        } catch {
          continue;
        }
        if (cached && cached.path === path && cached.size === size) continue;
        if (!cached) pendingFirstRead += 1;
        todo.push({ id, path, size });
      }
      todo.sort((a, b) => Number(files.has(a.id)) - Number(files.has(b.id)));
      let spent = 0;
      const touched: string[] = [];
      for (const t of todo) {
        const want = Math.min(t.size, WAKE_HEAD_BYTES);
        if (spent > 0 && spent + want > budget) break;
        let head: Buffer;
        try {
          head = await readHead(t.path, want);
        } catch {
          unreadable.add(t.id); // deleted or unreadable mid-scan: skip it, never the rest
          continue;
        }
        unreadable.delete(t.id);
        spent += head.length;
        records.set(t.id, recordFromHead(t.id, head, t.size, roots));
        files.set(t.id, { path: t.path, size: t.size });
        touched.push(t.id);
      }
      await refreshVault(nowMs);
      if (!ready && [...known].every((id) => !onDisk.has(id) || files.has(id) || unreadable.has(id))) {
        // The first reads are history, not news: they become the served baseline, never a push.
        for (const [id, rec] of records) served.set(id, toEntry(rec));
        ready = true;
        const s = summary();
        ctx.log.info(
          "wake-recall",
          `cold pass done: fed ${s.totals.fed} of ${s.totals.sessions} at wake · nothing ${s.totals.nothing} (${s.totals.headlessMisses} headless) · unread ${s.totals.unread} · pending ${s.totals.pending}`,
        );
        publish(ctx, [], true);
      } else publish(ctx, touched, gone.length > 0);
      if (pendingFirstRead > 0 && spent > 0) ctx.log.info("wake-recall", `read ${Math.round(spent / 1024)} KB of transcript heads this tick`);
      latestSummary = summary();
    },
    snapshotExtras() {
      return { [WAKE_RECALL_SUMMARY_KEY]: summary() };
    },
  };
}

export const wakeRecallFeature = createWakeRecallFeature();
