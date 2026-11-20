// outcomes-lib: the fold over real-shaped transcript lines (shapes copied from real transcripts,
// contents made up), the precedence table, the gh argv and cache policy, the Feed rule and the
// persisted store's validation. Pure: the tail-ending cases that need files live in outcomes.test.ts.

import { describe, expect, it } from "vitest";
import type { OutcomePr, PrState } from "../../shared/features/outcomes.js";
import { parseOutcomesMap } from "../../shared/features/outcomes.js";
import type { LastLineState } from "../heuristics.js";
import {
  ABANDON_MS,
  buildRecord,
  classifyOutcome,
  emptyStore,
  ghPrViewArgs,
  githubRepoOfRemotes,
  graduationTitle,
  mayCarryOutcome,
  newFoldState,
  newStoredSession,
  OPEN_RECHECK_MS,
  OutcomeFoldReader,
  parseStore,
  placeMergesByDir,
  prCheckDue,
  prCheckFrom,
  prsToCheck,
  shouldAnnounce,
  summaryOf,
  todosOf,
  UNKNOWN_RETRY_MS,
  type ClassifyInput,
  type FoldState,
  type PrCheck,
} from "../features/outcomes-lib.js";
import { artifactUrlsIn } from "../features/shelf-lib.js";
import type { TailEnding } from "../features/subagents/endings.js";
import { PROMPT_STALL_MS, STALL_MS } from "../features/subagents/fold.js";

const SID = "5a1157ca-9872-479d-b350-993efc43de69";
const CWD = "/Users/someone";
const T0 = "2026-09-28T08:00:00.000Z";
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

// ── real-shaped lines ──────────────────────────────────────────────────

