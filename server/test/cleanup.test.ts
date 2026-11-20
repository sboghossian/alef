// "cleanup" (P2) pure rules: path guards, the live-guard, head facts, buckets, tmux close and
// request validation. No real fs, tmux or ~/.claude anywhere in this file.

import { describe, expect, it } from "vitest";
import type { CleanupTmuxExec } from "../features/cleanup-tmux.js";
import { closeDeadTmux } from "../features/cleanup-tmux.js";
import {
  bucketOf,
  classifyCandidates,
  idsInArgv,
  isAllowedProjDir,
  liveGuardReason,
  makeBatchId,
  parseManifest,
  parseRestoreBody,
  parseRetireBody,
  parseTmuxList,
  retirablePathError,
  scanHead,
  type LiveGuardInput,
  type SessionCandidateInput,
} from "../features/cleanup-lib.js";

const ID = "11111111-2222-3333-4444-555555555555";
const ROOT = "/Users/x/.claude/projects";
const NOW = Date.parse("2026-09-25T12:00:00Z");
const DAY = 86_400_000;

describe("retirablePathError", () => {
  it("accepts exactly <root>/<proj>/<uuid>.jsonl and <root>/<proj>/<uuid>", () => {
    expect(retirablePathError(ROOT, `${ROOT}/-Users-x-code/${ID}.jsonl`, ID)).toBeNull();
    expect(retirablePathError(ROOT, `${ROOT}/-Users-x-code/${ID}`, ID)).toBeNull();
  });
  it("refuses a non-uuid id", () => {
    expect(retirablePathError(ROOT, `${ROOT}/p/abc.jsonl`, "abc")).toMatch(/session id/);
  });
  it("refuses memory/ and memory.bak-*", () => {
    expect(retirablePathError(ROOT, `${ROOT}/memory/${ID}.jsonl`, ID)).toMatch(/memory/);
    expect(retirablePathError(ROOT, `${ROOT}/memory.bak-x/${ID}.jsonl`, ID)).toMatch(/memory/);
    expect(isAllowedProjDir("memory")).toBe(false);
    expect(isAllowedProjDir("Memory.bak-2026")).toBe(false);
  });
  it("refuses ../ escapes, siblings of the root and anything else under ~/.claude", () => {
    expect(retirablePathError(ROOT, `${ROOT}/../${ID}.jsonl`, ID)).toMatch(/outside|direct child/);
    expect(retirablePathError(ROOT, `/Users/x/.claude/${ID}.jsonl`, ID)).toMatch(/outside/);
    expect(retirablePathError(ROOT, `/Users/x/.claude/projects-evil/p/${ID}.jsonl`, ID)).toMatch(/outside/);
    expect(retirablePathError(ROOT, `/Users/x/.claude/settings.json`, ID)).toMatch(/outside/);
  });
  it("refuses wrong depth, the root itself and a mismatched name", () => {
    expect(retirablePathError(ROOT, ROOT, ID)).toMatch(/outside/);
    expect(retirablePathError(ROOT, `${ROOT}/p`, ID)).toMatch(/direct child/);
    expect(retirablePathError(ROOT, `${ROOT}/p/${ID}/subagents`, ID)).toMatch(/direct child/);
    expect(retirablePathError(ROOT, `${ROOT}/p/99999999-2222-3333-4444-555555555555.jsonl`, ID)).toMatch(/does not match/);
    expect(retirablePathError(ROOT, `${ROOT}/p/${ID}.jsonl.bak`, ID)).toMatch(/does not match/);
  });
  it("refuses relative paths", () => {
    expect(retirablePathError("projects", `projects/p/${ID}.jsonl`, ID)).toMatch(/absolute/);
  });
});

function guard(over: Partial<LiveGuardInput> = {}): LiveGuardInput {
  return {
    id: ID,
    nowMs: NOW,
    jsonlMtimeMs: NOW - 2 * DAY,
    status: "dormant",
    awaitingInput: false,
    tmuxBoundAlive: false,
    processVouched: false, cwdHasLiveClaude: false,
    inProcessArgv: false,
    pendingApproval: false,
    currentSessionIds: new Set(),
    ...over,
  };
}

