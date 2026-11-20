// Reads the graph feed the vault builds for itself and turns it into VaultNote values.
//
// Source: <vault>/60-Meta/graph-feed/manifest.json plus shard-00..NN.tsv, rebuilt hourly by the
// vault's own build_graph_feed.py (throttled to 55 minutes). READ-ONLY: nothing here writes to the
// vault. One tab-separated row per note, 13 fields, in the order the builder's docblock pins:
//
//   id  path  kind  type  date  project  umbrella  tags  links  ghost  mentions  minutes  up
//
// `up` is "id:rule", the note one step up toward Home (brain_climb.py). Older feeds stop at 12.
//
// Cost: ~32,000 rows across 16 shards, about 6.8 MB. Parsed once at boot and then only when a
// shard's mtime or size changes, so the hourly rebuild costs one re-read of the shards it touched
// (the builder rewrites whole shards, and a new note lands in exactly one of them).
//
// The vault lives under ~/Documents, which iCloud may evict: a read of an evicted file can hang.
// readFeed therefore never blocks a request — the feature serves the last parse and refreshes in
// the background, the way the archive feature does.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VaultMeta, VaultNote } from "../../shared/features/vault.js";
import { vaultRoot } from "../config.js";

/** Whole days since the Unix epoch, UTC. */
const DAY_MS = 86_400_000;

export interface VaultFeedOptions {
  /** Defaults to $ALEF_VAULT_DIR, else ~/Documents/Code/alex_claude. */
  vaultDir?: string;
  /** Defaults to 60-Meta/graph-feed. */
  feedSubdir?: string;
  now?: () => number;
}

export interface VaultFeed {
  notes: readonly VaultNote[];
  meta: VaultMeta;
}

interface ManifestShard {
  name: string;
  nodes: number;
}

interface Manifest {
  generated: string;
  notes: number;
  links: number;
  tags: number;
  shards: readonly ManifestShard[];
}

