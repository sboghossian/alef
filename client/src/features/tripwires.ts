// "tripwires": a live session just repeated a lesson the fleet already wrote down (the server's
// deterministic rules, server/features/tripwires.ts). Two surfaces, both observe-only:
//   - the one Feed, as kind "tripwire" (other views read that kind from the Feed);
//   - the agent panel: a "⚠ repeats lesson: …" badge per lesson this session repeated.
// Hits arrive in the snapshot extras ("tripwires.hits") and as WS pushes. Snippets and district
// names are untrusted transcript text: rendered with textContent / the title property only.

import "./tripwires.css";
import { agentTitle } from "../../../shared/display";
import { parseTripwireHits, TRIPWIRES_HITS_KEY, type TripwireHit } from "../../../shared/features/tripwires";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { badgeText, hitsForAgent, hitToFeedItem, mergeHits } from "./tripwires-lib";

const SLOT = "fx-tripwires";
const MAX_BADGES = 3;

let hits: TripwireHit[] = [];

function renderAgentPanel(agentId: string, slot: HTMLElement): void {
  slot.replaceChildren();
  const mine = hitsForAgent(hits, agentId);
  if (mine.length === 0) return;
  for (const hit of mine.slice(0, MAX_BADGES)) {
    const badge = h("div", `tw-badge tw-${hit.severity}`, badgeText(hit));
    badge.title = `${hit.lesson}\nLearned from: ${hit.source}`;
    const cmd = h("code", "tw-snippet", hit.snippet);
    cmd.title = `${hit.tool}${hit.subagentId ? " (a subagent of this session)" : ""} at ${new Date(hit.at).toLocaleString()}`;
    slot.append(badge, cmd);
  }
  if (mine.length > MAX_BADGES) slot.append(h("div", "tw-more", `+${mine.length - MAX_BADGES} more lessons repeated`));
}

/** A snapshot carries the server's whole kept list (it replaces ours; a restarted server folds
 *  its hit log back in first); a WS push carries only new hits (merged in). */
function ingest(incoming: TripwireHit[], ctx: ClientContext, replace: boolean): void {
  hits = mergeHits(replace ? [] : hits, incoming);
  if (incoming.length) {
    ctx.feed.push(
      incoming.map((hit) => {
        const agent = ctx.store.agents.get(hit.sessionId);
        return hitToFeedItem(hit, (agent && agentTitle(agent)) || undefined);
      }),
    );
  }
  refreshAgentPanel(SLOT, renderAgentPanel);
}

export const tripwiresFeature: ClientFeature = {
  id: "tripwires",
  mount() {
    watchAgentPanel(SLOT, renderAgentPanel);
  },
  onSnapshot(world, ctx) {
    ingest(parseTripwireHits(world.extras?.[TRIPWIRES_HITS_KEY]), ctx, true);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p) || p.kind !== "hits") return;
    ingest(parseTripwireHits(p.hits), ctx, false);
  },
};
