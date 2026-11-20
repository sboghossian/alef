# Views: plugging into the Alef shell

Alef is one shell around several **views**. The shell (`client/src/shell/`) owns the chrome:

```
┌ top bar: logo · Today · Work · World · Brain · Setup │ the active one's sub-pills ──────────┐
│ left sidebar      │  main view area  = YOUR `root`       │ details  │ right sidebar:       │
│ one search        │  (the 3D planet shows through it     │ panel    │ Activity · Loops ·   │
│ + YOUR sections   │   when usesPlanet is true)           │ (on a    │ Controls  ·  ?       │
│ (gone if none)    │                        compass (br)  │  click)  │                      │
├───────────────────┴──── prompt box, docked (⚡ Automations · text · city · Dispatch) ───────┤
└ status bar (cities, live/total, … Jev · ▶ Claude FM ▴ · weather · fps · ? · ⌘K) ▴ drawer ──┘
```

**Home** (Alex, 2026-09-29): 🏠 Home is the first registered view, so it is the default route and
the fallback for unknown ones. It shows the prompt box centred in its own `root` (`ctx.promptBox`, below)
instead of docked; every other view keeps the docked box. Its first section is **Needs you now**
(UX-1): the Inbox itself (`features/inbox.ts` `needsPane`), with a count, or "Nothing needs you" and
what is running. There is no Inbox tab in the right rail: anything that should show what waits on
you calls `openNeedsYou(ctx)` (opens `#/home/needs`, scrolls there and focuses its heading); the
status bar's waiting count and `?tab=inbox` do too, and a stored `alef.shell.tab=inbox` opens the
Feed. The greeting band stays under ~280px, and on a main area ≥1800px wide the sections sit in two
columns (VIS-9).
A pixel garden (`client/src/features/garden.ts`) grows behind the greeting from today's real sessions: one plant per session started today, stem height from its message count, a bloom for a shipped or delivered outcome, a swaying tip while live. Engine: `garden-lib.ts` (Markov-style rewrite rules, after MarkovJunior).

