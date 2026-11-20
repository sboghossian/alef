// Lesson tripwires: every rule against real commands from the last 7 days of transcripts (copied
// verbatim; the session cwd is the one the transcript recorded). A rule with no real repeat in
// that window gets its true case from a real command with one argument changed, marked as such.

import { describe, expect, it } from "vitest";
import { TRIPWIRE_DEFS } from "../features/tripwires-defs.js";
import {
  compileTripwires,
  effectiveDir,
  maskShell,
  matchToolUse,
  resolveDir,
  sanitizeSnippet,
  SNIPPET_MAX,
  stripHeredocs,
  TripwireTracker,
  userLineKind,
  type SessionMemory,
} from "../features/tripwires-lib.js";
import { assistantLine, userLine } from "./helpers.js";

const HOME = "/Users/alexboghossian";
const AW = `${HOME}/Documents/Code/agent-world`;
const ACME = `${HOME}/Documents/Code/acme-ai-next`;
const SKILLS = `${HOME}/.claude/skills-repo`;
const tws = compileTripwires(TRIPWIRE_DEFS);

function ids(command: string, cwd: string, memory?: SessionMemory): string[] {
  return matchToolUse(tws, { name: "Bash", input: { command } }, cwd, HOME, memory).map((m) => m.tripwire.def.id);
}

function trips(id: string, command: string, cwd: string): void {
  expect(ids(command, cwd), command).toContain(id);
}

function quiet(id: string, command: string, cwd: string): void {
  expect(ids(command, cwd), command).not.toContain(id);
}

describe("definitions", () => {
  it("compile, with unique kebab ids, a lesson, a source and a real date each", () => {
    expect(tws.length).toBeGreaterThanOrEqual(8);
    expect(tws.length).toBeLessThanOrEqual(12);
    expect(new Set(tws.map((t) => t.def.id)).size).toBe(tws.length);
    for (const { def } of tws) {
      expect(def.lesson.length).toBeGreaterThan(20);
      expect(def.lesson).not.toContain("\n");
      expect(def.source.length).toBeGreaterThan(5);
      expect(Number.isFinite(Date.parse(def.since))).toBe(true);
    }
  });

  it("only ever look at Bash commands", () => {
    expect(matchToolUse(tws, { name: "Read", input: { file_path: `${AW}/README.md`, command: '"$B" restart' } }, AW, HOME)).toEqual([]);
  });
});

describe("browse-restart-stop", () => {
  const id = "browse-restart-stop";
  it("trips on the real `browse restart --help` that took the shared browser down", () => {
    trips(id, 'B=~/.claude/skills/gstack/browse/dist/browse\n"$B" restart --help 2>&1 | head -20\necho "---"\nls ~/.claude/skills/gstack/browse/ 2>&1', AW);
    trips(id, "~/.claude/skills/gstack/browse/dist/browse stop", AW); // same binary, by path (real path, other verb)
  });
  it("stays quiet on normal tab work and on the notes that record the lesson", () => {
    quiet(id, 'B="$HOME/.claude/skills/gstack/browse/dist/browse"\n$B tab-new >/dev/null 2>&1 || true\n$B viewport 1440x900\n$B goto http://localhost:3113/', `${HOME}/.acme-worktrees/round-13`);
    quiet(id, 'kill -9 74419 2>/dev/null; sleep 2; echo "--- browse daemon health ---"; B="$HOME/.claude/skills/gstack/browse/dist/browse"; $B status 2>&1 | head -5', `${HOME}/.acme-worktrees/tick-1810`);
    // The loop editing LOOP.md and the journal (python heredoc + journal heredoc): text, not commands.
    quiet(
      id,
      "python3 - <<'EOF'\nimport os\np=os.path.expanduser('~/.alef-loop/LOOP.md');s=open(p).read()\ns=s.replace(\"- Never give the resident tools or execution.\",\"- Never run `browse restart`, `browse stop` or any browse subcommand to 'see its help'.\")\nopen(p,'w').write(s)\nEOF\ncat >> ~/.alef-loop/journal.md <<'EOF'\n- The builder restarted the SHARED browse daemon by running `browse restart --help`.\nEOF",
      AW,
    );
  });
});

