// Pure display logic for the "census" feature. Kept separate from census.ts (DOM glue) so the
// formatting is unit-testable without a document. (A new merge's Feed item is the server's now:
// server/features/governance-lib.ts mergeNews.)

import type { ArchiveSummary } from "../../../shared/features/archive";
import type { CensusGenerations } from "../../../shared/features/census";
import type { VisionClaim, VisionStatus } from "../../../shared/features/vision";

// ---------------------------------------------------------------- sessions ever

export type SessionsTotal = { known: true; total: number; indexed: number; fossils: number } | { known: false };

/** agents.length (live/indexed sessions) + the archive feature's own fossil count — computed
 *  fresh from each WorldSnapshot, never cached across snapshots. `known: false` (never a
 *  fabricated 0) until the archive summary has landed at least once. */
export function computeSessionsTotal(agentsCount: number, archiveSummary: ArchiveSummary | null): SessionsTotal {
  if (!archiveSummary) return { known: false };
  return { known: true, total: agentsCount + archiveSummary.total, indexed: agentsCount, fossils: archiveSummary.total };
}

// ---------------------------------------------------------------- generations

/** Irregular singular/plural pairs — "children"/"child" doesn't follow the regular +s rule. */
const DEPTH_LABELS: ReadonlyArray<{ one: string; many: string }> = [
  { one: "child", many: "children" },
  { one: "grandchild", many: "grandchildren" },
  { one: "great-grandchild", many: "great-grandchildren" },
];

function depthLabel(depth: number, n: number): string {
  const entry = DEPTH_LABELS[depth - 1];
  if (entry) return n === 1 ? entry.one : entry.many;
  return `depth-${depth} descendant${n === 1 ? "" : "s"}`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** "109 sessions" -> "1,071 children" -> "35 grandchildren" -> … in depth order, one entry per
 *  depth that actually occurs in `byDepth` (never invents a depth with 0 records). Empty when
 *  there are no records yet (`gen.total === 0`). */
export function generationChain(gen: CensusGenerations): string[] {
  if (gen.total === 0) return [];
  const chain = [plural(gen.parents, "session")];
  const depths = Object.keys(gen.byDepth)
    .map(Number)
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  for (const d of depths) {
    const n = gen.byDepth[d] ?? 0;
    chain.push(`${n.toLocaleString()} ${depthLabel(d, n)}`);
  }
  return chain;
}

// ---------------------------------------------------------------- merged PRs: links

/** Built from the PR number alone — never from any text the PR carries. */
export function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

// ---------------------------------------------------------------- vision ledger

/** How a ledger row says where its status comes from: "audited <date>" for an audited status,
 *  "probe ✓ <time>" when a probe re-checked it just now (✗ when the probe lowered it). */
export function visionLabel(c: VisionClaim, time: (iso: string) => string): string {
  const r = c.probeResult;
  if (!r || r.state === "pending") return r ? `audited ${c.auditedAt} · probe pending` : `audited ${c.auditedAt}`;
  if (r.state === "pass") return `probe ✓ ${time(r.at)}`;
  return `probe ✗ ${time(r.at)}: audited ${c.status}, now ${c.effective}`;
}

export type VisionGroups = Record<VisionStatus, VisionClaim[]>;

/** Rows grouped by the status that counts, in the truth table's order within each group. */
export function visionGroups(claims: readonly VisionClaim[]): VisionGroups {
  const out: VisionGroups = { real: [], partial: [], missing: [], metaphor: [] };
  for (const c of [...claims].sort((a, b) => a.n - b.n)) out[c.effective].push(c);
  return out;
}

/** "75.0% · strict 55.3%", or the honest "not scored" when nothing counts (never a bare 0%). */
export function visionHeadline(pct: number | null, strictPct: number | null): string {
  if (pct === null || strictPct === null) return "Not scored: no claim counts yet.";
  return `${pct.toFixed(1)}% runs today · strict ${strictPct.toFixed(1)}%`;
}
