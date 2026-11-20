// Honest trips on REAL shapes: edges exactly as GET /api/world serves them, island roots exactly as
// db.listIslandSlugs() returns them on Alex's machine (worktree + subfolder aliases, the home
// island, "/" and /private/tmp catch-alls), and the real canonical-repo resolver on a real fs tree.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalRepoResolver } from "../canonical-repo.js";
import { deriveVisits, diffVisits, islandOfPath, newestTouch, newTrips, type EdgeLike, type VisitEdge } from "../trips-lib.js";

const HOME = "/Users/alexboghossian";
const SCRATCH = "/private/tmp/claude-501/-Users-alexboghossian/8d48c55e-2b52-4e82-953c-1206e890e607/scratchpad";

// Rows as cwd_islands holds them (listIslandSlugs): cwd → island id.
const ROOTS = new Map<string, string>([
  [HOME, "alexboghossian"],
  [`${HOME}/.claude/projects`, "projects"],
  ["/", "root"],
  ["/private/tmp", "tmp"],
  [`${SCRATCH}/chat-city`, "chat-city"],
  [`${HOME}/Documents/Code`, "code"],
  [`${HOME}/Documents/Code/agent-world`, "agent-world"],
  [`${HOME}/Documents/Code/agent-world/server`, "agent-world"], // subfolder alias
  [`${HOME}/.alef-worktrees/honest-trips`, "agent-world"], // worktree alias
  [`${HOME}/Documents/Code/alex_claude`, "alex-claude"],
  [`${HOME}/Documents/Code/acme-ai-next`, "acme-ai-next"],
  [`${HOME}/.eulex-bench/bench`, "bench"],
  [`${HOME}/.eulex-bench/bench/runs`, "runs"],
  [`${HOME}/.claude/hooks`, "harness"], // never a destination, whatever its cwd
]);

const A = "051664c3-f810-4a48-9ce8-d8c32c16658a"; // home-run session
const B = "6d1e2f8a-1b7c-4c55-9a3e-0c2b9e0d4f11"; // agent-world session
const C = "c0ffee00-0000-4000-8000-000000000003"; // bench session

const SESSIONS = new Map([
  [A, { islandId: "alexboghossian" }],
  [B, { islandId: "agent-world" }],
  [C, { islandId: "bench" }],
]);

const touched = (from: string, path: string, at: string, weight = 1): EdgeLike => ({ from, to: `file:${path}`, kind: "touched", weight, at });

describe("islandOfPath", () => {
  it("picks the longest island root that holds the path, aliases included", () => {
    expect(islandOfPath(`${HOME}/.eulex-bench/bench/runs/2026-09-28/score.json`, ROOTS, HOME)).toBe("runs");
    expect(islandOfPath(`${HOME}/.eulex-bench/bench/config.yaml`, ROOTS, HOME)).toBe("bench");
    expect(islandOfPath(`${HOME}/.alef-worktrees/honest-trips/server/director.ts`, ROOTS, HOME)).toBe("agent-world");
    expect(islandOfPath(`${HOME}/Documents/Code/agent-world/server/db.ts`, ROOTS, HOME)).toBe("agent-world");
    expect(islandOfPath(`${HOME}/Documents/Code/alex_claude/60-Meta/inbox-sweep/2026-09-22.md`, ROOTS, HOME)).toBe("alex-claude");
  });

  it("matches whole path segments only", () => {
    expect(islandOfPath(`${HOME}/Documents/Code/agent-world-old/x.ts`, ROOTS, HOME)).toBe("code");
    expect(islandOfPath(`${HOME}/Documents/Code/agent-world`, ROOTS, HOME)).toBe("agent-world");
  });

  it("falls back to the home island only for a path under the home dir that no other root holds", () => {
    expect(islandOfPath(`${HOME}/.config/yalla-brief.yaml`, ROOTS, HOME)).toBe("alexboghossian");
    expect(islandOfPath("/opt/homebrew/etc/x.conf", ROOTS, HOME)).toBeNull();
    expect(islandOfPath("/etc/hosts", ROOTS, HOME)).toBeNull(); // "/" is a catch-all, never a destination
    expect(islandOfPath(`${HOME}/.config/x`, new Map([["/", "root"]]), HOME)).toBeNull(); // no home island at all
  });

  it("never lands on a catch-all temp dir, but a real island inside one still counts", () => {
    expect(islandOfPath(`${SCRATCH}/notes.md`, ROOTS, HOME)).toBeNull();
    expect(islandOfPath("/private/tmp/claude-501/-Users-alexboghossian/tasks/b1.output", ROOTS, HOME)).toBeNull();
    expect(islandOfPath(`${SCRATCH}/chat-city/index.html`, ROOTS, HOME)).toBe("chat-city");
  });

  it("excludes the harness island", () => {
    expect(islandOfPath(`${HOME}/.claude/hooks/plan-gate.sh`, ROOTS, HOME)).toBe("alexboghossian");
  });
});

