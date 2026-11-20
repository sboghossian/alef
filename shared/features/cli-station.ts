// Wire types for the "cli-station" feature: a small Harness building listing agent-authored
// CLIs from the ~/.claude/clis/<name>/cli.json registry (contract owned by the /cli-forge
// skill's _registry.py — field names are fixed, don't change them here without changing there).
//
//   GET /api/cli-station/snapshot -> CliStationSnapshotResult

export type CliAuthor = "agent" | "alex";

export interface CliEntry {
  name: string;
  tool: string;
  purpose: string;
  entry: string; // absolute path
  language: string;
  created: string; // YYYY-MM-DD
  author: CliAuthor;
  tests: string | null; // absolute path, or null
}

export interface CliStationSnapshot {
  /** Registry present but empty is `registryPresent: true, clis: []` (a real "none yet"),
   *  distinct from the dir not existing at all. */
  registryPresent: boolean;
  clis: CliEntry[];
  /** cli.json files that failed schema validation (skipped, not returned in `clis`). */
  invalidCount: number;
  scannedAt: string; // ISO
}

export interface CliStationSnapshotResult extends CliStationSnapshot {
  ok: true;
}

export interface CliStationError {
  ok: false;
  error: string;
}
