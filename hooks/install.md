# Approvals hook (A2)

`hooks/permission-request.mjs` lets you answer Claude Code permission prompts from the world.
Claude Code runs it on the `PermissionRequest` event, which fires only when Claude would
show a permission prompt. It does not fire in `claude -p`.

## What it does

1. POSTs the hook payload (tool name, input, session id, cwd) to `http://127.0.0.1:5179/api/approvals`.
   It allows 700ms to connect and trims every string to 3,000 chars.
2. If the world is closed, errors, or has its **Approvals in world** toggle OFF (the server answers 204),
   the hook exits 0 at once and prints nothing. You get the normal terminal prompt.
3. Otherwise it long-polls `GET /api/approvals/:id` for up to 60s:
   - **Approve** prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   - **Deny** prints the same shape with `"behavior":"deny"` and an optional `message`
   - **Open Terminal instead**, a timeout (the server expires requests after 65s), or the world
     going away mid-poll for more than 5s: the hook exits silently and the terminal prompt appears.

stdout carries only that one decision line. Errors go to stderr.

## Install

Easiest: Health › "Approvals hook installed" › **Install (preview diff)** shows the exact
settings.json diff, and writes it (after a timestamped backup) only when you click **Install**.

From a shell, print the diff (this writes nothing), then apply it (backs up settings.json first):

```sh
node scripts/install-approvals-hook.mjs
node scripts/install-approvals-hook.mjs --apply
```

Or merge the `hooks.PermissionRequest` entry into `~/.claude/settings.json` by hand. Use `matcher: ""`
(all tools) and `timeout: 70` (seconds, so the 60s poll always finishes first). If you already
have `PermissionRequest` hooks, append to that array instead of replacing it.

## Uninstall / pause

- Pause: click **Approvals: ON** in the world's header. The hook then falls through at once.
- Remove: delete the entry from `~/.claude/settings.json`.

## Risks

- Any local process can POST a decision to the loopback API. The guard stops browsers on
  other sites (JSON-only writes, Origin check) but not local software.
- When the world is open but you are not looking at it, a prompt waits up to 60s before it
  falls back to the terminal.

# Watchdog (launchd): bring Alef back after a reboot

`scripts/alef-watchdog.sh` restarts the live Alef when it is down. launchd runs it at login and
every 5 minutes (`StartInterval` 300 + `RunAtLoad`). Each run:

- `GET http://127.0.0.1:5179/api/health` answers 200: it does nothing and logs nothing.
- Not 200 and nothing listens on :5179: it runs `$HOME/.alef-loop/bin/alef-live start` and logs one line
  with the exit code and the API's answer afterwards.