export function vaultFeedDir(opts: VaultFeedOptions = {}, home = homedir()): string {
  const vaultDir = opts.vaultDir ?? vaultRoot(home);
  return join(vaultDir, opts.feedSubdir ?? join("60-Meta", "graph-feed"));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The manifest is data written by another process: read it defensively, never trust its shape. */
export function parseManifest(raw: string): Manifest | null {
  let v: unknown;
  try {
    v = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const stats = typeof o.stats === "object" && o.stats !== null ? (o.stats as Record<string, unknown>) : {};
  const shardsRaw = Array.isArray(o.shards) ? o.shards : [];
  const shards: ManifestShard[] = [];
  for (const s of shardsRaw) {
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    if (typeof so.name !== "string" || !so.name) continue;
    // Shard names come from a file we do not control: keep them to a bare basename so a crafted
    // manifest can never walk us out of the feed directory.
    if (so.name.includes("/") || so.name.includes("\\") || so.name.includes("..")) continue;
    shards.push({ name: so.name, nodes: num(so.nodes) ?? 0 });
  }
  if (shards.length === 0) return null;
  return {
    generated: typeof o.generated === "string" ? o.generated : "",
    notes: num(stats.notes) ?? 0,
    links: num(stats.links) ?? 0,
    tags: num(stats.tags) ?? 0,
    shards,
  };
}

/** "YYYY-MM-DD" (optionally "…THH") -> [day index, hour]. Anything else -> [null, null]. */
export function parseDate(field: string): [number | null, number | null] {
  if (field.length < 10) return [null, null];
  const ymd = field.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return [null, null];
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return [null, null];
  const day = Math.floor(ms / DAY_MS);
  // The builder appends the local hour as "THH" when the frontmatter date carried a time.
  let hour: number | null = null;
  if (field.length >= 13 && field[10] === "T") {
    const h = Number.parseInt(field.slice(11, 13), 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) hour = h;
  }
  return [day, hour];
}

function splitList(field: string): readonly string[] {
  if (!field) return [];
  const out: string[] = [];
  for (const part of field.split(",")) {
    const t = part.trim();
    if (t) out.push(t);
  }
  return out;
}

/** "total;last-date;week:count,week:count" -> the weekly map plus the last-mention day. */
export function parseMentions(field: string): Pick<VaultNote, "mentionWeeks" | "mentionLast"> {
  if (!field) return { mentionWeeks: null, mentionLast: null };
  const parts = field.split(";");
  const lastRaw = parts[1] ?? "";
  const weeksRaw = parts[2] ?? "";
  const [lastDay] = parseDate(lastRaw);
  const weeks = new Map<number, number>();
  for (const pair of splitList(weeksRaw)) {
    const colon = pair.indexOf(":");
    if (colon <= 0) continue;
    const week = Number.parseInt(pair.slice(0, colon), 10);
    const count = Number.parseInt(pair.slice(colon + 1), 10);
    if (!Number.isInteger(week) || !Number.isInteger(count) || count <= 0) continue;
    weeks.set(week, (weeks.get(week) ?? 0) + count);
  }
  // A mentions field with no parsable weeks still means "this is an entity note", so the map stays
  // non-null and empty rather than collapsing back to "not an entity".
  return { mentionWeeks: weeks, mentionLast: lastDay };
}

/** "id:rule" -> the step up. Empty or malformed -> none. */
export function parseUp(field: string): Pick<VaultNote, "up" | "upRule"> {
  const colon = field.indexOf(":");
  if (colon <= 0) return { up: null, upRule: "" };
  return { up: field.slice(0, colon), upRule: field.slice(colon + 1) };
}

/** One TSV row -> a note, or null when the row is short or has no id/path. */
export function parseRow(line: string): VaultNote | null {
  if (!line) return null;
  const f = line.split("\t");
  const id = f[0] ?? "";
  const path = f[1] ?? "";
  if (!id || !path) return null;
  const [day, hour] = parseDate(f[4] ?? "");
  const minutesRaw = Number.parseInt(f[11] ?? "", 10);
  return {
    id,
    path,
    kind: (f[2] ?? "n") === "a" ? "a" : "n",
    type: f[3] ?? "",
    day,
    hour,
    project: f[5] ?? "",
    umbrella: f[6] ?? "",
    tags: splitList(f[7] ?? ""),
    links: splitList(f[8] ?? ""),
    ghosts: splitList(f[9] ?? ""),
    minutes: Number.isInteger(minutesRaw) && minutesRaw > 0 ? minutesRaw : null,
    ...parseMentions(f[10] ?? ""),
    ...parseUp(f[12] ?? ""),
  };
}

export function parseShard(text: string): VaultNote[] {
  const out: VaultNote[] = [];
  for (const line of text.split("\n")) {
    const note = parseRow(line);
    if (note) out.push(note);
  }
  return out;
}

interface ShardCache {
  mtimeMs: number;
  size: number;
  notes: readonly VaultNote[];
}

/** Keeps the parsed feed warm and re-reads only the shards whose file actually changed. */
export class VaultFeedReader {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly shards = new Map<string, ShardCache>();
  private feed: VaultFeed | null = null;
  /** The manifest's generated/stats plus every parsed shard's name, mtime and size behind `feed`. */
  private signature = "";
  private inFlight: Promise<VaultFeed | null> | null = null;

  constructor(opts: VaultFeedOptions = {}) {
    this.dir = vaultFeedDir(opts);
    this.now = opts.now ?? Date.now;
  }

  /** The last parse, or null when nothing has been read yet. Never does I/O. */
  current(): VaultFeed | null {
    return this.feed;
  }

  /** Re-reads what changed. Concurrent callers share one pass. When the manifest and every shard
   *  are as they were, resolves to the very same feed object (parsedAt included), so callers can
   *  memoise on its identity. */
  refresh(): Promise<VaultFeed | null> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(): Promise<VaultFeed | null> {
    let manifest: Manifest | null;
    try {
      manifest = parseManifest(await readFile(join(this.dir, "manifest.json"), "utf8"));
    } catch {
      return this.feed; // the feed is not there (or not readable): keep serving what we had
    }
    if (!manifest) return this.feed;

    const notes: VaultNote[] = [];
    const seen = new Set<string>();
    const sig: string[] = [manifest.generated, String(manifest.notes), String(manifest.links), String(manifest.tags)];
    for (const shard of manifest.shards) {
      const path = join(this.dir, shard.name);
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await stat(path);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue; // the manifest names a shard that is not on disk: skip it, keep the rest
      }
      const cached = this.shards.get(shard.name);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        notes.push(...cached.notes);
        seen.add(shard.name);
        sig.push(`${shard.name}:${mtimeMs}:${size}`);
        continue;
      }
      let parsed: readonly VaultNote[];
      try {
        parsed = parseShard(await readFile(path, "utf8"));
      } catch {
        if (cached) {
          notes.push(...cached.notes);
          sig.push(`${shard.name}:${cached.mtimeMs}:${cached.size}`); // what was served, so a later good read counts as a change
        }
        seen.add(shard.name);
        continue;
      }
      this.shards.set(shard.name, { mtimeMs, size, notes: parsed });
      notes.push(...parsed);
      seen.add(shard.name);
      sig.push(`${shard.name}:${mtimeMs}:${size}`);
    }
    // Drop caches for shards the manifest no longer lists, so a reshard does not leak memory.
    for (const name of [...this.shards.keys()]) if (!seen.has(name)) this.shards.delete(name);

    const signature = sig.join("|");
    if (this.feed && signature === this.signature) return this.feed;
    this.signature = signature;
    this.feed = {
      notes,
      meta: {
        generatedAt: manifest.generated,
        parsedAt: new Date(this.now()).toISOString(),
        notes: manifest.notes,
        links: manifest.links,
        tags: manifest.tags,
        shards: manifest.shards.length,
        ready: true,
      },
    };
    return this.feed;
  }
}

export const EMPTY_META: VaultMeta = {
  generatedAt: "",
  parsedAt: "",
  notes: 0,
  links: 0,
  tags: 0,
  shards: 0,
  ready: false,
};
