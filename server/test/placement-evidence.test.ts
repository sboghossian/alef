// Placing a home-run session where its work SHIPPED (placement-evidence-lib.ts, home-placement.ts):
// pr-link records, `git push` / `gh pr create` / `gh pr merge` output, and the files its subagents
// edited. Line shapes are real ~/.claude/projects records (key sets verbatim, ids and text
// shortened); repo lookups run real `git remote get-url origin` on real temp clones.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorldDb } from "../db.js";
import { runHomePlacementBackfill, runPlacementEvidenceBackfill } from "../home-placement.js";
import { runIndexPass } from "../indexer.js";
import { parseLine } from "../jsonl-events.js";
import {
  foldEvidence,
  githubRepoOfRemoteUrl,
  isShipCommand,
  mayCarryEvidence,
  newEvidenceFold,
  pickCloneRoot,
  pickShipRepo,
  shipOutputRepos,
  shipScores,
} from "../placement-evidence-lib.js";
import { appendToSessionFile, makeTempDb, makeTempProjectsDir, writeSessionFile } from "./helpers.js";

const SID = "5e0772ee-14ee-4c51-bdef-ab7c3df21201";

// ── real line shapes ───────────────────────────────────────────────────────────────────────

const prLink = (repo: string, n: number, ts: string, sid = SID): string =>
  JSON.stringify({ type: "pr-link", sessionId: sid, prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: ts });

function userText(cwd: string, ts: string, text: string, sid = SID): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId: "50a234fd-995e-41bd-9f87-009827889b5d",
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    uuid: "4a6b5398-2741-4ba1-aca0-b3526fdb7200",
    timestamp: ts,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd,
    sessionId: sid,
    version: "2.1.278",
    gitBranch: "HEAD",
  });
}

interface Who {
  cwd: string;
  ts: string;
  /** Subagent transcripts: isSidechain, agentId, and the parent's sessionId. */
  agentId?: string;
}

function toolUseLine(w: Who, id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    parentUuid: "432bde44-070e-4ba7-8aae-ad701376d6b1",
    isSidechain: w.agentId !== undefined,
    ...(w.agentId ? { agentId: w.agentId } : {}),
    message: {
      model: "claude-opus-5",
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
    },
    type: "assistant",
    uuid: `u-${id}`,
    timestamp: w.ts,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: w.cwd,
    sessionId: SID,
    version: "2.1.278",
    gitBranch: "HEAD",
  });
}

/** A parent's tool_result line carries toolUseResult (stdout…); a subagent's usually doesn't. */
function toolResultLine(w: Who, id: string, text: string): string {
  return JSON.stringify({
    parentUuid: "58909fbe-05af-490d-90d2-745ceb1755f8",
    isSidechain: w.agentId !== undefined,
    ...(w.agentId ? { agentId: w.agentId } : {}),
    promptId: "50a234fd-995e-41bd-9f87-009827889b5d",
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: text, is_error: false }] },
    uuid: `r-${id}`,
    timestamp: w.ts,
    ...(w.agentId ? {} : { toolUseResult: { stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: false } }),
    sourceToolAssistantUUID: `u-${id}`,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: w.cwd,
    sessionId: SID,
    version: "2.1.278",
    gitBranch: "HEAD",
  });
}

// Verbatim tool outputs from real transcripts.
const PUSH_OUT =
  "remote: \nremote: Create a pull request for 'fix/tick-1889-competitor-logos' on GitHub by visiting:        \nremote:      https://github.com/ACME-Inc/acme-ai/pull/new/fix/tick-1889-competitor-logos        \nremote: \nTo https://github.com/ACME-Inc/acme-ai.git\n * [new branch]          fix/tick-1889-competitor-logos -> fix/tick-1889-competitor-logos\nbranch 'fix/tick-1889-competitor-logos' set up to track 'origin/fix/tick-1889-competitor-logos'.";
