# Alef — Wave 2 spec (round 10): 1:1s, Retire & tidy, Completeness, Game feel

Status: design only, written read-only on 2026-09-25. Nothing in `~/Documents/Code/agent-world` was edited.
Evidence tags: ✅ = I read the file or ran a GET against `localhost:5179` · 🧪 = assumption to check during the build.

---

## 0. What exists today (✅ verified, so builders don't reinvent it)

| Need | Already there | Where |
|---|---|---|
| Type into an agent | `POST /api/talk/:agentId` (tmux `send-keys -l`, refuses while a prompt is on screen) | `server/features/talk.ts` `deliverTalkText`, client `features/talk.ts` exports `sendTalk`, `resumeInTmux`, `talkInfo`, `onTalkChange` |
| Resume a session in tmux | `POST /api/talk/reactivate/:agentId` → `aw-<id8>` session + Terminal | same |
| Stop / note | `POST /api/agents/:id/interrupt[?hard=1]`, `POST /api/agents/:id/note` | `server/features/control.ts` |
| Transcript parsing | `findSessionJsonl`, `parseTranscript`, `readTranscript` (64 MB cap, skips tool_result) | `server/features/transcript.ts` |
| Todos / approvals / usage / skills / git / shelf / subagents per agent | `/api/todos/:id`, `/api/approvals`, `/api/usage/session/:id`, `/api/skills/session/:id`, `/api/fork/:id`, `/api/shelf/:id`, `/api/subagents?parent=` | `server/features/*` |
| Jev (TypeSafe) call | `callJev(apiKey, body, fetch, timeout)`, `isChoiceAnswer`; council shows batched Choice+Score | `server/director.ts:190`, `server/features/council-jev.ts` |
| A 3D room you can reuse | `createRoom3D(deps)` → `setData / setStage(rect) / setActive / hit / dispose`; helpers `lampMood, modelKey, stickyNotes, plantStage, clockHands` | `client/src/views/room-3d.ts`, `views/room-lib.ts` |
| Worktree removal (clean trees only, never `--force`) | `POST /api/fork/remove`; root `~/.alef-worktrees` | `server/features/fork.ts:122,371,421` |
| Live detection | `isLive`, `processVouchedSessions`, `liveClaudeCwds()` | `server/heuristics.ts:86`, `server/live.ts` |
| Hold-to-confirm | `courier/hold.ts` (the Feed reuses it) | `client/src/features/courier/hold.ts` |
| Tool name → kind map | builtin tool table | `client/src/features/orbit-lib.ts` (~l.150) |
| Camera fly | easeInOutCubic plus a mid-flight hop, fixed 1.4 s | `client/src/main.ts:523-548` |
| Agent states | `working · permission · waiting · idle · sleeping` | `shared/features/agent-state.ts:9` |

Live numbers (GET `/api/world`, 17:45 local, ✅): 346–351 sessions, 7 live, 0 awaiting; message counts: 7 sessions have 1 message, 19 have 2, 89 have 3, 222 have ≥10. The oldest session was last active **18 days ago**, so a ">90 days dormant" rule matches **0** today (59 match >14 days). **61 sessions (5.5 MB) are one-shot `claude -p` runs of the session-groups classifier** (first line starts "Classify each Claude Code session"). That babysitter was disabled on 2026-09-24, so these are dead leftovers and the best first cleanup bucket. `~/.claude/projects` = 2.4 GB, 345 jsonl files. `~/.alef-worktrees` and `~/.alef-trash` don't exist yet. One talk binding (`aw-0f101cc1`, agentId null). The approvals hook is installed (`permission-request.mjs` appears in `~/.claude/settings.json`). Jev `status: online`. gzip on one 7.3 MB transcript gave 4.1 MB (≈1.8×), so compressing the trash saves only a little.

Hazards found:
- Session folders under `~/.claude/projects/<proj>/` sit next to `memory/`, `memory.bak-*/` and `memory.mbp-pre-symlink-backup/`. **Retire may only touch `<uuid>.jsonl` and a folder whose name is exactly `<uuid>`** (it holds `tool-results/` and `subagents/`).
- The client can't remove agents yet. `store.upsertAgents` only adds, and `AgentsVisual` has no remove (`scene/agents.ts:73-95`). Geometry is laid out once. So retiring needs a hub seam (P0).
- This spec session (`8d48c55e…`) is itself a live session in `-Users-alexboghossian`. It is exactly the kind of thing the live-guard must refuse.

---

## 1. Packages, ranked by value