describe("kill-port-pidset", () => {
  const id = "kill-port-pidset";
  it("trips on the real kills of a port's whole PID set", () => {
    trips(id, 'B=/Users/alexboghossian/.claude/skills/gstack/browse/dist/browse; $B closetab 2 >/dev/null 2>&1; pkill -f "nx start main" 2>/dev/null; lsof -ti:3199 2>/dev/null | xargs -r kill 2>/dev/null; echo cleaned', `${HOME}/.acme-worktrees/eng-3659`);
    trips(id, 'P=$(lsof -ti tcp:3742 2>/dev/null); echo "pids: $P"; [ -n "$P" ] && kill $P 2>/dev/null; sleep 2; curl -s -o /dev/null -w "%{http_code}\\n" --max-time 2 http://localhost:3742/ 2>/dev/null || echo "closed"', `${HOME}/.acme-worktrees/tick-1810`);
  });
  it("stays quiet when the kill is scoped to the listener, or kills a known pid", () => {
    quiet(id, 'PIDS=$(lsof -ti tcp:4399 -sTCP:LISTEN 2>/dev/null); echo "listener pids: $PIDS"; [ -n "$PIDS" ] && kill $PIDS; /bin/sleep 3; echo killed', `${HOME}/.acme-worktrees/tick-1899`);
    quiet(id, "cd ~/.acme-worktrees/gro-team-fix && lsof -ti tcp:3117 -sTCP:LISTEN | xargs -r kill 2>/dev/null; sleep 1; git status --porcelain | head -20", `${HOME}/.acme-worktrees/gro-team-fix`);
    quiet(id, "kill -9 74419 2>/dev/null; sleep 2; if lsof -ti tcp:3742 >/dev/null 2>&1; then echo \"port 3742 holders: $(lsof -ti tcp:3742 | tr '\\n' ' ')\"; else echo \"port 3742 closed\"; fi", `${HOME}/.acme-worktrees/tick-1810`);
    quiet(id, 'cd ~/.acme-worktrees/justinian-research; for p in $(lsof -t +D apps/main/.next 2>/dev/null | sort -u); do :; done; pkill -f "justinian-research.*next-build"; sleep 3', `${HOME}/.acme-worktrees/justinian-research`);
  });
});

describe("alef-server-restart", () => {
  const id = "alef-server-restart";
  it("trips on a real restart of the live 5179 server", () => {
    trips(id, "cd ~/Documents/Code/agent-world && S=/private/tmp/claude-501/x/scratchpad; P=$(lsof -ti tcp:5179 -sTCP:LISTEN); ps -o pid,command -p $P | tail -1; kill $P; rm -f data/world.db*; (npx tsx server/index.ts > $S/server.log 2>&1 &)", AW);
  });
  it("stays quiet on read-only port checks and on a throwaway port", () => {
    quiet(id, 'cd ~/Documents/Code/agent-world && lsof -ti tcp:5179 -sTCP:LISTEN; lsof -ti tcp:5178 -sTCP:LISTEN; D=$(date +%F); for u in "/api/health"; do curl -s -m 5 "http://127.0.0.1:5179$u" | head -c 600; done', AW);
    // The same restart shape, on the throwaway port the loop is told to use (real command, port changed).
    quiet(id, "P=$(lsof -ti tcp:5199 -sTCP:LISTEN); kill $P", `${HOME}/.alef-worktrees/lesson-tripwires`);
  });
});

describe("shared-checkout-stash", () => {
  const id = "shared-checkout-stash";
  it("trips on a real stash in the shared acme-ai-next checkout", () => {
    trips(id, 'cd ~/Documents/Code/acme-ai-next && export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH && git stash push --include-untracked -m "tick-1967 park untracked (restore me)" 2>&1 | tail -3; echo "--- stash list ---"; git stash list | head -3', ACME);
  });
  it("stays quiet in a worktree, behind a variable dir, on `stash list`, and in quoted notes", () => {
    quiet(id, 'cd ~/.alef-worktrees/hide-empty && git stash push -m "temp: hide-empty-islands fix (stashed for before/after measurement)" -- client/src/main.ts && git status --short', AW);
    quiet(id, 'export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH\nW=/Users/alexboghossian/.acme-worktrees/tick-1986\ncd "$W" && git stash push -u -m "batch2-fixer: all tick-1986+tick-1996 fixes before rebase" 2>&1\necho "stash exit=$?"', ACME);
    quiet(id, "git stash list | head -3", ACME);
    quiet(id, 'echo "- [batch2-fixer] 2) back in the original worktree, git stash push -u, git rebase feat/tick-1986-redact-before-you-prompt, then git stash pop — the 3-way merge auto-resolves" >> "$L"', ACME);
  });
});

describe("shared-checkout-discard", () => {
  const id = "shared-checkout-discard";
  // The real command cd's into a worktree first. No real repeat in 7 days, so the true case is the
  // same command without its `cd` line: then it runs in the shared checkout the session sits in.
  const real = "export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH\ncd /Users/alexboghossian/.acme-worktrees/tick-1982\ngit branch --show-current\ngit checkout feat/tick-1981-blog-buying-the-tool 2>&1\ngit reset --hard 01ca3d7cf 2>&1\ngit status";
  it("trips on reset --hard in the shared checkout (real command, cd removed)", () => {
    trips(id, real.replace("cd /Users/alexboghossian/.acme-worktrees/tick-1982\n", ""), ACME);
  });
  it("stays quiet when the same command runs in a worktree, and on the memory note about it", () => {
    quiet(id, real, ACME);
    quiet(id, "M=~/.claude/projects/-Users-alexboghossian/memory && cat > $M/project_skills_repo_shared_across_sessions.md <<'MD'\n- **Never `git reset --hard` / `git checkout -- .` here.** Other sessions' uncommitted work is in\nMD", SKILLS);
  });
});