const PR_CREATE_OUT = "https://github.com/ACME-Inc/acme-ai/pull/510";
const MERGE_OUT = "✓ Merged pull request ACME-Inc/legal-taxonomy#5 (feat(data): 2026-09 verification run)";
const DENIED_OUT =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. If you have other tasks that don't depend on this action, continue working on those.";
const PULL_OUT = "From https://github.com/sboghossian/agent-world\n * branch            main       -> FETCH_HEAD\nAlready up to date.";
const PUSH_CMD = "export PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH\ncd ~/.acme-worktrees/tick-1889-logos\ngit push -u origin fix/tick-1889-competitor-logos 2>&1";
const PR_CMD = "cd \"$DST\"\ngh pr create --repo ACME-Inc/acme-ai --base main --head feat/tick-1880-internal-links \\\n  --title \"feat(tick-1880): internal links\" --body-file /tmp/pr.md";

const lines = (...ls: string[]): string => ls.join("\n") + "\n";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

/** A real git clone (no network): `git init` plus an origin remote. */
function makeClone(root: string, origin: string): string {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
  return root;
}

/** A clone that already has an island: a session was run from it (the indexer's own way). */
async function cloneWithIsland(t: World, name: string, origin: string, sid: string): Promise<string> {
  const root = makeClone(join(t.dir, "code", name), origin);
  await writeSessionFile(t.dir, `-code-${name}`, sid, lines(userText(root, "2026-09-20T09:00:00.000Z", "work here", sid)));
  return root;
}

interface World {
  dir: string;
  db: WorldDb;
  home: string;
}

async function world(): Promise<World> {
  const dir = await makeTempProjectsDir();
  const db = await makeTempDb(dir);
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  return { dir, db, home };
}

const pass = (t: World): Promise<unknown> => runIndexPass(t.db, { projectsDir: t.dir, homeDir: t.home });
const homeIsland = (t: World): string | null => t.db.getIslandForCwd(t.home);

async function writeSubagent(t: World, rel: string, body: string): Promise<string> {
  const dir = join(t.dir, "-home", SID, "subagents", ...rel.split("/").slice(0, -1));
  await mkdir(dir, { recursive: true });
  const path = join(dir, rel.split("/").at(-1) ?? "agent.jsonl");
  await appendToSessionFile(path, body);
  return path;
}

// ── pure ───────────────────────────────────────────────────────────────────────────────────

