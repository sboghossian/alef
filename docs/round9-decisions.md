# Round 9 decisions — every surface, audit + Jev council

Generated 2026-09-25. Audit = one Sonnet pass over the code; council = Jev (TypeSafe) scoring the options through 4 personas (pragmatist, visionary, skeptic, user advocate), then one Claude synthesis (`POST /api/council`). Agreement = majority share among the personas.

**Status (2026-09-26): none of these are applied.** An overnight build of the agreed rows was reverted (cb4211a, 495cc0c) because Alex never approved them; only three bug fixes stayed (Claude FM popover overlap, conflict popover sides, the Ctrl-C "click twice" hint). Every row below waits for his tick.

| Surface | Kind | Decision | Agreement | Note |
|:--|:--|:--|:--|:--|
| Orbit (default 3D planet view) | view | Unify tool-station icons across views | 0.75 | agree |
| District (one city up close) | view | Fold District into Orbit's focus mode | 0.75 | agree |
| Room (single-agent interior) | view | Upgrade #/room/all in place into Control room | 1.00 | agree |
| Courier (fly-a-plane minigame) | view | HOLD — Alex decides | 0.75 | Audit: keep as its own view. Jev: fold into Orbit as a ride mode. Genuine split. |
| Canvas (orchestration graph) | view | Move its activity feed into the bottom data bar, demote the graph | 1.00 | agree |
| Board (kanban of every agent) | view | Unify Board's columns with agent-state's 5 states | 1.00 | agree |
| Voice (talk to Alef) | view | Fix the Alef/Jev naming split | 0.75 | agree |
| Code (read-only file browser) | view | Label the bare '⌖' icon | 0.75 | Same pick, Jev added the label text. |
| Brain (read-only vault browser) | view | Make Legend rows actually filter | 0.50 | agree |
| Inbox (right sidebar tab) | right-tab | Keep Inbox as its own tab | 1.00 | agree |
| Loops (right sidebar tab) | right-tab | Point quick-prompts' chip at this same tab | 1.00 | Jev returned no pick; audit recommendation used. |
| Feed (right sidebar tab) | right-tab | Keep Feed as the one true event stream | 0.75 | agree |
| Help (right sidebar tab, '?') | right-tab | Add a persistent '?' hint near the view switcher | 0.75 | agree |
| Settings (right sidebar tab) | right-tab | Group Settings into labeled sections | 0.50 | agree |
| Routines (right sidebar tab) | right-tab | Keep Routines read-only, cross-link to Automations | 1.00 | agree |
| Status bar readouts (cities/agents/subagents/links/tokens/waiting/Jev/fps) | status-item | Turn the drawer into an always-visible bottom data bar | 0.50 | agree |
| Claude FM (status bar music player) | status-item | Fix the popover's overlap with view content | 1.00 | agree |
| The one search / ⌘K palette | sidebar | Add a visible search affordance in the top bar | 0.75 | agree |
| Prompt / dispatch box | control | Add a guided auto-setup flow | 0.50 | agree |
| Automations modal (⚡) | control | Delete the 3 duplicate inline readers, point at canonical surfaces | 1.00 | agree |
| Global keyboard shortcuts | shortcut | Add lightweight persistent hint badges | 0.75 | agree |
| Subagent drones | control | Add a permanent Subagents status-bar chip | — | Council call failed (HTTP 400); audit recommendation used. |
| Fork into worktree | control | Also surface Fork from Code view's Repo section | 0.75 | agree |
| Ask the council | control | Add a cost/quota note before submit | 1.00 | agree |
| Usage chip (≈$X today · Yh) | status-item | Move into the bottom data bar as a spend-over-time chart | 0.75 | Alex's standing ask (all graphs in the bottom bar) outranks Jev's keep-as-is. |
| Sky / weather chip | status-item | Keep as-is | 1.00 | agree |
| Sound toggle | control | Keep as-is | 1.00 | agree |
| Talk to a live agent | control | Add a palette command for the standalone dispatch panel | 1.00 | agree |
| Approvals (permission-request card) | control | Keep both instant and hold-to-confirm models | 0.50 | agree |
| Agenda billboard | control | Keep as-is | 0.50 | agree |
| Todo progress cards | control | Keep, add a '+N more working' note past the 8-card cap | 0.75 | Jev's pick; trivial. |
| Conflict beams | control | Make the hover-chip's both sides individually clickable | 1.00 | agree |
| Agent state rings | control | Unify with Board's 4 columns | 1.00 | agree |
| Replay & daily report | control | Delete Automations' duplicate reader, point it here | 0.75 | agree |
| Skills panel | control | Keep as-is | 0.75 | agree |