describe("liveGuardReason", () => {
  it("lets a quiet dormant session go", () => {
    expect(liveGuardReason(guard())).toBeNull();
    expect(liveGuardReason(guard({ status: null }))).toBeNull();
  });
  it.each<[string, Partial<LiveGuardInput>, RegExp]>([
    ["live status", { status: "live" }, /live/],
    ["active < 30 min", { jsonlMtimeMs: NOW - 29 * 60_000 }, /30 minutes/],
    ["unknown mtime", { jsonlMtimeMs: null }, /could not be read/],
    ["tmux bound", { tmuxBoundAlive: true }, /tmux/],
    ["process vouched", { processVouched: true }, /vouches/], ["live claude in its folder", { cwdHasLiveClaude: true }, /running in its folder/],
    ["in ps argv", { inProcessArgv: true }, /resume/],
    ["awaiting input", { awaitingInput: true }, /waiting/],
    ["pending approval", { pendingApproval: true }, /approval/],
    ["current session", { currentSessionIds: new Set([ID]) }, /current Claude session/],
  ])("refuses: %s", (_name, over, re) => {
    expect(liveGuardReason(guard(over))).toMatch(re);
  });
  it("finds ids in process argv", () => {
    expect([...idsInArgv(["node x", `claude --resume ${ID.toUpperCase()}`], [ID, "other"])]).toEqual([ID]);
    expect(idsInArgv([], [ID]).size).toBe(0);
  });
});

describe("scanHead", () => {
  const user = JSON.stringify({ type: "user", entrypoint: "sdk-cli", message: { role: "user", content: "summarise this" } });
  const asst = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
  const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
  it("reads turns, tools and the sdk-cli marker", () => {
    const f = scanHead([JSON.stringify({ type: "queue-operation" }), user, asst].join("\n"), false);
    expect(f).toEqual({ userTextTurns: 1, assistantTurns: 1, toolUse: false, headless: true, firstType: "queue-operation", truncated: false });
    expect(scanHead([user, tool].join("\n"), false).toolUse).toBe(true);
  });
  it("handles empty, malformed and a cut last line", () => {
    expect(scanHead("", false)).toEqual({ userTextTurns: 0, assistantTurns: 0, toolUse: false, headless: false, firstType: null, truncated: false });
    expect(scanHead("{nope\n[1,2]\nnull", false).assistantTurns).toBe(0);
    expect(scanHead(`${user}\n${asst.slice(0, 20)}`, true).assistantTurns).toBe(0);
  });
  it("tool_result-only user lines are not user text turns", () => {
    const tr = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } });
    expect(scanHead(tr, false).userTextTurns).toBe(0);
  });
});

function sess(over: Partial<SessionCandidateInput> = {}): SessionCandidateInput {
  return {
    id: ID,
    projDir: "p",
    title: "t",
    cwd: "/w",
    islandId: "w",
    lastActive: new Date(NOW - DAY).toISOString(),
    messageCount: 20,
    bytes: 100,
    facts: null,
    protected: null,
    ...over,
  };
}

