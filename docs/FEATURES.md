# Feature plugins

New features are modules that register with a registry. They do not edit the hub files.

## The rule

Don't edit `server/index.ts`, `client/src/main.ts` or `shared/types.ts` to add a feature.
Add modules instead:

| Layer  | Your files                                   | The one line you add                    |
|--------|----------------------------------------------|-----------------------------------------|
| Server | `server/features/<id>.ts`                    | import + array entry in `server/features/index.ts` |
| Client | `client/src/features/<id>.ts`                | import + array entry in `client/src/features/index.ts` |
| Shared | `shared/features/<id>.ts` (payload, extras, request/response types) | none |

Use the same kebab-case `id` on the server and the client. Server messages are routed by it.
If a hub really has to change (a new ctx API, say), make that change on its own, separate from any feature.
Don't bundle it into a feature.

Everything here is TS strict: no `any`, and no `console.*`. Log through `ctx.log` on the server and `log` from `client/src/log.ts` on the client.

## Server: `ServerFeature` (`server/features/registry.ts`)

```ts
export const myFeature: ServerFeature = {
  id: "my-feature",
  routes: [{ method: "GET", path: "/api/my-feature/:agentId", handler: (req, res, ctx, params) => respondJson(res, 200, {...}) }],
  onIndexPass(ctx, newLinesBySession) { /* Map<sessionId, raw jsonl lines>, every 10s when there are new lines */ },
  onStart(ctx) { /* awaited once before the server listens (bounded, 10s): restore state from disk here */ },
  onTick(ctx) { /* every tickIntervalMs (default 10s); never overlaps itself */ },
  tickIntervalMs: 30_000,
  snapshotExtras: (ctx) => ({ "my-feature.state": ... }), // merged into WorldSnapshot.extras
  snapshotIslands: (ctx) => [], // extra islands in the snapshot only (the artifacts Museum)
};
```