describe("shared-checkout-branch", () => {
  const id = "shared-checkout-branch";
  it("trips on real branch switches in shared main checkouts", () => {
    trips(id, 'cd ~/Documents/Code/agent-world && git switch -c feat/mission-control && sed -n 40,70p client/src/shell/shell.ts', AW);
    trips(id, 'export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH; cd ~/.claude/skills-repo && git checkout -b feat/linkedin-post-hard-cap 2>&1 && git add linkedin-post/SKILL.md', SKILLS);
    trips(id, "cd ~/Documents/Code/agent-world && git switch -c fix/inbox-dive-to-room && git add client/src", HOME); // session cwd is ~, the cd is what counts
  });
  it("stays quiet going back to main, restoring files, and in worktrees", () => {
    quiet(id, 'export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH; cd ~/.claude/skills-repo && git checkout main 2>&1 && echo "--- ahead/behind vs origin ---"', SKILLS);
    quiet(id, 'cd ~/Documents/Code/agent-world && git revert --no-commit e47ebc7 2>&1 | tail -3; git checkout HEAD -- client/src/features/claude-fm client/src/style.css && git status --short', AW);
    quiet(id, 'export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH; cd /Users/alexboghossian/.acme-worktrees/tick-1982 && git checkout -b feat/tick-1981-blog-buying-the-tool && git branch --show-current', ACME);
    quiet(id, "cd ~/Documents/Code/acme-ai-next && git fetch origin main -q\ncd /tmp/acme-stamp && git fetch origin main -q && git checkout -q -B verify origin/main 2>&1 | tail -1", HOME);
  });
});

describe("secret-scan-without-rtk-proxy", () => {
  const id = "secret-scan-without-rtk-proxy";
  it("trips on the real scan the rtk rewrite hid a key from", () => {
    trips(id, 'cd ~/Documents/Code/agent-world && git ls-files | grep -iE "\\.env|\\.db|secret|key" ; git log -p --all | grep -EIo "(sk-[A-Za-z0-9_-]{20,}|[a-z]+_(live|test)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})" | sort -u | head; echo "---scan done"', HOME);
    trips(id, "export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH; cd ~/.claude/skills-repo\ngrep -rn 'croma_live_\\|XW3939' gov-data/ && echo \"SECRET FOUND - ABORT\" || echo \"no secret in gov-data/\"", `${SKILLS}/acme-preflight`);
  });
  it("stays quiet when the pipeline starts with rtk proxy, and on greps that hunt no secret", () => {
    quiet(id, 'cd ~/Documents/Code/agent-world && rtk proxy git log -p --all | grep -EIo "(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})" | sort -u | head', HOME); // the fixed form of the real scan
    quiet(id, 'cd ~/Documents/Code/agent-world && git ls-files | grep -iE "\\.env|\\.db|secret|key"', HOME);
    quiet(id, 'rtk proxy grep -rl "swiftshader\\|--use-gl\\|CHROME_FLAGS" ~/.claude/skills/gstack/browse/ 2>/dev/null | head -20', AW);
  });
});

describe("tests-through-rtk-filter", () => {
  const id = "tests-through-rtk-filter";
  it("trips on real test runs the rtk hook rewrites, piped into a filter", () => {
    trips(id, 'cd ~/.alef-worktrees/resident-feedback && npx vitest run 2>&1 | grep -E "Test Files|Tests " ; git add server/features/resident-lib.ts', `${HOME}/.alef-worktrees/resident-feedback`);
    trips(id, "printf 'semantic tests: '; python3 -m pytest \"$P/tests/test_semantic.py\" -q 2>&1 | tail -3", `${SKILLS}/acme-preflight`);
  });
  it("stays quiet through rtk proxy, on runners rtk leaves alone, and on greps that mention vitest", () => {
    quiet(id, 'rtk proxy npx vitest run 2>&1 | grep -E "Tests |FAIL" ; P=$(lsof -ti tcp:5179 -sTCP:LISTEN)', AW);
    quiet(id, 'W=/Users/alexboghossian/.acme-worktrees/tick-1986\ncd "$W" && bun test apps/academy/src/components/tools/redaction/engine.test.ts 2>&1 | tail -10', ACME);
    quiet(id, 'grep -n "test\\|vitest" package.json | head -20 && echo "---" && cat vitest.config.ts 2>/dev/null', AW);
    quiet(id, 'echo "== test infra"; git ls-tree -r --name-only origin/main | grep -E "(vitest|jest)\\.config|\\.test\\.ts$" | head -10', ACME);
  });
});

