// ⚡ Synapses: the vault's notes as neurons (weigh, add, decide). Read-only.
//
// The vault pipeline (alex-brain 60-Meta/scripts/brain_synapses.py `build --write`, every
// capture run) writes <vault>/60-Meta/.synapses.tsv: per note, its strongest synapses, weighted by
// link structure + co-activation (notes used in the same session), with a 120-day half-life and
// normalised so hubs speak quietly. Line: `id \t path \t nbrId:w,nbrId:w,…`.
//
// Two reads off it:
//   synapsesOf(path)   a note's strongest synapses ("Wired to" in the Brain note panel)
//   vaultFiring(…)     what is firing now: notes dated in the last few days fire, and the signal
//                      spreads one hop along synapses; a note fires past THRESHOLD.
//
// A missing cache is not an error: both return empty and the view simply shows nothing extra.
// Logs carry counts only.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VaultFiring, VaultFiringNote, VaultNote, VaultSynapse } from "../../shared/features/vault.js";

export const SYNAPSES_REL = join("60-Meta", ".synapses.tsv");

const THRESHOLD = 0.08;
const Z_SAT = 0.3;
const HALF_LIFE = 120;
const MACHINE = "10-Sessions/automations/";
const STRUCTURE = new Set(["_index", "_hub", "home", "readme"]);

export interface SynapseGraph {
  byId: Map<string, { path: string; nbrs: [string, number][] }>;
  byPath: Map<string, string>;
}

export function parseSynapses(text: string): SynapseGraph {
  const byId: SynapseGraph["byId"] = new Map();
  const byPath = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [id, path, list] = line.split("\t");
    if (!id || !path) continue;
    const nbrs: [string, number][] = [];
    for (const pair of (list ?? "").split(",")) {
      const k = pair.lastIndexOf(":");
      const w = Number(pair.slice(k + 1));
      if (k > 0 && Number.isFinite(w) && w > 0) nbrs.push([pair.slice(0, k), w]);
    }
    byId.set(id, { path, nbrs });
    byPath.set(path.toLowerCase(), id);
  }
  return { byId, byPath };
}

/** Index/hub notes, 60-Meta and machine-run sessions carry signal but never surface as "firing". */
export function hiddenFromFiring(path: string): boolean {
  const stem = (path.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
  return STRUCTURE.has(stem) || path.startsWith("60-Meta/") || path.startsWith(MACHINE);
}

/** A note's strongest synapses, strongest first. `path` is vault-relative, with or without ".md". */
export function synapsesOf(g: SynapseGraph, path: string, k = 12): VaultSynapse[] {
  const key = path.toLowerCase();
  const id = g.byPath.get(key) ?? g.byPath.get(`${key}.md`);
  if (!id) return [];
  const out: VaultSynapse[] = [];
  for (const [nid, w] of g.byId.get(id)?.nbrs ?? []) {
    const n = g.byId.get(nid);
    if (n && !hiddenFromFiring(n.path)) out.push({ path: n.path, w: Math.round(w * 1000) / 1000 });
  }
  return out.sort((a, b) => b.w - a.w).slice(0, k);
}

/** What is firing on `today`: notes dated within `days` fire with their recency, then one hop of
 *  spreading activation (z = Σ a·w, fire at THRESHOLD, a = min(1, z / Z_SAT) · 0.6). */
export function vaultFiring(g: SynapseGraph, notes: readonly VaultNote[], today: number, days = 2, cap = 200): VaultFiring {
  const seeds = new Map<string, number>();
  for (const n of notes) {
    if (n.kind !== "n" || n.day === null || n.path.startsWith(MACHINE)) continue;
    const age = today - n.day;
    if (age < 0 || age >= days) continue;
    const id = g.byPath.get(n.path.toLowerCase());
    if (id) seeds.set(id, 0.5 ** (age / HALF_LIFE));
  }
  const z = new Map<string, number>();
  const via = new Map<string, [number, string]>();
  for (const [i, a] of seeds) {
    for (const [j, w] of g.byId.get(i)?.nbrs ?? []) {
      if (seeds.has(j)) continue;
      const s = a * w;
      z.set(j, (z.get(j) ?? 0) + s);
      const best = via.get(j);
      if (!best || s > best[0]) via.set(j, [s, i]);
    }
  }
  const fired: VaultFiringNote[] = [];
  for (const [i, a] of seeds) {
    const n = g.byId.get(i);
    if (n && !hiddenFromFiring(n.path)) fired.push({ path: n.path, act: Math.round(a * 1000) / 1000, hop: 0, via: null });
  }
  for (const [j, v] of z) {
    if (v < THRESHOLD) continue;
    const n = g.byId.get(j);
    if (!n || hiddenFromFiring(n.path)) continue;
    const src = via.get(j);
    fired.push({
      path: n.path,
      act: Math.round(Math.min(1, v / Z_SAT) * 0.6 * 1000) / 1000,
      hop: 1,
      via: src ? (g.byId.get(src[1])?.path ?? null) : null,
    });
  }
  fired.sort((a, b) => a.hop - b.hop || b.act - a.act || (a.path < b.path ? -1 : 1));
  return { days, seeds: fired.filter((f) => f.hop === 0).length, notes: fired.slice(0, cap) };
}

/** Reads the cache, re-parsing only when its mtime moves. */
export class SynapseReader {
  private graph: SynapseGraph | null = null;
  private mtime = -1;
  constructor(private readonly file: string) {}

  async read(): Promise<SynapseGraph | null> {
    let m: number;
    try {
      m = (await stat(this.file)).mtimeMs;
    } catch {
      this.graph = null;
      this.mtime = -1;
      return null;
    }
    if (m !== this.mtime || !this.graph) {
      this.graph = parseSynapses(await readFile(this.file, "utf8"));
      this.mtime = m;
    }
    return this.graph;
  }
}
