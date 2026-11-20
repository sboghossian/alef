// Wire types for the "memory-layers" feature: the three memory buildings (episodic archive,
// semantic library, procedural workshop) that replaced the single memory library next to
// Harness City. Real counts only; a source that can't be read is `null` ("no data"), never 0.
//
//   GET /api/memory-layers/snapshot -> MemoryLayersSnapshotResult

/** Same buckets memory-claim-lint.py sorts a claim into (✅/📣/🧪/none), applied per memory file. */
export type ConfidenceMark = "verified" | "reported" | "hypothesis" | "unmarked";

export interface RecallIndexStats {
  present: boolean;
  sizeBytes: number | null;
  lastIndexedAt: string | null; // ISO
}

export interface EpisodicStats {
  /** ~/.claude/projects/**\/*.jsonl, top-level session transcripts. */
  transcriptFiles: number | null;
  /** Of the above, the ones under a "subagents" directory. */
  subagentTranscriptFiles: number | null;
  /** hermes-loop's FTS5 index (~/.gstack/memory/sessions.db). */
  recallIndex: RecallIndexStats;
}

export interface SemanticStats {
  /** Memory files, excluding MEMORY.md itself. */
  fileCount: number | null;
  confidence: Record<ConfidenceMark, number>;
  staleDays: number;
  /** Files whose `modified:` frontmatter (fallback: mtime) is older than staleDays. */
  staleCount: number;
}

export interface ProceduralStats {
  /** Distinct installed skills (user + plugin + project, deduped by slug). */
  skillCount: number | null;
  /** Skills with at least one "## Known failure modes (auto-logged)" entry (learning-loop.py). */
  patchedSkillCount: number;
  /** Total entries across every skill's "Known failure modes" section. */
  patchEntryCount: number;
}

export interface MemoryLayersSnapshot {
  episodic: EpisodicStats;
  semantic: SemanticStats;
  procedural: ProceduralStats;
  scannedAt: string; // ISO
}

export interface MemoryLayersSnapshotResult extends MemoryLayersSnapshot {
  ok: true;
}

export interface MemoryLayersError {
  ok: false;
  error: string;
}