describe("pipe-masks-exit-code", () => {
  const id = "pipe-masks-exit-code";
  it("trips when a check piped into tail is then trusted", () => {
    trips(id, 'npx tsc --noEmit -p tsconfig.app.json 2>&1 | tail -5 && echo "tsc clean"', `${HOME}/Documents/Code/commandline`);
    trips(id, 'npm install -g @anthropic-ai/claude-code@2.1.280 2>&1 | tail -15; echo "=== exit: $? ==="; claude --version', HOME);
    trips(id, 'cd ~/.acme-worktrees/tick-2006 && bun install --frozen-lockfile 2>&1 | tail -3 && bunx nx build main > $L 2>&1; echo "exit $?" >> $L', `${HOME}/.acme-worktrees/tick-2006`);
  });
  it("stays quiet on the log-then-exit shape and on a section header after tail", () => {
    quiet(id, 'PIDS=$(lsof -ti tcp:4399 -sTCP:LISTEN 2>/dev/null); cd ~/.acme-worktrees/tick-1899 && bun run build > /tmp/gro1899-build.log 2>&1; echo "wrapper_exit=$?"', HOME);
    quiet(id, 'echo "=== tsc ===" && npx tsc --noEmit 2>&1 | tail -10 && echo "=== vitest ==="', AW);
  });
});

describe("ps-grep-counts-itself", () => {
  const id = "ps-grep-counts-itself";
  it("trips on the real count that included the grep (the journal's dead end)", () => {
    trips(id, 'rtk proxy ps -o command= -p 67356 | cut -c1-250; rtk proxy ps aux | grep -c "native-binary/claude"; cd ~/Documents/Code/agent-world', AW);
    trips(id, 'ps aux | rtk proxy grep -c "measure_audience" ; ls -la audience.json 2>/dev/null || echo "no json yet"', `${SKILLS}/acme-preflight`);
  });
  it("stays quiet with the [x] trick or grep -v grep", () => {
    quiet(id, 'date -u +%FT%T; ps aux | grep -c "[c]laude --\\|[/]claude$\\|bin/claude"', AW);
    quiet(id, 'echo "still running:"; tail -3 $SP/build.log; ps aux | rtk proxy grep next-build | rtk proxy grep -v grep | wc -l; fi', `${HOME}/.acme-worktrees/bench-audit`);
  });
});

describe("worktree-in-icloud", () => {
  const id = "worktree-in-icloud";
  const real = "cd ~/Documents/Code/agent-world && git fetch -q origin && git worktree add -q -b fix/resident-collapse-dupes ~/.alef-worktrees/collapse-dupes origin/main && cd ~/.alef-worktrees/collapse-dupes";
  it("trips when the worktree lands under ~/Documents (real command, path moved)", () => {
    trips(id, real.replace("~/.alef-worktrees/collapse-dupes origin", "~/Documents/Code/collapse-dupes origin"), AW);
  });
  it("stays quiet for the real command, which uses ~/.alef-worktrees", () => {
    quiet(id, real, AW);
  });
});

describe("merge-without-review", () => {
  const id = "merge-without-review";
  const merge = "cd ~/Documents/Code/agent-world && gh pr merge 8 --merge 2>&1 | tail -2";
  it("trips on a merge with no review or go-ahead earlier in the session", () => {
    trips(id, merge, AW);
  });
  it("stays quiet after a review agent or after Alex said merge (tracker memory)", () => {
    const t0 = Date.parse("2026-09-27T06:40:00Z");
    const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
    const reviewed = new TripwireTracker(tws, { home: HOME, liveWindowMs: Infinity });
    const lines = [
      assistantLine({ cwd: AW, timestamp: at(0), toolUses: [{ name: "Agent", input: { description: "Review PR #8 (flaky test fix)", subagent_type: "general-purpose", prompt: "Review the diff…" } }] }),
      assistantLine({ cwd: AW, timestamp: at(60), toolUses: [{ name: "Bash", input: { command: merge } }] }),
    ];
    expect(reviewed.ingest("s-reviewed", lines, { cwd: AW, district: "agent-world", nowMs: t0 }).map((h) => h.tripwireId)).not.toContain(id);
    const approved = new TripwireTracker(tws, { home: HOME, liveWindowMs: Infinity });
    const lines2 = [userLine({ cwd: AW, timestamp: at(0), text: "merge all which is done" }), lines[1]!];
    expect(approved.ingest("s-approved", lines2, { cwd: AW, district: "agent-world", nowMs: t0 }).map((h) => h.tripwireId)).not.toContain(id);
    const bare = new TripwireTracker(tws, { home: HOME, liveWindowMs: Infinity });
    expect(bare.ingest("s-bare", [lines[1]!], { cwd: AW, district: "agent-world", nowMs: t0 }).map((h) => h.tripwireId)).toEqual([id]);
  });
});

