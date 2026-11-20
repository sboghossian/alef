import type { LayerReaders } from "../features/system.js";
import type { LayerSources } from "../features/system-layers.js";
import type { Settled } from "../features/system-lib.js";

const ok = <T,>(value: T): Settled<T> => ({ ok: true, value });

export function layerSources(over: Partial<LayerSources> = {}): LayerSources {
  return {
    conduct: ok({ cases: 12, claimLint: true, constitution: 4 }),
    runtimes: ok([{ name: "Claude Code", present: true, how: "claude on PATH" }, { name: "Cursor", present: false, how: "not found" }, { name: "ExampleVendor", present: null, how: "hosted" }]),
    fleet: ok([{ name: "agent-world", ageMs: 3_600_000 }]),
    jev: ok({ router: true, cardsToday: 43, cardsTotal: 179 }),
    skillMeta: ok([{ name: "linear", description: "Linear tickets", mtimeMs: 1 }, { name: "grill-me", description: "interview the user", mtimeMs: 3 }, { name: "zzz", description: "", mtimeMs: 2 }]),
    mcpMeta: ok({ hosted: ["claude.ai Gmail", "claude.ai Linear"], local: ["exa"], plugins: ["legal@kw"] }),
    memoryExtra: ok({ wikilinks: 2771, sessionsIndexed: 5281, codegraph: true, workflows: null, memoryToday: 3, inboxToday: 0 }),
    recall: ok({ chunks: 12345, mtimeMs: Date.parse("2026-10-14T11:00:00Z") }),
    ...over,
  };
}

/** Hermetic layer readers for feature tests (the defaults read the real home). */
export const LAYER_FAST: Partial<LayerReaders> = {
  conduct: async () => ({ cases: 12, claimLint: true, constitution: 4 }),
  runtimes: async () => [],
  fleet: async () => [],
  jev: async () => ({ router: true, cardsToday: 1, cardsTotal: 2 }),
  skillMeta: async () => [],
  mcpMeta: async () => ({ hosted: [], local: [], plugins: [] }),
  recall: async () => ({ chunks: 7, mtimeMs: 1 }),
  memoryExtra: async () => ({ wikilinks: 1, sessionsIndexed: 1, codegraph: false, workflows: null, memoryToday: 0, inboxToday: 0 }),
};
