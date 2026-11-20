// home-placement.ts, exercised through the real indexer (runIndexPass): a session run from a
// catch-all cwd (home dir) should land on the island of the repo its touched files dominantly
// belong to, recomputed from its accumulated touched-file edges as they grow across passes.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHomePlacementBackfill } from "../home-placement.js";
import { runIndexPass } from "../indexer.js";
import { appendToSessionFile, assistantLine, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

/** A directory with a `.git` marker: enough for the git-root walk (it never reads the file
 *  itself, only its ancestor directories), so the touched files below it need not exist. */
async function makeRepo(root: string): Promise<string> {
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

function editTool(path: string): { name: string; input: Record<string, unknown> } {
  return { name: "Edit", input: { file_path: path } };
}

describe("home-placement: catch-all sessions re-homed by touched files", () => {
  it("moves a home session onto the repo it dominantly touched, keeping cwd truthful", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const sessionId = "11111111-0000-0000-0000-000000000001";

    const body =
      [
        userLine({ cwd: home, timestamp: "2026-09-20T10:00:00.000Z", text: "fix stuff" }),
        assistantLine({
          cwd: home,
          timestamp: "2026-09-20T10:00:01.000Z",
          toolUses: [editTool(join(repoA, "src", "a.ts")), editTool(join(repoA, "src", "b.ts")), editTool(join(repoA, "src", "c.ts"))],
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-home", sessionId, body);

    await runIndexPass(db, { projectsDir: dir, homeDir: home });

    const session = db.getSession(sessionId);
    expect(session?.cwd).toBe(home); // truthful cwd, unchanged
    expect(session?.islandId).toBe("repo-a");
    expect(db.getIslandForCwd(repoA)).toBe("repo-a"); // the repo got an island, the indexer's own way
    expect(session?.islandId).not.toBe(db.getIslandForCwd(home)); // moved off the catch-all island

    db.close();
  });

  it("stays on the catch-all island on a tie between two repos", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const repoB = await makeRepo(join(dir, "code", "repo-b"));
    const sessionId = "11111111-0000-0000-0000-000000000002";

    const body =
      [
        userLine({ cwd: home, timestamp: "2026-09-20T10:00:00.000Z", text: "look at two repos" }),
        assistantLine({
          cwd: home,
          timestamp: "2026-09-20T10:00:01.000Z",
          toolUses: [editTool(join(repoA, "a.ts")), editTool(join(repoA, "b.ts")), editTool(join(repoB, "a.ts")), editTool(join(repoB, "b.ts"))],
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-home", sessionId, body);

    await runIndexPass(db, { projectsDir: dir, homeDir: home });

    const session = db.getSession(sessionId);
    expect(session?.islandId).toBe(db.getIslandForCwd(home)); // unmoved: a 2-2 tie has no single winner
    expect(db.getIslandForCwd(repoA)).toBeNull();
    expect(db.getIslandForCwd(repoB)).toBeNull();

    db.close();
  });

  it("stays on the catch-all island when the leading repo is under 50% (no tie)", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const repoB = await makeRepo(join(dir, "code", "repo-b"));
    const repoC = await makeRepo(join(dir, "code", "repo-c"));
    const sessionId = "11111111-0000-0000-0000-000000000003";

    const body =
      [
        userLine({ cwd: home, timestamp: "2026-09-20T10:00:00.000Z", text: "spread across repos" }),
        assistantLine({
          cwd: home,
          timestamp: "2026-09-20T10:00:01.000Z",
          toolUses: [
            editTool(join(repoA, "a.ts")),
            editTool(join(repoA, "b.ts")),
            editTool(join(repoA, "c.ts")), // repo-a: 3
            editTool(join(repoB, "a.ts")),
            editTool(join(repoB, "b.ts")), // repo-b: 2
            editTool(join(repoC, "a.ts")),
            editTool(join(repoC, "b.ts")), // repo-c: 2 (total 7; leader is 3/7 ≈ 43%)
          ],
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-home", sessionId, body);

    await runIndexPass(db, { projectsDir: dir, homeDir: home });

    const session = db.getSession(sessionId);
    expect(session?.islandId).toBe(db.getIslandForCwd(home));

    db.close();
  });

  it("stays on the catch-all island with only 1 touched file, even though it's the only repo", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const sessionId = "11111111-0000-0000-0000-000000000004";

    const body =
      [
        userLine({ cwd: home, timestamp: "2026-09-20T10:00:00.000Z", text: "peek at one file" }),
        assistantLine({ cwd: home, timestamp: "2026-09-20T10:00:01.000Z", toolUses: [editTool(join(repoA, "a.ts"))] }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-home", sessionId, body);

    await runIndexPass(db, { projectsDir: dir, homeDir: home });

    const session = db.getSession(sessionId);
    expect(session?.islandId).toBe(db.getIslandForCwd(home));
    expect(db.getIslandForCwd(repoA)).toBeNull(); // no island created for a repo that never won placement

    db.close();
  });

  it("never moves a session whose own cwd is not a catch-all, even if its touches dominate another repo", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const ownProject = join(dir, "ws", "own-project");
    await mkdir(ownProject, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const sessionId = "11111111-0000-0000-0000-000000000005";

    const body =
      [
        userLine({ cwd: ownProject, timestamp: "2026-09-20T10:00:00.000Z", text: "work from my own project dir" }),
        assistantLine({
          cwd: ownProject,
          timestamp: "2026-09-20T10:00:01.000Z",
          toolUses: [editTool(join(repoA, "a.ts")), editTool(join(repoA, "b.ts")), editTool(join(repoA, "c.ts"))],
        }),
      ].join("\n") + "\n";
    await writeSessionFile(dir, "-ws-own-project", sessionId, body);

    await runIndexPass(db, { projectsDir: dir, homeDir: home });

    const session = db.getSession(sessionId);
    expect(session?.cwd).toBe(ownProject);
    expect(session?.islandId).toBe(db.getIslandForCwd(ownProject)); // its own cwd's island, untouched
    expect(session?.islandId).not.toBe("repo-a");
    expect(db.getIslandForCwd(repoA)).toBeNull(); // placement never even considered this session

    db.close();
  });

  it("recomputes as more touches arrive (crossing the threshold only on a later pass), and is idempotent", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const sessionId = "11111111-0000-0000-0000-000000000006";

    const filePath = await writeSessionFile(
      dir,
      "-home",
      sessionId,
      [
        userLine({ cwd: home, timestamp: "2026-09-20T10:00:00.000Z", text: "one file for now" }),
        assistantLine({ cwd: home, timestamp: "2026-09-20T10:00:01.000Z", toolUses: [editTool(join(repoA, "a.ts"))] }),
      ].join("\n") + "\n",
    );

    await runIndexPass(db, { projectsDir: dir, homeDir: home });
    expect(db.getSession(sessionId)?.islandId).toBe(db.getIslandForCwd(home)); // <2 touches: stays

    // A second, unrelated pass with nothing new must be a true no-op (idempotent).
    await runIndexPass(db, { projectsDir: dir, homeDir: home });
    expect(db.getSession(sessionId)?.islandId).toBe(db.getIslandForCwd(home));

    // More of the SAME repo arrives: cumulative touches (2) now cross the threshold.
    await appendToSessionFile(
      filePath,
      assistantLine({ cwd: home, timestamp: "2026-09-20T10:01:00.000Z", toolUses: [editTool(join(repoA, "b.ts"))] }) + "\n",
    );
    await runIndexPass(db, { projectsDir: dir, homeDir: home });
    expect(db.getSession(sessionId)?.islandId).toBe("repo-a");
    const islandAfterFirstMove = db.getIslandForCwd(repoA);

    // Re-running with nothing new must not thrash the placement or mint a second island for repo-a.
    await runIndexPass(db, { projectsDir: dir, homeDir: home });
    expect(db.getSession(sessionId)?.islandId).toBe("repo-a");
    expect(db.getIslandForCwd(repoA)).toBe(islandAfterFirstMove);

    db.close();
  });
});

describe("runHomePlacementBackfill: one-time catch-up for pre-existing data", () => {
  it("places an already-indexed catch-all session from its already-persisted edges, exactly once", async () => {
    const dir = await makeTempProjectsDir();
    const db = await makeTempDb(dir);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const repoA = await makeRepo(join(dir, "code", "repo-a"));
    const sessionId = "11111111-0000-0000-0000-000000000008";

    // Simulate data indexed by a build that predates home-placement.ts: a catch-all session
    // with touched-file edges already persisted (via the normal indexer shape), never placed.
    db.setIslandForCwd(home, "home-slug");
    db.upsertSession({
      id: sessionId,
      cwd: home,
      islandId: "home-slug",
      title: "t",
      startedAt: "2026-09-20T10:00:00.000Z",
      lastActive: "2026-09-20T10:00:00.000Z",
      jsonlMtime: 0,
      messageCountDelta: 1,
      model: null,
      cntEditDelta: 0,
      cntResearchDelta: 0,
      cntBashDelta: 0,
      cntTextOnlyDelta: 0,
      cntAssistantTotalDelta: 0,
    });
    for (const f of ["a.ts", "b.ts"]) {
      const fileObjId = `file:${join(repoA, f)}`;
      db.upsertObjectShell({ id: fileObjId, kind: "file", name: f, islandId: "home-slug" });
      db.upsertEdge({ from: sessionId, to: fileObjId, kind: "touched", at: "2026-09-20T10:00:00.000Z" });
    }
    expect(db.getSession(sessionId)?.islandId).toBe("home-slug");

    await runHomePlacementBackfill(db, home);
    expect(db.getSession(sessionId)?.islandId).toBe("repo-a");

    // Move it back by hand: a second backfill call must be a no-op (it already ran once).
    db.setSessionIslandId(sessionId, "home-slug");
    await runHomePlacementBackfill(db, home);
    expect(db.getSession(sessionId)?.islandId).toBe("home-slug");

    db.close();
  });
});