describe("shell normalization", () => {
  it("maskShell keeps the length and blanks structure inside quotes, comments and 2>&1", () => {
    const cmd = 'grep -E "a|b;c" f 2>&1 | tail # never run browse restart\nls';
    const m = maskShell(cmd);
    expect(m.length).toBe(cmd.length);
    expect(m).toBe(`grep -E "a b c" f 2> 1 | tail ${" ".repeat("# never run browse restart".length)}\nls`);
  });
  it("maskShell keeps $( … ) inside double quotes as real structure", () => {
    const cmd = 'echo "port: $(lsof -ti tcp:3742 | tr x y)"';
    expect(maskShell(cmd)).toBe(cmd);
  });
  it("maskShell treats an escaped pipe as text", () => {
    expect(maskShell('grep -n "test\\|vitest" package.json')).toBe('grep -n "test\\ vitest" package.json');
  });
  it("stripHeredocs drops bodies (quoted, <<- and unterminated) but keeps the rest of the line", () => {
    expect(stripHeredocs("cat > f <<'EOF' && echo done\nbrowse restart\nEOF\nls")).toBe("cat > f <<'EOF' && echo done\nls");
    expect(stripHeredocs("cat <<-END\n\tgit stash\n\tEND\npwd")).toBe("cat <<-END\npwd");
    expect(stripHeredocs("python3 - <<'PY'\nprint('git stash')")).toBe("python3 - <<'PY'");
  });
});

describe("where a command runs", () => {
  it("resolveDir expands ~ and $HOME, joins relative paths, refuses variables", () => {
    expect(resolveDir("~/Documents/Code/agent-world", "/", HOME)).toBe("~/Documents/Code/agent-world");
    expect(resolveDir("$HOME/.claude/skills-repo/", "/", HOME)).toBe("~/.claude/skills-repo");
    expect(resolveDir("apps/main", ACME, HOME)).toBe("~/Documents/Code/acme-ai-next/apps/main");
    expect(resolveDir("..", `${HOME}/.alef-worktrees/x`, HOME)).toBe("~/.alef-worktrees");
    expect(resolveDir('"$W"', ACME, HOME)).toBeNull();
    expect(resolveDir("/tmp/acme-stamp", HOME, HOME)).toBe("/tmp/acme-stamp");
  });
  it("effectiveDir prefers git -C, then the last cd before the command, then the cwd", () => {
    const run = (cmd: string, needle: string, cwd: string): string | null => {
      const i = cmd.indexOf(needle);
      return effectiveDir(cmd, maskShell(cmd), i, needle, cwd, HOME);
    };
    expect(run("git -C ~/.claude/skills-repo stash", "git -C ~/.claude/skills-repo stash", AW)).toBe("~/.claude/skills-repo");
    expect(run("cd /tmp && ls; cd ~/Documents/Code/agent-world && git stash", "git stash", HOME)).toBe("~/Documents/Code/agent-world");
    expect(run("git stash", "git stash", ACME)).toBe("~/Documents/Code/acme-ai-next");
    expect(run('echo "cd /tmp" && git stash', "git stash", AW)).toBe("~/Documents/Code/agent-world"); // a quoted cd is text
  });
});

describe("snippets", () => {
  it("are one line, redacted and capped", () => {
    const s = sanitizeSnippet('grep -rlE "sk-or-|TYPESAFE_API_KEY=EXAMPLE-FAKE-0" .\n\u2028curl -H "Authorization: Bearer ${EXAMPLE_TOKEN}" x');
    expect(s).not.toMatch(/[\n\u2028]/);
    expect(s).not.toContain("EXAMPLE-FAKE-0");
    expect(s).not.toContain("EXAMPLE-FAKE-1");
    expect(s).toContain("[redacted]");
    expect(sanitizeSnippet("x".repeat(500)).length).toBe(SNIPPET_MAX);
  });
  it("a hit's snippet is the matched command, not the whole tool input", () => {
    const [hit] = matchToolUse(tws, { name: "Bash", input: { command: 'B=~/.claude/skills/gstack/browse/dist/browse\n"$B" restart --help 2>&1 | head -20\necho "---"' } }, AW, HOME);
    expect(hit?.snippet).toBe('"$B" restart --help 2>&1');
  });
});

describe("TripwireTracker", () => {
  const t0 = Date.parse("2026-09-27T10:00:00Z");
  const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
  const browseLine = (s: number): string => assistantLine({ cwd: AW, timestamp: at(s), toolUses: [{ name: "Bash", input: { command: '"$B" restart --help 2>&1 | head -20' } }] });

  it("dedupes per session + tripwire, and keeps hits newest first with their district", () => {
    const t = new TripwireTracker(tws, { home: HOME });
    const first = t.ingest("sess-a", [browseLine(0), browseLine(5)], { cwd: AW, district: "agent-world", nowMs: t0 + 10_000 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "sess-a:browse-restart-stop", sessionId: "sess-a", district: "agent-world", tripwireId: "browse-restart-stop", severity: "danger", tool: "Bash", at: at(0) });
    expect(t.ingest("sess-a", [browseLine(20)], { cwd: AW, district: "agent-world", nowMs: t0 + 30_000 })).toEqual([]);
    const other = t.ingest("sess-b", [browseLine(40)], { cwd: AW, district: null, nowMs: t0 + 50_000 });
    expect(other.map((h) => h.id)).toEqual(["sess-b:browse-restart-stop"]);
    expect(t.hits().map((h) => h.sessionId)).toEqual(["sess-b", "sess-a"]);
  });

  it("only flags live tool calls: history replayed into a pass stays quiet", () => {
    const t = new TripwireTracker(tws, { home: HOME });
    expect(t.ingest("sess-old", [browseLine(0)], { cwd: AW, district: null, nowMs: t0 + 60 * 60_000 })).toEqual([]);
    expect(t.hits()).toEqual([]);
  });

  it("caps the list and survives malformed lines", () => {
    const t = new TripwireTracker(tws, { home: HOME, cap: 2 });
    for (const s of ["a", "b", "c"]) t.ingest(s, ["{not json", browseLine(0)], { cwd: AW, district: null, nowMs: t0 });
    expect(t.hits().map((h) => h.sessionId)).toEqual(["c", "b"]);
  });
});