function toolUse(id: string, name: string, input: Record<string, unknown>, ts = T0): string {
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: false,
    type: "assistant",
    message: { model: "claude-opus-5-5", id: `msg_${id}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null },
    uuid: `u-${id}`,
    timestamp: ts,
    cwd: CWD,
    sessionId: SID,
    entrypoint: "claude-vscode",
  });
}

function toolResult(id: string, text: string, ts = T0): string {
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text, is_error: false }] },
    uuid: `r-${id}`,
    timestamp: ts,
    toolUseResult: { stdout: text, stderr: "", interrupted: false, isImage: false },
    cwd: CWD,
    sessionId: SID,
    entrypoint: "claude-vscode",
  });
}

/** A Bash call that exited non-zero (✅ real shape: "Exit code N" leads the content, is_error is
 *  true, and toolUseResult is a plain "Error: …" string). */
function toolError(id: string, output: string, ts = T0): string {
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: `Exit code 1\n${output}`, is_error: true }] },
    uuid: `r-${id}`,
    timestamp: ts,
    toolUseResult: `Error: Exit code 1\n${output}`,
    cwd: CWD,
    sessionId: SID,
    entrypoint: "claude-vscode",
  });
}

/** Claude Code's own pr-link record (✅ shape: {type, sessionId, prNumber, prUrl, prRepository, timestamp}). It is
 *  written when a session's (or a subagent's) command touches a PR, not only when it opens one. */
function prLink(repo: string, n: number, ts = T0): string {
  return JSON.stringify({ type: "pr-link", sessionId: SID, prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: ts });
}

/** Claude Code's own record of a published claude.ai artifact (✅ shape from real transcripts). */
function frameLink(url: string, ts = T0): string {
  return JSON.stringify({ type: "frame-link", sessionId: SID, path: "/private/tmp/scratchpad/report.html", frameUrl: url, title: "Report", artifactCount: 1, timestamp: ts });
}

function text(t: string, ts = T0): string {
  return JSON.stringify({ type: "assistant", message: { id: "msg_t", role: "assistant", type: "message", content: [{ type: "text", text: t }], stop_reason: "end_turn" }, timestamp: ts, cwd: CWD, sessionId: SID });
}

function fold(lines: readonly string[], prev: FoldState = newFoldState()): FoldState {
  const r = new OutcomeFoldReader(prev);
  for (const l of lines) r.line(l, T0);
  return r.finish(prev.offset + 1, false);
}

describe("the outcome fold (real line shapes)", () => {
  it("a pr-link record is a PR, the repo lowercased, repeats counted once", () => {
    const f = fold([prLink("ACME-Inc/acme-ai", 412, at(0)), prLink("ACME-Inc/acme-ai", 412, at(30))]);
    expect(f.prs).toEqual([{ repo: "acme-inc/acme-ai", number: 412, at: at(0) }]);
  });

  it("`gh pr create` printing a PR URL is a PR, even when its output lands in a later read", () => {
    const first = fold([toolUse("toolu_1", "Bash", { command: 'gh pr create --base main --title "x" --body "y"' })]);
    expect(first.pendingShip).toEqual(["toolu_1"]);
    expect(first.prs).toEqual([]);
    const second = fold([toolResult("toolu_1", "https://github.com/o/r/pull/12\n", at(1))], first);
    expect(second.pendingShip).toEqual([]);
    expect(second.prs).toEqual([{ repo: "o/r", number: 12, at: at(1) }]);
  });

  it("'Merged pull request o/r#12' from `gh pr merge` is PR o/r#12", () => {
    const f = fold([toolUse("toolu_2", "Bash", { command: "gh pr merge 12 --merge" }), toolResult("toolu_2", "✓ Merged pull request o/r#12 (feat: x)\n")]);
    expect(f.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["o/r#12"]);
  });

  it("git's 'To https://github.com/o/r' after a push is a push; a .git suffix is dropped", () => {
    const f = fold([
      toolUse("toolu_3", "Bash", { command: "git push -u origin feat/x" }),
      toolResult("toolu_3", "       0\nTo https://github.com/O/R.git\n * [new branch]      feat/x -> feat/x\n", at(2)),
    ]);
    expect(f.pushes).toEqual([{ repo: "o/r", at: at(2) }]);
    expect(f.prs).toEqual([]);
  });

  it("the push hint 'pull/new/<branch>' is not a PR", () => {
    const hint = "remote: \nremote: Create a pull request for 'feat-x' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/feat-x\nremote: \n";
    const f = fold([toolUse("toolu_4", "Bash", { command: "git push" }), toolResult("toolu_4", `${hint}To https://github.com/o/r\n * [new branch]      feat-x -> feat-x\n`)]);
    expect(f.prs).toEqual([]);
    expect(f.pushes.map((p) => p.repo)).toEqual(["o/r"]);
  });

  it("a frame-link record is a published artifact; a quoted 'frame-link' in a command is just a tool call", () => {
    const f = fold([frameLink("https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7?x=1", at(3)), toolUse("toolu_5", "Bash", { command: "grep -c '\"frame-link\"' x.jsonl https://claude.ai/artifact/QuotedNotPublished1" })]);
    expect(f.artifacts).toEqual([{ url: "https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7", at: at(3) }]);
    expect(f.toolCalls).toBe(1);
  });

  it("an artifact link merely written in text or a tool result never counts", () => {
    const f = fold([text("Published at https://claude.ai/artifact/AbCdEfGh12"), toolResult("toolu_x", "https://claude.ai/code/artifact/AbCdEfGh12")]);
    expect(f.artifacts).toEqual([]);
  });

  it("counts tool calls, writes and learnings (memory / lessons files)", () => {
    const f = fold([
      toolUse("a", "Read", { file_path: "/repo/a.ts" }),
      toolUse("b", "Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }),
      toolUse("c", "Write", { file_path: "/Users/someone/.claude/projects/-Users-someone/memory/feedback_x.md", content: "…" }),
      toolUse("d", "MultiEdit", { file_path: "notes/lessons.md", edits: [] }),
      toolUse("e", "NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "" }),
    ]);
    expect(f.toolCalls).toBe(5);
    expect(f.writes).toBe(4);
    expect(f.learnings).toEqual(["/Users/someone/.claude/projects/-Users-someone/memory/feedback_x.md", "/Users/someone/notes/lessons.md"]);
  });

  it("the latest TodoWrite list counts; every item completed = finished", () => {
    const todos = (s: string[]): Record<string, unknown> => ({ todos: s.map((status, i) => ({ content: `step ${i}`, status, activeForm: `doing ${i}` })) });
    const open = fold([toolUse("t1", "TodoWrite", todos(["completed", "in_progress", "pending"]))]);
    expect(todosOf(open)).toEqual({ total: 3, completed: 1 });
    const done = fold([toolUse("t2", "TodoWrite", todos(["completed", "completed", "completed"]))], open);
    expect(todosOf(done)).toEqual({ total: 3, completed: 3 });
    expect(classifyOutcome(input({ todos: todosOf(done) })).outcome).toBe("finished");
  });

  it("the TaskCreate / TaskUpdate list (✅ real shapes: 'Task #1 created successfully: …'), across reads", () => {
    const created = fold([
      toolUse("tc1", "TaskCreate", { subject: "Render" }),
      toolUse("tc2", "TaskCreate", { subject: "Archive" }),
      toolResult("tc1", "Task #1 created successfully: Render"),
    ]);
    expect(created.pendingTaskCreates).toEqual(["tc2"]);
    const later = fold([toolResult("tc2", "Task #2 created successfully: Archive"), toolUse("tu1", "TaskUpdate", { taskId: "1", status: "completed" })], created);
    expect(todosOf(later)).toEqual({ total: 2, completed: 1 });
    const all = fold([toolUse("tu2", "TaskUpdate", { taskId: "2", status: "completed" })], later);
    expect(todosOf(all)).toEqual({ total: 2, completed: 2 });
    const prototypeKey = fold([toolUse("tu3", "TaskUpdate", { taskId: "__proto__", status: "completed" })], all);
    expect(todosOf(prototypeKey)).toEqual({ total: 3, completed: 3 });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("lines that can't change the fold are skipped before any JSON parse", () => {
    expect(mayCarryOutcome(text("done?"), false, false)).toBe(false);
    expect(mayCarryOutcome(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), false, false)).toBe(false);
    expect(mayCarryOutcome(toolResult("x", "out"), false, false)).toBe(false);
    expect(mayCarryOutcome(toolResult("x", "out"), true, false)).toBe(true);
    expect(mayCarryOutcome(toolResult("x", "out"), false, true)).toBe(true);
    expect(mayCarryOutcome(prLink("o/r", 1), false, false)).toBe(true);
    expect(mayCarryOutcome(frameLink("https://claude.ai/artifact/AbCdEfGh12"), false, false)).toBe(true);
    expect(mayCarryOutcome(toolUse("y", "Read", { file_path: "/a" }), false, false)).toBe(true);
  });

  it("garbage lines are ignored", () => {
    const f = fold(["{not json", "", "[]", "null"]);
    expect(f).toEqual({ ...newFoldState(), offset: 1 });
  });
});

/** A session's full record from a fold, as outcomes.ts builds it (read to its end, dormant). */
function recordOf(f: FoldState, checks: Record<string, PrCheck> = {}) {
  const quiet = Date.parse(at(100));
  return buildRecord(SID, { ...newStoredSession(), fold: f, readSize: 10, mtimeMs: quiet }, checks, { live: false, nowMs: Date.parse(at(200)), file: { size: 10, mtimeMs: quiet }, lastLine: null });
}

describe("a PR the session only closed is not its PR", () => {
  // ✅ Real sequence (32ac2c72, 2026-09-21): `gh pr close 499 --repo ACME-Inc/acme-ai` on another
  // author's PR, gh's "✓ Closed pull request ACME-Inc/acme-ai#499 (…)", then Claude Code's pr-link
  // 1s later. The author reopened and merged it hours later, so gh says MERGED.
  const close = (id: string, n: number, ts = T0): string[] => [
    toolUse(id, "Bash", { command: `gh pr close ${n} --repo Someone/their-repo --comment "Closing: superseded."`, description: "Close the PR" }, ts),
    toolResult(id, `✓ Closed pull request Someone/their-repo#${n} (fix: a thing)\n---\nCLOSED`, ts),
  ];
  const mergedLater: Record<string, PrCheck> = { "someone/their-repo#77": { state: "MERGED", mergedAt: at(90), url: null, checkedAt: at(91) } };

  it("closing someone else's PR, which its author reopens and merges later, is never shipped", () => {
    const f = fold([...close("toolu_c1", 77), prLink("Someone/their-repo", 77, at(0))]);
    expect(f.prs).toEqual([]);
    const rec = recordOf(f, mergedLater);
    expect(rec.outcome).toBe("unknown");
    expect(rec.prs).toEqual([]);
  });

  it("in any order and across reads: a pr-link read first, then the close, then its output", () => {
    const first = fold([prLink("Someone/their-repo", 77, at(0))]);
    expect(first.prs.map((p) => p.number)).toEqual([77]);
    const [use, result] = close("toolu_c2", 77, at(1));
    const second = fold([use ?? ""], first);
    const third = fold([result ?? "", prLink("Someone/their-repo", 77, at(2))], second);
    expect(third.prs).toEqual([]);
    expect(recordOf(third, mergedLater).outcome).toBe("unknown");
  });

  it("a PR the session opened and later closed stays its PR (delivered: closed without merging)", () => {
    const f = fold([
      toolUse("toolu_c3", "Bash", { command: 'gh pr create --base main --title "x" --body "y"' }),
      toolResult("toolu_c3", "https://github.com/Someone/their-repo/pull/77\n", at(1)),
      ...close("toolu_c4", 77, at(2)),
      prLink("Someone/their-repo", 77, at(2)),
    ]);
    expect(f.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["someone/their-repo#77"]);
    const closed: Record<string, PrCheck> = { "someone/their-repo#77": { state: "CLOSED", mergedAt: null, url: null, checkedAt: at(3) } };
    expect(recordOf(f, closed)).toMatchObject({ outcome: "delivered", reason: "someone/their-repo#77 closed without merging" });
  });

  it("a close inside a merge command (✅ real: `gh pr merge 474 …` then `gh pr close 256` in one call) drops only the closed PR", () => {
    const f = fold([
      toolUse("toolu_c5", "Bash", { command: 'gh pr create --base main --title "x" --body "y"' }),
      toolResult("toolu_c5", "https://github.com/Someone/their-repo/pull/88\n", at(1)),
      toolUse("toolu_c6", "Bash", { command: 'gh pr merge 88 --squash --delete-branch 2>&1 | tail -3\ngh pr view 88 --json state --template \'{{.state}}\'\necho; echo "=== close #77 as superseded ==="\ngh pr close 77 --comment "Superseded by #88"' }, at(2)),
      toolResult("toolu_c6", "\nMERGED\n=== close #77 as superseded ===\n✓ Closed pull request Someone/their-repo#77 (feat: the old attempt)", at(3)),
      prLink("Someone/their-repo", 77, at(3)),
      prLink("Someone/their-repo", 88, at(4)),
    ]);
    expect(f.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["someone/their-repo#88"]);
  });
});

describe("a `gh pr merge <n>` that merged is the session's PR, though gh prints no URL", () => {
  // ✅ Real (6a10cdc0, 2026-09-16): gh in a non-TTY prints nothing on a merge, and Claude Code wrote
  // no pr-link, so the session that merged acme-inc/acme-ai#460 had no sighting of it.
  const HOME = "/Users/someone";
  const MERGE_460 = `export DEVELOPER_DIR=/Library/Developer/CommandLineTools; cd ~/Documents/Code/acme-ai-next; gh pr merge 460 --squash --delete-branch 2>&1 | tail -5; echo "=== state ==="; gh pr view 460 --json state,mergedAt --template '{{.state}} {{.mergedAt}}'`;
  const OUT_460 = "failed to delete local branch feat/tick-1670-linkedin-partner-id: failed to run git: error: cannot delete branch 'feat/tick-1670-linkedin-partner-id' used by worktree at '/Users/someone/.acme-worktrees/tick-1670'\n\n=== state ===\nMERGED 2026-09-16T09:51:59Z";
  const NO_OUTPUT = "(Bash completed with no output)";
  const merged = (key: string, mergedAt: string): Record<string, PrCheck> => ({ [key]: { state: "MERGED", mergedAt, url: null, checkedAt: "2026-09-28T09:00:00Z" } });
  const foldHome = (lines: readonly string[], prev: FoldState = newFoldState(), home: string | null = HOME): FoldState => {
    const r = new OutcomeFoldReader(prev, home);
    for (const l of lines) r.line(l, T0);
    return r.finish(prev.offset + 1, false);
  };
  const merges = (commands: readonly string[], home: string | null = HOME): FoldState =>
    foldHome(commands.flatMap((command, i) => [toolUse(`toolu_mn${i}`, "Bash", { command }, at(i)), toolResult(`toolu_mn${i}`, NO_OUTPUT, at(i))]), newFoldState(), home);
  const keys = (prs: ReadonlyArray<{ repo: string; number: number }>): string[] => prs.map((p) => `${p.repo}#${p.number}`).sort();

  it("the real #460 merge: no URL, no pr-link, a `cd` first; the checkout's repo, and gh's mergedAt inside the call, make it shipped", () => {
    const [from, to] = ["2026-09-16T09:51:02.907Z", "2026-09-16T09:52:01.403Z"]; // ✅ the real call's two lines
    const f = foldHome([toolUse("toolu_m460", "Bash", { command: MERGE_460 }, from), toolResult("toolu_m460", OUT_460, to)]);
    expect(f.prs).toEqual([]);
    expect(f.mergesByDir).toEqual([{ dir: "/Users/someone/Documents/Code/acme-ai-next", number: 460, from, to }]);
    const placed = placeMergesByDir(f, new Map([["/Users/someone/Documents/Code/acme-ai-next", "acme-inc/acme-ai"]]));
    expect(placed.ranMerges).toEqual([{ repo: "acme-inc/acme-ai", number: 460, from, to }]);
    expect(placed.mergesByDir).toEqual([]);
    expect(keys(prsToCheck(placed))).toEqual(["acme-inc/acme-ai#460"]); // gh is asked about it
    const rec = recordOf(placed, merged("acme-inc/acme-ai#460", "2026-09-16T09:51:59Z"));
    expect(rec).toMatchObject({ outcome: "shipped", reason: "acme-inc/acme-ai#460 merged" });
    expect(summaryOf(rec).mergedPrs).toEqual([{ repo: "acme-inc/acme-ai", number: 460, mergedAt: "2026-09-16T09:51:59Z" }]);
  });

  it("a merge call that failed quietly, on a PR someone else merged later, is not the session's PR", () => {
    const f = placeMergesByDir(merges(["gh pr merge 12 2>&1 | tail -1"]), new Map([[CWD, "o/r"]]));
    expect(keys(f.ranMerges)).toEqual(["o/r#12"]);
    const rec = recordOf(f, merged("o/r#12", at(90))); // merged 90 min after the call returned
    expect(rec.prs).toEqual([]);
    expect(rec.outcome).toBe("unknown");
    // Not MERGED at all (it failed, and is still open or was closed): never a PR, never "delivered".
    expect(recordOf(f, { "o/r#12": { state: "OPEN", mergedAt: null, url: null, checkedAt: at(5) } }).prs).toEqual([]);
    // Inside the call, allowing GitHub's whole seconds: it is.
    expect(recordOf(f, merged("o/r#12", new Date(Date.parse(at(0)) - 2_000).toISOString())).prs.map((p) => p.number)).toEqual([12]);
  });

  it("the real race: a call 3s after another session's printed gh's failure, so only the one that merged counts", () => {
    // ✅ Real (#501, 2026-09-21): 2f4b251b ran `gh pr merge 501` at 10:24:23.6, a9268b40 at 10:24:26.3;
    // GitHub merged at 10:24:30, inside both calls. a9268b40's call printed gh's failure.
    const lines = (id: string, from: string, to: string, out: string): string[] => [
      toolUse(id, "Bash", { command: "cd ~/Documents/Code/acme-ai-next\ngh pr merge 501 --squash --delete-branch 2>&1 | tail -2\ngh pr view 501 --json state --jq .state" }, from),
      toolResult(id, out, to),
    ];
    const winner = placeMergesByDir(foldHome(lines("toolu_w", "2026-09-21T10:24:23.646Z", "2026-09-21T10:24:31.900Z", "MERGED")), new Map([["/Users/someone/Documents/Code/acme-ai-next", "acme-inc/acme-ai"]]));
    const loser = foldHome(lines("toolu_l", "2026-09-21T10:24:26.319Z", "2026-09-21T10:24:34.150Z", "GraphQL: Merge already in progress (mergePullRequest)\nOPEN"));
    const check = merged("acme-inc/acme-ai#501", "2026-09-21T10:24:30Z");
    expect(recordOf(winner, check).outcome).toBe("shipped");
    expect(loser.mergesByDir).toEqual([]);
    expect(loser.ranMerges).toEqual([]);
    for (const out of ["X Pull request ACME-Inc/acme-ai#501 is not mergeable: the base branch policy prohibits the merge.", "HTTP 502: Bad Gateway (https://api.github.com/graphql)", "non-200 OK status code: 502 Bad Gateway body: \"\""]) {
      expect(foldHome(lines("toolu_x", "2026-09-21T10:24:26.319Z", "2026-09-21T10:24:34.150Z", out)).mergesByDir).toEqual([]);
    }
  });

  it("--repo, -R, --repo= and a PR URL name the repo themselves (✅ real: `gh pr merge 501 --repo ACME-Inc/acme-ai --squash …`)", () => {
    const f = merges([
      "gh pr merge 501 --repo ACME-Inc/acme-ai --squash --delete-branch 2>&1 | tail -3",
      "gh pr merge -R o/r 7 --merge",
      "gh pr merge 8 --repo=o/r --squash",
      "gh pr merge https://github.com/O/R2/pull/9 --squash",
      'gh pr merge --subject "fix: 12 things; and more" 10 --repo o/r',
    ]);
    expect(keys(f.ranMerges)).toEqual(["acme-inc/acme-ai#501", "o/r#10", "o/r#7", "o/r#8", "o/r2#9"]);
    expect(f.mergesByDir).toEqual([]);
    expect(f.prs).toEqual([]);
  });

  it("the directory: the line's cwd, then each `cd` in order (relative ones too); a `cd` it can't follow drops the merge", () => {
    expect(merges(["gh pr merge 3 --squash"]).mergesByDir.map((m) => m.dir)).toEqual([CWD]);
    expect(merges(["cd /repos && cd app\ngh pr merge 4 --squash"]).mergesByDir.map((m) => m.dir)).toEqual(["/repos/app"]);
    expect(merges(["cd '/repos/with space' && gh pr merge 4"]).mergesByDir.map((m) => m.dir)).toEqual(["/repos/with space"]);
    expect(merges(["(cd /elsewhere && make); gh pr merge 4"]).mergesByDir.map((m) => m.dir)).toEqual([CWD]); // a subshell's cd is over
    for (const command of ['cd "$WT" && gh pr merge 5', "cd ~other/x; gh pr merge 6", "cd - && gh pr merge 6", "if true; then cd /x; fi; gh pr merge 6", "GH_REPO=o/r gh pr merge 7"]) {
      expect(merges([command]).mergesByDir).toEqual([]);
    }
    expect(merges(["cd ~/x; gh pr merge 7"], null).mergesByDir).toEqual([]); // no home dir to expand ~ against
  });

  it("names nothing gh could be pointed at: a shell variable, no number (the current branch), a mention in a string", () => {
    const f = merges([
      "for n in 62 63; do gh pr merge $n --merge >/dev/null 2>&1; done",
      "gh pr merge --squash --delete-branch 2>&1",
      'echo "- run `gh pr merge <n> --merge`." >> journal.md',
      "gh pr merge feat/some-branch --squash",
      "cat > notes.md <<'EOF'\ngh pr merge 12 --squash\nEOF",
    ]);
    expect(f.ranMerges).toEqual([]);
    expect(f.mergesByDir).toEqual([]);
    expect(f.pendingMerges).toEqual([]);
  });

  it("a merge that never ran (✅ real: denied by the auto-mode classifier, is_error) is not a PR", () => {
    const f = foldHome([
      toolUse("toolu_md", "Bash", { command: "gh pr merge 480 --merge 2>&1" }, at(0)),
      toolError("toolu_md", "Permission for this action was denied by the Claude Code auto mode classifier.", at(1)),
      toolUse("toolu_mr", "Bash", { command: "gh pr merge 481 --repo o/r --merge" }, at(2)),
      toolError("toolu_mr", "Permission for this action was denied by the Claude Code auto mode classifier.", at(3)),
    ]);
    expect(f.ranMerges).toEqual([]);
    expect(f.mergesByDir).toEqual([]);
    expect(f.pendingMerges).toEqual([]);
  });

  it("its output can land in a later read; a directory with no single GitHub repo drops the merge", () => {
    const first = foldHome([toolUse("toolu_ml", "Bash", { command: "cd ~/code/app && gh pr merge 12 --squash" }, at(0))]);
    expect(first.pendingMerges).toEqual([{ id: "toolu_ml", number: 12, repo: null, dir: "/Users/someone/code/app", from: at(0) }]);
    const second = foldHome([toolResult("toolu_ml", NO_OUTPUT, at(1))], first);
    expect(second.pendingMerges).toEqual([]);
    expect(second.mergesByDir).toEqual([{ dir: "/Users/someone/code/app", number: 12, from: at(0), to: at(1) }]);
    const dropped = placeMergesByDir(second, new Map([["/Users/someone/code/app", null]]));
    expect(dropped.ranMerges).toEqual([]);
    expect(dropped.mergesByDir).toEqual([]);
    expect(placeMergesByDir(second, new Map()).mergesByDir).toEqual(second.mergesByDir); // not asked yet: waits
  });

  it("a merge by number counts even when the same call closes another PR (✅ real: 474 merged, 256 closed)", () => {
    const f = foldHome([
      toolUse("toolu_mc", "Bash", { command: 'cd ~/code/app\ngh pr merge 474 --squash --delete-branch 2>&1 | tail -3\ngh pr close 256 --comment "Superseded by #474"' }, at(0)),
      toolResult("toolu_mc", "\nMERGED\n✓ Closed pull request O/App#256 (feat: old)", at(1)),
      prLink("O/App", 256, at(1)),
    ]);
    const placed = placeMergesByDir(f, new Map([["/Users/someone/code/app", "o/app"]]));
    expect(placed.prs).toEqual([]);
    expect(recordOf(placed, merged("o/app#474", at(1))).prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["o/app#474"]);
  });

  it("githubRepoOfRemotes: the one GitHub repo `git remote -v` lists, else null (a fork's upstream leaves gh's pick ambiguous)", () => {
    expect(githubRepoOfRemotes("origin\thttps://github.com/ACME-Inc/acme-ai.git (fetch)\norigin\thttps://github.com/ACME-Inc/acme-ai.git (push)\n")).toBe("acme-inc/acme-ai");
    expect(githubRepoOfRemotes("origin\tgit@github.com:o/r.git (fetch)\nmirror\thttps://github.com/O/R (fetch)\nlab\thttps://gitlab.com/o/r.git (fetch)\n")).toBe("o/r");
    expect(githubRepoOfRemotes("origin\thttps://github.com/me/fork.git (fetch)\nupstream\thttps://github.com/them/repo.git (fetch)\n")).toBeNull();
    expect(githubRepoOfRemotes("origin\thttps://gitlab.com/o/r.git (fetch)\n")).toBeNull();
    expect(githubRepoOfRemotes("")).toBeNull();
  });
});

describe("a push counts only when git reports a ref it updated", () => {
  const push = (id: string, command: string, output: string, ts = T0): string[] => [toolUse(id, "Bash", { command }, ts), toolResult(id, output, ts)];

  it("a rejected push is not a push (✅ real shape: is_error, 'To <url>', then ' ! [rejected]')", () => {
    const rejected = "To https://github.com/o/r.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart.";
    const f = fold([toolUse("toolu_r1", "Bash", { command: "git add -A && git commit -q -m x && git push origin main" }), toolError("toolu_r1", rejected, at(1))]);
    expect(f.pushes).toEqual([]);
    expect(recordOf(f).outcome).toBe("unknown");
  });

  it("a server-side rejection is not a push either", () => {
    const f = fold(push("toolu_r2", "git push origin main", "remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo https://github.com/o/r.git\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs"));
    expect(f.pushes).toEqual([]);
  });

  it("a --dry-run push is not a push, though git prints the same lines", () => {
    const f = fold(push("toolu_r3", "git push --dry-run -u origin feat/x", "To https://github.com/o/r\n * [new branch]      feat/x -> feat/x\n"));
    expect(f.pushes).toEqual([]);
  });

  it("deleting a remote branch is not a push", () => {
    const f = fold(push("toolu_r4", "git push origin --delete feat/x 2>&1 | tail -3", "To https://github.com/o/r.git\n - [deleted]           feat/x\n"));
    expect(f.pushes).toEqual([]);
  });

  it("fast-forward, forced and new-branch updates are pushes (✅ the three shapes seen in real output)", () => {
    const f = fold([
      ...push("toolu_r5", "git push", "To https://github.com/o/a.git\n   1a2b3c4d..5e6f7a8b  main -> main\n", at(1)),
      ...push("toolu_r6", "git push --force-with-lease", "To https://github.com/o/b.git\n + 1a2b3c4d...5e6f7a8b feat/x -> feat/x (forced update)\n", at(2)),
      ...push("toolu_r7", "git push -u origin feat/y 2>&1 | tail -3", "To https://github.com/o/c.git\n * [new branch]      feat/y -> feat/y\nbranch 'feat/y' set up to track 'origin/feat/y'.\n", at(3)),
    ]);
    expect(f.pushes.map((p) => p.repo).sort()).toEqual(["o/a", "o/b", "o/c"]);
  });

  it("per remote: a rejected remote next to a landed one counts only the landed one; a retry that lands counts", () => {
    const two = fold(push("toolu_r8", "git push a feat/x; git push b feat/x", "To https://github.com/o/a\n * [new branch]      feat/x -> feat/x\nTo https://github.com/o/b\n ! [rejected]        feat/x -> feat/x (fetch first)\n"));
    expect(two.pushes.map((p) => p.repo)).toEqual(["o/a"]);
    const retry = fold(push("toolu_r9", "git push || (git pull --rebase && git push)", "To https://github.com/o/r\n ! [rejected]        main -> main (fetch first)\nFrom https://github.com/o/r\n   1a2b3c4..5e6f7a8  main       -> origin/main\nTo https://github.com/o/r\n   5e6f7a8..9f0e1d2  main -> main\n"));
    expect(retry.pushes.map((p) => p.repo)).toEqual(["o/r"]);
  });

  it("a fetch's ref line after a rejected push is not the push's", () => {
    const f = fold(push("toolu_r10", "git push || git fetch", "To https://github.com/o/r\n ! [rejected]        main -> main (fetch first)\nFrom https://github.com/o/r\n   1a2b3c4..5e6f7a8  main       -> origin/main\n"));
    expect(f.pushes).toEqual([]);
  });

  it("a dry run whose output lands in a later read is still not a push", () => {
    const first = fold([toolUse("toolu_r11", "Bash", { command: "git push --dry-run origin main" })]);
    const second = fold([toolResult("toolu_r11", "To https://github.com/o/r\n   1a2b3c4..5e6f7a8  main -> main\n", at(1))], first);
    expect(second.pushes).toEqual([]);
  });
});

describe("artifactUrlsIn (shelf-lib)", () => {
  it("claude.ai artifact links only, sanitized, without query or fragment, deduped", () => {
    const t = "see https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7?token=abc#x and https://claude.ai/code/artifact/0f1e2d3c-aaaa-bbbb-cccc-000011112222, " +
      "https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7. Not https://claude.ai/chat/123456 nor https://example.com/artifact/AbCdEfGh12";
    expect(artifactUrlsIn(t)).toEqual(["https://claude.ai/artifact/83KrHJiPKosgyiPS51YgX7", "https://claude.ai/code/artifact/0f1e2d3c-aaaa-bbbb-cccc-000011112222"]);
    expect(artifactUrlsIn("")).toEqual([]);
  });
});

// ── the verdict ─────────────────────────────────────────────────────────

const pr = (state: PrState, extra: Partial<OutcomePr> = {}): OutcomePr => ({ repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", state, mergedAt: state === "MERGED" ? at(60) : null, checkedAt: at(61), firstSeenAt: at(0), ...extra });
const ending = (kind: TailEnding["kind"], extra: Partial<TailEnding> = {}): TailEnding => ({ kind, error: null, headless: false, ...extra });
const ask: LastLineState = { kind: "assistant_tool", toolName: "AskUserQuestion", textIsQuestion: false };
const question: LastLineState = { kind: "assistant_text", toolName: null, textIsQuestion: true };
const DAY = 24 * 3_600_000;

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return { live: false, quietMs: 2 * DAY, prs: [], pushes: [], artifacts: [], ending: null, lastLine: null, todos: null, ...over };
}

describe("classifyOutcome: the precedence table", () => {
  const cases: Array<[string, Partial<ClassifyInput>, string, string | null]> = [
    ["merged PR", { prs: [pr("MERGED")] }, "shipped", "o/r#12 merged"],
    ["merged PR beats an API-error ending", { prs: [pr("MERGED")], ending: ending("api_error", { error: "API Error: 529" }) }, "shipped", "o/r#12 merged"],
    ["open PR", { prs: [pr("OPEN")] }, "delivered", "o/r#12 open"],
    ["closed PR", { prs: [pr("CLOSED")] }, "delivered", "o/r#12 closed without merging"],
    ["gh couldn't say: never shipped", { prs: [pr("unknown")] }, "delivered", "o/r#12 (gh couldn't say)"],
    ["not checked yet: never shipped", { prs: [pr("unchecked")] }, "delivered", "o/r#12 (not checked yet)"],
    ["a push", { pushes: [{ repo: "o/r", at: at(5) }] }, "delivered", "pushed to o/r"],
    ["an artifact", { artifacts: [{ url: "https://claude.ai/artifact/AbCdEfGh12", at: at(5) }] }, "delivered", "published a claude.ai artifact"],
    ["a push beats a failed ending", { pushes: [{ repo: "o/r", at: at(5) }], ending: ending("api_error", { error: "API Error: x" }) }, "delivered", "pushed to o/r"],
    ["API-error tail", { ending: ending("api_error", { error: "API Error: Request timed out" }) }, "failed", "API Error: Request timed out"],
    ["user interrupt, interactive", { ending: ending("interrupted") }, "stopped", "interrupted by the user"],
    ["interrupt, headless", { ending: ending("interrupted", { headless: true }) }, "failed", "interrupted (cause unknown)"],
    ["cut-off tool call", { ending: ending("assistant_tool") }, "failed", "cut off: a tool call never returned"],
    ["failed beats abandoned", { ending: ending("api_error", { error: "API Error: x" }), lastLine: question }, "failed", "API Error: x"],
    ["pending AskUserQuestion, 25h", { ending: ending("assistant_tool"), lastLine: ask, quietMs: DAY + 3_600_000 }, "abandoned", "waited on you: AskUserQuestion"],
    ["pending AskUserQuestion, 1h: not failed, not abandoned yet", { ending: ending("assistant_tool"), lastLine: ask, quietMs: 3_600_000 }, "unknown", null],
    ["a closing question, 25h", { ending: ending("assistant_text"), lastLine: question, quietMs: DAY + 1 }, "abandoned", "its last message asked you a question"],
    ["abandoned beats finished", { lastLine: question, todos: { total: 2, completed: 2 } }, "abandoned", "its last message asked you a question"],
    ["todos all done", { ending: ending("assistant_text"), todos: { total: 2, completed: 2 } }, "finished", "all 2 todo items completed"],
    ["todos not all done", { todos: { total: 2, completed: 1 } }, "unknown", null],
    ["an empty todo list", { todos: { total: 0, completed: 0 } }, "unknown", null],
    ["a clean end, nothing else", { ending: ending("assistant_text") }, "unknown", null],
    ["nothing conversational in the tail: unknown, never failed", { ending: ending(null) }, "unknown", null],
    ["live beats everything", { live: true, prs: [pr("MERGED")], ending: ending("api_error") }, "active", null],
  ];
  for (const [name, over, outcome, reason] of cases) {
    it(name, () => {
      const v = classifyOutcome(input(over));
      expect(v.outcome).toBe(outcome);
      expect(v.reason).toBe(reason);
    });
  }

  it("a mid-turn tail stays unknown until its stall bound (30 min), then fails", () => {
    expect(classifyOutcome(input({ ending: ending("tool_result"), quietMs: 20 * 60_000 })).outcome).toBe("unknown");
    expect(classifyOutcome(input({ ending: ending("tool_result"), quietMs: 31 * 60_000 })).outcome).toBe("failed");
  });

  it("abandoned needs 24h of dormancy", () => {
    expect(classifyOutcome(input({ lastLine: question, quietMs: ABANDON_MS - 1 })).outcome).toBe("unknown");
    expect(classifyOutcome(input({ lastLine: question, quietMs: ABANDON_MS })).outcome).toBe("abandoned");
  });

  it("evidence time: the merge for shipped, the newest sighting for delivered", () => {
    expect(classifyOutcome(input({ prs: [pr("MERGED")] })).evidenceAt).toBe(at(60));
    expect(classifyOutcome(input({ prs: [pr("OPEN")], pushes: [{ repo: "o/r", at: at(9) }] })).evidenceAt).toBe(at(9));
  });

  it("says how long the clock alone can still change a verdict (provisionalMs), and never afterwards", () => {
    const min = 60_000;
    // A turn left mid-way: unknown (or finished) until its stall bound, then failed for good.
    expect(classifyOutcome(input({ ending: ending("tool_result"), quietMs: 15 * min }))).toMatchObject({ outcome: "unknown", provisionalMs: STALL_MS });
    expect(classifyOutcome(input({ ending: ending("tool_result"), quietMs: 15 * min, todos: { total: 2, completed: 2 } }))).toMatchObject({ outcome: "finished", provisionalMs: STALL_MS });
    expect(classifyOutcome(input({ ending: ending("tool_result"), quietMs: STALL_MS + 1 }))).toMatchObject({ outcome: "failed", provisionalMs: null });
    expect(classifyOutcome(input({ ending: ending("prompt"), quietMs: 40 * min }))).toMatchObject({ outcome: "unknown", provisionalMs: PROMPT_STALL_MS });
    // A question to the user: unknown until ABANDON_MS, then abandoned for good; a pending
    // AskUserQuestion is never read as a cut-off tool call meanwhile.
    expect(classifyOutcome(input({ ending: ending("assistant_text"), lastLine: question, quietMs: 3_600_000 }))).toMatchObject({ outcome: "unknown", provisionalMs: ABANDON_MS });
    expect(classifyOutcome(input({ ending: ending("assistant_tool"), lastLine: ask, quietMs: 3_600_000 }))).toMatchObject({ outcome: "unknown", provisionalMs: ABANDON_MS });
    expect(classifyOutcome(input({ lastLine: question, quietMs: ABANDON_MS }))).toMatchObject({ outcome: "abandoned", provisionalMs: null });
    // Final: a clean ending, a failure, and shipped / delivered, whatever the tail does later.
    expect(classifyOutcome(input({ ending: ending("assistant_text"), quietMs: 15 * min })).provisionalMs).toBeNull();
    expect(classifyOutcome(input({ ending: ending("api_error", { error: "API Error: x" }), quietMs: 15 * min })).provisionalMs).toBeNull();
    expect(classifyOutcome(input({ prs: [pr("MERGED")], ending: ending("tool_result"), quietMs: 15 * min })).provisionalMs).toBeNull();
    expect(classifyOutcome(input({ pushes: [{ repo: "o/r", at: at(5) }], lastLine: question, quietMs: 3_600_000 })).provisionalMs).toBeNull();
    expect(classifyOutcome(input({ live: true, ending: ending("tool_result"), quietMs: 15 * min })).provisionalMs).toBeNull();
  });

  it("provisionalMs is exactly where fold's endingOutcome turns each tail kind into a failure", () => {
    const kinds: Array<TailEnding["kind"]> = ["assistant_text", "tool_end", "api_error", "interrupted", "text_open", "thinking", "assistant_tool", "tool_result", "prompt", null];
    for (const kind of kinds) {
      for (const headless of [false, true]) {
        const e = ending(kind, { headless });
        const due = classifyOutcome(input({ ending: e, quietMs: 60_000 })).provisionalMs;
        const everFails = classifyOutcome(input({ ending: e, quietMs: 100 * DAY })).outcome !== "unknown";
        expect(due !== null, `${kind} headless=${headless}`).toBe(everFails);
        if (due === null) continue;
        expect(classifyOutcome(input({ ending: e, quietMs: due })).outcome, `${kind} at its bound`).toBe("unknown");
        expect(classifyOutcome(input({ ending: e, quietMs: due + 1 })).outcome, `${kind} past its bound`).not.toBe("unknown");
      }
    }
  });

  it("buildRecord turns it into provisionalUntil: the transcript's mtime plus that bound", () => {
    const mtimeMs = Date.parse(at(100));
    const s = { ...newStoredSession(), readSize: 10, mtimeMs, ending: ending("tool_result") };
    const rec = (nowMin: number) => buildRecord(SID, s, {}, { live: false, nowMs: Date.parse(at(nowMin)), file: { size: 10, mtimeMs }, lastLine: null });
    expect(rec(115)).toMatchObject({ outcome: "unknown", provisionalUntil: new Date(mtimeMs + STALL_MS).toISOString() });
    expect(rec(131)).toMatchObject({ outcome: "failed", provisionalUntil: null });
  });

  it("keeps the failed ending on a shipped record, but not a pending question's", () => {
    expect(classifyOutcome(input({ prs: [pr("MERGED")], ending: ending("api_error", { error: "API Error: x" }) })).ending).toEqual({ status: "failed", reason: "API Error: x", headless: false });
    expect(classifyOutcome(input({ ending: ending("assistant_tool"), lastLine: ask })).ending).toBeNull();
  });
});

// ── gh ──────────────────────────────────────────────────────────────────

describe("gh pr view: argv and cache policy", () => {
  it("builds exactly `gh pr view <n> --repo <owner/repo> --json state,mergedAt,url`", () => {
    expect(ghPrViewArgs("acme-inc/acme-ai", 412)).toEqual(["pr", "view", "412", "--repo", "acme-inc/acme-ai", "--json", "state,mergedAt,url"]);
  });

  it("refuses anything that isn't a plain owner/repo and a positive PR number", () => {
    for (const repo of ["o/r;rm -rf ~", "-x/r", "o/-r", "../r", "o/..", "o/r/x", "o", "O/R", "o r/x", "$(id)/r"]) expect(ghPrViewArgs(repo, 1)).toBeNull();
    for (const n of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(ghPrViewArgs("o/r", n)).toBeNull();
  });

  it("reads gh's answer: MERGED / OPEN / CLOSED, anything else is unknown", () => {
    const c = "2026-09-28T09:00:00.000Z";
    expect(prCheckFrom({ ok: true, stdout: '{"mergedAt":"2026-09-28T03:30:03Z","state":"MERGED","url":"https://github.com/o/r/pull/12"}' }, c)).toEqual({
      state: "MERGED",
      mergedAt: "2026-09-28T03:30:03Z",
      url: "https://github.com/o/r/pull/12",
      checkedAt: c,
    });
    expect(prCheckFrom({ ok: true, stdout: '{"mergedAt":null,"state":"OPEN","url":"https://github.com/o/r/pull/12"}' }, c).state).toBe("OPEN");
    expect(prCheckFrom({ ok: true, stdout: '{"mergedAt":null,"state":"CLOSED","url":"https://github.com/o/r/pull/12"}' }, c).state).toBe("CLOSED");
    expect(prCheckFrom({ ok: false, code: "EXIT" }, c).state).toBe("unknown");
    expect(prCheckFrom({ ok: false, code: "ENOENT" }, c).state).toBe("unknown");
    expect(prCheckFrom({ ok: true, stdout: "not json" }, c).state).toBe("unknown");
    expect(prCheckFrom({ ok: true, stdout: '{"state":"DRAFT"}' }, c).state).toBe("unknown");
    expect(prCheckFrom({ ok: true, stdout: '{"state":"MERGED","url":"javascript:alert(1)"}' }, c)).toMatchObject({ state: "MERGED", url: null });
  });

  it("MERGED and CLOSED are final; OPEN is asked again after 6h, unknown after 1h", () => {
    const t = Date.parse("2026-09-28T09:00:00.000Z");
    const check = (state: "MERGED" | "OPEN" | "CLOSED" | "unknown") => ({ state, mergedAt: null, url: null, checkedAt: new Date(t).toISOString() });
    expect(prCheckDue(undefined, t)).toBe(true);
    expect(prCheckDue(check("MERGED"), t + 10 * 365 * DAY)).toBe(false);
    expect(prCheckDue(check("CLOSED"), t + 10 * 365 * DAY)).toBe(false);
    expect(prCheckDue(check("OPEN"), t + OPEN_RECHECK_MS - 1)).toBe(false);
    expect(prCheckDue(check("OPEN"), t + OPEN_RECHECK_MS)).toBe(true);
    expect(prCheckDue(check("unknown"), t + UNKNOWN_RETRY_MS - 1)).toBe(false);
    expect(prCheckDue(check("unknown"), t + UNKNOWN_RETRY_MS)).toBe(true);
  });
});

// ── the Feed ────────────────────────────────────────────────────────────

describe("graduations", () => {
  const nowMs = Date.parse(at(120));
  const base = { prev: "delivered" as const, next: "shipped" as const, evidenceAt: at(60), announced: [], cold: false, nowMs };

  it("a transition into shipped with fresh evidence is announced", () => {
    expect(shouldAnnounce(base)).toBe(true);
    expect(shouldAnnounce({ ...base, prev: null, next: "delivered" })).toBe(true);
  });

  it("never during the cold scan, never twice, never on stale evidence, never for other outcomes", () => {
    expect(shouldAnnounce({ ...base, cold: true })).toBe(false);
    expect(shouldAnnounce({ ...base, prev: "shipped" })).toBe(false);
    expect(shouldAnnounce({ ...base, announced: ["shipped"] })).toBe(false);
    expect(shouldAnnounce({ ...base, evidenceAt: new Date(nowMs - DAY).toISOString() })).toBe(false);
    expect(shouldAnnounce({ ...base, evidenceAt: null })).toBe(false);
    expect(shouldAnnounce({ ...base, next: "failed" })).toBe(false);
    expect(shouldAnnounce({ ...base, next: "finished" })).toBe(false);
  });

  it("titles: '🎓 <name> shipped owner/repo#n', '📦 <name> delivered …'", () => {
    expect(graduationTitle("Fix the dashboard", "shipped", [pr("MERGED")], [])).toBe("🎓 Fix the dashboard shipped o/r#12");
    expect(graduationTitle("Fix it", "delivered", [pr("OPEN")], [])).toBe("📦 Fix it delivered o/r#12");
    expect(graduationTitle("Fix it", "delivered", [], [{ repo: "o/r" }])).toBe("📦 Fix it delivered a push to o/r");
    expect(graduationTitle("Fix it", "delivered", [], [])).toBe("📦 Fix it delivered a claude.ai artifact");
    const long = graduationTitle("x".repeat(200) + " <b>tag</b>", "shipped", [pr("MERGED")], []);
    expect(long.endsWith("shipped o/r#12")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

// ── the persisted store ─────────────────────────────────────────────────

describe("parseStore", () => {
  const sid = "11111111-1111-1111-1111-111111111111";
  const good = (): Record<string, unknown> => {
    const st = emptyStore();
    st.sessions[sid] = { ...newStoredSession(), fold: fold([prLink("o/r", 3)]), readSize: 10, mtimeMs: 5, ending: { kind: "assistant_text", error: null, headless: false }, last: "delivered" };
    st.prs["o/r#3"] = { state: "OPEN", mergedAt: null, url: null, checkedAt: T0 };
    return JSON.parse(JSON.stringify(st)) as Record<string, unknown>;
  };

  it("round-trips a valid store", () => {
    expect(parseStore(good())).toEqual(good());
  });

  it("anything malformed or from another version starts empty (null)", () => {
    for (const bad of [null, "x", [], 42, {}, { ...good(), version: 0 }, { ...good(), version: 4 }, { ...good(), sessions: [] }, { ...good(), prs: null }, { ...good(), ticks: "1" }]) {
      expect(parseStore(bad)).toBeNull();
    }
  });

  it("a version-1 store (folded before closes and rejected pushes were told apart) starts empty, so nothing is re-announced", () => {
    expect(parseStore({ ...good(), version: 1 })).toBeNull();
  });

  it("a version-2 store (folded before merges by number counted) restarts its sessions but keeps gh's final answers", () => {
    // Its folds already read past `gh pr merge <n>` calls, so every session is re-read from its
    // start. A PR's state is gh's answer about the PR, not the fold's: MERGED and CLOSED are final
    // (never re-asked), so they carry over; OPEN and unknown are asked again. ✅ The live v2 store
    // held 179 PR states (176 MERGED, 2 CLOSED, 1 OPEN): 178 carry over instead of ~185 re-asks at
    // 10 a tick.
    const raw: Record<string, unknown> = { ...good(), version: 2, ticks: 235, coldDone: true, coldTicks: 13 };
    const prs = raw.prs as Record<string, unknown>;
    const merged = { state: "MERGED", mergedAt: "2026-09-16T09:51:59Z", url: "https://github.com/acme-inc/acme-ai/pull/460", checkedAt: T0 };
    const closed = { state: "CLOSED", mergedAt: null, url: null, checkedAt: T0 };
    prs["acme-inc/acme-ai#460"] = merged;
    prs["o/r#5"] = closed;
    prs["o/r#6"] = { state: "unknown", mergedAt: null, url: null, checkedAt: T0 };
    prs["o/r#x"] = merged; // not owner/repo#n
    prs["o/r#7"] = { ...merged, mergedAt: 5 }; // malformed
    expect(parseStore(raw)).toEqual({ ...emptyStore(), prs: { "acme-inc/acme-ai#460": merged, "o/r#5": closed } });
    // Only a v2 store with a PR map carries anything; a malformed one starts empty as before.
    expect(parseStore({ ...good(), version: 2, prs: [] })).toBeNull();
    expect(parseStore({ version: 2 })).toBeNull();
  });

  it("drops a single malformed session or PR entry, keeps the rest", () => {
    const raw = good();
    const sessions = raw.sessions as Record<string, unknown>;
    sessions["22222222-2222-2222-2222-222222222222"] = { fold: { offset: -1 } };
    sessions["not-a-session-id"] = (good().sessions as Record<string, unknown>)[sid];
    (raw.prs as Record<string, unknown>)["o/r#x"] = { state: "OPEN", mergedAt: null, url: null, checkedAt: T0 };
    (raw.prs as Record<string, unknown>)["o/r#4"] = { state: "SHIPPED", mergedAt: null, url: null, checkedAt: T0 };
    const st = parseStore(raw);
    expect(Object.keys(st?.sessions ?? {})).toEqual([sid]);
    expect(Object.keys(st?.prs ?? {})).toEqual(["o/r#3"]);
  });
});

describe("parseOutcomesMap (the client's validator)", () => {
  it("keeps known outcomes, drops unknown / invalid, never touches a prototype", () => {
    const m = parseOutcomesMap(JSON.parse('{"a":"shipped","b":"unknown","c":"graduated","d":3,"__proto__":"failed"}'));
    expect(m).toEqual(Object.fromEntries([["a", "shipped"], ["__proto__", "failed"]]));
    expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
    expect(parseOutcomesMap(null)).toBeNull();
    expect(parseOutcomesMap([])).toBeNull();
  });
});

describe("summaryOf: the merged PRs a crew is grouped by (generations-and-crews)", () => {
  it("lists only the PRs gh reports MERGED, once each, with their merge time", () => {
    const f = fold([prLink("Owner/Repo", 5, at(0)), prLink("owner/repo", 5, at(2)), prLink("owner/repo", 6, at(3)), prLink("owner/other", 7, at(4))]);
    const checks: Record<string, PrCheck> = {
      "owner/repo#5": { state: "MERGED", mergedAt: at(60), url: null, checkedAt: at(61) },
      "owner/repo#6": { state: "OPEN", mergedAt: null, url: null, checkedAt: at(61) },
      "owner/other#7": { state: "CLOSED", mergedAt: null, url: null, checkedAt: at(61) },
    };
    const s = summaryOf(recordOf(f, checks));
    expect(s.prs).toBe(3);
    expect(s.merged).toBe(1);
    expect(s.mergedPrs).toEqual([{ repo: "owner/repo", number: 5, mergedAt: at(60) }]);
  });

  it("a session with no merged PR has an empty list, not a missing one", () => {
    const s = summaryOf(recordOf(fold([prLink("o/r", 9, at(0))]), { "o/r#9": { state: "unknown", mergedAt: null, url: null, checkedAt: at(61) } }));
    expect(s.merged).toBe(0);
    expect(s.mergedPrs).toEqual([]);
  });
});
