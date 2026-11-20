// What would the Town square's global workspace show right now? GET-only: reads a running Alef
// server's /api/world and /api/feed, rebuilds the client's own sources from them with the shipped
// adapters (shell/feed.ts, features/workspace-lib.ts) and runs the shipped scorer. With --replay
// it also steps the last 2 h in 15 s ticks (the client's own cadence) and counts slot changes and
// re-entries, to check the hysteresis on real data.
//
//   npx tsx scripts/workspace-now.ts [--base http://localhost:5179] [--replay]

import type { ApprovalView } from "../shared/features/approvals";
import type { CompletenessCheck } from "../shared/features/completeness";
import type { FeedResponse } from "../shared/features/feed";
import { isPresidentBoard, type PresidentBoard } from "../shared/features/president";
import { isResidentState } from "../shared/features/resident";
import { parseRunEndings, parseSubagentList } from "../shared/features/subagents";
import { parseTripwireHits, TRIPWIRES_HITS_KEY } from "../shared/features/tripwires";
import type { VillageMessage } from "../shared/features/village";
import type { WorldAgent, WorldSnapshot } from "../shared/types";
import { approvalToFeed, awaitingToFeed, decisionToFeed, type FeedItem } from "../client/src/shell/feed";
import { fetchFeedWindow } from "../client/src/features/feed-bridge";
import { parseStranded } from "../client/src/features/talk";
import { hitToFeedItem } from "../client/src/features/tripwires-lib";
import {
  agentLookup,
  gatherCandidates,
  groupCandidates,
  salience,
  selectWorkspace,
  WORKSPACE,
  type HealthSummary,
  type WorkspaceIsland,
  type WorkspaceSlot,
  type WorkspaceSources,
} from "../client/src/features/workspace-lib";

const args = process.argv.slice(2);
const base = args.includes("--base") ? (args[args.indexOf("--base") + 1] ?? "") : "http://localhost:5179";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** `extras["completeness.summary"]` now carries the server's own `generatedAt` (`cache.at`,
 *  round 11 review fix) — prefer it, the same as the client (features/completeness.ts's
 *  `currentHealthSummary`); fall back to this reader's own clock only for an old payload from a
 *  server that predates the field, so this script's own "Health fresh" reading can't overstate
 *  what a live client actually shows. */
function parseHealthSummary(v: unknown): HealthSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.checks)) return null;
  return { generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : new Date().toISOString(), checks: o.checks as CompletenessCheck[] };
}

const world = await get<WorldSnapshot>("/api/world");
// Paged back over the 2 h window, the way the client's feed bridge loads it (one page of 500 is
// often under an hour of a busy fleet).
const feedRes = await fetchFeedWindow((path) => get<FeedResponse>(path), 0, Date.now() - WORKSPACE.windowMs);
if (!feedRes) throw new Error("GET /api/feed: no answer");
const extras = world.extras ?? {};
const agents = new Map(world.agents.map((a) => [a.id, a] as const));
const lookup = agentLookup(() => agents);
const who = (id: string): { title: string; city: string } | undefined => {
  const a = agents.get(id);
  return a ? { title: a.title, city: a.islandId } : undefined;
};

// The client Feed's items, rebuilt the way shell/feed-sources.ts builds them: Jev decisions,
// agents waiting now, open approvals, activity lines (from the server feed, same derivation), and
// the lesson tripwires the tripwires feature pushes (features/tripwires.ts).
const feed: FeedItem[] = [
  ...parseTripwireHits(extras[TRIPWIRES_HITS_KEY]).map((h) => hitToFeedItem(h, who(h.sessionId)?.title)),
  ...world.jev.decisions.map((d) => decisionToFeed(d)),
  ...world.agents.filter((a: WorldAgent) => a.awaitingInput).map((a) => awaitingToFeed(a, a.islandId)),
  ...(Array.isArray(extras["approvals.pending"]) ? (extras["approvals.pending"] as ApprovalView[]) : []).map((a) => approvalToFeed(a, who)),
  ...feedRes.items
    .filter((i) => i.kind === "activity")
    .map((i): FeedItem => ({ id: `act:${i.id}`, kind: i.tag === "reason" || i.tag === "plan" ? "caption" : "activity", at: Date.parse(i.at), title: i.title, agentId: i.agentId ?? undefined })),
];
const resident = isResidentState(extras["resident.state"]) ? extras["resident.state"] : null;
const islands: WorkspaceIsland[] = world.islands.map((i) => ({ id: i.id, path: i.path }));
const stranded = parseStranded(extras["talk.stranded"]);
const health = parseHealthSummary(extras["completeness.summary"]);
const presidentBoardRaw = extras["president.board"];
const presidentBoard: PresidentBoard | null = isPresidentBoard(presidentBoardRaw) ? presidentBoardRaw : null;
const sources: WorkspaceSources = {
  feed,
  messages: Array.isArray(extras["village.messages"]) ? (extras["village.messages"] as VillageMessage[]) : [],
  subagents: parseSubagentList(extras["subagents.recent"]),
  runEndings: parseRunEndings(extras["subagents.runs"]),
  resident,
  serverFeed: feedRes.items.filter((i) => i.kind === "routine"),
  stranded,
  islands,
  health,
  presidentBoard,
};