// ── Review fixes (PR #27 review) ─────────────────────────────────────────────────────────────

/** A user line with the fields the 2026-09 CLI writes (shapes copied from the Alef loop session
 *  943ddee1: a skill body is isMeta, a relayed report is isMeta + turnOrigin "peer", a task
 *  notification and a /loop run carry their own turnOrigin, Alex's prompt is "human"). */
function realUserLine(text: string, at: string, o: { isMeta?: boolean; turnOrigin?: string; asString?: boolean } = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: AW,
    sessionId: "943ddee1-a73d-470c-835a-55084c09c69f",
    type: "user",
    ...(o.isMeta ? { isMeta: true } : {}),
    ...(o.turnOrigin ? { turnOrigin: o.turnOrigin } : {}),
    message: { role: "user", content: o.asString ? text : [{ type: "text", text }] },
    uuid: `u-${at}`,
    timestamp: at,
  });
}

// Real text: the /loop skill body re-injected every iteration (isMeta), its prohibitions verbatim.
const LOOP_BODY = "# /loop — schedule a recurring or self-paced prompt\n\n3. BUILD in a fresh worktree `git worktree add -b <fix|feat>/<slug> ~/.alef-worktrees/<slug> origin/main` + symlink node_modules. NEVER edit, stash, reset, or merge in the main checkout ~/Documents/Code/agent-world (another session works there).\n4. SHIP: conventional commit, push, `gh pr create`. NEVER merge — merging is Alex's call.";
const LOOP_RUN = "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>Run one iteration of the Alef self-improvement loop as specified in ~/.alef-loop/LOOP.md</command-args>";

describe("userLineKind", () => {
  const at = "2026-09-27T10:00:00.000Z";
  it("only a prompt Alex typed is human; a /loop run is a new turn; injected text is neither", () => {
    expect(userLineKind(realUserLine("merge", at, { turnOrigin: "human" }), "merge")).toBe("human");
    expect(userLineKind(realUserLine("1.", at, { turnOrigin: "sdk" }), "1.")).toBe("human");
    expect(userLineKind(realUserLine(LOOP_RUN, at, { turnOrigin: "scheduled", asString: true }), LOOP_RUN)).toBe("turn");
    expect(userLineKind(realUserLine(LOOP_BODY, at, { isMeta: true }), LOOP_BODY)).toBe("other");
    const relay = "Another Claude session sent a message:\n<agent-message from=\"a50bf1fa021849629\">\nReviewer: BLOCK. Do not merge #27.";
    expect(userLineKind(realUserLine(relay, at, { isMeta: true, turnOrigin: "peer", asString: true }), relay)).toBe("other");
    const note = "<task-notification>\n<task-id>a3e57c0dde52037c7</task-id>\n<status>completed</status>\n<summary>ready to merge</summary>";
    expect(userLineKind(realUserLine(note, at, { turnOrigin: "task_notification", asString: true }), note)).toBe("other");
  });
  it("reads older transcripts (no turnOrigin) from the text", () => {
    expect(userLineKind(userLine({ cwd: AW, timestamp: at, text: "merge all which is done" }), "merge all which is done")).toBe("human");
    expect(userLineKind(userLine({ cwd: AW, timestamp: at, text: "<task-notification>ready to merge" }), "<task-notification>ready to merge")).toBe("other");
    expect(userLineKind(userLine({ cwd: AW, timestamp: at, text: "Base directory for this skill: ~/.claude/skills/x\n\nnever merge" }), "Base directory for this skill: ~/.claude/skills/x\n\nnever merge")).toBe("other");
    expect(userLineKind(userLine({ cwd: AW, timestamp: at, text: LOOP_RUN }), LOOP_RUN)).toBe("turn");
    expect(userLineKind(userLine({ cwd: AW, timestamp: at, text: '<pasted_content id="e3bf">x</pasted_content> merge' }), '<pasted_content id="e3bf">x</pasted_content> merge')).toBe("human");
  });
});

