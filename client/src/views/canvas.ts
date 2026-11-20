// 🕸️ Canvas: the orchestration graph in lanes (features/canvas). The feature owns the graph;
// this view opens it inside the main area and mirrors its filters in the left sidebar.

import { canvasFilter, canvasSolo, canvasSoloId, canvasSoloSelected, restoreSolo, canvasFilterState, mountCanvasLegendSection, mountCanvasViewSection, setCanvasOpen } from "../features/canvas";
import type { AlefView, FilterState, ViewContext } from "../shell/views";

let ctx: ViewContext | null = null;

/** The sidebar's filter state as the feature actually has it ("solo" = the One session toggle). */
function actualState(): FilterState {
  const f = canvasFilterState();
  return { scope: [f.scope], narrow: [...(f.city ? ["city"] : []), ...(canvasSoloId() ? ["solo"] : [])] };
}

export const canvasView: AlefView = {
  id: "canvas",
  emoji: "🕸️",
  name: "Canvas",
  hint: "The orchestration graph in lanes: prompt → hook → plan → tools → subagents → files",
  keys: ["v"],
  mount(_root, c) {
    ctx = c;
    setCanvasOpen(c, true);
    restoreSolo(c, c.route().param);
    c.setFilterState(actualState()); // before the shell replays the stored filters into onFilter
  },
  onParam(param) {
    if (!ctx) return;
    canvasSolo(ctx, param, { route: false });
    ctx.setFilterState(actualState()); // the toggle above the canvas and the sidebar chip agree
  },
  unmount() {
    if (ctx) setCanvasOpen(ctx, false);
    ctx = null;
  },
  filters() {
    const f = canvasFilterState();
    return [
      {
        id: "scope",
        label: "Time",
        type: "segmented",
        default: [f.scope],
        options: [
          { value: "today", label: "Live + today" },
          { value: "all", label: "All time" },
        ],
      },
      {
        id: "narrow",
        label: "Narrow the canvas",
        type: "chips",
        multi: true,
        default: [...(actualState().narrow ?? [])],
        options: [
          { value: "city", label: "Selected session's city", hint: "Every session of the selected session's city" },
          { value: "solo", label: "One session", hint: "Solo: only the selected session's footprint (same as the toggle above the canvas; Esc returns)" },
        ],
      },
      {
        id: "view",
        label: "View",
        type: "section",
        render(host) {
          mountCanvasViewSection(host);
        },
      },
      {
        id: "legend",
        label: "Legend",
        type: "section",
        collapsed: true,
        render(host) {
          mountCanvasLegendSection(host);
        },
      },
    ];
  },
  onFilter(state) {
    const c = ctx;
    if (!c) return;
    const cur = canvasFilterState();
    const scope = state.scope?.[0] === "all" ? "all" : "today";
    const city = state.narrow?.includes("city") ?? false;
    const one = state.narrow?.includes("solo") ?? false;
    if (scope !== cur.scope) canvasFilter(c, { scope });
    if (one !== (canvasSoloId() !== null)) {
      if (one) canvasSoloSelected(c);
      else canvasSolo(c, null);
    }
    if (city !== cur.city) canvasFilter(c, { city });
    // The feature may refuse a narrow (nothing selected) and solo clears the city: mirror what it did.
    const after = actualState();
    if (String(after.narrow) !== String(state.narrow ?? [])) c.setFilterState({ ...state, narrow: after.narrow ?? [] });
  },
};
