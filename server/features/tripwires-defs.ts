// The lesson tripwires: versioned rule definitions, one per lesson the fleet already paid for.
// Mined (read-only) from ~/.alef-loop/journal.md, ~/.alef-loop/LOOP.md and the standing warnings
// in ~/.claude/projects/-Users-alexboghossian/memory/MEMORY.md (+ the memory files they point
// to). Each regex was spot-checked against the last 7 days of real transcripts; the true and
// false cases in server/test/tripwires-lib.test.ts are those real commands.
//
// How a rule reads a Bash command (tripwires-lib.ts): heredoc bodies are dropped, and separators
// inside quotes, `#` comments and the `&` of `2>&1` are blanked. So `[^\n;&|]` means "inside one
// simple command", and AT means "a command starts here" (after an optional wrapper such as
// `rtk proxy`, `sudo`, `xargs -r`). A command merely MENTIONED in a commit message, a heredoc or
// a quoted note never starts at AT, which is what keeps the notes that record these lessons from
// tripping them. The body of a `bash -c '…'` is read as a command too, except by `topLevelOnly`
// rules (the RTK hook never rewrites inside one). Lookaheads and `NAME=` … `$NAME` spans are
// bounded (`{0,N}`), and text past MAX_MATCH_CHARS is never matched, so a pathological command
// can't stall the server.
//
// Bump TRIPWIRES_VERSION whenever a rule is added, removed or its meaning changes.

import type { TripwireDef } from "./tripwires-lib.js";

export const TRIPWIRES_VERSION = 2;

/** A `NAME=value` prefix (its value quoted or bare). */
const ASSIGN = String.raw`[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()"'])*`;
/** A command starts here: line start, a separator or `$(`, then wrappers (`then`, `rtk proxy`,
 *  `FOO=1`, …). */
