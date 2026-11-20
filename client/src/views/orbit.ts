// 🌍 Orbit: the planet (the hub renders it; this view owns the left-sidebar sections).
// Sections: Theme (T's orbitThemes), Show (orbitFilters state: live / waiting / today /
// dormant), Show: archived (features/archive fossils, default on), Districts (rich list: click =
// focus that district, the rest washes out and the camera frames it; archived counts included,
// plus a 🦴 row per archived-only district), Hide on the planet (orbitFilters kinds). orbitFilters is the source of
// truth: the palette, ?filter= and the District view can change it too, and the sidebar follows.

import { openArchivePlace, openAutoLot } from "../features/archive";
import { isArchivedDistrict, islandIdsWithAgents, visibleIslands } from "../features/archive-lib";
import { archiveSummary, archiveVisible, archivedInGroup, autoDistricts, districtRowsWithArchive, onArchiveChange, setArchiveVisible } from "../features/archive-state";
import { AUTO_GROUP, AUTO_LOTS_GROUP, AUTO_LOT_PREFIX, isAutoLotRow } from "../features/auto-districts-lib";
import { renderExplainSection } from "../features/explain";
import { orbitFilters, type KindKey, type StateFilter } from "../features/orbit-filters";
import { KIND_KEYS, KIND_LABELS, STATE_FILTERS } from "../features/orbit-lib";
import { cityListOptions } from "../shell/city-list";
import { renderThemePicker } from "../shell/theme-picker";
import type { AlefView, FilterSpec, FilterState, ViewContext } from "../shell/views";
import { topicsState, unplacedSessions } from "../features/topics-state";

const STATE_DOT: Partial<Record<StateFilter, string>> = { live: "live", waiting: "awaiting", today: "today", dormant: "asleep" };

let ctx: ViewContext | null = null;
let subscribed = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/** orbitFilters → the sidebar's FilterState. */
function stateFromOrbit(): FilterState {
  const f = orbitFilters.get();
  return {
    show: f.state === "all" ? [] : [f.state],
    district: f.district ? [f.district] : [],
    hide: KIND_KEYS.filter((k) => !f.kinds[k]),
    archived: [archiveVisible() ? "on" : "off"],
  };
}

function sameState(a: FilterState, b: FilterState): boolean {
  return ["show", "archived", "district", "hide"].every((k) => (a[k] ?? []).join() === (b[k] ?? []).join());
}

/** Round 11: Districts grouped under topic continents (3 cities per continent before "Show all"),
 *  or the classic flat list of 12 when the server sent no topics map. */
function districtGrouping(): Pick<FilterSpec, "limit" | "groups" | "note"> {
  const st = topicsState();
  if (!st) return { limit: 12 };
  const fresh = unplacedSessions();
  return {
    limit: 3,
    groups: st.layout.continents.flatMap((c) => {
      const head = {
        key: c.key,
        label: c.name,
        color: c.color,
        meta: `${c.sessions + archivedInGroup(c.key)} sessions${c.cities.length ? ` · ${c.cities.length} ${c.cities.length === 1 ? "city" : "cities"}` : ""}`,
        empty: "No folder of its own: its sessions ran from a shared folder (home or /).",
      };
      const lots = c.key === AUTO_GROUP ? autoDistricts()?.lots : undefined;
      if (!lots?.length) return [head];
      // Automated Runs' home-folder sessions by automation, right under the continent's own rows.
      return [head, { key: AUTO_LOTS_GROUP, label: `${c.name} · by automation`, color: c.color, meta: `${lots.length} sub-districts` }];
    }),
    note: `Grouped by topic continent. Counts include archived sessions (🦴 fossils: vault notes whose transcripts were pruned). New sessions are sorted automatically; the planet re-draws on reload${fresh ? ` (${fresh} newly sorted since this load)` : ""}.`,
  };
}

