# Round 10 plan: Alef becomes the primary interface

Status: **waiting for Alex's OK.** Nothing below gets built until he approves it. Anything not listed is out of scope.

## 1. Room screen → chat (runs on your Max plan)

- **Opening it:** clicking the screen in any Room zooms it into a chat panel over the room stage, with the 3D room dimmed behind it. Esc goes back to the room.
- **Engine:** your own `claude` CLI, headless (`-p --input-format stream-json --output-format stream-json`), started by Alef's server in the agent's folder. There is no API key and no per-token billing.
- **Panel:**
  - The header shows the agent, city, a model picker, the mode (normal, plan, accept edits), live agent count, and tokens and cost for this chat.
  - Messages stream in. Tool calls appear as station chips, and approvals show inline through Alef's existing hook.
  - The composer has a text box, attach files or images (button or drag and drop), Send and Stop.
- **Which session it talks to:**
  - A dormant agent is continued with `--resume <id>`.
  - A new chat can be started in any city.
  - If the agent is still open in a terminal or VS Code, the panel says "continuing here creates a fork" before the first send.
- **Model switching:** the model applies per message (`--resume` + `--model`), so you can switch mid-conversation.
- **Not in v1:** slash commands inside the panel.

## 2. Jev router (global, every Claude session on the Mac)

- **The hook:** one `UserPromptSubmit` hook, `~/.claude/hooks/jev-router.mjs`, added to `~/.claude/settings.json` with a backup taken first. It returns `additionalContext` holding the 2–4 notes or memories Jev picked plus one line of model advice ("this is Haiku work: /model haiku").
- **Why advice only:** a hook cannot switch the model. That's verified from the raw docs.
- **No stacking:** it takes over the ranking step of the memory-recall hook rather than adding a third hook beside memory-recall and skill-router. Both of those keep working if Jev is down.
- **Budget:** 2.5 s. On timeout or error it adds nothing and your prompt goes through untouched.
- **Inside Alef's chat:** Jev's model pick is applied, not just advised. You see it before sending and can override it.

## 3. Jev as president (proposes, never launches)

- **What Jev reads:** about every 30 min it looks at open loops, failing Health checks, stale `tasks/todo.md` items and dormant districts, then proposes at most 3 sessions at a time. Each proposal carries the task, city, model and why.
- **Where they show:** as "Jev proposes" rows in the existing **Inbox** tab. There's no new tab.
- **Your choices:** **Launch** (plan mode, through the existing dispatch) or **Dismiss**. Nothing starts without your click.

## 4. District merges (Jev proposes, you approve)

- **The proposal:** Jev proposes merging small dormant districts into a neighbour or into "Suburbs", as rows in the same Inbox list. For example: "merge 6 districts, 9 sessions, none active in 14 days".
- **What approving does:** it only changes the display, stored in `data/district-merges.json`. No files move. The planet re-lays out on the next reload, because city geometry is built once at load.
- **Undoing:** one Settings row, "Merged districts (N) · Undo", added inside the existing Settings. No regrouping.

## 5. System view (live architecture)

- **What it shows:** a view of the whole system, drawn live in the Alef style. A prompt flows to hooks, then the Jev router, then the model, agents and subagents, tools and stations, then memory, the vault and routines. Live agents animate along the path in real time.
- **Where it lives:** it needs a top-bar icon (🗺️ System), which would be the 4th new icon.

## Order and checks

1. Chat, then the router, then president, then merges, then the System view.
2. Each ships as its own commit, with tests and a real-browser check, on `feat/mission-control` (PR #3).
3. For the global hook, I'll show you the `settings.json` diff before installing it.