describe("merge-without-review: what counts as a review or a go-ahead", () => {
  const id = "merge-without-review";
  const t0 = Date.parse("2026-09-27T06:40:00Z");
  const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
  const merge = (s: number, n = 8): string => assistantLine({ cwd: AW, timestamp: at(s), toolUses: [{ name: "Bash", input: { command: `cd ~/Documents/Code/agent-world && gh pr merge ${n} --merge 2>&1 | tail -2` } }] });
  const agent = (s: number, description: string, prompt = "Read the diff and report."): string => assistantLine({ cwd: AW, timestamp: at(s), toolUses: [{ name: "Agent", input: { description, subagent_type: "general-purpose", prompt } }] });
  const human = (s: number, text: string): string => realUserLine(text, at(s), { turnOrigin: "human" });
  /** Which of the session's merges flagged, in order (a fresh tracker per merge so dedupe can't hide one). */
  function flagged(lines: string[]): boolean[] {
    const out: boolean[] = [];
    lines.forEach((l, i) => {
      if (!l.includes("gh pr merge")) return;
      const t = new TripwireTracker(tws, { home: HOME, liveWindowMs: Infinity });
      const hits = t.ingest("s", lines.slice(0, i + 1), { cwd: AW, district: "agent-world", nowMs: t0 });
      out.push(hits.some((h) => h.tripwireId === id && h.snippet.includes(`merge ${/gh pr merge (\d+)/.exec(l)![1]}`)));
    });
    return out;
  }

  it("the reviewer's five disarming cases no longer excuse a merge", () => {
    expect(flagged([realUserLine(LOOP_BODY, at(0), { isMeta: true }), merge(60)])).toEqual([true]); // a prohibition in a skill body
    const relay = "Another Claude session sent a message:\n<agent-message from=\"a50bf1fa021849629\">\nReviewer: BLOCK. Do not merge #27.";
    expect(flagged([realUserLine(relay, at(0), { isMeta: true, turnOrigin: "peer", asString: true }), merge(60)])).toEqual([true]);
    expect(flagged([human(0, "don't merge yet"), merge(60)])).toEqual([true]);
    expect(flagged([agent(0, "Post preview link", "post the Vercel preview link"), merge(60)])).toEqual([true]); // "preview" is not a review
    const note = "<task-notification>\n<task-id>a3e57c0dde52037c7</task-id>\n<summary>Agent finished: ready to merge</summary>\n</task-notification>";
    expect(flagged([realUserLine(note, at(0), { turnOrigin: "task_notification", asString: true }), merge(60)])).toEqual([true]);
  });

  it("real go-aheads excuse it; questions and 'so I can merge' do not", () => {
    for (const ok of ["merge", "Merge all", "sure thing + merge", "fix > QA > merge", "1. merge\n2. fix it", "resolve conflicts then merge yourself", "Is this done? Prepare a PR. Everything is in order. Merge and deploy."]) {
      expect(flagged([human(0, ok), merge(60)]), ok).toEqual([false]);
    }
    for (const no of ["what open PRs to merge? \nPush commit also", "for the 155 days old -> tell me the PR links so I can merge", "NEVER merge — merging is Alex's call."]) {
      expect(flagged([human(0, no), merge(60)]), no).toEqual([true]);
    }
  });

  it("a go-ahead covers the merges that answer it, not a later run (the loop's real incident)", () => {
    // 943ddee1: "merge" early on, many /loop runs later, then "1." answering a question: PR 8 merged unreviewed.
    expect(flagged([human(0, "merge"), realUserLine(LOOP_RUN, at(30), { turnOrigin: "scheduled", asString: true }), realUserLine(LOOP_BODY, at(31), { isMeta: true }), human(40, "1."), merge(60)])).toEqual([true]);
    expect(flagged([human(0, "merge"), human(20, "??"), merge(60)])).toEqual([false]); // nudging before any merge keeps it
    expect(flagged([human(0, "merge both pr - 464 first then 465 :)"), merge(60, 464), merge(70, 465)])).toEqual([false, false]);
    expect(flagged([human(0, "merge"), merge(60, 1), human(90, "thanks, now fix the header"), merge(120, 2)])).toEqual([false, true]);
  });

  it("one review covers one merge, whether an agent was spawned or messaged", () => {
    const reviews = [agent(0, "Review PR 10"), agent(1, "Review PR 11"), agent(2, "Review PR 12")];
    expect(flagged([...reviews, merge(60, 11), merge(61, 10), merge(62, 12), merge(63, 13)])).toEqual([false, false, false, true]);
    const resend = assistantLine({ cwd: AW, timestamp: at(0), toolUses: [{ name: "SendMessage", input: { to: "ab1c09dac5b39fd75", summary: "Re-review PR 24 fix commit", message: "The fixes for your BLOCK on PR #24 are pushed." } }] });
    expect(flagged([resend, merge(60, 24)])).toEqual([false]);
    expect(flagged([agent(0, "Review PR 22"), realUserLine(LOOP_RUN, at(30), { turnOrigin: "scheduled", asString: true }), merge(60, 24)])).toEqual([true]); // a new run starts clean
  });
});

