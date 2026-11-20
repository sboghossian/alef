// Crews ("shipped together"): 2+ DISTINCT sessions whose session-outcomes records name the same
// MERGED PR (owner/repo#n, GET /api/outcomes rows' mergedPrs). Alef's only "merge" signal: no
// transcript continues another session, and a subagent handing its result back is family, not a
// crew. Pure and shared, so the agent panel (client/src/features/family-lib.ts re-exports these)
// and the vision ledger's crews probe (server/features/vision.ts) count crews with one function.

import type { OutcomeMergedPr } from "./outcomes.js";

export interface SessionPrs {
  sessionId: string;
  mergedPrs: OutcomeMergedPr[];
}

export interface ShipCrew {
  repo: string;
  number: number;
  mergedAt: string | null;
  /** Distinct session ids, sorted; always 2 or more. */
  sessions: string[];
}

/** Every merged PR that 2+ distinct sessions name, newest merge first (undated last). */
export function shipCrews(rows: readonly SessionPrs[]): ShipCrew[] {
  const groups = new Map<string, { repo: string; number: number; mergedAt: string | null; sessions: Set<string> }>();
  for (const row of rows) {
    for (const pr of row.mergedPrs) {
      const key = `${pr.repo.toLowerCase()}#${pr.number}`;
      let g = groups.get(key);
      if (!g) {
        g = { repo: pr.repo.toLowerCase(), number: pr.number, mergedAt: null, sessions: new Set() };
        groups.set(key, g);
      }
      g.mergedAt ??= pr.mergedAt;
      g.sessions.add(row.sessionId);
    }
  }
  const crews: ShipCrew[] = [];
  for (const g of groups.values()) if (g.sessions.size >= 2) crews.push({ repo: g.repo, number: g.number, mergedAt: g.mergedAt, sessions: [...g.sessions].sort() });
  return crews.sort((a, b) => {
    if (a.mergedAt !== b.mergedAt) {
      if (a.mergedAt === null) return 1;
      if (b.mergedAt === null) return -1;
      return a.mergedAt > b.mergedAt ? -1 : 1;
    }
    return a.repo !== b.repo ? (a.repo < b.repo ? -1 : 1) : a.number - b.number;
  });
}

export interface CrewCounts {
  crews: number;
  /** Distinct sessions in at least one crew. */
  sessions: number;
}

export function crewCounts(crews: readonly ShipCrew[]): CrewCounts {
  return { crews: crews.length, sessions: new Set(crews.flatMap((c) => c.sessions)).size };
}