describe("buckets", () => {
  const headlessFacts = { userTextTurns: 1, assistantTurns: 1, toolUse: false, headless: true, firstType: "queue-operation", truncated: false };
  it("assigns one bucket per session, first match wins", () => {
    expect(bucketOf(sess({ messageCount: 0 }), NOW, 5, 90)?.bucket).toBe("empty");
    expect(bucketOf(sess({ messageCount: 2, facts: headlessFacts }), NOW, 5, 90)?.bucket).toBe("headless");
    expect(bucketOf(sess({ messageCount: 2, facts: { ...headlessFacts, toolUse: true } }), NOW, 5, 90)?.bucket).toBe("tiny");
    expect(bucketOf(sess({ messageCount: 4 }), NOW, 5, 90)?.bucket).toBe("tiny");
    expect(bucketOf(sess({ messageCount: 4 }), NOW, 3, 90)).toBeNull();
    expect(bucketOf(sess({ lastActive: new Date(NOW - 91 * DAY).toISOString() }), NOW, 5, 90)?.bucket).toBe("dormant");
    expect(bucketOf(sess({ lastActive: new Date(NOW - 20 * DAY).toISOString() }), NOW, 5, 14)?.reason).toMatch(/20 days/);
    expect(bucketOf(sess({ lastActive: "garbage" }), NOW, 5, 14)).toBeNull();
  });
  it("a cut head read (one huge prompt line) never proves a session empty", () => {
    const cut = { userTextTurns: 0, assistantTurns: 0, toolUse: false, headless: false, firstType: null, truncated: true };
    expect(bucketOf(sess({ messageCount: 2, facts: cut }), NOW, 5, 90)?.bucket).toBe("tiny");
    expect(bucketOf(sess({ messageCount: 0, facts: cut }), NOW, 5, 90)?.bucket).toBe("tiny");
    expect(bucketOf(sess({ messageCount: 0, facts: { ...cut, truncated: false } }), NOW, 5, 90)?.bucket).toBe("empty");
  });
  it("totals count selectable items only; protected ones apart and last", () => {
    const b = classifyCandidates({
      nowMs: NOW,
      tiny: 5,
      dormantDays: 90,
      sessions: [sess({ id: "a", messageCount: 1, bytes: 10 }), sess({ id: "b", messageCount: 1, bytes: 99, protected: "it is live right now" }), sess({ id: "c" })],
      tmux: [],
      tmuxBoundToLive: new Set(),
      claudeAncestors: new Set(),
      worktrees: [],
    });
    expect(b.tiny.map((i) => i.id)).toEqual(["a", "b"]);
    expect(b.tiny[1]?.protected).toMatch(/live/);
    expect(b.totals).toEqual({ bytes: 10, count: 1, protectedCount: 1 });
  });
  it("empty input → empty buckets", () => {
    const b = classifyCandidates({ nowMs: NOW, tiny: 5, dormantDays: 90, sessions: [], tmux: [], tmuxBoundToLive: new Set(), claudeAncestors: new Set(), worktrees: [] });
    expect(b.totals).toEqual({ bytes: 0, count: 0, protectedCount: 0 });
  });
  it("tmux: only aw-* whose claude exited; bound-to-live is protected", () => {
    const rows = parseTmuxList("aw-abcd1234 0 4001 zsh\naw-live0001 0 4002 claude\nmine 1 4003 zsh\naw-dead0001 1 4004 node\nnonsense\n");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ name: "aw-abcd1234", dead: false, panePid: 4001, command: "zsh" });
    const b = classifyCandidates({ nowMs: NOW, tiny: 5, dormantDays: 90, sessions: [], tmux: rows, tmuxBoundToLive: new Set(["aw-abcd1234"]), claudeAncestors: new Set(), worktrees: [] });
    expect(b.tmux.map((t) => t.name)).toEqual(["aw-abcd1234", "aw-dead0001"]);
    expect(b.tmux[0]?.protected).toMatch(/live/);
  });
  // `tmux list-sessions -F '#{session_name} #{pane_dead} #{pane_pid} #{pane_current_command}'` on
  // 2026-09-28: three live Alef launches, each `zsh -c 'claude …; rm -f …'`, so tmux says "zsh".
  const REAL_TMUX = "aw-5c67d47b 0 90077 zsh\naw-68597ce4 0 66726 zsh\naw-e10a9ec9 0 90545 zsh\n";
  it("tmux: a zsh -c wrapper with a live claude below it is not dead (real 2026-09-28 rows)", () => {
    const tmux = parseTmuxList(REAL_TMUX);
    const all = (claudeAncestors: ReadonlySet<number> | null) =>
      classifyCandidates({ nowMs: NOW, tiny: 5, dormantDays: 90, sessions: [], tmux, tmuxBoundToLive: new Set(), claudeAncestors, worktrees: [] }).tmux.map((t) => t.name);
    expect(all(new Set([66725, 66726, 90077, 90545]))).toEqual([]);
    // aw-e10a9ec9's claude has exited (its zsh somehow outlived it): that one alone is listed
    expect(all(new Set([66725, 66726, 90077]))).toEqual(["aw-e10a9ec9"]);
  });
  it("tmux: when the process list can't be read, no alive pane is called dead (fail closed)", () => {
    const tmux = parseTmuxList("aw-live0002 0 4242 zsh\naw-dead0002 1 4343 zsh\naw-nopid001 0 zsh\n");
    const b = classifyCandidates({ nowMs: NOW, tiny: 5, dormantDays: 90, sessions: [], tmux, tmuxBoundToLive: new Set(), claudeAncestors: null, worktrees: [] });
    expect(b.tmux.map((t) => t.name)).toEqual(["aw-dead0002"]);
    // a row without a pane pid can't be checked either
    expect(classifyCandidates({ nowMs: NOW, tiny: 5, dormantDays: 90, sessions: [], tmux, tmuxBoundToLive: new Set(), claudeAncestors: new Set(), worktrees: [] }).tmux.map((t) => t.name)).toEqual([
      "aw-live0002",
      "aw-dead0002",
    ]);
  });
  it("worktrees: repo gone, unregistered or idle 14 days", () => {
    const base = { path: "/h/.alef-worktrees/r/n", name: "n", repo: "/r", registered: true, repoExists: true, forkId: null, lastSessionMs: NOW - DAY, liveInside: false };
    const b = classifyCandidates({
      nowMs: NOW,
      tiny: 5,
      dormantDays: 90,
      sessions: [],
      tmux: [],
      tmuxBoundToLive: new Set(),
      claudeAncestors: new Set(),
      worktrees: [base, { ...base, repoExists: false }, { ...base, registered: false }, { ...base, lastSessionMs: null, liveInside: true }],
    });
    expect(b.worktree.map((w) => w.reason)).toEqual(["its repo is gone", "missing from its repo's git worktree list", "no session touched it for 14 days"]);
    expect(b.worktree[2]?.protected).toMatch(/live/);
  });
});