| Rank | Pkg | Name | Effort | Model | Depends on |
|---|---|---|---|---|---|
| — | **P0** | Hub seams (serial, first) | S | Opus (orchestrator) | — |
| 1 | **P1** | One-on-ones (💬 1:1 view + Jev agenda) | L | Opus/Sonnet | P0 (`shared/stations.ts`) |
| 2 | **P4a** | Game feel: world life & feedback | L | Sonnet | P0 (`hide`, stations) |
| 3 | **P2** | Retire & tidy up (restorable trash) | L | **Opus** (safety-critical fs) | P0 (`forgetSession`, `removeAgents`) |
| 4 | **P4b** | Game feel: camera, transitions, adaptive quality | M | Sonnet | P0 (frameStats in scene-bus) |
| 5 | **P3** | Completeness (🩺 Health view + score) | M | Sonnet | P2's exported `classifyCandidates` + `renderCleanup` (contract below) |

Why this order: 1:1s are the most direct form of "control your agents". P4a is the headline ask ("feels like a game") and is the part people see. P2 is necessary hygiene but it's the risky one. P4b polishes. P3 uses P2's data.

Start after the 4 builders editing agent-world now have landed. Run P1, P2, P4a, P4b, P3 in parallel once P0 is merged.

### Ownership rules (all packages)
- No package edits a file another package owns. Hub files (`server/features/index.ts`, `client/src/features/index.ts`, `client/src/views/index.ts`) get **only the exact lines listed**, in a final commit of their own per package. The additions are line-additive, so merges are trivial.
- `main.ts`, `shell/shell.ts`, `scene/agents.ts`, `state.ts`, `server/db.ts`: P0 edits them first. After that, only the package named below may touch them.
- TS strict, no `any`, no `console.*`. Use `ctx.log` / `client/src/log.ts`. Scope CSS per module. 12 px minimum text, 32 px targets. Comic kit tokens.
- Safety constraints carried from README "Safety": loopback only, user-click only (never Jev- or agent-initiated), argv-only execFile, no shell interpolation of transcript text.

---

## P0 — Hub seams (S, serial, lands first, one commit per concern)

Goal: the small core APIs the packages need, so none of them has to edit hubs.

| File | Change |
|---|---|
| `server/db.ts` | `forgetSession(id: string): { offsetsDeleted: number }`: in one transaction, `DELETE FROM sessions WHERE id=?`, `DELETE FROM edges WHERE from_id=? OR to_id=?` (🧪 check the column names at l.114), `DELETE FROM file_offsets WHERE path LIKE '%/'||?||'.jsonl'`. With the offset row gone, a restored file is re-indexed from byte 0 (rename keeps mtime). |
| `client/src/state.ts` | `removeAgents(ids: readonly string[])` + `onAgentsRemoved(fn)` event. |
| `client/src/scene/agents.ts` | `hide(ids: ReadonlySet<string>)` composes with `setFilter`: hides the house, creature, car and plane, and unregisters the pick. Instant; P4a adds the pack-up animation. |
| `client/src/main.ts` | Wire `store.onAgentsRemoved → agentsVisual.hide`. Deselect if the selected agent is gone. Write a rolling `frameStats {fps1s, p95ms10s}` into the scene-bus every 0.5 s. |
| `client/src/scene/scene-bus.ts` | Add `frameStats?: { fps: number; p95ms: number }` to `SceneParts`. |
| `shared/stations.ts` (new) | `type StationId = "bash"|"edit"|"read"|"search"|"web"|"mcp"|"skill"|"agent"|"todo"|"other"`; `stationOf(toolName)` (move the table out of `orbit-lib.ts`; `mcp__*` maps to mcp); `STATIONS: Record<StationId,{emoji,label,color}>`. This is the one icon + color per tool from the round 9 decision. + `shared/stations.test.ts`. |

Tests: `server/test/db-forget.test.ts` (forget, then an index pass on a restored file re-creates the row with the same messageCount), `state` removal unit test, stations table test.
Verify: `npm run typecheck && npm test`. The app boots unchanged.

---

## P1 — One-on-ones 💬 (L) — rank 1

**Decision: a new view, not a mode of Room.**
- Option A, a mode inside Room: good because the agent sits in its own room. Bad because `views/room.ts` is 40 KB, is probably being edited right now, and a mode would double its state machine.
- Option B, a new view that **reuses `createRoom3D`** for the backdrop (pick): the same "sit across the desk" look, disjoint files, and its own route to deep-link from Inbox, Feed and arrows.
- Option C, a right-panel chat: cheap, but it's a 360 px column. Nothing to see.