const AT = String.raw`(?:^|[\n;&|(]|\$\()\s*(?:(?:then|do|else|rtk(?:\s+proxy)?|sudo|nohup|time|command|exec|xargs(?:\s+-\S+)*|env(?:\s+\w+=\S*)*)\s+|${ASSIGN}[ \t]+)*`;
/** `git`, optionally `-C <dir>`. */
const GIT = String.raw`git(?:\s+-C\s+\S+)?\s+`;
/** Main checkouts other sessions work in at the same time (never a worktree nested inside one). */
const SHARED_CHECKOUTS = String.raw`^~/(?:Documents/Code/(?:agent-world|acme-ai-next)|\.claude/skills-repo)(?!/(?:\.claude/)?\.?worktrees(?:/|$))(?:/|$)`;
/** An lsof call that is about a port (`-i`, `tcp:`, `:3000`). */
const LSOF_PORT = String.raw`lsof\b(?=[^)\n;&|]{0,200}?(?:-i|tcp:|:\d|:\$))`;
const NO_LISTEN_PAREN = String.raw`(?![^)]{0,400}-sTCP:LISTEN)`;
const NO_LISTEN_CMD = String.raw`(?![^\n;&|]{0,400}-sTCP:LISTEN)`;
/** From a `NAME=` assignment to the command that uses `$NAME`: at most this far apart. */
const LATER = String.raw`[\s\S]{0,4000}?`;
const ALEF_PORTS = String.raw`\b517[89]\b`;
/** A path under ~/Documents (iCloud Drive). */
const ICLOUD = String.raw`(?:~|\$HOME|\$\{HOME\}|/Users/[^/\s"']+)/Documents/`;
/** Commands whose pass/fail is the point of running them. */
const CHECK_CMD = String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|ci|install|test|lint|typecheck)\b|(?:npx|bunx)\s+(?:tsc|vitest|jest|eslint|nx\s+(?:build|run-many|test|lint)|next\s+build)\b|bun\s+build\b|\btsc\b)`;
/** The first command of a pipeline: the one the RTK hook rewrites (✅ checked with `rtk hook
 *  claude` / `rtk hook check`: it rewrites each pipeline's first command, including after `||` and
 *  after a `FOO=1` prefix, leaves later `| grep` alone, leaves a command that starts with
 *  `rtk proxy` untouched, and never rewrites `egrep` or inside `bash -c`). An explicit `rtk <cmd>`
 *  counts too. */
const PIPE_START = String.raw`(?:^|[\n;&(]|\|\||\$\()\s*(?:(?:then|do|else|sudo|time|command|env(?:\s+\w+=\S*)*|rtk(?!\s+proxy\b))\s+|${ASSIGN}[ \t]+)*`;
/** Test runners the RTK hook rewrites to its compact filter (`bunx vitest`, `bun test`, `npm test` are left alone). */
const RTK_TEST = String.raw`(?:(?:npx\s+)?(?:vitest|jest|playwright\s+test)|(?:python3?\s+-m\s+)?pytest)\b`;
/** A go-ahead to merge in a prompt Alex typed: "merge", "Merge all", "fix > QA > merge", "resolve
 *  conflicts then merge yourself". Not a merge in the same clause as a negation ("don't merge yet",
 *  "NEVER … or merge in the main checkout"), not "so I can merge" (he merges himself), and not a
 *  question ("what PRs to merge?"). A clause ends at . ! ? ; or a newline. */
const MERGE_GO_AHEAD = String.raw`(?<!\b(?:not?|never|\w*n['’]t|dont|cant|wont|cannot|without|avoid|stop|hold|I)\b[^.!?;\n]*)\bmerge\b(?![^.!?;\n]*\?)`;
/** A secret-looking needle in a search pattern. */
const SECRET_SIG = String.raw`(?:\bsk-|\bsk_(?:live|test)|\bgh[pousr]_|github_pat_|\bAKIA|\bxox[abprs]-|\bAIza|PRIVATE KEY|\b[a-z]+_live_)`;

export const TRIPWIRE_DEFS: readonly TripwireDef[] = [
  {
    id: "browse-restart-stop",
    lesson: "Never run `browse restart` / `browse stop` (even with --help): the browse daemon is one browser every session shares.",
    source: "~/.alef-loop/journal.md 2026-09-27 (#16) · LOOP.md hard limits",
    since: "2026-09-27",
    severity: "danger",
    tool: "^Bash$",
    match: [String.raw`${AT}(?:"?\$\{?B\}?"?|"?[^\s"';&|()]*\bbrowse"?)\s+(?:restart|stop)\b`],
  },
  {
    id: "kill-port-pidset",
    lesson: "Never kill a port's whole lsof PID set: it includes the shared Chromium. Use `lsof -ti tcp:PORT -sTCP:LISTEN`.",
    source: "MEMORY.md standing warning · project_browse_server_shared_across_agents (2026-09-21)",
    since: "2026-09-21",
    severity: "danger",
    tool: "^Bash$",
    match: [
      String.raw`${AT}kill\b[^\n;&|]{0,200}?\$\(\s*${LSOF_PORT}${NO_LISTEN_PAREN}[^)]{0,400}\)`,
      String.raw`${AT}${LSOF_PORT}${NO_LISTEN_CMD}[^\n;&|]{0,400}\|\s*xargs\b[^\n;&|]{0,200}\bkill\b`,
      String.raw`\b([A-Za-z_]\w*)=\$\(\s*${LSOF_PORT}${NO_LISTEN_PAREN}[^)]{0,400}\)${LATER}${AT}kill\b[^\n;&|]{0,200}?\$\{?\1\b`,
      String.raw`\bfor\s+([A-Za-z_]\w*)\s+in\s+\$\(\s*${LSOF_PORT}${NO_LISTEN_PAREN}[^)]{0,400}\)${LATER}${AT}kill\b[^\n;&|]{0,200}?\$\{?\1\b`,
    ],
  },
  {
    id: "alef-server-restart",
    lesson: "Never kill or restart the live Alef servers on 5178/5179: run a throwaway copy on your own ports.",
    source: "~/.alef-loop/LOOP.md hard limits (2026-09-27)",
    since: "2026-09-27",
    severity: "danger",
    tool: "^Bash$",
    match: [
      String.raw`${AT}kill\b[^\n;&|]{0,200}?\$\(\s*lsof\b[^)]{0,300}?${ALEF_PORTS}[^)]{0,300}\)`,
      String.raw`${AT}lsof\b[^\n;&|]{0,300}?${ALEF_PORTS}[^\n;&|]{0,300}\|\s*xargs\b[^\n;&|]{0,200}\bkill\b`,
      String.raw`\b([A-Za-z_]\w*)=\$\(\s*lsof\b[^)]{0,300}?${ALEF_PORTS}[^)]{0,300}\)${LATER}${AT}kill\b[^\n;&|]{0,200}?\$\{?\1\b`,
      String.raw`${AT}(?:pkill|killall)\b[^\n;&|]{0,200}?tsx\s+(?:watch\s+)?server/index\.ts`,
    ],
  },
  {
    id: "shared-checkout-stash",
    lesson: "Never `git stash` in a shared checkout (agent-world, acme-ai-next, skills-repo): it takes other sessions' uncommitted work.",
    source: "MEMORY.md standing warnings · project_acme_repo_concurrent_sessions (2026-09-01)",
    since: "2026-09-01",
    severity: "warn",
    tool: "^Bash$",
    match: [String.raw`${AT}${GIT}stash\b(?!\s+(?:list|show)\b)`],
    inDirs: SHARED_CHECKOUTS,
  },
  {
    id: "shared-checkout-discard",
    lesson: "Never `git reset --hard` / `checkout -- .` / `clean -f` in a shared checkout: other sessions' work is in that tree.",
    source: "MEMORY.md standing warnings · project_skills_repo_shared_across_sessions (2026-09-21)",
    since: "2026-09-21",
    severity: "danger",
    tool: "^Bash$",
    match: [String.raw`${AT}${GIT}(?:reset\b[^\n;&|]*\s--hard\b|checkout(?:\s+-q)?(?:\s+HEAD)?\s+--\s+\.(?=\s|$)|restore\b(?:\s+-\S+)*\s+\.(?=\s|$)|clean\b[^\n;&|]*\s-[a-zA-Z]*f)`],
    inDirs: SHARED_CHECKOUTS,
  },
  {
    id: "shared-checkout-branch",
    lesson: "Never switch branches in a shared main checkout: HEAD moves under every other session. Use a worktree.",
    source: "~/.alef-loop/LOOP.md step 3 · project_skills_repo_shared_across_sessions (2026-09-21)",
    since: "2026-09-21",
    severity: "warn",
    tool: "^Bash$",
    match: [String.raw`${AT}${GIT}(?:switch|checkout)\b(?![^\n;&|]*\s--(?:\s|$))(?!(?:\s+-q)?\s+(?:main|master)(?![\w/.-]))`],
    inDirs: SHARED_CHECKOUTS,
  },
  {
    id: "secret-scan-without-rtk-proxy",
    lesson: "Secret scans must start with `rtk proxy`: the rtk rewrite filtered `git log -p` and printed a clean result over a real key.",
    source: "MEMORY.md standing warning · feedback_rtk_hides_secret_scan_hits (2026-09-24)",
    since: "2026-09-24",
    severity: "danger",
    tool: "^Bash$",
    topLevelOnly: true,
    match: [
      // grep / rg for a secret as the pipeline's first command (rtk rewrites it to `rtk grep`)
      String.raw`${PIPE_START}(?:grep|rg)\b[^\n;&|]*${SECRET_SIG}`,
      // git log -p / git diff / git show / cat (rewritten) piped into a grep for a secret
      String.raw`${PIPE_START}(?:git(?:\s+-C\s+\S+)?\s+(?:log|diff|show)|cat)\b[^\n;&|]*(?:\|[^\n;&|]*)*?\|\s*(?:rtk\s+proxy\s+)?(?:grep|egrep|rg)\b[^\n;&|]*${SECRET_SIG}`,
    ],
  },
  {
    id: "tests-through-rtk-filter",
    lesson: "Tests run through the rtk filter and then piped to tail/grep hide failures: `rtk proxy <tests> > log 2>&1`, grep the log for FAIL.",
    source: "~/.alef-loop/LOOP.md step 4 · journal 2026-09-27",
    since: "2026-09-27",
    severity: "warn",
    tool: "^Bash$",
    topLevelOnly: true,
    match: [String.raw`${PIPE_START}${RTK_TEST}[^\n;&|]*\|\s*(?:tail|head|grep)\b`],
  },
  {
    id: "pipe-masks-exit-code",
    lesson: "A build/test piped into tail reports tail's exit code: `cmd > log 2>&1; echo EXIT=$?`, never `cmd | tail && …`.",
    source: "MEMORY.md standing warning · feedback_pipe_masks_exit_code (2026-09-07)",
    since: "2026-09-07",
    severity: "warn",
    tool: "^Bash$",
    match: [String.raw`${AT}${CHECK_CMD}[^\n;&|]*\|\s*(?:rtk\s+proxy\s+)?(?:tail|head)\b[^\n;&|]*(?:&&\s*\(?\s*(?:${CHECK_CMD}|(?:echo|printf)\s[^\n;&|]*?(?<![a-z])(?:ok|clean|pass(?:ed|es)?|success(?:ful)?|succeeded|green|parses)(?![a-z]))|;\s*echo\b[^\n;&|]*\$\?)`],
    flags: "i",
  },
  {
    id: "merge-without-review",
    lesson: "Don't `gh pr merge` a PR nobody reviewed: run an independent review first (or have Alex's go-ahead).",
    source: "~/.alef-loop/journal.md 2026-09-27 (iterations 1-2) · LOOP.md hard limits",
    since: "2026-09-27",
    severity: "warn",
    tool: "^Bash$",
    match: [String.raw`${AT}gh\s+pr\s+merge\b`],
    // One review covers one merge; Alex's go-ahead covers the merges that answer it. Neither
    // carries into a new run (the loop's next scheduled iteration).
    unlessEarlier: [
      { tool: "^(?:Agent|Task|Workflow|Skill|SendMessage)$", input: String.raw`\breview`, until: "match" },
      { tool: "grok_review|grok-review", until: "match" },
      { userText: MERGE_GO_AHEAD, until: "reply" },
    ],
  },
  {
    id: "ps-grep-counts-itself",
    lesson: "`ps | grep -c X` counts the grep itself: use `pgrep`, `grep -v grep` or a `[x]` pattern.",
    source: "~/.alef-loop/journal.md 2026-09-27 (iteration 4 dead end)",
    since: "2026-09-27",
    severity: "info",
    tool: "^Bash$",
    match: [String.raw`${AT}ps\b[^\n;&|]*\|\s*(?:rtk\s+proxy\s+)?grep\b(?:[^\n;&|]*\s(?:-(?=[a-zA-Z]*c)[a-zA-Z]+|--count)\b|[^\n;&]*\|\s*wc\s+-l\b)`],
    allow: [String.raw`grep\s+-v\s+(?:-\S+\s+)*["']?grep\b`, String.raw`\[[^\]\s]+\]`],
  },
  {
    id: "worktree-in-icloud",
    lesson: "Never put a git worktree under ~/Documents (iCloud): worktrees there ate 500 GB. Use ~/.alef-worktrees or ~/.acme-worktrees.",
    source: "MEMORY.md standing warning · project_disk_blowup_2026_09_15",
    since: "2026-09-15",
    severity: "danger",
    tool: "^Bash$",
    match: [
      String.raw`${AT}${GIT}worktree\s+add\b[^\n;&|]*\s["']?${ICLOUD}`,
      // the target held in a variable: WT=~/Documents/Code/x && git worktree add -b b "$WT"
      String.raw`\b([A-Za-z_]\w*)=["']?${ICLOUD}${LATER}${AT}${GIT}worktree\s+add\b[^\n;&|]*\s["']?\$\{?\1\b`,
    ],
  },
];