export const orbitView: AlefView = {
  id: "orbit",
  emoji: "🌍",
  name: "Orbit",
  hint: "The planet: every city, house and car",
  usesPlanet: true,
  mount(_root, c) {
    ctx = c;
    c.setFilterState(stateFromOrbit());
    unsubscribe = orbitFilters.onChange(() => {
      const next = stateFromOrbit();
      c.setFilterState(next);
    });
    if (!subscribed) {
      subscribed = true;
      onArchiveChange(() => {
        ctx?.setFilterState(stateFromOrbit());
        ctx?.refreshFilters();
      });
      // District counts follow the live agents (throttled: agent updates arrive in bursts).
      c.store.onAgents(() => {
        if (!ctx || refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          ctx?.refreshFilters();
        }, 2000);
      });
    }
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    ctx = null;
  },
  filters(c) {
    const counts = new Map(orbitFilters.options().states.map((s) => [s.id, s.count]));
    return [
      { id: "theme", label: "Theme", type: "section", render: (host) => renderThemePicker(host, true) },
      { id: "explain", label: "Explain", type: "section", render: (host) => renderExplainSection(host) },
      {
        id: "show",
        label: "Show",
        type: "chips",
        options: STATE_FILTERS.filter((s) => s !== "all").map((s) => ({
          value: s,
          label: s === "waiting" ? "Waiting on you" : s[0]!.toUpperCase() + s.slice(1),
          count: counts.get(s),
          dot: STATE_DOT[s],
          hint: s === "dormant" ? "Only sleeping agents; the rest wash out" : `Only ${s} agents; the rest wash out`,
        })),
      },
      {
        id: "archived",
        label: "Show: archived",
        type: "segmented",
        default: ["on"],
        count: archiveSummary()?.total,
        options: [
          {
            value: "on",
            label: "Shown",
            hint: "🦴 Fossils: sessions only the vault remembers (their transcripts were pruned). Dormant for good, never reactivatable.",
          },
          { value: "off", label: "Hidden", hint: "Hide the archived fossils" },
        ],
      },
      {
        id: "district",
        label: "Districts",
        type: "list",
        sortable: true,
        pinnable: true,
        ...districtGrouping(),
        options: districtRowsWithArchive(
          cityListOptions(
            visibleIslands([...c.store.islands.values()], islandIdsWithAgents([...c.store.agents.values()]), archiveSummary()),
            [...c.store.agents.values()],
            { groupOf: (id) => topicsState()?.layout.continentOf.get(id) },
          ),
        ),
      },
      {
        id: "hide",
        label: "Hide on the planet",
        type: "chips",
        multi: true,
        collapsed: true,
        options: KIND_KEYS.map((k: KindKey) => ({ value: k, label: KIND_LABELS[k] })),
      },
    ];
  },
  onFilter(state) {
    if (!ctx || sameState(state, stateFromOrbit())) return;
    const cur = orbitFilters.get();
    const show = STATE_FILTERS.find((x) => x === state.show?.[0]) ?? "all";
    if (show !== cur.state) orbitFilters.setState(show);
    setArchiveVisible(state.archived?.[0] !== "off");
    const district = state.district?.[0] ?? null;
    if (district && isAutoLotRow(district)) {
      // A sub-district of Automated Runs has no city to focus: list its sessions instead.
      openAutoLot(district.slice(AUTO_LOT_PREFIX.length));
      ctx.setFilterState(stateFromOrbit());
    } else if (district && isArchivedDistrict(district)) {
      // An archived-only district has no city to focus: list its fossils instead.
      openArchivePlace(district);
      ctx.setFilterState(stateFromOrbit());
    } else if (district !== cur.district) orbitFilters.setDistrict(district);
    const hidden = new Set(state.hide ?? []);
    for (const k of KIND_KEYS) if (cur.kinds[k] === hidden.has(k)) orbitFilters.setKind(k, !hidden.has(k));
  },
};