describe("placement-evidence-lib", () => {
  it("parses a real pr-link record, tool_use ids and tool_result blocks", () => {
    expect(parseLine(prLink("ACME-Inc/acme-ai", 524, "2026-09-23T07:39:45.171Z"))?.prLink).toEqual({ repo: "ACME-Inc/acme-ai", number: 524 });
    const w = { cwd: "/h", ts: "2026-09-23T05:03:00.000Z" };
    expect(parseLine(toolUseLine(w, "toolu_01U4yMNNenEXKDhossswmXDT", "Bash", { command: PUSH_CMD }))?.toolUses[0]?.id).toBe("toolu_01U4yMNNenEXKDhossswmXDT");
    expect(parseLine(toolResultLine(w, "toolu_01U4yMNNenEXKDhossswmXDT", PUSH_OUT))?.toolResults).toEqual([{ toolUseId: "toolu_01U4yMNNenEXKDhossswmXDT", content: PUSH_OUT, isError: false }]);
  });

  it("reads PRs and pushes out of real ship-command output, and nothing else", () => {
    expect(shipOutputRepos(PUSH_OUT)).toEqual({ prs: [], pushes: ["acme-inc/acme-ai"] }); // "pull/new/<branch>" is not a PR
    expect(shipOutputRepos(PR_CREATE_OUT)).toEqual({ prs: [{ repo: "acme-inc/acme-ai", number: 510 }], pushes: [] });
    expect(shipOutputRepos(MERGE_OUT)).toEqual({ prs: [{ repo: "acme-inc/legal-taxonomy", number: 5 }], pushes: [] });
    expect(shipOutputRepos(DENIED_OUT)).toEqual({ prs: [], pushes: [] });
    expect(shipOutputRepos(PULL_OUT)).toEqual({ prs: [], pushes: [] }); // a pull's "From" line is not a push
    expect(shipOutputRepos("To git@github.com:sboghossian/agent-world.git\n   2c0130e..aece1fd  feat/x -> feat/x").pushes).toEqual(["sboghossian/agent-world"]);
  });

  it("maps remote URLs to owner/repo and never returns credentials", () => {
    expect(githubRepoOfRemoteUrl("https://github.com/ACME-Inc/acme-ai.git\n")).toBe("acme-inc/acme-ai");
    expect(githubRepoOfRemoteUrl("git@github.com:sboghossian/agent-world.git")).toBe("sboghossian/agent-world");
    expect(githubRepoOfRemoteUrl("ssh://git@github.com/sboghossian/aleph")).toBe("sboghossian/aleph");
    expect(githubRepoOfRemoteUrl("https://x-access-token:ghs_SECRET@github.com/o/r.git")).toBe("o/r");
    expect(githubRepoOfRemoteUrl("https://gitlab.com/o/r.git")).toBeNull();
    expect(githubRepoOfRemoteUrl("https://github.com/o/r/extra")).toBeNull();
  });

  it("ignores a pr-link whose repository isn't a plain owner/repo", () => {
    const acc = newEvidenceFold();
    for (const repo of ["a/b/c", "<img src=x>/r", "../..", "ACME-Inc/acme-ai"]) {
      foldEvidence(acc, parseLine(prLink(repo, 1, "2026-09-23T07:39:45.171Z"))!, "t", { agentEdits: false, cwd: null });
    }
    expect(acc.rows.map((r) => r.subject)).toEqual(["acme-inc/acme-ai"]);
  });

  it("recognises ship commands only", () => {
    expect(isShipCommand(PUSH_CMD)).toBe(true);
    expect(isShipCommand(PR_CMD)).toBe(true);
    expect(isShipCommand("git -C ~/Documents/Code/agent-world push -q origin main")).toBe(true);
    expect(isShipCommand("gh pr merge 32 --merge")).toBe(true);
    expect(isShipCommand("gh pr view 10 --json state")).toBe(false);
    expect(isShipCommand("git pull --ff-only && git log --oneline | head")).toBe(false);
    expect(isShipCommand("echo push")).toBe(false);
  });

  it("pairs a command with its output across folds (the pending set carries over)", () => {
    const w = { cwd: "/h", ts: "2026-09-23T05:03:00.000Z" };
    const first = newEvidenceFold();
    foldEvidence(first, parseLine(toolUseLine(w, "toolu_A", "Bash", { command: PUSH_CMD }))!, w.ts, { agentEdits: false, cwd: null });
    expect([...first.pending]).toEqual(["toolu_A"]);
    const next = newEvidenceFold(first.pending);
    foldEvidence(next, parseLine(toolResultLine(w, "toolu_B", PUSH_OUT))!, w.ts, { agentEdits: false, cwd: null }); // not ours
    foldEvidence(next, parseLine(toolResultLine(w, "toolu_A", PUSH_OUT))!, w.ts, { agentEdits: false, cwd: null });
    expect(next.rows).toEqual([{ kind: "push", key: "toolu_A acme-inc/acme-ai", subject: "acme-inc/acme-ai", at: w.ts }]);
    expect(next.pending.size).toBe(0);
    expect([...next.resolved]).toEqual(["toolu_A"]);
  });

  it("records subagent edits (relative paths against the line's cwd) only when asked", () => {
    const w = { cwd: "/r/wt", ts: "2026-09-16T10:28:13.481Z", agentId: "ad8c0810f6430f903" };
    const line = parseLine(toolUseLine(w, "toolu_E", "Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }))!;
    const own = newEvidenceFold();
    foldEvidence(own, line, w.ts, { agentEdits: false, cwd: null });
    expect(own.rows).toEqual([]);
    const sub = newEvidenceFold();
    foldEvidence(sub, line, w.ts, { agentEdits: true, cwd: null });
    expect(sub.rows).toEqual([{ kind: "agent-edit", key: "/r/wt/src/a.ts", subject: "/r/wt/src/a.ts", at: w.ts }]);
  });

  it("picks a shipped repo only when it clearly leads", () => {
    const rows = (...s: string[]): Array<{ kind: "pr"; subject: string }> => s.map((subject) => ({ kind: "pr", subject }));
    expect(pickShipRepo(shipScores(rows("a/x")))).toBe("a/x"); // one PR is enough
    expect(pickShipRepo(shipScores(rows("a/x", "a/y")))).toBeNull(); // tie
    expect(pickShipRepo(shipScores(rows("a/x", "a/x", "a/y", "a/z", "a/w")))).toBeNull(); // 2 of 5 < half
    expect(pickShipRepo(shipScores(rows("a/x", "a/x", "a/y")))).toBe("a/x");
    expect(pickShipRepo(new Map())).toBeNull();
  });

  it("prefers the visible clone when two share a remote", () => {
    const home = "/Users/me";
    expect(pickCloneRoot(["/Users/me/.cache/portfolio-skill/commandline", "/Users/me/Documents/Code/commandline"], home)).toBe("/Users/me/Documents/Code/commandline");
    expect(pickCloneRoot([], home)).toBeNull();
  });

  it("the byte prefilter never drops a line that carries evidence", () => {
    const w = { cwd: "/h", ts: "2026-09-23T05:03:00.000Z" };
    expect(mayCarryEvidence(prLink("o/r", 1, w.ts), false)).toBe(true);
    expect(mayCarryEvidence(toolUseLine(w, "t1", "Bash", { command: PUSH_CMD }), false)).toBe(true);
    expect(mayCarryEvidence(toolUseLine(w, "t2", "Write", { file_path: "/a", content: "" }), false)).toBe(true);
    expect(mayCarryEvidence(toolResultLine(w, "t1", PUSH_OUT), true)).toBe(true);
    expect(mayCarryEvidence(toolResultLine(w, "t1", PUSH_OUT), false)).toBe(false);
    expect(mayCarryEvidence(userText("/h", w.ts, "push the thing"), true)).toBe(false);
    expect(mayCarryEvidence(toolUseLine(w, "t3", "Read", { file_path: "/a" }), false)).toBe(false);
  });
});

// ── through the real indexer ───────────────────────────────────────────────────────────────

describe("home placement by where the work shipped", () => {
  it("moves a home session to the clone whose origin its pr-link names, keeping cwd truthful", async () => {
    const t = await world();
    const clone = await cloneWithIsland(t, "acme-ai-next", "https://github.com/ACME-Inc/acme-ai.git", "aaaaaaaa-0000-4000-8000-000000000001");
    await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-23T07:00:00.000Z", "TICK-1911 OpenCase"), prLink("ACME-Inc/acme-ai", 524, "2026-09-23T07:39:45.171Z")));
    await pass(t);
    const s = t.db.getSession(SID);
    expect(s?.cwd).toBe(t.home);
    expect(s?.islandId).toBe(t.db.getIslandForCwd(clone));
    expect(s?.islandId).not.toBe(homeIsland(t));
    t.db.close();
  });

  it("shipped beats touched: one PR to repo A outweighs three edits in repo B", async () => {
    const t = await world();
    const a = await cloneWithIsland(t, "agent-world", "git@github.com:sboghossian/agent-world.git", "aaaaaaaa-0000-4000-8000-000000000002");
    const b = makeClone(join(t.dir, "code", "vault"), "https://github.com/sboghossian/alex-brain.git");
    const w = { cwd: t.home, ts: "2026-09-23T07:00:01.000Z" };
    await writeSessionFile(
      t.dir,
      "-home",
      SID,
      lines(
        userText(t.home, "2026-09-23T07:00:00.000Z", "notes then a PR"),
        ...["a.md", "b.md", "c.md"].map((f, i) => toolUseLine(w, `toolu_E${i}`, "Edit", { file_path: join(b, f), old_string: "x", new_string: "y" })),
        prLink("sboghossian/agent-world", 7, "2026-09-23T07:10:00.000Z"),
      ),
    );
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(a));
    t.db.close();
  });

  it("counts a push whose output lands in a later pass (pending ship commands are kept in the db)", async () => {
    const t = await world();
    const clone = await cloneWithIsland(t, "acme-ai-next", "https://github.com/ACME-Inc/acme-ai.git", "aaaaaaaa-0000-4000-8000-000000000003");
    const w = { cwd: t.home, ts: "2026-09-23T05:03:10.000Z" };
    const file = await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-23T05:03:00.000Z", "ship it"), toolUseLine(w, "toolu_01U4yMNNenEXKDhossswmXDT", "Bash", { command: PUSH_CMD })));
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t)); // no output yet
    expect([...t.db.pendingShipUses(SID)]).toEqual(["toolu_01U4yMNNenEXKDhossswmXDT"]);

    await appendToSessionFile(file, lines(toolResultLine({ ...w, cwd: "/Users/x/.acme-worktrees/tick-1889-logos" }, "toolu_01U4yMNNenEXKDhossswmXDT", PUSH_OUT)));
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(clone));
    expect(t.db.pendingShipUses(SID).size).toBe(0);
    t.db.close();
  });

  it("a denied merge or a pull is not shipping", async () => {
    const t = await world();
    await cloneWithIsland(t, "agent-world", "https://github.com/sboghossian/agent-world.git", "aaaaaaaa-0000-4000-8000-000000000004");
    const w = { cwd: t.home, ts: "2026-09-23T05:03:10.000Z" };
    await writeSessionFile(
      t.dir,
      "-home",
      SID,
      lines(
        userText(t.home, "2026-09-23T05:03:00.000Z", "merge it"),
        toolUseLine(w, "toolu_M", "Bash", { command: "gh pr merge 12 --merge && git pull --ff-only" }),
        toolResultLine(w, "toolu_M", `${DENIED_OUT}\n${PULL_OUT}`),
      ),
    );
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t));
    expect(t.db.placementEvidenceOf(SID)).toEqual([]);
    t.db.close();
  });

  it("places by the files its subagents edited, and re-reading a subagent transcript adds nothing", async () => {
    const t = await world();
    const repo = makeClone(join(t.dir, "code", "thumbpad"), "https://github.com/sboghossian/thumbpad.git");
    const parent = await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-20T10:00:00.000Z", "delegate the build")));
    const w = { cwd: repo, ts: "2026-09-20T10:05:00.000Z", agentId: "ad8c0810f6430f903" };
    const sub = await writeSubagent(
      t,
      "agent-ad8c0810f6430f903.jsonl",
      lines(...["src/a.ts", "src/b.ts", "src/c.ts"].map((f, i) => toolUseLine(w, `toolu_S${i}`, "Edit", { file_path: join(repo, f), old_string: "x", new_string: "y" }))),
    );
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(repo));
    expect(t.db.getSession(SID)?.cwd).toBe(t.home);
    expect(t.db.placementEvidenceOf(SID)).toHaveLength(3);
    expect(t.db.getFileOffset(sub)?.byteOffset).toBeGreaterThan(0);

    // The same edit again plus a new file; the parent gains a line so the pass looks at its subagents.
    await appendToSessionFile(sub, lines(toolUseLine(w, "toolu_S9", "Edit", { file_path: join(repo, "src/a.ts"), old_string: "y", new_string: "z" }), toolUseLine(w, "toolu_S10", "Write", { file_path: join(repo, "src/d.ts"), content: "" })));
    await appendToSessionFile(parent, lines(userText(t.home, "2026-09-20T10:10:00.000Z", "thanks")));
    await pass(t);
    expect(t.db.placementEvidenceOf(SID)).toHaveLength(4);
    t.db.close();
  });

  it("reads a workflow agent's gh pr create output (subagents/workflows/<run>/agent-*.jsonl)", async () => {
    const t = await world();
    const clone = await cloneWithIsland(t, "acme-ai-next", "https://github.com/ACME-Inc/acme-ai.git", "aaaaaaaa-0000-4000-8000-000000000005");
    await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-20T10:00:00.000Z", "run the workflow")));
    const w = { cwd: "/Users/x/.acme-worktrees/tick-1880-linkmap", ts: "2026-09-20T10:20:00.000Z", agentId: "a68bc6f0adb1e952c" };
    await writeSubagent(t, "workflows/wf_e3106ee8-ee4/agent-a68bc6f0adb1e952c.jsonl", lines(toolUseLine(w, "toolu_P", "Bash", { command: PR_CMD }), toolResultLine(w, "toolu_P", PR_CREATE_OUT)));
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(clone));
    t.db.close();
  });

  it("never moves a session whose own cwd is not a catch-all, whatever it shipped", async () => {
    const t = await world();
    await cloneWithIsland(t, "acme-ai-next", "https://github.com/ACME-Inc/acme-ai.git", "aaaaaaaa-0000-4000-8000-000000000006");
    const own = join(t.dir, "ws", "own");
    await mkdir(own, { recursive: true });
    await writeSessionFile(t.dir, "-ws-own", SID, lines(userText(own, "2026-09-23T07:00:00.000Z", "x"), prLink("ACME-Inc/acme-ai", 524, "2026-09-23T07:39:45.171Z")));
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(own));
    expect(t.db.placementEvidenceOf(SID)).toEqual([]); // not even recorded
    t.db.close();
  });

  it("a PR to a repo with no local clone island moves nothing and creates no island", async () => {
    const t = await world();
    makeClone(join(t.dir, "code", "unindexed"), "https://github.com/ACME-Inc/acme-ai.git"); // a clone, but no island
    await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-23T07:00:00.000Z", "x"), prLink("ACME-Inc/acme-ai", 524, "2026-09-23T07:39:45.171Z")));
    const islandsBefore = t.db.listIslandSlugs().size;
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t));
    expect(t.db.listIslandSlugs().size).toBe(islandsBefore + 1); // only the home cwd's own island
    t.db.close();
  });
});

