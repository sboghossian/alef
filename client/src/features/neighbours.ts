// "neighbours": a read-only agent-panel section with who a session worked alongside and where it
// went, from signals the world already serves (the rules live in neighbours-lib.ts):
//   - "Worked alongside (shared files)": sessions that touched the same files;
//   - "Crew (same district, overlapping hours)": same island, overlapping first-to-last message
//     windows (GET /api/neighbours/windows on every snapshot, then pushes; server/features/
//     neighbours.ts; a session without one is never crew), and
//     a shared repo or file;
//   - "Trips": its `visited` edges (files it read or edited in another district's folder);
//   - "Messages with other sessions": village SendMessage traffic with both ends resolved.
// No buttons, no animation, no writes. A session with none of these gets no section at all.
//
// Bounded: the feature keeps its own edge map, one entry per (from, to, kind). Every WS "edges" push
// is the whole served set (server/index.ts broadcasts buildWorldViews().edges whenever it changed, its
// only "edges" broadcast; the store replaces its `edges` with it too), so each push REPLACES the
// map: an edge the server stopped serving leaves with it. The index is rebuilt only when that set
// changed and a panel reads it; the panel's DOM is rebuilt only when its rows changed.
// Titles, file names and previews are untrusted: rendered with textContent / the title property.

import "./neighbours.css";
import { agentTitle, displayIslandName } from "../../../shared/display";
import { NEIGHBOURS_WINDOWS_PATH } from "../../../shared/features/neighbours";
import type { WorldEdge } from "../../../shared/types";
import { log } from "../log";
import { redactOn } from "../redact";
import { h, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import { lateExtra, type LateExtra } from "./late-extra";
import { dropEdgesFrom, edgeMap, indexEdges, neighbourSections, sameEdges, validWindows, type ActiveWindow, type NeighbourIndex } from "./neighbours-lib";
import type { ClientContext, ClientFeature } from "./registry";
import { villageData } from "./village-data";

const SLOT = "fx-neighbours";

let edges = new Map<string, WorldEdge>();
let index: NeighbourIndex | null = null;
/** Session id → its first and last message, as the server last served them. */
let windows = new Map<string, ActiveWindow>();
let windowsLoad: LateExtra | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function currentIndex(ctx: ClientContext): NeighbourIndex {
  index ??= indexEdges(
    edges.values(),
    [...ctx.store.islands.values()].map((i) => i.path).filter(Boolean),
  );
  return index;
}

function refresh(ctx: ClientContext): void {
  refreshAgentPanel(SLOT, (id, slot) => render(id, slot, ctx));
}

/** Store listeners run inside the store's own dispatch: a throw here must not skip the others. */
function guarded(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn("neighbours", `${what} failed`, err);
  }
}

function render(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  const store = ctx.store;
  const sections = neighbourSections(agentId, {
    index: currentIndex(ctx),
    agents: store.agents,
    windows,
    messages: villageData.messages,
    titleOf: (id) => {
      const a = store.agents.get(id);
      return a ? agentTitle(a) : null;
    },
    islandName: (id) => {
      const island = store.islands.get(id);
      return island && id !== "harness" ? displayIslandName(island) : null;
    },
    redactPreviews: redactOn(),
  });
  const key = JSON.stringify(sections);
  if (slot.dataset.nbKey === key) return;
  slot.dataset.nbKey = key;
  slot.replaceChildren();
  for (const section of sections) {
    const list = h("ul", "file-list");
    for (const row of section.rows) {
      const li = h("li");
      li.title = row.hover;
      li.append(document.createTextNode(row.text), h("span", "nb-tag", row.tag));
      list.append(li);
    }
    slot.append(h("h3", undefined, section.heading), list);
  }
}

export const neighboursFeature: ClientFeature = {
  id: "neighbours",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => render(id, slot, ctx));
    ctx.store.onEdges((batch) =>
      guarded("edges push", () => {
        const next = edgeMap(batch);
        if (sameEdges(edges, next)) return;
        edges = next;
        index = null;
        refresh(ctx);
      }),
    );
    ctx.store.onAgentsRemoved((ids) =>
      guarded("agents removed", () => {
        if (!dropEdgesFrom(edges, ids)) return;
        index = null;
        refresh(ctx);
      }),
    );
    villageData.onChange(() => guarded("village messages", () => refresh(ctx)));
    windowsLoad = lateExtra(
      () => ctx.api.getJson<unknown>(NEIGHBOURS_WINDOWS_PATH),
      (body) =>
        guarded("windows load", () => {
          // Empty until the server's scan is done (it then pushes them all): no session is crew.
          windows = new Map(validWindows(isRecord(body) ? body.windows : null).map((w) => [w.id, { first: w.first, last: w.last }] as const));
          refresh(ctx);
        }),
    );
  },
  onSnapshot(world, ctx) {
    edges = edgeMap(world.edges);
    index = null;
    windowsLoad?.refresh();
    refresh(ctx);
  },
  onMessage(msg, ctx) {
    guarded("windows push", () => {
      const payload: unknown = msg.payload;
      if (!isRecord(payload) || payload.kind !== "windows") return;
      const fresh = validWindows(payload.windows);
      if (!fresh.length) return;
      const apply = (): void => {
        for (const w of fresh) windows.set(w.id, { first: w.first, last: w.last });
        refresh(ctx);
      };
      if (windowsLoad) windowsLoad.push("merge", apply);
      else apply();
    });
  },
};