Under Needs you now, **Pick up where you left off** (capability #2) shows the 3-4 projects whose
city had a session most recently (`GET /api/project-page/recent`): the newest verdict, open todos,
spend over 30 days, the vault note (opened in Brain) and one Resume. Resume is the Reactivate path
(`ui/agent-open.ts`, `claude --resume`, refused for a live session); a live one opens its Room.

**📌 Project** (UX-3, `views/project.ts`): "project" used to mean a World city, a Library entry and a
vault 20-Projects note. `#/project/<key>` (a Library id, a vault slug or a city id) is the one page
that joins them (`GET /api/project-page/:key`, `server/features/project-page.ts`): the city's
sessions, open todos, the last verdicts, spend, git, and the vault `_index.md` summary with a link
into Brain. Reached from ⌘K (projects are Go to results), the Library drawer's 📌 Page, Vault's
Projects list, the district card and Home's cards. A project finds its vault note by the note's
`code_path`, then `github`, then brain_taxonomy's aliases, then the folder name
(`server/features/project-match-lib.ts`, DATA-7).

**The layout rule** (Alex, 2026-09-25): the only chrome is the top bar, the left sidebar, the
right sidebar, the status bar with the prompt box docked above it, plus ONE contextual details
panel (`#panel`, docked full height at the main area's right edge) that appears when you click an
element and closes on ✕, Esc or a view switch. Nothing else floats. A view's controls, legends,
stats and searches go in its left-sidebar sections (`type: "section"` / `"search"`); live or status
things go in the right sidebar or the status bar / drawer. Exceptions only where the element IS the
view (the canvas surface, a minimap inside it, the courier HUD while flying, the approval card).

A view owns exactly one element, `root` (the main view area), and its left-sidebar sections.
Everything else is the shell's.

## Add a view (one line)

1. Write `client/src/views/<id>.ts` exporting an `AlefView`.
2. Add it to the list in `client/src/views/index.ts` (import + one array entry). The order is the
   order of the top-bar switcher, and the FIRST entry (🏠 Home) is the default route and the
   unknown-route fallback: add yours after it. **Wave 2: replace the placeholder entry for your view**
   (`comingSoon(...)`) with your import; don't reorder the others.
3. Scope your CSS under `.view-<id>` (the shell puts that class on `root`) or your own ids.
   Import a CSS file from your view module (`import "./board.css"`), like `features/canvas`.

Don't edit `shell/*.ts`, `main.ts` or `index.html` to add a view. If you need a new shell API,
make that change on its own, separate from the view. That includes the group table: a view no
group claims gets its own top-bar button, so steps 1-3 are still the whole job. Grouping it is an
optional fourth step — see [View groups](#view-groups-the-top-bar).

## The contract (`client/src/shell/views.ts`)

```ts
interface AlefView {
  id: string;            // kebab-case; also the route #/<id>
  emoji: string;
  name: string;
  hint?: string;         // switcher tooltip
  keys?: string[];       // single keys that open it ("1", "b"); duplicates throw at startup
  usesPlanet?: boolean;  // keep the shared 3D canvas visible + rendering behind root
  mount(root: HTMLElement, ctx: ViewContext): void | Promise<void>;
  unmount(): void;       // undo what mount did OUTSIDE root; the shell empties root itself
  filters?(ctx: ViewContext): FilterSpec[];   // left sidebar filters for this view
  onFilter?(state: FilterState): void;        // also called once right after mount
  onSelect?(target: Selection | null): void;  // shared selection; also called right after mount
  onFocus?(on: boolean): void;                // focus mode (F) toggled while you are active
  onParam?(param: string | null): void;       // #/room/a → #/room/b without a remount
  onEscape?(): boolean;                       // true = you handled Esc
}

interface ViewContext extends ClientContext {   // ClientContext = what features get (FEATURES.md)
  selection: { get(): Selection | null; set(sel: Selection | null): void };
  route(): Route;                               // { view, param }
  focus: { isOn(): boolean; set(on: boolean): void };
  planet: PlanetApi;                            // flyToAgent/flyToCity/enterRoom/exitRoom/roomAgent/startRide/endRide
  refreshFilters(): void;                       // re-ask filters() (counts changed)
  setFilterState(next: FilterState): void;      // overwrite stored state (you refused a value); no onFilter
  sidebars: { open(): { left; right }; setOpen(state): void };
  promptBox: { mountIn(host: HTMLElement): () => void };  // move THE prompt box (#dispatch) into host; call the restore on unmount (shell/prompt-box.ts; views/home.test.ts)
  feedStream: { list(q?: FeedQuery): FeedItem[]; onChange(fn): () => void };  // read the one Feed
}

// ClientContext (features AND views) gained these shell calls:
feed: FeedSink;                                 // push(items) / resolve(id, outcome)
openRightTab(tab: "loops" | "feed" | "mac" | "help" | "settings" | "routines" | "logs"): void;
showView(id: string, param?: string | null): void;
activeView(): string;

type Selection = { kind: "agent" | "city" | "object" | "subagent" | "jev" | "system"; id: string };

interface FilterSpec {
  id: string; label: string;
  type: "chips" | "segmented" | "list" | "toggle" | "search" | "section";
  options?: { value: string; label: string; count?: number; emoji?: string; hint?: string; dot?: string;
              meta?: string; spark?: number[]; activity?: number }[];   // meta/spark/activity: "list" rows
  multi?: boolean;       // chips only
  default?: string[];
  collapsed?: boolean;   // start folded (the user's fold choice is remembered)
  count?: number;        // number in the section header ("list" defaults to its row count)
  placeholder?: string;  // "search"
  sortable?: boolean; pinnable?: boolean; limit?: number;   // "list": Activity | A–Z, ☆ pins, "Show all N"
  render?(host: HTMLElement): void | (() => void);          // "section": fill once, update in place
}
type FilterState = Readonly<Record<string, readonly string[]>>;   // filterId → selected values
```

### Lifecycle

- `show(id, param)`: the old view's `unmount()` runs, `root` is emptied, then your `mount(root, ctx)`,
  then `onFilter(initial state)` and `onSelect(current selection)`. A throwing / rejecting `mount`
  shows a friendly error card in `root`; every other hook is try/catch-guarded and logged.
- Same view, new param: `onParam(param)` if you have it, else a full remount.
- Sections: the shell renders your `FilterSpec[]` as collapsible groups in one card under the search,
  with an "active filters" strip (removable chips + Reset) on top, remembers the state per view (for
  this page load), and calls `onFilter` on every change. Call `ctx.refreshFilters()` when counts
  change; it is cheap, and it keeps what the user is in the middle of: a `"section"` host element is
  created once per view (the shell calls `render(host)` once and re-attaches the same element on
  every refresh, so update it in place; the returned cleanup runs on unmount), a `"search"` input
  keeps its caret (value `[text]`, debounced), list scroll and keyboard focus are restored.
  A `filters()` that throws is logged and shows no sections (never the previous view's).
- "list" pins are keyed by the spec id only, so `district` pins follow you across views. For the
  standard rich district rows use `cityListOptions()` from `shell/city-list.ts` (dot, "2 live · 5
  today", 7-day sparkline, agent count, activity order).
- Switching views empties the sidebar search and closes the details panel.
- The sidebar search (`⌘K`) finds every registered view by its name, hint and group, and every
  Vault section in `MIND_TABS`, above agents and the Ask Jev / Dispatch rows. Nothing to register.
- Selection: `ctx.selection.set({ kind: "agent", id })` selects everywhere (planet marker + side
  panel on planet views, the Board card, the Canvas node…). Planet clicks call your `onSelect`.
- Focus mode (`F`, or `ctx.focus.set(true)`): the shell hides ALL its chrome (top bar, both
  sidebars, prompt box, status bar, pills) and calls `onFocus(true)`. Hide your own noise too
  (secondary columns, legends, toolbars). `Esc` / `F` leaves and calls `onFocus(false)`.
  On Orbit with an agent selected/hovered, `F` is the richer agent focus (camera locks on it).
- `H` hides the two side rails only (UX-12): the top bar, the prompt box and the status bar stay,
  so you always see which destination you are in. `Z` is zen (planet only: other views switch to
  Orbit first).
- A view whose `filters()` is empty gets **no left sidebar** (UX-11, `hidesLeftSidebar` in
  `views.ts`): the main area takes its width. `⌘K` (or the status bar's search) brings the search
  back until it is emptied. On a phone the sidebar is a sheet, unchanged.
- Empty, loading and error states: use `viewState()` (`shell/view-state.ts`): centred in the view,
  a title, one line, at most ONE action (`Try again`, `Open Machine`…). `overlay: true` fills a
  positioned parent (Brain draws it over the graph). Don't park a failure in a sidebar section.
- `Esc`: dialogs and the sidebar search first, then your `onEscape()`, then the shell goes back
  to the previous view (from Home it closes the side panel).

### Routing and keys

`#/orbit`, `#/district`, `#/room/<agentId>`, `#/courier`, `#/canvas`, `#/board`, `#/voice`,
`#/code`, `#/brain` (`#/brain/<vault path>` opens that note), `#/vault/<section>`, `#/capabilities` (the old `#/atlas`, redirected),
`#/system` (shown as Machine), `#/health`, `#/routines`, `#/library` (`#/library/lens:type`, `#/library/lens:pinned`, `#/library/<projectId>` opens that project's drawer), `#/project/<key>` (one project, see below), `#/home`. The retired `#/projects[/<id>]`, `#/shelf` and `#/atlas` are aliases: `resolveLegacyRoute` (`views.ts`) rewrites them to the Library and Capabilities routes, for the address bar and for every `showView("projects" | "shelf")` call. To retire another view the same way, add one line there plus a test. An empty hash and unknown routes open the first registered view
(🏠 Home, `initialRoute` in `views.ts`). Back/forward work (hashchange).
Keys: `1`–`5` open the five destinations (Today · Work · World · Brain · Setup, see below) on their
remembered sub-mode, pressed again inside a group they step to its next view. View keys: `V` Canvas ·
`6`/`B` Board · `7` Voice · `8` Code · `9` Brain. Reserved (never bind): `1`–`5`, `F` `H` `Z` `M` `?`
`A` `D` `0` `+` `-` arrows, `Esc`, `⌘K` (`groups.test.ts` fails if a view claims a group key). Keys are ignored while typing in an input.

### `usesPlanet`

- `true` (Orbit, District, Courier, Room): `root` is transparent and click-through
  (`pointer-events: none`); give your own overlay elements `pointer-events: auto`. The 3D canvas
  keeps rendering behind. Labels, bubbles, beacons and the compass stay.
- `false` (Board, Canvas, Voice, Code, Brain): `root` is an opaque cream page and the 3D frame
  loop pauses (saves the GPU). Planet overlays (labels, beacons, compass) are hidden.

### View groups (the top bar)

The bar shows five named destinations instead of one button per view (Wave 12 IA, UX-2/UX-9).
`client/src/shell/groups.ts` holds the table; the shell reads it and nothing else does:

| Key | Destination | Views (sub-pills) |
| --- | --- | --- |
| 1 | ⚡ Today | Home · Board |
| 2 | 🛠️ Work | Code · Canvas · Voice · Library (Project lights Library) |
| 3 | 🪐 World | Orbit · District · Room · Courier |
| 4 | 🧠 Brain | none: one destination, its flat tab bar carries Graph (the Brain view) and the Vault's 14 sections (`#/vault/<section>`) |
| 5 | ⚙️ Setup | Health (Fix queue on top) · Machine (`#/system`) · Capabilities (the old Atlas) · Routines |

**Brain** (`views/mind-tabs.ts`): one row of 15 tabs (Graph, Folders, Flows, …, Gaps), the four
artifact groups only as hairline gaps. Brain and Vault both mount it with `mindFrame(bar, body)`,
a full-width strip above the view's body, so it sits in the same place in both (VIS-8). A view
listed under a group's `inside` (Vault → Brain) has no sub-pill and lights its host's pill.

Clicking a group opens the sub-mode you last used there; its siblings appear as chips after a
hairline, in the same row. Keys `1`–`5` press the group buttons. View ids, routes and deep links
(`#/room/<id>`, `#/canvas?session=<id>`) are untouched.

Two rules keep it safe to change:

- **A group never mixes planet views with flat ones** (`usesPlanet`), so moving between a group's
  sub-modes never triggers the planet fade. `groups.test.ts` enforces this by reading each view
  module, and will fail if you put a planet view in a flat group.
- **A view no group claims still appears**, as its own top-level button (`ungroupedViewIds`).
  Registering a view can't make it unreachable, so you never have to touch this table.

Settings → Alef → *Views grouped into five* turns the whole thing off and puts the flat
one-button-per-view bar back, unchanged (remembered as `alef.shell.view-groups`).

## The right rail (UX-7)

Three labelled tabs, `RAIL_TABS` in `views.ts`: **Activity** (Feed · Logs), **Loops**, **Controls**
(Mac · Routines · Settings). A tab holding more than one pane shows a small segmented switch at
its top. Every pane keeps its id (`#alef-pane-<pane>`) and `ctx.openRightTab(<pane>)` still takes
the old names (`"feed"`, `"logs"`, `"mac"`, …); `railTabFor` maps a pane to its tab. **Help** is
not a tab: `?` (the rail's ? button, the status bar's, or `openRightTab("help")`) opens it as an
overlay; Esc closes it. `?tab=<pane|tab>` in the URL opens that pane.

## The Feed (`client/src/shell/feed.ts`)

ONE live feed in the right sidebar. Kinds: `approval` · `awaiting` · `tripwire` · `decision` (Jev's
"official results") · `activity` · `caption` · `routine` · `report` · `system`. Already wired:
activity + captions (plan/reason lines) from the store, Jev decisions, approvals (pinned, with
**hold-to-confirm** Approve/Deny that reuse `courier/hold.ts` and send the same real decision as
the big card), agents waiting on you (pinned until they stop), routine start/finish, today's
digest and the daily report as `report` items. Push your own:

```ts
ctx.feed.push({ id: "report:yalla-brief:2026-09-25", kind: "report", at: Date.now(),
  title: "yalla-brief is ready", detail: "08:00 run", href: "/api/automations/yalla-brief/latest" });
```

Rules: `id` must be stable per real event (it dedupes; same id = update in place). Real text only.
`pinned: true` keeps an open item on top until `ctx.feed.resolve(id, outcome)`. Clicking an item
selects + flies to its `agentId` (else `cityId`).

Every Feed item is also a candidate for the **Town square's top 5** (the global workspace,
`features/workspace-lib.ts`), shown above the Feed's chips and in the #/room/all Town square. To
flag something the whole system should see, push a `tripwire` with the session it is about; the
same title from several sessions is merged into one slot that scores higher for each district:

```ts
ctx.feed.push({ id: `tripwire:lesson:${sessionId}:${at}`, kind: "tripwire", at, title: "Repeating a known lesson: …", agentId: sessionId });
```

A server feature publishes the same thing with `appendToFeed({ id, at, kind: "tripwire", agentId, title, detail, tag })`
(`server/features/feed.ts`); `features/feed-bridge.ts` brings it into the Feed, catching up on every
snapshot (page load, WS reconnect) and paging `GET /api/feed?before=<seq>` back over the 2 h window.
When the Feed passes its cap (300), tripwires are the last closed items it drops.

Governance decisions travel the same way: a server feature appends `kind: "decision"` with a
`gov:<source>` tag (`server/features/governance-lib.ts` writes the words; one item per real event).
The bridge shows `gov:jev` (Jev ranked the president's board) as a Jev `decision` and every other
source (`gov:click`, `gov:council`, `gov:resident`, `gov:census`) as `system`. The store's own Jev
decisions carry no `gov:` tag, so nothing shows twice. The server keeps every feed item for at least
2 h, and the Logs tab keeps the non-activity ones across restarts.

## Shell DOM you can rely on

| id | what |
|----|------|
| `#alef-view` | the main view area (your `root` is this element; class `view-<id>` while you are active) |
| `#alef-left`, `#alef-search` | left sidebar, the one search box (⌘K focuses it) |
| `#alef-right`, `#alef-tab-<tab>`, `#alef-pane-<pane>` | right sidebar, its three tabs, each pane |
| `#alef-help` | the ? Help overlay |
| `#dispatch`, `#dispatch-text` | the prompt box (unchanged ids) |
| `#statusbar`, `#alef-drawer` | status bar and its data drawer |
| `#panel` | the ONE contextual details panel (`ctx.openPanel`), docked full height at the main area's right edge |
| `#board-cols` | Board columns (agent-state decorates the cards) |

CSS variables on `<body>`: `--alef-top`, `--alef-left`, `--alef-right`, `--alef-bottom` (px insets
of the main area; `--alef-bottom` includes the docked prompt box, `--alef-status` is the status bar
+ drawer alone, `--alef-prompt` is kept at 0px for old rules). Position anything with them.
Body classes: `alef-view-<id>`, `alef-no-planet` (a non-planet view is active), `alef-no-3d`
(WebGL never started or its context is lost: the canvas and every planet-pinned overlay are hidden
and `#alef-no3d` explains why, see `ui/no-3d.ts`), `aw-focus`, `aw-chrome-hidden`, `aw-zen`,
`alef-phone` (≤520px). A new planet-pinned overlay goes in both hide lists in `shell.css`
(`shell.css.test.ts` checks they match).

## Style

Bright comic kit (tokens at the top of `client/src/style.css`: `--ink`, `--cream`, `--paper`,
`--yellow`, `--pink`, `--sky`, `--r-card`, `--btn-h`, `--touch`, `--fs-min`). Cream cards, 3px ink
borders, hard offset shadows. Never dark or murky. 12px minimum text, 32px targets (44px on
phones). Don't add floating surfaces: put controls in a sidebar section (see the layout rule).

## Test

Pure logic goes in `*.test.ts` next to it (vitest, node env, no DOM). See `shell/views.test.ts`
and `shell/feed.test.ts` for the patterns.

## Canvas: Everything | One session

The canvas header carries a segmented toggle. **One session** isolates a single session's footprint
(its subagents, skills, MCPs, files and repos, artifacts, approvals): pick it from the search box (live
first), click **Solo** on a session card, or open `#/canvas?session=<id>` (the shell rewrites it to
`#/canvas/<id>`). Esc returns to Everything; the choice is remembered in localStorage. Lanes added:
Atlas departments (`GET /api/atlas`) and Artifacts (`GET /api/artifacts`); both stay out of the layout
until they have a card, and a capped lane ends in a "+N more" node. Routines and hooks have no
per-session link in the data, so Solo leaves them out.

Solo is laid out to read at first paint: the session's lane sits in the middle (what it thought with
on the left: skills, model, memory, router; what it did on the right: subagents, tools, files,
artifacts), empty lanes take no room, and each lane shows at most 10 cards (`SOLO_CAP`). The rest sit
behind the lane's "+N more" card, which opens the lane on click; hidden subagents keep their file and
MCP links through it. The view centres the session at a zoom of at least 0.66, so cards keep their
labels; leaving Solo puts the view back where it was. The sidebar's old "Its tree" chip is now the
same "One session" switch (and `?canvas=1&select=<id>&tree=1` opens Solo on that session).
