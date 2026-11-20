// "webtrips" (client): every session's agent panel says how often it left the planet for the web,
// e.g. "🌐 12 web trips · 4 hosts" with the hosts it went to most, from GET
// /api/webtrips/session/:id. Sessions browse on their own; Alef sends only Jev out (the Ask Jev
// panel counts Jev's trips). Nothing is shown until the server has read every transcript of the
// session (a half-counted number would be too low). Hosts are untrusted transcript text:
// textContent only. Observe only: no buttons, no requests beyond the GET.

import "./webtrips.css";
import { isSessionWebTrips, TRIP_TOOLS, webTripsLine, type SessionWebTrips, type WebTripsSessionResponse } from "../../../shared/features/webtrips";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";

const SLOT = "fx-webtrips";
const REFETCH_MS = 60_000;

/** sessionId → its tally; null = the server knows no transcript for it. */
const entries = new Map<string, SessionWebTrips | null>();
const fetchedAt = new Map<string, number>();
const inFlight = new Set<string>();

function fetchEntry(ctx: ClientContext, agentId: string): void {
  const at = fetchedAt.get(agentId);
  if (inFlight.has(agentId) || (at !== undefined && Date.now() - at < REFETCH_MS)) return;
  inFlight.add(agentId);
  void ctx.api.getJson<WebTripsSessionResponse>(`/api/webtrips/session/${encodeURIComponent(agentId)}`, 8000).then((res) => {
    inFlight.delete(agentId);
    if (!isRecord(res) || res.ok !== true) return; // unreachable: try again on the next render
    fetchedAt.set(agentId, Date.now());
    if (res.ready !== true) return; // still reading its transcripts: say nothing yet
    entries.set(agentId, isSessionWebTrips(res.entry) ? res.entry : null);
    refreshAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
  });
}

/** "WebSearch 7 · WebFetch 3 · curl 2" in TRIP_TOOLS order. */
function toolsText(e: SessionWebTrips): string {
  return TRIP_TOOLS.flatMap((t) => (e.byTool[t] ? [`${t} ${e.byTool[t]}`] : [])).join(" · ");
}

function renderPanel(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  fetchEntry(ctx, agentId);
  const e = entries.get(agentId);
  if (!e) return; // loading, still counting, or no transcript: say nothing rather than guess
  const line = h("div", e.trips === 0 ? "wt-line wt-none" : "wt-line", `🌐 ${webTripsLine(e)}`);
  line.title = "Web trips this session (and its subagents) made on its own: WebSearch, WebFetch, exa, firecrawl, obscura and curl/wget, read from its transcripts. A call that was denied (a permission rule, a hook, you, the auto-mode classifier) never ran and is not counted. Alef itself only sends Jev out.";
  slot.append(line);
  if (e.trips === 0) return;
  const parts = [toolsText(e)];
  if (e.subagentTrips > 0) parts.push(`${e.subagentTrips} by its subagents`);
  slot.append(h("div", "wt-sub", parts.join(" · ")));
  if (e.topHosts.length > 0) slot.append(h("div", "wt-sub", `Most: ${e.topHosts.map((x) => `${x.host} (${x.trips})`).join(", ")}`));
}

export const webTripsFeature: ClientFeature = {
  id: "webtrips",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => renderPanel(id, slot, ctx));
  },
};