describe("islandOfPath with the real canonical-repo resolver", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("puts an edit in a linked worktree no session ran in on its repo's island, not on home", async () => {
    const home = await mkdtemp(join(tmpdir(), "trips-home-"));
    dirs.push(home);
    const repo = join(home, "Documents", "Code", "acme-ai-next");
    const wt = join(home, ".acme-worktrees", "tick-2200");
    await mkdir(join(repo, ".git", "worktrees", "tick-2200"), { recursive: true });
    await mkdir(join(wt, "apps", "main"), { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "tick-2200")}\n`);
    await mkdir(join(home, ".config"), { recursive: true });
    const roots = new Map([
      [home, "home"],
      [repo, "acme-ai-next"],
    ]);
    const canonical = createCanonicalRepoResolver(home);
    const rootOf = (d: string) => canonical.rootOf(d);

    expect(islandOfPath(join(wt, "apps", "main", "page.tsx"), roots, home, rootOf)).toBe("acme-ai-next");
    expect(islandOfPath(join(wt, "apps", "main", "page.tsx"), roots, home)).toBe("home"); // without it: home
    expect(islandOfPath(join(home, ".config", "yalla-brief.yaml"), roots, home, rootOf)).toBe("home"); // in no repo
  });
});

describe("deriveVisits", () => {
  it("one visit per (session, other island): touches summed, newest time kept", () => {
    const edges: EdgeLike[] = [
      touched(A, `${HOME}/Documents/Code/alex_claude/60-Meta/inbox-sweep/2026-09-22.md`, "2026-09-22T11:28:56.932Z"),
      touched(A, `${HOME}/Documents/Code/alex_claude/20-Projects/x.md`, "2026-09-23T08:00:00.000Z", 3),
      touched(B, `${HOME}/.alef-loop/journal.md`, "2026-09-28T02:00:00.000Z"),
      touched(C, `${HOME}/.eulex-bench/bench/runs/r1/out.json`, "2026-09-27T10:00:00.000Z", 2),
    ];
    expect(deriveVisits(edges, SESSIONS, ROOTS, HOME)).toEqual<VisitEdge[]>([
      { from: A, to: "alex-claude", kind: "visited", weight: 4, at: "2026-09-23T08:00:00.000Z" },
      { from: B, to: "alexboghossian", kind: "visited", weight: 1, at: "2026-09-28T02:00:00.000Z" },
      { from: C, to: "runs", kind: "visited", weight: 2, at: "2026-09-27T10:00:00.000Z" },
    ]);
  });

  it("ignores home-island work, scratch files, non-file targets, other edge kinds and unknown sessions", () => {
    const edges: EdgeLike[] = [
      touched(B, `${HOME}/.alef-worktrees/honest-trips/server/trips-lib.ts`, "2026-09-28T03:00:00.000Z"), // own repo via alias
      touched(A, `${HOME}/.config/yalla-brief.yaml`, "2026-09-28T03:00:00.000Z"), // home session in home
      touched(B, `${SCRATCH}/measure.ts`, "2026-09-28T03:00:00.000Z"), // scratchpad
      { from: B, to: `repo:${HOME}/Documents/Code/acme-ai-next`, kind: "touched", weight: 1, at: "2026-09-28T03:00:00.000Z" },
      { from: B, to: "skill:humanizer", kind: "uses", weight: 5, at: "2026-09-28T03:00:00.000Z" },
      { from: A, to: B, kind: "visited", weight: 1, at: "2026-09-28T03:00:00.000Z" }, // the old invented shape
      touched("unknown-session", `${HOME}/Documents/Code/acme-ai-next/README.md`, "2026-09-28T03:00:00.000Z"),
      // Its own harness files: a persisted tool result (seen live 2026-09-28) and its transcript.
      touched(A, `${HOME}/.claude/projects/-Users-alexboghossian/${A}/tool-results/b6tu8u17m.txt`, "2026-09-28T04:06:04.267Z", 3),
      touched(A, `${HOME}/.claude/projects/-Users-alexboghossian/${A}.jsonl`, "2026-09-28T04:06:05.000Z"),
    ];
    expect(deriveVisits(edges, SESSIONS, ROOTS, HOME)).toEqual([]);
  });

  it("still counts another session's files in the same folder, e.g. writing the shared memory", () => {
    const edges = [touched(A, `${HOME}/.claude/projects/-Users-alexboghossian/memory/feedback_x.md`, "2026-09-28T04:00:00.000Z")];
    expect(deriveVisits(edges, SESSIONS, ROOTS, HOME).map((v) => v.to)).toEqual(["projects"]);
  });
});

describe("diffVisits", () => {
  const v = (from: string, to: string, weight: number, at: string): VisitEdge => ({ from, to, kind: "visited", weight, at });

  it("puts new and changed visits, removes stale ones and every agent->agent edge, leaves equal rows alone", () => {
    const stored: EdgeLike[] = [
      v(A, "alex-claude", 4, "2026-09-23T08:00:00.000Z"), // unchanged
      v(C, "runs", 1, "2026-09-26T10:00:00.000Z"), // changed
      v(B, "acme-ai-next", 2, "2026-09-20T00:00:00.000Z"), // no longer proven
      { from: A, to: B, kind: "visited", weight: 1, at: "2026-09-28T03:00:00.000Z" }, // invented pair
      touched(A, `${HOME}/x.md`, "2026-09-28T03:00:00.000Z"), // not a visit: ignored
    ];
    const derived = [v(A, "alex-claude", 4, "2026-09-23T08:00:00.000Z"), v(B, "alexboghossian", 1, "2026-09-28T02:00:00.000Z"), v(C, "runs", 2, "2026-09-27T10:00:00.000Z")];
    const { put, remove } = diffVisits(stored, derived);
    expect(put.map((p) => `${p.from}>${p.to}`)).toEqual([`${B}>alexboghossian`, `${C}>runs`]);
    expect(remove).toEqual([
      { from: B, to: "acme-ai-next" },
      { from: A, to: B },
    ]);
    expect(diffVisits(derived, derived)).toEqual({ put: [], remove: [] });
  });
});

describe("newTrips", () => {
  const visits: VisitEdge[] = [
    { from: A, to: "alex-claude", kind: "visited", weight: 4, at: "2026-09-28T03:10:00.000Z" },
    { from: B, to: "alexboghossian", kind: "visited", weight: 1, at: "2026-09-28T03:05:00.000Z" },
    { from: B, to: "acme-ai-next", kind: "visited", weight: 1, at: "2026-09-28T03:09:00.000Z" },
    { from: C, to: "runs", kind: "visited", weight: 2, at: "2026-09-28T02:00:00.000Z" },
  ];

  it("flies only LIVE sessions, only for touches after the cursor, to their newest destination", () => {
    const since = "2026-09-28T03:00:00.000Z";
    expect(newTrips(visits, since, new Set([B, C]))).toEqual([{ sessionId: B, islandId: "acme-ai-next", at: "2026-09-28T03:09:00.000Z" }]);
    expect(newTrips(visits, since, new Set())).toEqual([]); // everyone dormant: nobody travels
    expect(newTrips(visits, "2026-09-28T03:10:00.000Z", new Set([A, B, C]))).toEqual([]); // nothing newer than the cursor
  });
});

describe("newestTouch", () => {
  it("is the newest file touch, ignoring repo/uses/visited edges", () => {
    const edges: EdgeLike[] = [
      touched(A, `${HOME}/a.md`, "2026-09-28T03:00:00.000Z"),
      { from: A, to: `repo:${HOME}/Documents/Code/agent-world`, kind: "touched", weight: 1, at: "2026-09-28T09:00:00.000Z" },
      { from: A, to: "alex-claude", kind: "visited", weight: 1, at: "2026-09-28T09:00:00.000Z" },
      touched(B, `${HOME}/b.md`, "2026-09-28T04:00:00.000Z"),
    ];
    expect(newestTouch(edges)).toBe("2026-09-28T04:00:00.000Z");
    expect(newestTouch([])).toBeNull();
  });
});