- Upgrades (WebSocket): `upgrades: [{ path: "/ws/term/:agentId", handler(req, socket, head, ctx, params) }]`. The hub owns one `upgrade` router: it applies the same loopback Host/Origin guard as HTTP, then gives `/ws` to itself and anything else to the first feature path that matches, or answers 404. Use a `ws` `WebSocketServer({ noServer: true })` and call `handleUpgrade`. Never pass `{ server }`, because two servers on one http server abort each other's paths with a 400. `server/features/term.ts` is the example.
- Routes: the core routes (`/api/world`, `/api/health`) match first. (`/api/reactivate/:id` and `/api/dispatch` are the talk feature's: it owns the world tmux sessions they start.) After that, the first feature route that matches wins. `:params` are URI-decoded, one path segment each. `respondJson`, `respondJsonText` (an already-serialised body), `readJsonBody` and `isRecord` live in `server/http.ts`.
- Every route shares one event loop. Never run a synchronous child process (`execFileSync`, `spawnSync`), and keep big `JSON.parse`/`stringify` and long loops off the request path: serve the last result and refresh in the background (`createSwr` in `cache-lib.ts`), or hand the work to a worker thread (`brain-worker-host.ts`). `GET /api/health` reports the event-loop lag (`eventLoop`: p50/p99/max for the last minute and the current one), the live probe (`live`), the machine's load (`host`) and each feature's `health()` under `features.<id>` (brain: whether parsing runs on its worker or in-process, with the start failure and next retry); the lag is also logged once a minute (`[loop]`, a warning past 1 s).
- `onIndexPass` receives untrusted transcript text. Parse it (`parseLine` in `server/jsonl-events.ts`) and never execute it. The indexer only collects raw lines when at least one feature defines this hook.
- `onStart`: a client replaces its state with each snapshot, and a tab left open reconnects the moment a restarted server listens. So anything a feature restores from disk must be loaded here, not lazily from `snapshotExtras`. The hub runs every hook in parallel before `listen()` and waits at most `START_HOOK_TIMEOUT_MS` (10s) for each; a late one is logged and keeps running.
- `snapshotExtras`: prefix your keys with your feature id. On a key clash the first feature in the list wins and the clash is logged. When no feature defines the hook, `extras` is absent. Keep it small: every tab gets it in `/api/world` and in every WS snapshot. A map with a row per session (crew windows, job verdicts, agent states) goes behind its own GET route instead, which the client feature loads with `lateExtra` (`client/src/features/late-extra.ts`) on every `onSnapshot`, routing its WS pushes through it so an in-flight answer never undoes a newer push.
- `snapshotIslands`: islands that are not a folder (the artifacts feature's `museum`). They are in the snapshot the client gets, never in `ctx.worldViews()`, so server-side counts of districts don't see them. An id the world already has is skipped.
- A throwing hook is logged and isolated. A throwing route handler becomes a 500.

`ServerContext` (plus `featureId` and `emit`, bound per feature):

| API | What |
|-----|------|
| `db` | `WorldDb` (sqlite index: sessions, objects, edges, meta) |
| `config` | `ServerConfig` (paths, port, TypeSafe test hooks) |
| `log` | server logger |
| `detectLive()` | cwd → count of running `claude` processes. Never blocks: it serves the latest async ps + lsof probe (≤ ~3 s old, `server/live-cache.ts`) and starts the next one in the background |
| `liveStatus?()` | whether that latest probe could read the process table (`ok: false` when ps timed out); a check reads this to answer "unknown" instead of guessing |
| `executors` | `reactivate`, `dispatch` (plain Terminal: talk's fallback when tmux is missing), `openEditor` (VS Code); tests stub them |
| `worldViews()` | `{ agents, objects, edges, islands }` as the snapshot sees them now |
| `emit(payload)` | broadcasts `{ type: "feature", feature: <id>, payload }` over WS |
| `broadcast(msg)` | any `ServerMessage`. Prefer `emit` |

Tests can boot a server with their own list: `bootTestServer({ configOverrides: { features: [myFeature] } })`.

## Reading another feature's state

A feature that needs another feature's numbers reads that feature's own latest state through an
exported getter, never a second count of the same thing. The getter answers `null` (or a
`ready: false` / not-read flag) until its owner has computed once, and the reader shows that as
pending or unknown, never as 0. The vision ledger (`server/features/vision.ts`) is the main reader:

| Getter | Owner | Null / not ready until |
|--------|-------|------------------------|
| `latestOutcomeRecords()`, `latestOutcomesColdDone()` | `outcomes.ts` | the store is loaded; the first scan of every transcript and PR is done |
| `latestCareerWorkers()`, `latestCareerTrends()` | `careers.ts` | the archive list and `careers.json` are loaded |
| `latestCensusMerged()` | `census.ts` | the first `gh pr list` |
| `latestSubagentRecords()` | `subagents/index.ts` | the first pass over `subagents.db` |
| `latestArchivedSessions()` | `archive.ts` | the vault's session notes are scanned |
| `latestJobsCounts()`, `latestWakeRecallSummary()` | `jobs.ts`, `wake-recall.ts` | their first computation / cold pass |
| `sicknessSummary()` | `sickness.ts` | the case log is loaded (its `scan.finishedAt` says when every transcript was read) |
| `webTripsFeature.summary()`, `webTripsFeature.jevRead()` | `webtrips.ts` | `summary().ready`: every transcript read; `jevRead()`: `data/jev-web.jsonl` read once |
| `latestWorkspaceBroadcast()` | `workspace-state.ts` | the first server-side top 5 |
| `currentResidentState()` | `resident.ts` | the resident's `state.json` is read |
| `currentStranded()` | `talk.ts` | never null: an empty list until talk's first stranded-launch scan |
| `currentHealthChecks()` | `completeness.ts` | the first checklist compute |
| `latestLoopsBoard()` | `loops.ts` | the first scan after boot |
| `latestVaultGaps()` | `vault.ts` | the vault's graph feed is read (memoised with the Gaps section) |

The Fix queue (`fixes.ts`, Health's top section) is the other big reader: health checks, open
Sickness cases, vault gaps, stale loops and abandoned sessions in one list, built from these
getters only.

Pure logic two sides both need lives in `shared/` (for example `shared/features/crews.ts`: the
agent panel and the ledger's crews probe count crews with one function).

## What features keep under `data/`

Everything sits beside `world.db` (the folder of `ALEF_DB_PATH`, gitignored). Writes go to a
`.tmp` file renamed into place, or append to a log; a migration of `world.db` takes a
`world.db.pre-<name>-<ISO>.bak` first.

| File | Feature | What |
|------|---------|------|
| `outcomes.json` | outcomes | each session's verdict evidence, byte offsets and PR states |
| `careers.json` | careers | retirements and names you set in the Tower (display only) |
| `president.json`, `district-merges.json` | president | the last board, dismiss cooldowns, the launch log and Jev's ledger; approved display-only district merges |
| `sickness.jsonl`, `sickness-scan.json` | sickness | cases and "Mark treated" clicks (append-only); the scanner's offsets |
| `tripwires.jsonl` (+ `tripwires.1.jsonl` …) | tripwires | every hit, folded back in at boot |
| `workspace-influence.jsonl` | workspace | one record per Jev proposal / resident reflection: was its subject in the square it was shown |
| `jev-web.jsonl` | websearch, webtrips | every web search Jev ran, with its top 5 results |
| `alumni.jsonl` | alumni | legacy cards, and their restored / voided events (append-only) |
| `home-digest.json` | home | the cached Haiku summaries and the day's spend |
| `fixes.json` | fixes | per Fix queue row: a snooze / won't fix (a Health row's lives in `health-dismissals.json`), and the session a "Draft a fix" or a Loops ▶ Launch started |
| `health-keeper.json` | health-keeper | the 04:30 slot it last handled, its last score and failing checks, the day's Inbox item |
| `credential-scan.json` | voice brain | closed paths and reason classes, never a value |
| `artifacts/<id>.html` | artifacts | a copy of each artifact's source page (≤8 MB, secrets redacted), for the in-app preview. Its items and per-transcript cursors live in `world.db`'s meta table (`artifacts_v1_*`) |
| (world.db meta only) | shelf-board | the Shelf's items and its own per-transcript cursors (`shelf_board_v1_*`, backup `world.db.pre-shelf-board-<ISO>.bak` before the first write) and Alex's pins and sections (`shelf_board_v1_pins`) |
| `town-log.ndjson` | logs | the Logs tab's ring (rewritten to the newest 2000 past 2 MB) |

## Client: `ClientFeature` (`client/src/features/registry.ts`)

```ts
export const myFeature: ClientFeature = {
  id: "my-feature",
  mount(ctx) { /* once, after the world is built; subscribe to ctx.store.on* here */ },
  onSnapshot(world, ctx) { /* initial world, then every mid-session snapshot; read world.extras */ },
  onMessage(msg, ctx) { /* only { type: "feature", feature: "my-feature" }; validate msg.payload */ },
  onFrame(dt, ctx) { /* every planet frame, not inside a room; keep it cheap */ },
  onEscape(ctx) { return false; /* true = you closed your overlay, stop the Esc chain */ },
  paletteCommands: (ctx) => [{ id: "refresh", title: "Refresh my thing", keywords: ["sync"], run: () => {} }],
  hudButtons: [{ id: "open", label: "☀", title: "Weather", onClick: (ctx) => ctx.openPanel("my-feature") }],
  panels: [{ id: "my-feature", title: "Weather", render: (el, ctx) => { el.textContent = "..."; } }],
  ride: { start(ctx) {}, frame(dt, ctx) { /* owns ctx.camera */ }, stop(ctx) {} }, // optional, see below
};
```

- A throwing `onFrame` is logged once and then disabled until the page reloads. Other hooks are logged and isolated.
- Palette commands only appear for a non-empty query, and are fuzzy-matched on `title` and `keywords`. Their ids get namespaced to `<featureId>:<id>`.
- `ride` (at most one feature; the first one wins): key `2` and the ride button hand the camera to it. The hub saves the view, turns the orbit controls off, and calls `start`, then `frame(dt)` every planet frame instead of its own camera update, then `stop` on `1`, Esc, the Orbit button, a fly-to, or `ctx.endRide()`. After `stop` it restores the saved view exactly. A throwing `start` or `frame` ends the ride. `features/courier` is the example.
- HUD buttons: `placement: "menu"` (default) become labeled rows in the right sidebar's **Settings** tab; `"status"` ones become chips in the status bar. Panels open in the side panel (`#panel`). A feature that is really a whole screen should be a **view** instead: see [VIEWS.md](VIEWS.md).
- A feature that needs its own DOM creates it in `mount`. Scope your CSS to your own ids and classes. `client/src/style.css` is shared.

`ClientContext`:

| API | What |
|-----|------|
| `scene`, `camera` | three.js scene and perspective camera |
| `store` | `WorldStore`: `agents`, `islands`, `objects`, `edges`, `jev`, `activities`, `on*` events |
| `elapsed()` | render clock, in seconds |
| `flyTo(id)` | selects and flies to an agent id, or flies to a city id |
| `openPanel(id)` / `openPalette(q?)` (focuses the sidebar search) / `toast(text, kind?)` | UI |
| `hasPanel(id)` | true when an enabled feature registers that panel id (show a button to a panel another piece may not have shipped yet only when it exists) |
| `feed.push(items)` / `feed.resolve(id, outcome)` | the one live Feed (docs/VIEWS.md) |
| `openRightTab(tab)` / `showView(id, param?)` / `activeView()` | the Alef shell |
| `api` | `getJson`, `postJson` (both never throw), `reactivate`, `openEditor`, `dispatch`, `askJev` |
| `cityPosition(cityId)` | world position of the city's tower top |
| `agentPosition(agentId)` | roof of the agent's house |
| `surfacePoint(dir, lift?)` | ground point on the planet in direction `dir` |
| `labels.say(text, anchor, seconds?)` / `labels.burst(text, anchor)` | speech bubble / comic burst at a world point |
| `endRide()` | leave the ride mode (if one is active); the hub restores the camera it saved |

## Worked examples in the tree

- Server: `server/features/ask-jev.ts` (a POST route plus in-flight state) and `server/features/open-editor.ts` (a `:param` route plus an executor).
- Client: `client/src/features/inbox.ts` (store events, renders Home's "Needs you now"; `openNeedsYou` opens it) and `client/src/features/quick-prompts.ts` (the ⚡ Automations modal, `onEscape`, panels).
- Tests: `server/test/registry.test.ts` and `client/src/features/registry.test.ts`.