describe("shell structure (review findings)", () => {
  it("a cd inside ( … ) or $( … ) ends with it", () => {
    quiet("shared-checkout-stash", "(cd ~/Documents/Code/agent-world && git log -1); git stash", "/tmp");
    quiet("shared-checkout-stash", 'X=$(cd ~/Documents/Code/agent-world && pwd); git stash', "/tmp");
    trips("shared-checkout-stash", "(cd ~/Documents/Code/agent-world && git stash)", "/tmp");
  });
  it("a relative cd resolves against where the previous cd left the shell", () => {
    trips("shared-checkout-stash", "cd ~/Documents/Code/agent-world/server && cd .. && git stash", "/tmp");
    quiet("shared-checkout-stash", "cd ~/Documents/Code/agent-world && cd ../../.. && git stash", "/tmp");
  });
  it("a here-string or a quoted <<EOF opens no heredoc", () => {
    trips("shared-checkout-stash", "wc -c <<< hi\ngit stash", AW);
    trips("shared-checkout-stash", 'git commit -m "docs: use <<EOF heredocs"\ngit stash', AW);
    expect(stripHeredocs('git commit -m "$(cat <<\'EOF\'\nfix: x\n\ngit stash notes\nEOF\n)"\nls')).toBe('git commit -m "$(cat <<\'EOF\'\n)"\nls');
    expect(stripHeredocs("cat <<A <<B\na\nA\nb\nB\npwd")).toBe("cat <<A <<B\npwd");
  });
  it("a worktree nested inside a shared checkout is not the shared checkout", () => {
    quiet("shared-checkout-branch", "git checkout -b feat/x", `${AW}/.claude/worktrees/x`);
    trips("shared-checkout-branch", "git checkout -b feat/x", `${AW}/server`);
  });
});

describe("rtk rewrite shapes (review findings)", () => {
  it("rtk rewrites after || and after a FOO=1 prefix, never egrep", () => {
    trips("secret-scan-without-rtk-proxy", 'false || grep -rn "sk-" .', AW);
    trips("tests-through-rtk-filter", "FOO=1 npx vitest run | tail", AW);
    quiet("secret-scan-without-rtk-proxy", 'egrep -rn "sk-" .', AW);
    quiet("tests-through-rtk-filter", 'npx tsc --noEmit || echo "a | b"', AW);
  });
  it("a worktree target held in a variable (the real 09-14 command)", () => {
    trips("worktree-in-icloud", 'WT=~/Documents/Code/acme-wt-compete && git worktree add -b feat/tick-1646-competitor-landscape "$WT" origin/main 2>&1 | tail -5 && echo "=== created ==="', ACME);
    quiet("worktree-in-icloud", 'WT=~/.acme-worktrees/compete && git worktree add -b feat/x "$WT" origin/main', ACME);
  });
  it("a bash -c body is a command too, except for the rtk lessons (rtk never rewrites inside it)", () => {
    trips("browse-restart-stop", "bash -c '~/.claude/skills/gstack/browse/dist/browse restart'", AW);
    trips("shared-checkout-stash", "cd ~/Documents/Code/agent-world && nohup bash -c 'git stash' >/dev/null 2>&1", HOME);
    quiet("shared-checkout-stash", "cd ~/.alef-worktrees/x && bash -c 'git stash'", AW);
    quiet("secret-scan-without-rtk-proxy", `bash -c 'grep -rn "sk-" .'`, AW);
  });
});

describe("secrets in snippets (review finding)", () => {
  // Synthetic keys, built at run time so no key-shaped literal sits in the source.
  const aws = ["AK", "IA", "ABCDEFGH23456789"].join("");
  const google = ["AI", "za", "Sy", "Bq3xYv7Lm0Np2Rs4Tu6Wv8Xz_AbCdEfGh-k"].join("");
  it("redacts every key shape the secret rule hunts for", () => {
    for (const needle of [aws, google, ["gh", "s_", "EXAMPLE-FAKE-1qrstuv0123"].join(""), ["xo", "xs-", "EXAMPLE-FAKE-11234"].join("")]) {
      const [hit] = matchToolUse(tws, { name: "Bash", input: { command: `grep -rn "${needle}" .` } }, AW, HOME);
      expect(hit?.tripwire.def.id).toBe("secret-scan-without-rtk-proxy");
      expect(hit?.snippet).not.toContain(needle);
      expect(hit?.snippet).toContain("[redacted]");
    }
  });
});

describe("pathological commands (review finding)", () => {
  it("never stall the server: every rule stays fast on 100k-char commands", () => {
    for (const command of [`ps aux | grep -${"c".repeat(100_000)}1`, "kill $(lsof -i :1".repeat(6000), "P=$(lsof -i :3000)".repeat(5600), "WT=~/Documents/x\n".repeat(6000)]) {
      const t = performance.now();
      matchToolUse(tws, { name: "Bash", input: { command } }, AW, HOME);
      expect(performance.now() - t, command.slice(0, 30)).toBeLessThan(1000);
    }
  });
  it("still sees a lesson at the start of a long command", () => {
    trips("browse-restart-stop", `"$B" restart\necho ${"x".repeat(100_000)}`, AW);
  });
});
