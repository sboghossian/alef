// The Brain tab bar: the "Alex's Brain" artifact's fifteen tabs, drawn across the top of both
// the 🧠 Brain view (which IS the artifact's Graph tab) and the 🗄️ Vault view (the other fourteen).
// One bar, two views, so the pair reads as ONE Brain destination (the top bar's Brain pill, which
// has no sub-pills) and every tab is one click away whether or not the left sidebar is open.
//
// Flat (UX-2): one row of tabs, the artifact's four groups only as hairline gaps between them (and
// as each group's accessible name), not as a third level of labels. Both views place it the same
// way (VIS-8): `mindFrame()` puts the bar in a full-width strip above the view's own body.
//
// DOM-light on purpose: `mindTabs()` builds the bar, `mindFrame()` the strip around it. The tab
// list is plain data (MIND_TABS) so it is unit-tested against Vault's section ids.

import "./mind-tabs.css";

export interface MindTab {
  /** "graph" is Brain; every other id is a Vault section (#/vault/<id>). */
  id: string;
  label: string;
  hint: string;
}

export interface MindTabGroup {
  name: string;
  tabs: readonly MindTab[];
}

/** The artifact's order and grouping: Map · Time · Mind · Care. */
export const MIND_TABS: readonly MindTabGroup[] = [
  {
    name: "Map",
    tabs: [
      { id: "graph", label: "Graph", hint: "What connects to what" },
      { id: "atlas", label: "Folders", hint: "Where your notes live: folders by size" },
      { id: "flows", label: "Flows", hint: "How areas link to each other" },
      { id: "constellation", label: "Constellation", hint: "Which projects are related" },
    ],
  },
  {
    name: "Time",
    tabs: [
      { id: "pulse", label: "Pulse", hint: "When the brain grows" },
      { id: "focus", label: "Focus", hint: "Where your attention went" },
      { id: "growth", label: "Growth", hint: "How fast it compounds" },
      { id: "meetings", label: "Meetings", hint: "How much of the week meetings take" },
    ],
  },
  {
    name: "Mind",
    tabs: [
      { id: "projects", label: "Projects", hint: "What you are working on" },
      { id: "topics", label: "Topics", hint: "What you think about, what is rising" },
      { id: "people", label: "People", hint: "Who is in your orbit, who is fading" },
      { id: "sources", label: "Sources", hint: "Where thinking happens" },
      { id: "hubs", label: "Hubs", hint: "Which notes hold everything together" },
    ],
  },
  {
    name: "Care",
    tabs: [
      { id: "echoes", label: "Echoes", hint: "What you forgot you knew" },
      { id: "gaps", label: "Gaps", hint: "Where the brain needs repair" },
    ],
  },
];

/** Where a tab lives: Graph is the Brain view, everything else a Vault section. */
export function mindTabRoute(id: string): { view: string; param: string | null } {
  return id === "graph" ? { view: "brain", param: null } : { view: "vault", param: id };
}

/** The bar, with `active` lit. `go` is the caller's navigation (ctx.showView). */
export function mindTabs(active: string, go: (view: string, param: string | null) => void, extraClass = ""): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = `mind-tabs${extraClass ? ` ${extraClass}` : ""}`;
  nav.setAttribute("aria-label", "Brain tabs");
  for (const g of MIND_TABS) {
    const group = document.createElement("div");
    // ch-seg: the one shared selected style (chrome.css) for the lit tab.
    group.className = "mind-tabs-group ch-seg";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", g.name);
    for (const t of g.tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mind-tab";
      b.dataset.tab = t.id;
      b.textContent = t.label;
      b.title = `${g.name} · ${t.hint}`;
      if (t.id === active) {
        b.classList.add("on");
        b.setAttribute("aria-current", "page");
      }
      b.addEventListener("click", () => {
        // The lit tab, not `active`: Vault builds this bar once and relights it as sections change.
        if (b.classList.contains("on")) return;
        const r = mindTabRoute(t.id);
        go(r.view, r.param);
      });
      group.append(b);
    }
    nav.append(group);
  }
  return nav;
}

/** The Brain destination's frame: the bar in a full-width strip, `body` filling the rest. Brain
 *  and Vault both mount this, so the bar sits at the same place in both (VIS-8). */
export function mindFrame(bar: HTMLElement, body: HTMLElement): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "mind-frame";
  const strip = document.createElement("div");
  strip.className = "mind-strip";
  strip.append(bar);
  frame.append(strip, body);
  return frame;
}

/** Light the tab for `active` on a bar built earlier, without rebuilding it. */
export function lightMindTab(nav: HTMLElement, active: string): void {
  for (const b of nav.querySelectorAll<HTMLButtonElement>(".mind-tab")) {
    const on = b.dataset.tab === active;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}