const now = Date.now();
const { observed, candidates } = gatherCandidates(sources, lookup, now);
const res = selectWorkspace(candidates, {}, now, observed);
const byUrgency = new Map<string, number>();
for (const c of candidates) byUrgency.set(c.urgency, (byUrgency.get(c.urgency) ?? 0) + 1);

const oldestFeedAt = feedRes.items[0]?.at;
console.log(
  `Sources: ${feed.length} feed items, ${sources.messages.length} messages, ${sources.subagents.length} subagent records, ${sources.serverFeed.length} routine runs, resident ${resident ? "on" : "off"}, ${stranded.length} stranded launches, health ${health ? `${health.checks.filter((c) => c.state === "fail").length} fail / ${health.checks.filter((c) => c.state === "warn").length} warn` : "n/a"}, ${presidentBoard?.proposals.length ?? 0} Jev proposals`,
);
console.log(`Server feed history: ${feedRes.items.length} items, oldest ${oldestFeedAt ? `${Math.round((Date.now() - Date.parse(oldestFeedAt)) / 60_000)} min ago` : "none"} (the 2 h window is ${oldestFeedAt && Date.parse(oldestFeedAt) <= Date.now() - WORKSPACE.windowMs ? "covered" : "NOT fully covered: the server ring doesn't reach that far"})`);
console.log(`Candidates: ${observed} observed → ${candidates.length} in the last 2 h (${[...byUrgency].map(([k, n]) => `${k} ${n}`).join(", ")})`);
console.log(`Groups: ${res.counts.groups} after merging near-identical ones (${res.counts.contenders} urgent or broad enough to ever clear the bar) → ${res.counts.shown} shown, ${res.counts.belowThreshold} under the bar (${WORKSPACE.enter}), ${res.counts.crowdedOut} crowded out\n`);
console.log("TOP 5 right now:");
res.top.forEach((e, i) => console.log(`  ${i + 1}. [${e.urgency}] ${e.text}\n     ${e.reason}`));
if (!res.top.length) console.log("  (empty: nothing clears the bar)");

console.log("\nNext 8 under the bar:");
const shown = new Set(res.top.map((e) => e.key));
groupCandidates(candidates)
  .map((g) => ({ g, s: salience(g, now) }))
  .filter((x) => !shown.has(x.g.key))
  .sort((a, b) => b.s.score - a.s.score)
  .slice(0, 8)
  .forEach(({ g, s }) =>
    console.log(`  ${s.score.toFixed(1).padStart(5)}  [${s.urgency}] ${s.lead.text.slice(0, 90)}  (×${s.weight} · rec ${s.recency.toFixed(2)} · nov ${s.novelty.toFixed(2)} · br ${s.breadth.toFixed(2)} · ${g.members.length} items, ${s.occurrences} occ)`),
  );

if (args.includes("--replay")) {
  // Step the last 2 h in 15 s ticks, only showing each candidate from its own time on.
  const all = gatherCandidates(sources, lookup, now).candidates;
  let slot: WorkspaceSlot = {};
  let last = res;
  let changes = 0;
  let reentries = 0;
  const leftAt = new Map<string, number>();
  const everIn = new Set<string>();
  for (let t = now - WORKSPACE.windowMs; t <= now; t += 15_000) {
    const r = selectWorkspace(
      all.filter((c) => c.at <= t),
      slot,
      t,
    );
    for (const k of Object.keys(r.slot)) {
      if (!(k in slot)) {
        changes++;
        const left = leftAt.get(k);
        if (left !== undefined) {
          reentries++;
          const g = r.top.find((e) => e.key === k);
          console.log(`  re-entry after ${Math.round((t - left) / 60_000)} min out: ${g?.text.slice(0, 70)} (${g?.reason})`);
        }
        everIn.add(k);
      }
    }
    for (const k of Object.keys(slot)) {
      if (!(k in r.slot)) {
        changes++;
        leftAt.set(k, t);
      }
    }
    slot = r.slot;
    last = r;
  }
  console.log("\nTOP 5 with hysteresis (what a client open for the last 2 h shows now):");
  last.top.forEach((e, i) => console.log(`  ${i + 1}. [${e.urgency}] ${e.text}\n     ${e.reason}`));
  console.log(`\nReplay (2 h, 15 s ticks = ${Math.round(WORKSPACE.windowMs / 15_000)} runs): ${everIn.size} groups ever entered, ${changes} enter/leave events, ${reentries} re-entries after leaving.`);
}