### UX (zero learning curve)
- Route `#/one-on-one/<agentId>`. Top bar 💬 "1:1". Key `O` (🧪 check it doesn't collide: the view registry throws on duplicates at startup). `usesPlanet: true, coversPlanet: true`.
- **Left 40%**: the agent's room (`createRoom3D`, `setStage` = left rect). The creature is animated by its state, the lamp shows its mood, the plant grows with its tokens. Hidden on a phone (≤520 px).
- **Right 60%: the conversation card**, top to bottom:
  1. **Header**: title, city, state chip, model, "$ today · active 1h12" (usage API), branch and ahead/behind (fork API).
  2. **Agenda** (3 rows, always readable in 5 s): **Did** (≤3 lines), **Blocked** (≤2), **Needs you** (≤2, bold, yellow). Each row can carry a small Jev chip ("Jev: needs a decision · 82%"). Without a key the chip says "rules". One-line "Why?" shows the source line.
  3. **Pending approval** inline, when there is one: the tool and command, with hold-1s Approve / Deny (reuses `courier/hold.ts` → `POST /api/approvals/:id/decision`).
  4. **History**: the last 40 turns, newest at the bottom. User bubbles on the right, the agent on the left. Tool calls collapse into station chips (`🔧 Bash ×3 · ✏️ Edit ×2`). Click a chip to expand the redacted summaries. Text is redacted and capped at 800 chars per turn, with "show more".
  5. **Composer**, by reach:
     - `tmux` (world-launched): textarea + **Send** (↵). Plus a **Stop** button while it's working (interrupt). Sent text shows as "sending…", then "delivered". The reply streams in as new activity arrives.
     - `resume` (dormant, not in tmux): the composer is disabled and a big **"▶ Resume here in tmux"** button calls `resumeInTmux`. When `onTalkChange` reports a binding, the composer turns on ("Now connected").
     - `terminal-live` (live in someone's own Terminal or VS Code): read-only, "It's running in your own terminal. Type there, or Stop it there". Button: "Open in VS Code".
     - A prompt on screen (409 from talk): the composer shows "Answer its prompt first" and scrolls to the approval.
- **Left sidebar sections**: **Queue** (list: every agent that needs you first, then permission › waiting › working › idle, each with a state dot and a one-line need). `[` / `]` move to the prev/next 1:1, so a morning run is one key per agent. **This agent**: Room · Code · Fork · 🪦 Retire (P2 export `retireAgents`, hidden when live).
- Entry points (all opt-in integration lines, listed so the owners add them later): Inbox row ▸ "1:1". Feed awaiting item. P4a's "calls for you" arrow and house click while it's waiting. Palette "1:1 with <title>" (via the P1 entry feature). Room dock button.

### Server — `server/features/one-on-one.ts` (id `one-on-one`)
- `GET /api/one-on-one/:agentId?turns=40` → `OneOnOneBrief`:
  `{ agent:{id,title,cwd,islandId,state,model}, reach:{kind:"tmux"|"resume"|"terminal-live", tmuxName?:string, reason:string}, turns: Turn[], digest:{did:Item[], blocked:Item[], needs:Item[]}, todos, pendingApproval|null, jsonlMtime }`
  - **Tail read**: open the jsonl (`findSessionJsonl`) and read the last 2 MB, dropping the first partial line. Never read the whole 64 MB. This needs its own parser because `parseTranscript` drops `tool_result`, and "blocked" needs `is_error`.
  - **Digest rules** (deterministic, each item keeps `sourceAt` for "Why?"):
    - did = unique Edit/Write/NotebookEdit file basenames + `git commit -m` subjects from Bash inputs + completed todos
    - blocked = the last ≤3 `tool_result.is_error` (tool + first line of the error) + the permission state + repeated identical failing Bash commands
    - needs = pending approval, `awaitingInput` + the last assistant text ending in "?" (≤200 chars), and an open todo that is `in_progress` with no activity for 15 min
  - Everything passes through `redactSecrets` (`server/heuristics.ts:146`).
  - **Reach**: a tmux binding exists and `has-session` succeeds (`boundTmuxSession`) → tmux. Otherwise live → terminal-live. Otherwise → resume.
- `POST /api/one-on-one/:agentId/agenda` → `{ source:"jev"|"rules", needsKind, needsP, urgency, first:itemId, probabilities }`. One batched TypeSafe body (`model: jev-latest`), state = the digest items + todos + state:
  - `needs_you`: Choice over `decision | approval | review_result | answer_question | unblock_error | nothing`
  - `urgency`: Score low/med/high
  - `first`: Choice over ≤6 agenda item ids (which to show first)
  - Cache key `(agentId, jsonlMtime)`. At most 1 call per 15 s across agents. No key or a 5xx falls back to rules. Jev never writes the text: it only ranks and classifies. The text comes from the transcript.
- Sending, resuming, stopping and approving reuse the existing routes. **No new write route.**

### Client files (P1 owns)
`client/src/views/one-on-one.ts`, `views/one-on-one-lib.ts` (+`.test.ts`), `views/one-on-one.css`, `views/one-on-one-css.d.ts`, `client/src/features/one-on-one-entry.ts` (palette commands + an `openOneOnOne(ctx,id)` export), `shared/features/one-on-one.ts`, `server/features/one-on-one.ts`, `server/features/one-on-one-lib.ts`, `server/test/one-on-one.test.ts`.
Live updates: the view subscribes to `store` activities for this agent → optimistic "…working: Edit foo.ts" line + a brief refetch debounced to 2 s. A 10 s poll is the fallback. Unmount disposes Room3D and the listeners.

### Hub lines
- `server/features/index.ts`: `import { oneOnOneFeature } from "./one-on-one.js";` + array entry `oneOnOneFeature,` under a new `// Wave 2 (round 10)` comment.
- `client/src/features/index.ts`: `import { oneOnOneEntryFeature } from "./one-on-one-entry";` + `oneOnOneEntryFeature,` after `councilFeature,`.
- `client/src/views/index.ts`: `import { oneOnOneView } from "./one-on-one";` + `oneOnOneView,` right after `roomView,`.

### Tests
Server:
- tail read with a partial first line
- digest from a fixture jsonl (edits → did, `is_error` → blocked, trailing "?" → needs, a secret in a Bash command is redacted)
- reach matrix with a stub `TalkExec` (bound+alive / bound+dead / live unbound / dormant)
- the Jev body shape, the fallback on no key / 500 / timeout, a cache hit makes no second call, the 15 s budget
- invalid uuid → 400, unknown → 404

Client lib:
- queue ordering
- composer state machine (tmux / resume→bound / terminal-live / prompt-409)
- turn collapsing into station chips

### Verify
- `curl localhost:5179/api/one-on-one/<a real dormant id>` (read-only)
- a talk round trip against a throwaway `aw-qa-1on1` tmux session, the way round 7 did it
- Playwright on swiftshader: screenshots at 1280 and 390 for tmux, resume and approval states
- `/qa` across the view

---

## P2 — Retire & tidy up 🪦 (L, Opus) — rank 3

Principle: **nothing is ever deleted.** "Retire" = move the files to `~/.alef-trash/<YYYY-MM-DD>/<batchId>/` with a manifest, hide the agent, and restore in one click. Every action is a click. Nothing runs on a timer. Live sessions are refused on the server, whatever the client sends.

### What can be retired (the only paths P2 may ever move)
- `<projectsDir>/<projDir>/<uuid>.jsonl`, where `<uuid>` passes `isValidUuid`
- `<projectsDir>/<projDir>/<uuid>/`, only when the folder name equals the same uuid (it holds `subagents/` and `tool-results/`)
- Guards, checked on the realpath before and after symlinks: inside `realpath(~/.claude/projects)`, a direct child of a direct child, never a folder that starts with `memory`, never anything else under `~/.claude`. `projectsDir` comes from `ctx.config.projectsDir` (✅ `server/index.ts:89`).

### Live-guard (re-checked at action time, per id; any hit refuses)
- `worldViews().agents[id].status === "live"`
- jsonl mtime < 30 min ago
- a talk binding for the id has a live tmux session
- the id is in `processVouchedSessions` for the current `liveClaudeCwds()`
- the id appears in any `ps` argv (`--resume <id>`)
- a pending approval for the id

### Suggestion buckets — `GET /api/cleanup/candidates?tiny=5&dormantDays=90`
| Bucket | Rule | Today (✅ from /api/world) |
|---|---|---|
| `headless` one-shots | ≤3 messages AND no tool_use AND the first user content was a queued `claude -p` prompt (🧪 confirm an `entrypoint` field or `queue-operation` first line is a reliable marker) | ≥61 (the session-groups classifier, 5.5 MB) |
| `empty` | 0 user or assistant turns | a few (to be measured) |
| `tiny` | messageCount < N (chips 3 / 5 / 10, default 5) | ~116 at <5 |
| `dormant` | lastActive > D days (chips 14 / 30 / 90, default 90) | 0 at 90 · 59 at 14 |
| `worktree` | a dir under `~/.alef-worktrees/<repo>/<name>` missing from its repo's `git worktree list`, or whose repo is gone, or with no session touching it for 14 days | 0 (the root doesn't exist yet) |
| `tmux` | `tmux list-sessions -F '#{session_name} #{pane_dead} #{pane_current_command}'` matching `^aw-`, where the pane is dead or the command is a shell (claude exited) and it isn't bound to a live agent | to be measured |

Each item carries `bytes` (jsonl + recursive size of the uuid folder), `reason`, and `protected?: string` (live-guard reason, shown greyed, not selectable). The response also has `totals: {bytes, count, protectedCount}`. Cached for 60 s and invalidated after any retire or restore.

### Actions
- `POST /api/cleanup/retire {ids: string[] (≤200), compress?: boolean}` → `{batchId, results:[{id, ok, error?, bytes}]}`.
  1. Per id: re-run the guards.
  2. `fs.rename` to `~/.alef-trash/<date>/<batchId>/<projDir>/…`. Same volume, so it's atomic.
  3. If `compress`: gzip, read back and check the sha256 matches the original, and only then unlink the renamed original.
  4. Write `manifest.json` `{batchId, at, items:[{sessionId,title,cwd,messageCount,lastActive,from[],to[],bytes,sha256,compressed}]}` and append one line to `~/.alef-trash/log.jsonl`.
  5. `ctx.db.forgetSession(id)`, then emit `{kind:"retired", ids}`.
- `GET /api/cleanup/trash` → the batches, newest first, with their manifests.
- `POST /api/cleanup/restore {batchId, ids?}`: never overwrites (409 if the destination exists). gunzip + sha256 check when compressed, rename back, then remove the empty trash dirs. The indexer brings the agent back within 10 s (the offset row was deleted) and emits `{kind:"restored", ids}`. The client says "It will appear after the next index pass". 🧪 A new house needs a page reload because geometry is laid out once: say so on screen, or P0 could add a runtime `upsert` for new houses as a follow-up.
- `POST /api/cleanup/tmux/:name/close`: only `^aw-[a-z0-9]{4,16}$` that is still dead at action time. `capture-pane -p -S -` → `~/.alef-trash/<date>/tmux/<name>.txt`, then `kill-session -t =name`. The scrollback is kept as text.
- Worktrees: no new route. The client calls the existing `POST /api/fork/remove` (clean trees only, never `--force`, the branch stays, so it's recoverable with `git worktree add`). Dirty trees show "Has changes: open in Finder".

### Honest disk figure
Header: **"212 MB could leave `~/.claude/projects` (Claude's /resume list and Alef's index get smaller). Alef never deletes: the files move to `~/.alef-trash`, and the space comes back when you empty that folder yourself."** The number is illustrative: compute it from the real candidates. Plus a **Show trash in Finder** button (`open -R`, argv). The compress toggle reads "saves about 45%" (measured 1.8× on one 7.3 MB file ✅; recompute from the first batch).

### Client (P2 owns)
- `client/src/features/cleanup.ts` (ClientFeature `cleanup`):
  - `onMessage` retired/restored → `store.removeAgents`
  - palette "Tidy up…" and "Show trash"
  - a Settings row "🧹 Tidy up" → `showView("health","tidy")`
  - exports **`retireAgents(ctx, ids): Promise<RetireResult>`** (click, then toast "Retired 3 · Undo" for 10 s; Undo → restore) and **`renderCleanup(host: HTMLElement, ctx: ClientContext): () => void`** (the whole Tidy UI, mounted by P3's Health view)
- `client/src/features/cleanup-lib.ts` (+test), `cleanup.css`, `cleanup-css.d.ts`, `shared/features/cleanup.ts`.
- Tidy UI: one bucket card per row, "🪦 61 one-shot headless runs · 5.5 MB [Review ▾] [Retire all]". Review opens rows with checkboxes (title, city, last active, size, reason). Protected rows are greyed with the reason. A sticky footer "Retire 61 selected · 5.5 MB". The **Trash** section lists batches by date with "Restore all / per item" and "Show in Finder".
- In-world: retiring plays P4a's pack-up puff (if it's there) before the hide.

### Server files (P2 owns)
`server/features/cleanup.ts`, `cleanup-lib.ts` (pure: bucket rules, path guards, live-guard evaluation over plain inputs; exports **`classifyCandidates(input): CandidateBuckets`** for P3), `cleanup-trash.ts` (fs: rename, gzip+verify, manifest, restore; dependency-injected `home`/`projectsDir`/`fs`), `cleanup-tmux.ts` (stub-able exec like `TalkExec`), `server/test/cleanup.test.ts`, `server/test/cleanup-trash.test.ts`.

### Hub lines
- `server/features/index.ts`: `import { cleanupFeature } from "./cleanup.js";` + `cleanupFeature,`
- `client/src/features/index.ts`: `import { cleanupFeature } from "./cleanup";` + `cleanupFeature,` after `oneOnOneEntryFeature,`

### Tests
Everything runs on a **tmp fake home + fake projectsDir, never the real `~/.claude`**:
- refuses a non-uuid, `memory/`, `memory.bak-x/`, a symlink escaping the root, `../` and a sibling project
- refuses live for each guard reason
- rename round trip keeps bytes and mtime
- compress round trip keeps the sha256 identical; a corrupted gz refuses the restore
- restore never overwrites
- the manifest is written before the db forget, and a crash between the steps leaves a restorable state
- 201 ids → 400
- tmux close refuses a bound or alive pane
- bucket rules against fixture sessions

### Verify
- The tests above.
- One manual end-to-end on the machine with **one** real dead classifier session: retire → gone from the world within 5 s → the file is in `~/.alef-trash/<date>/…` with its manifest → Restore → back after a reload with the same messageCount.
- `/qa` of the Tidy tab.
- Grep the diff for `unlink|rm(|rmSync|--force`. The only `unlink` allowed is after a verified gzip.

---

## P3 — Completeness 🩺 (M) — rank 5

Goal: a local score and checklist of "is my Alef setup whole and healthy", with one-click fixes only where the fix is safe and local.

### UX
- Status-bar chip **"🩺 92%"**: green ≥90, yellow ≥70, pink below. Click → `#/health`.
- View `health` (🩺 "Health", `usesPlanet:false`, no key). Tabs: **Checklist · Tidy up** (Tidy up = P2's `renderCleanup`).
- At the top, a big comic ring with the score and "3 things to fix". Checks are grouped **See · Control · Jev · Routines · Code · Tidy**. Each row: a dot, one line with the real number ("7 live claude processes, 7 visible ✓"), an expandable **Why**, and a **Fix** button only when there's a safe fix.
- When the score drops by ≥5 points, one Feed item (`kind:"system"`, stable id per day).

### Checks (id · how · pass · fix). Weights: critical 3, core 2, nice 1
| id | how (real source) | pass | safe fix |
|---|---|---|---|
| `index-coverage` (3) | count `*.jsonl` under `config.projectsDir` vs `db.listSessions().length` | db ≥ files − skipped-no-cwd | — (explain) |
| `live-visible` (3) | `liveClaudeCwds()` processes vs live agents; cwds with a process but no live agent | 0 invisible | — (lists the cwds) |
| `approvals-hook` (3) | read-only parse of `~/.claude/settings.json`: a PermissionRequest hook command contains `hooks/permission-request.mjs` of **this** repo; + `approvals.enabled` | both | toggle on (`POST /api/approvals/settings`); for a missing hook, "Show install steps" opens `hooks/install.md`. **Never writes settings.json** |
| `jev-key` (2) | `Boolean(process.env.TYPESAFE_API_KEY)` (never the value) + `jev.status==="online"` + last tick < 3 min | both | instructions only |
| `tmux` (2) | `talk.available` | true | copy `brew install tmux` |
| `terminal-pty` (2) | `stat` the node-pty `spawn-helper` execute bit (🧪 locate the build path) | executable | copy `npm_config_build_from_source=true npm rebuild node-pty` |
| `routines` (2) | `routines.state`: any `lastExitStatus ≠ 0` | none failing | open the Routines tab |
| `todo-files` (1) | the loops scan: count of `~/Documents/Code/*/tasks/todo.md` + age of whatsup `todos.json` | ≥1, and whatsup < 36 h | — |
| `tests` (2) | the last result in `data/completeness-tests.json` | ran < 24 h, 0 failed | **Run tests**: `execFile("npx",["vitest","run","--reporter=json"])` in the repo root, 180 s timeout, one run at a time (🧪 check the flag on vitest 5) |
| `broken-links` (1) | relative md links in README.md, docs/*.md, tasks/todo.md that point to missing files | 0 | — (lists them) |
| `deny-list` (2) | fork `loadDenyRules(defaultDenySources(home))` loads | loaded | — (says Fork refuses everything until then) |
| `indexes` (1) | `recall.ready`, `data/brain-index.json` age | ready, < 24 h | "Warm brain index" = GET `/api/brain/search?q=a` |
| `tidy` (1) | P2 `classifyCandidates` totals | < 25 items | "Open Tidy up" |
| `dead-tmux` (1) | P2 tmux bucket | 0 | "Open Tidy up" |
| `usage-prices` (1) | models seen without a price (usage store) | 0 | — |
| `fps` (2, client-side) | scene-bus `frameStats.fps` median over 10 s on Orbit | ≥ 40 | "Lower quality" → P4b quality tier |

- Score = passed weight ÷ total, with unknown excluded. States: pass / warn / fail / unknown.
- Cheap checks run on a 60 s `onTick` and publish `snapshotExtras["completeness.summary"]`. Tests and links run only on demand or at boot.
- Routes: `GET /api/completeness`, `POST /api/completeness/:checkId/fix` (only allowlisted fix ids), `POST /api/completeness/tests/run`.

### Files (P3 owns)
`server/features/completeness.ts`, `completeness-checks.ts` (pure evaluators over injected inputs), `completeness-fixes.ts`, `shared/features/completeness.ts`, `server/test/completeness.test.ts`, `client/src/views/health.ts`, `views/health-lib.ts` (+test), `views/health.css`, `views/health-css.d.ts`, `client/src/features/completeness.ts` (status chip, Feed item, fps sampler).

### Hub lines
- `server/features/index.ts`: `import { completenessFeature } from "./completeness.js";` + `completenessFeature,`
- `client/src/features/index.ts`: `import { completenessFeature } from "./completeness";` + `completenessFeature,` after `cleanupFeature,`
- `client/src/views/index.ts`: `import { healthView } from "./health";` + `healthView,` last

### Tests
- every evaluator on pass / fail / missing-input fixtures (settings.json absent, malformed, hook pointing to another repo)
- the score math
- the fix allowlist (an unknown id → 400)
- tests run is single-flight
- the key value is never in any response (assert the JSON has no substring of a fake key)

### Verify
- GET `/api/completeness` on the machine and compare 3 checks by hand (hook present ✅ today, Jev online ✅, tmux ✅).
- Playwright 1280/390.
- `/qa`.

---

## P4a — Game feel: world life & feedback (L) — rank 2

Goal: the planet is never still. Every agent's state reads at a glance, like units in an RTS. Finishing work is celebrated. Waiting agents come to you.

| # | Upgrade | Detail |
|---|---|---|
| 1 | **State animations per creature** (`scene/agents.ts`, instanced matrices, no new meshes) | working: fast hammer-bob synced to the activity rate (last 60 s events), plus a spark at the station. permission: jumps and waves, red "!" pip bounce. waiting: paces a 3-step loop in front of the door, turns to the camera every 4 s. idle: sits, slow breathing. sleeping: curled, pooled "Z" sprites (≤24 instanced quads) rising at night only. Crossfade 0.3 s between states. |
| 2 | **Tool stations at each live agent's lot** | 5 small props (bash anvil, edit desk, read shelf, web antenna, mcp plug) as ONE InstancedMesh per prop type, placed only for live agents (≤40). The prop matching `stationOf(activity.tool)` lights up (emissive pulse 0.8 s) and the creature turns to it. Colors and icons come from `shared/stations.ts`, the same ones P1 uses in chips. |
| 3 | **Celebrate** | a todo list going from not-all-done to all-done → "DONE!" burst (`ctx.labels.burst`) + confetti (one pooled 64-particle InstancedMesh, 1.2 s) + the existing chime. A Bash `git commit` in activity → "SHIPPED!". A subagent finishing → the drone lands with a sparkle. A retire → pack-up: the house shrinks and a dust puff plays over 0.6 s, then `hide`. Rate limit: ≤1 celebration per agent per 20 s, ≤3 on screen. |
| 4 | **Waiting agents call for you** | waiting/permission → the house pulses; every 15 s a speech bubble with its real last question (≤60 chars, redacted); plus an **edge arrow** for off-screen callers (pattern from `courier/hud.ts`, pooled ≤6 DOM arrows). Click the arrow or the bubble → `#/one-on-one/<id>` (P1). Soft ding at most once per agent per state change (existing sound feature). |
| 5 | **Idle life on the continuous day loop** | the sky's real day/night drives house windows going warm-emissive at night and streetlight glow (the key light still never changes, per README). Two flocks of birds (instanced, 12 each) by day. Cars keep ring-road loops for live agents. |
| 6 | **Arrival** | a new live session: its house "pops" (scale 0 → 1.1 → 1, 0.4 s) and a car rolls out of the city tower (`spawnDispatchCar` exists). |

- Files (P4a owns): `client/src/scene/agents.ts` (after P0), `client/src/scene/cities.ts` (window/streetlight emissive), `client/src/features/game-feel/life.ts`, `game-feel/celebrate.ts`, `game-feel/call-for-you.ts`, `game-feel/stations-props.ts`, `game-feel/game-feel.ts` (ClientFeature `game-feel`, composes them), `game-feel/game-feel-lib.ts` (+test: state→anim mapping, rate limiters, "todo became complete" edge detector, bubble text sanitizer), `game-feel/game-feel.css`, `game-feel/css.d.ts`.
- Hub line: `client/src/features/index.ts`: `import { gameFeelFeature } from "./game-feel/game-feel";` + `gameFeelFeature,` **last** (after `orbitFiltersFeature`, so it respects filter visibility).
- `prefers-reduced-motion`: no bob or confetti, and arrows stay (they're information).

## P4b — Game feel: camera, transitions, adaptive quality (M) — rank 4

| # | Upgrade | Detail |
|---|---|---|
| 1 | **Fly timing** (`main.ts` flyToDir/updateFly) | duration = clamp(0.6 + 0.9·arcAngle/π, 0.6, 1.5) s, so short hops feel snappy. A 6% overshoot-and-settle (easeOutBack on distance only) on arrival at an agent. Input during a fly cancels it smoothly (blend 0.25 s) instead of snapping. |
| 2 | **Idle camera** | after 20 s with no input on Orbit (not zen), a slow breathing dolly of ±2% distance and a 0.02 rad/s drift toward the busiest city. Any input stops it at once. |
| 3 | **View transitions** (`shell/shell.ts` + new `shell/transitions.css`) | 160 ms cross-fade of `#alef-view`. Planet→planet views keep the canvas and ease the camera. Planet→non-planet fades the canvas out after the fade (so the loop pause doesn't hitch). Room/1:1 entry keeps the existing "dive through the house" (fe03166). |
| 4 | **Adaptive quality** (`client/src/features/game-feel/quality.ts`, reads `frameStats`) | tier 0: pixelRatio min(dpr,2), all effects. Tier 1: pixelRatio 1.5, halve the particle caps, fewer bird flocks. Tier 2: pixelRatio 1, no confetti or birds, Z sprites ≤8. Step down when fps < 40 for 3 s, step up when > 55 for 10 s. Settings row "Quality: Auto / High / Low". Uses `sceneParts().rig.renderer.setPixelRatio` (no hub). Exposes `setQualityTier` for P3's fix. |

- Files (P4b owns): `client/src/main.ts` (after P0; only the fly block l.508-560 and the idle-camera hook in the orbit branch of `animate`), `client/src/shell/shell.ts` (view-switch fade only), `client/src/shell/transitions.css` (new), `client/src/features/game-feel/quality.ts` + `quality-lib.ts` (+test: tier hysteresis, fly duration fn). Quality registers through P4a's `game-feel.ts`. **Agreed interface**: `game-feel.ts` imports `{ qualityController }` from `./quality` — the only cross-file touchpoint, a stub is created by whoever lands first.
- Hub lines: none beyond P4a's.

### Performance budget (P4a + P4b together)
- Target **≥ 40 fps on this M-series Mac** at 1280 with 350 agents and 7 live, on Orbit auto-rotate plus a celebration going on. 🧪 There's no measured M-series baseline in the repo for the planet (README only gives 60 fps for the Canvas view on an M3 Pro). **Measure a baseline first** with a `?perf=1` sampler (P4b) that logs p50/p95 frame ms for 20 s.
- Added `onFrame` work ≤ **1.0 ms p95** in total, zero per-frame allocations (reused Vector3/Matrix4), ≤ **4 extra draw calls** (confetti, Z sprites, birds, station props: all instanced), ≤ 12 DOM overlays moved per frame, no layout reads (`getBoundingClientRect`) in the frame loop.
- The headless swiftshader run at ~12 fps is accepted. Tests assert logic, not fps. Adaptive quality must not step down under `?perf=headless` (to keep screenshots stable).

### Verify (P4a, P4b)
- vitest libs
- Playwright swiftshader shots with `?time=22:00` (night windows, Zs) and `?time=12:00`, a forced state fixture (`?demo=states`, a debug param in the P4a feature only), celebration mid-burst, off-screen arrow
- **manual on the Mac**: the fps chip ≥ 40 in all of the above and p95 from `?perf=1` before/after (report both numbers)
- `/qa` across all views for transition regressions

---

## 2. Consolidated hub lines (the orchestrator applies them at merge, in this order)

```ts
// server/features/index.ts: imports (alphabetical with the others)
import { cleanupFeature } from "./cleanup.js";
import { completenessFeature } from "./completeness.js";
import { oneOnOneFeature } from "./one-on-one.js";
// array, after councilFeature,
  // Wave 2 (round 10)
  oneOnOneFeature,
  cleanupFeature,
  completenessFeature,

// client/src/features/index.ts
import { cleanupFeature } from "./cleanup";
import { completenessFeature } from "./completeness";
import { gameFeelFeature } from "./game-feel/game-feel";
import { oneOnOneEntryFeature } from "./one-on-one-entry";
// array: after councilFeature,
  // Wave 2 (round 10)
  oneOnOneEntryFeature,
  cleanupFeature,
  completenessFeature,
// …and at the very end, after orbitFiltersFeature,
  gameFeelFeature,

// client/src/views/index.ts
import { healthView } from "./health";
import { oneOnOneView } from "./one-on-one";
// array: roomView, oneOnOneView, courierView, … brainView, healthView
```

## 3. Cross-package contracts (fixed now so the packages run in parallel)
- `shared/stations.ts` (P0): `StationId`, `stationOf(tool)`, `STATIONS`.
- P2 → P1/P3: `retireAgents(ctx, ids)`, `renderCleanup(host, ctx) => cleanup`, `classifyCandidates(input) => { buckets, totals }` (server, pure).
- P1 → P4a: route `#/one-on-one/<id>`, `openOneOnOne(ctx, id)`.
- P4b → P3: `setQualityTier(t: 0|1|2|"auto")`.
- P0 → P2/P4a: `db.forgetSession`, `store.removeAgents/onAgentsRemoved`, `agentsVisual.hide`, `sceneParts().frameStats`.

## 4. Deliberately NOT in this wave
From round 9 item 4, still open: bottom data dock with graphs, Control-room grid, Mac control (aleph `server.js:781-857` port), auto agent setup (session-groups `sg.py` classify port). Also: a Claude-written 1:1 summary (it would cost a headless `claude -p` call per click, and the memory warns that headless runs can exit 0 having done nothing: verify the artifact, not the exit code), and runtime house creation for restored or new agents (needs a layout change).

## 5. Open questions for Alex (with my pick)
1. The retire default: **plain move (pick)** / compress to gzip (≈1.8× measured on one file, slower, sha-verified) / move + offer to empty the trash (rejected: that's deleting).
2. The 1:1 key: **`O` (pick)** / no key, entry from Inbox and arrows only.
3. The default dormant threshold, given the oldest session is 18 days old: **keep 90 as asked, but show the 14/30 chips (pick)** / default to 14.