// ── the one-time backfill ──────────────────────────────────────────────────────────────────

describe("runPlacementEvidenceBackfill", () => {
  /** A db indexed by a build that predates placement evidence: no evidence rows, no subagent
   *  offsets, the session on the home island, the transcript's offset past its pr-link. */
  async function indexedBeforeFeature(): Promise<World & { clone: string; dbPath: string }> {
    const t = await world();
    const clone = await cloneWithIsland(t, "agent-world", "https://github.com/sboghossian/agent-world.git", "aaaaaaaa-0000-4000-8000-000000000007");
    await writeSessionFile(t.dir, "-home", SID, lines(userText(t.home, "2026-09-27T06:00:00.000Z", "We have been working together on Alef"), prLink("sboghossian/agent-world", 7, "2026-09-27T06:30:00.000Z")));
    const w = { cwd: "/Users/x/.alef-worktrees/resident-feedback", ts: "2026-09-27T06:20:00.000Z", agentId: "adff5bbe63cac8646" };
    await writeSubagent(t, "workflows/wf_1/agent-adff5bbe63cac8646.jsonl", lines(toolUseLine(w, "toolu_W", "Bash", { command: "git push -u origin feat/x && gh pr create --base main" }), toolResultLine(w, "toolu_W", "To https://github.com/sboghossian/agent-world.git\n * [new branch]      feat/x -> feat/x\nhttps://github.com/sboghossian/agent-world/pull/8")));
    await pass(t);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(clone));
    const dbPath = join(t.dir, "world.db");
    const raw = new Database(dbPath);
    raw.exec(`DELETE FROM placement_evidence; DELETE FROM file_offsets WHERE path LIKE '%/subagents/%';`);
    raw.close();
    t.db.setSessionIslandId(SID, homeIsland(t) ?? "");
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t));
    return { ...t, clone, dbPath };
  }

  it("reads evidence behind the stored offsets, places, backs up once, sets the flag last", async () => {
    const t = await indexedBeforeFeature();
    await runPlacementEvidenceBackfill(t.db, t.home);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(t.clone));
    expect(t.db.getSession(SID)?.cwd).toBe(t.home);
    expect(t.db.placementEvidenceOf(SID)).toHaveLength(3); // PR #7 (pr-link), PR #8 and the push (workflow agent)
    expect(t.db.getMeta("placement_evidence_backfilled")).toBe("1");
    const backups = (await readdir(t.dir)).filter((f) => /^world\.db\.pre-placement-evidence-.+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    expect(t.db.getMeta("placement_evidence_backup")).toBe(join(t.dir, backups[0] ?? ""));

    // Done means done.
    t.db.setSessionIslandId(SID, homeIsland(t) ?? "");
    await runPlacementEvidenceBackfill(t.db, t.home);
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t));
    t.db.close();
  });

  it("converges after a crash before any write, between the phases, or inside the final transaction", async () => {
    const t = await indexedBeforeFeature();
    const crash = (): never => {
      throw new Error("simulated crash");
    };
    await expect(runPlacementEvidenceBackfill(t.db, t.home, { beforeWrite: crash })).rejects.toThrow("simulated crash");
    expect(t.db.placementEvidenceOf(SID)).toEqual([]);
    await expect(runPlacementEvidenceBackfill(t.db, t.home, { beforeCommit: crash })).rejects.toThrow("simulated crash");
    expect(t.db.getMeta("placement_evidence_backfilled")).toBeNull();
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t)); // evidence recorded, nobody moved yet

    const realMove = t.db.setSessionIslandId.bind(t.db);
    t.db.setSessionIslandId = (id, island) => {
      realMove(id, island);
      crash();
    };
    await expect(runPlacementEvidenceBackfill(t.db, t.home)).rejects.toThrow("simulated crash");
    t.db.setSessionIslandId = realMove;
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t)); // rolled back
    expect(t.db.getMeta("placement_evidence_backfilled")).toBeNull();

    await runPlacementEvidenceBackfill(t.db, t.home);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(t.clone));
    expect(t.db.placementEvidenceOf(SID)).toHaveLength(3); // written three times, counted once
    expect(t.db.getMeta("placement_evidence_backfilled")).toBe("1");
    expect((await readdir(t.dir)).filter((f) => f.includes(".pre-placement-evidence-"))).toHaveLength(1);
    t.db.close();
  });

  it("a failed backup skips the migration this boot without blocking it", async () => {
    const t = await indexedBeforeFeature();
    const realBackup = t.db.backupTo.bind(t.db);
    t.db.backupTo = async () => {
      throw new Error("read-only dir");
    };
    await runHomePlacementBackfill(t.db, t.home); // the boot entry point: resolves, never throws
    expect(t.db.getMeta("placement_evidence_backfilled")).toBeNull();
    expect(t.db.placementEvidenceOf(SID)).toEqual([]);
    expect(t.db.getSession(SID)?.islandId).toBe(homeIsland(t));
    t.db.backupTo = realBackup;

    await runHomePlacementBackfill(t.db, t.home);
    expect(t.db.getSession(SID)?.islandId).toBe(t.db.getIslandForCwd(t.clone));
    t.db.close();
  });
});