describe("requests", () => {
  it("retire: 1..200 uuids, deduped", () => {
    expect(parseRetireBody({ ids: [ID, ID] })).toEqual({ ok: true, ids: [ID] });
    expect(parseRetireBody({ ids: [] }).ok).toBe(false);
    expect(parseRetireBody({ ids: ["../x"] }).ok).toBe(false);
    expect(parseRetireBody(null).ok).toBe(false);
    const ids201 = Array.from({ length: 201 }, (_, i) => `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`);
    expect(parseRetireBody({ ids: ids201 })).toEqual({ ok: false, error: "at most 200 ids per retire" });
  });
  it("restore: batch id shape, optional ids", () => {
    const batchId = makeBatchId(new Date(2026, 8, 25, 9, 5, 7), "abc123");
    expect(batchId).toBe("20260925-090507-abc123");
    expect(parseRestoreBody({ batchId })).toEqual({ ok: true, batchId, ids: null });
    expect(parseRestoreBody({ batchId: "../../etc" }).ok).toBe(false);
    expect(parseRestoreBody({ batchId, ids: ["x"] }).ok).toBe(false);
  });
  it("manifest parsing rejects tampered shapes", () => {
    const good = { batchId: "20260925-090507-abc123", date: "2026-09-25", at: "x", items: [{ sessionId: ID, from: ["/a"], to: ["/b"], state: "retired" }] };
    expect(parseManifest(good)?.items[0]?.state).toBe("retired");
    expect(parseManifest({ ...good, items: [{ sessionId: "nope", from: [], to: [], state: "retired" }] })).toBeNull();
    expect(parseManifest({ ...good, items: [{ sessionId: ID, from: ["/a"], to: [], state: "retired" }] })).toBeNull();
    expect(parseManifest({ ...good, date: "../x" })).toBeNull();
  });
});

describe("closeDeadTmux", () => {
  function stubExec(list: string): { exec: CleanupTmuxExec; killed: string[] } {
    const killed: string[] = [];
    return {
      killed,
      exec: {
        findTmux: async () => "/bin/tmux",
        list: async () => list,
        captureAll: async () => "scrollback",
        kill: async (_t, n) => void killed.push(n),
      },
    };
  }
  const noClaude = new Set<number>();
  it("saves then kills a dead aw-* session", async () => {
    const { exec, killed } = stubExec("aw-abcd1234 1 4001 zsh\n");
    const saved: string[] = [];
    const out = await closeDeadTmux(exec, "aw-abcd1234", new Set(), noClaude, async (t) => (saved.push(t), "/trash/aw.txt"));
    expect(out).toEqual({ status: 200, savedTo: "/trash/aw.txt" });
    expect(saved).toEqual(["scrollback"]);
    expect(killed).toEqual(["aw-abcd1234"]);
  });
  it("refuses an alive claude pane, a bound-to-live one, a foreign name and a missing one", async () => {
    const { exec, killed } = stubExec("aw-abcd1234 0 4001 claude\naw-bound001 0 4002 zsh\n");
    const save = async (): Promise<string> => "/x";
    expect((await closeDeadTmux(exec, "aw-abcd1234", new Set(), noClaude, save)).status).toBe(409);
    expect((await closeDeadTmux(exec, "aw-bound001", new Set(["aw-bound001"]), noClaude, save)).status).toBe(409);
    expect((await closeDeadTmux(exec, "main", new Set(), noClaude, save)).status).toBe(400);
    expect((await closeDeadTmux(exec, "aw-gone0001", new Set(), noClaude, save)).status).toBe(404);
    expect(killed).toEqual([]);
  });
  it("refuses a live Alef launch whose pane tmux calls 'zsh' (real aw-e10a9ec9), and never kills it", async () => {
    const { exec, killed } = stubExec("aw-e10a9ec9 0 90545 zsh\n");
    let saves = 0;
    const out = await closeDeadTmux(exec, "aw-e10a9ec9", new Set(), new Set([66725, 90545]), async () => (saves++, "/x"));
    expect(out).toEqual({ status: 409, error: "claude is still running in it" });
    expect(saves).toBe(0);
    expect(killed).toEqual([]);
    // unknown process list: refuse too
    expect((await closeDeadTmux(exec, "aw-e10a9ec9", new Set(), null, async () => "/x")).status).toBe(409);
    expect(killed).toEqual([]);
  });
  it("a failed save means no kill", async () => {
    const { exec, killed } = stubExec("aw-abcd1234 1 4001 zsh\n");
    await expect(closeDeadTmux(exec, "aw-abcd1234", new Set(), noClaude, async () => Promise.reject(new Error("disk")))).rejects.toThrow("disk");
    expect(killed).toEqual([]);
  });
});