- Not 200 but something listens on :5179 (still booting, or not Alef's): it starts nothing and logs one line.

It never kills a process and always exits 0 (Health's Routines check would read a non-zero exit as a
failing routine). It uses absolute paths and sets its own `PATH` (`/opt/homebrew/bin` first), since
launchd starts it without a login shell. Log: `~/Library/Logs/alef/watchdog.log` (trimmed to its last
500 lines past 1 MB). launchd's own stdout/stderr for the job go to `watchdog.launchd.log` next to it.

The plist sets `AbandonProcessGroup` to true, and it must stay. `alef-live start` backgrounds the server
and vite with `nohup`, which does not move them out of the watchdog job's process group. launchd.plist(5):
"When a job dies, launchd kills any remaining processes with the same process group ID as the job." Without
the key, the watchdog would log `ran alef-live start (exit 0), api now 200`, exit, and launchd would then
kill the server and vite it had just started. That would repeat every 5 minutes while the log reads as success.

Nothing in this repo installs it. To install (the script must be in the live checkout, so after this is
merged and deployed):

```sh
sed "s#__HOME__#$HOME#g" ~/.alef-live/hooks/launchd/com.stephane.alef-watchdog.plist.example \
  > ~/Library/LaunchAgents/com.stephane.alef-watchdog.plist
plutil -lint ~/Library/LaunchAgents/com.stephane.alef-watchdog.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stephane.alef-watchdog.plist
```

Pause it (Health then lists it as a paused routine): `launchctl bootout gui/$(id -u)/com.stephane.alef-watchdog`.
Uninstall: pause it, then `rm ~/Library/LaunchAgents/com.stephane.alef-watchdog.plist`.

## Known trap: launchd, iCloud and ~/Documents

A launchd job that touches `~/Documents` can exit 127 or get `EPERM`: macOS privacy controls (TCC) and
iCloud Drive's on-demand files both apply to it, and neither shows a dialog to a background job. So the
plist sets no `WorkingDirectory`, and the script reads nothing under `~/Documents`: its own path is in
`~/.alef-live`, and it only calls `curl`, `lsof` and `alef-live`.

The server that `alef-live start` launches still reads `~/Documents`: `~/.alef-live/node_modules` and
`~/.alef-live/data` are symlinks into `~/Documents/Code/agent-world`. Started from launchd, that server
may be refused those reads. If `watchdog.log` shows `ran alef-live start (exit 0), api now 000`, read
`~/Library/Logs/alef/server.log` for `EPERM` or `Operation not permitted`. The fix is on the Mac, not in
this script: grant the process access to the Documents folder in System Settings › Privacy & Security, or
move `node_modules` and `data` out of `~/Documents`.

Tried under launchd on 2026-09-29 (a throwaway LaunchAgent booting a worktree on another port): the
`~/Documents` reads worked. What hung was `~/Desktop`: the director's first tick asked
`server/canonical-repo.ts` for the repo of a deleted folder under it, which listed `~/Desktop`
synchronously, and `open()` blocked on a consent prompt no one saw. No error, no log line after
`[indexer] initial pass done`, never listening. From a terminal it answers at once, because Terminal
or VS Code already holds that grant.

What is guarded now: TCC gates opening contents inside a protected folder (`open`, `opendir`,
`readFile`), not a `stat` or `realpath` of the folder itself. `server/privacy-guard.ts`
(`isPrivacyGuarded`) is a deliberately wider list: `~/Desktop`, `~/Downloads`, `~/Library`,
`~/Movies`, `~/Music`, `~/Pictures` and `/Volumes`, in any letter case and also spelled
`/System/Volumes/Data/...`. `~/Documents` is not on it. Three background paths check it:

- `canonicalRepoRoot` (`server/canonical-repo.ts`: indexer, home placement, trips, backfills) returns
  no repo for a guarded path, before any fs call.
- `findGitRoot` (`server/repo-root.ts`: the indexer's 10 s pass, skills, memory layers, code) returns
  no git root for a guarded cwd, before any fs call.
- `folderTrust` (`server/trust.ts`: the trust list, launches) still stats `.git` in a guarded folder but
  never opens it: that folder counts as its own checkout, so `~/Downloads` stays listed and trustable.

Nothing else is guarded. A request-only path, such as `code.ts` listing a repo or chat/talk spawning in
a cwd, can still block a threadpool thread on a guarded cwd. If a boot hangs the same way again,
`sample <server pid> 5` shows the blocked call. Also: launchd's environment has no `TYPESAFE_API_KEY`,
so a watchdog-started server runs with Jev disabled (`status=disabled`).

Also known: if the API died but the client (vite, :5178) still runs, `alef-live start` answers "already
running" and starts nothing. The watchdog then logs the same line every 5 minutes; run
`~/.alef-loop/bin/alef-live restart` by hand.

## Known trap: a node upgrade drops the Documents grant

TCC grants the Documents folder per node binary path (`/opt/homebrew/Cellar/node/<ver>/bin/node`).
After `brew upgrade node`, the first launchd start of Alef blocks until Alex clicks Allow, or until
the new node gets Files & Folders or Full Disk Access in System Settings › Privacy & Security. Running
Alef once from Terminal does not grant it.
