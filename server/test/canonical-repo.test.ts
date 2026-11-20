// canonical-repo.ts + canonical-backfill.ts: a session's district is the main working tree of the
// git repo holding its cwd. Temp dirs fake a main repo (`.git` dir) plus linked worktrees (`.git`
// FILE pointing at <main>/.git/worktrees/<name>), exactly the shape `git worktree add` leaves.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCanonicalRepoBackfill } from "../canonical-backfill.js";
import { canonicalRepoRoot, createCanonicalRepoResolver } from "../canonical-repo.js";
import type { WorldDb } from "../db.js";
import { assignIslandId } from "../heuristics.js";
import { runIndexPass } from "../indexer.js";
import { assistantLine, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

interface Tree {
  dir: string;
  home: string;
  main: string;
  wt: string;
}

/** <dir>/home, a main repo at <dir>/code/main-repo and a linked worktree <dir>/worktrees/wt-1. */
async function makeTree(): Promise<Tree> {
  const dir = await makeTempProjectsDir();
  const home = join(dir, "home");
  const main = join(dir, "code", "main-repo");
  const wt = join(dir, "worktrees", "wt-1");
  await mkdir(home, { recursive: true });
  await mkdir(join(main, ".git", "worktrees", "wt-1"), { recursive: true });
  await mkdir(join(main, "server"), { recursive: true });
  await mkdir(join(wt, "apps", "main"), { recursive: true });
  await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt-1")}\n`);
  return { dir, home, main, wt };
}

describe("canonicalRepoRoot", () => {
  it("maps a linked worktree, and a subfolder of one, to the main repo", async () => {
    const t = await makeTree();
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.main);
    expect(canonicalRepoRoot(join(t.wt, "apps", "main"), t.home)).toBe(t.main);
  });

  it("resolves a relative gitdir against the worktree", async () => {
    const t = await makeTree();
    await writeFile(join(t.wt, ".git"), "gitdir: ../../code/main-repo/.git/worktrees/wt-1\n");
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.main);
  });

  it("maps a subfolder to its repo root, and the root to itself", async () => {
    const t = await makeTree();
    expect(canonicalRepoRoot(join(t.main, "server"), t.home)).toBe(t.main);
    expect(canonicalRepoRoot(t.main, t.home)).toBe(t.main);
  });

  it("returns null for a directory in no repo", async () => {
    const t = await makeTree();
    const loose = join(t.dir, "loose", "notes");
    await mkdir(loose, { recursive: true });
    expect(canonicalRepoRoot(loose, t.home)).toBeNull();
  });

  it("falls back to the worktree's own top level on a malformed .git file", async () => {
    const t = await makeTree();
    await writeFile(join(t.wt, ".git"), "this is not a gitdir line\n");
    expect(canonicalRepoRoot(join(t.wt, "apps", "main"), t.home)).toBe(t.wt);
    await writeFile(join(t.wt, ".git"), "");
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.wt);
  });

  it("falls back when gitdir points outside a .git/worktrees dir, or at a missing path", async () => {
    const t = await makeTree();
    const elsewhere = join(t.dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(t.wt, ".git"), `gitdir: ${elsewhere}\n`); // a submodule-like pointer
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.wt);
    await writeFile(join(t.wt, ".git"), `gitdir: ${join(t.dir, "gone", ".git", "worktrees", "wt-1")}\n`);
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.wt);
    await writeFile(join(t.wt, ".git"), `gitdir: ${join(t.main, ".git", "worktrees", "not-registered")}\n`);
    expect(canonicalRepoRoot(t.wt, t.home)).toBe(t.wt);
  });

  it("maps a deleted worktree by the worktrees still beside it, only when they agree", async () => {
    const t = await makeTree();
    const gone = join(t.wt, "..", "gro-merged", "apps", "main");
    expect(canonicalRepoRoot(gone, t.home)).toBeNull(); // one worktree beside it: not enough
    const wt2 = join(t.dir, "worktrees", "wt-2");
    await mkdir(join(t.main, ".git", "worktrees", "wt-2"), { recursive: true });
    await mkdir(wt2, { recursive: true });
    await writeFile(join(wt2, ".git"), `gitdir: ${join(t.main, ".git", "worktrees", "wt-2")}\n`);
    expect(canonicalRepoRoot(gone, t.home)).toBe(t.main);
    await mkdir(join(t.dir, "worktrees", "standalone", ".git"), { recursive: true });
    expect(canonicalRepoRoot(gone, t.home)).toBeNull(); // another repo there: ambiguous
  });

  it("maps a deleted subfolder of a repo to the repo", async () => {
    const t = await makeTree();
    expect(canonicalRepoRoot(join(t.main, "tmp", "gone"), t.home)).toBe(t.main);
  });

  it("leaves home and / alone, even when home itself is a repo", async () => {
    const t = await makeTree();
    expect(canonicalRepoRoot(t.home, t.home)).toBeNull();
    expect(canonicalRepoRoot("/", t.home)).toBeNull();
    await mkdir(join(t.home, ".git"), { recursive: true });
    const inHome = join(t.home, "Downloads");
    await mkdir(inHome, { recursive: true });
    expect(canonicalRepoRoot(t.home, t.home)).toBeNull();
    expect(canonicalRepoRoot(inHome, t.home)).toBeNull(); // enclosing "repo" is home: refused
  });

  it("never walks a folder macOS privacy controls guard, where launchd's open() blocks forever", async () => {
    const t = await makeTree();
    // The same shape the outside tree resolves, rebuilt under home's Desktop: a main repo and two
    // linked worktrees beside a deleted one (2026-09-29: listing ~/Desktop froze a launchd boot).
    const desk = join(t.home, "Desktop");
    const main = join(desk, "main-repo");
    await mkdir(join(main, "server"), { recursive: true });
    for (const name of ["wt-a", "wt-b"]) {
      await mkdir(join(main, ".git", "worktrees", name), { recursive: true });
      await mkdir(join(desk, name), { recursive: true });
      await writeFile(join(desk, name, ".git"), `gitdir: ${join(main, ".git", "worktrees", name)}\n`);
    }
    expect(canonicalRepoRoot(join(main, "server"), t.home)).toBeNull();
    expect(canonicalRepoRoot(join(desk, "wt-a"), t.home)).toBeNull();
    expect(canonicalRepoRoot(join(desk, "gone-wt", "src"), t.home)).toBeNull();
    // Control: outside guarded folders the same lookups still resolve.
    expect(canonicalRepoRoot(join(t.main, "server"), t.home)).toBe(t.main);
  });

  it("caches per cwd until the TTL passes", async () => {
    const t = await makeTree();
    const loose = join(t.dir, "later");
    await mkdir(loose, { recursive: true });
    let clock = 0;
    const r = createCanonicalRepoResolver(t.home, { ttlMs: 1000, now: () => clock });
    expect(r.rootOf(loose)).toBeNull();
    await mkdir(join(loose, ".git"));
    expect(r.rootOf(loose)).toBeNull(); // cached
    clock = 2000;
    expect(r.rootOf(loose)).toBe(loose);
  });
});

function editTool(path: string): { name: string; input: Record<string, unknown> } {
  return { name: "Edit", input: { file_path: path } };
}

async function indexSession(t: Tree, db: WorldDb, id: string, cwd: string, files: string[] = []): Promise<void> {
  const body =
    [
      userLine({ cwd, timestamp: "2026-09-20T10:00:00.000Z", text: "work" }),
      assistantLine({ cwd, timestamp: "2026-09-20T10:00:01.000Z", toolUses: files.map(editTool) }),
    ].join("\n") + "\n";
  await writeSessionFile(t.dir, `-p-${id.slice(-4)}`, id, body);
  await runIndexPass(db, { projectsDir: t.dir, homeDir: t.home });
}

describe("indexer: districts by canonical repo", () => {
  it("puts worktree and subfolder sessions on the main repo's island, cwd kept truthful", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await indexSession(t, db, "22222222-0000-0000-0000-000000000001", join(t.wt, "apps", "main"));
    await indexSession(t, db, "22222222-0000-0000-0000-000000000002", join(t.main, "server"));
    await indexSession(t, db, "22222222-0000-0000-0000-000000000003", t.main);

    const ids = ["1", "2", "3"].map((n) => db.getSession(`22222222-0000-0000-0000-00000000000${n}`));
    expect(ids.map((s) => s?.islandId)).toEqual(["main-repo", "main-repo", "main-repo"]);
    expect(ids[0]?.cwd).toBe(join(t.wt, "apps", "main"));
    expect(db.getIslandCwd("main-repo")).toBe(t.main); // the island is named by its root, not an alias
    db.close();
  });

  it("gives a cwd outside any repo its own island, and home stays the catch-all", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    const loose = join(t.dir, "loose");
    await mkdir(loose, { recursive: true });
    await indexSession(t, db, "22222222-0000-0000-0000-000000000004", loose);
    await indexSession(t, db, "22222222-0000-0000-0000-000000000005", t.home);
    expect(db.getSession("22222222-0000-0000-0000-000000000004")?.islandId).toBe("loose");
    expect(db.getSession("22222222-0000-0000-0000-000000000005")?.islandId).toBe("home");
    db.close();
  });

  it("home placement lands on the main repo when the touched files are in its worktrees", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    const wt2 = join(t.dir, "worktrees", "wt-2");
    await mkdir(join(t.main, ".git", "worktrees", "wt-2"), { recursive: true });
    await mkdir(wt2, { recursive: true });
    await writeFile(join(wt2, ".git"), `gitdir: ${join(t.main, ".git", "worktrees", "wt-2")}\n`);
    // Two touches in each worktree: a tie between worktrees, but one repo once canonicalized.
    await indexSession(t, db, "22222222-0000-0000-0000-000000000006", t.home, [join(t.wt, "a.ts"), join(t.wt, "b.ts"), join(wt2, "c.ts"), join(wt2, "d.ts")]);
    expect(db.getSession("22222222-0000-0000-0000-000000000006")?.islandId).toBe("main-repo");
    expect(db.getIslandForCwd(t.wt)).toBeNull(); // no island minted for a worktree
    db.close();
  });
});

function seedSession(db: WorldDb, id: string, cwd: string, islandId: string): void {
  db.upsertSession({
    id,
    cwd,
    islandId,
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
}

/** Data as an older build left it: every cwd its own island, objects on those islands, plus a
 *  home session that touched two files in the worktree (home placement must follow the repo). */
function seedLegacy(t: Tree, db: WorldDb): { legacy: Array<[string, string, string]>; gone: string } {
  const legacy: Array<[string, string, string]> = [
    ["33333333-0000-0000-0000-000000000001", t.wt, "wt-1"],
    ["33333333-0000-0000-0000-000000000002", join(t.main, "server"), "server"],
  ];
  for (const [id, cwd, island] of legacy) {
    db.setIslandForCwd(cwd, island);
    seedSession(db, id, cwd, island);
    db.upsertObjectShell({ id: `file:${join(cwd, "x.ts")}`, kind: "file", name: "x.ts", islandId: island });
  }
  const gone = join(t.dir, "worktrees", "deleted-wt"); // a worktree removed after merge
  db.setIslandForCwd(gone, "deleted-wt");
  db.upsertObjectShell({ id: `file:${join(gone, "y.ts")}`, kind: "file", name: "y.ts", islandId: "deleted-wt" });
  db.setIslandForCwd(t.home, "home");
  seedSession(db, "33333333-0000-0000-0000-000000000003", t.home, "home");
  for (const f of ["a.ts", "b.ts"]) {
    db.upsertEdge({ from: "33333333-0000-0000-0000-000000000003", to: `file:${join(t.wt, f)}`, kind: "touched", at: "2026-09-20T10:00:00.000Z" });
  }
  return { legacy, gone };
}

function dump(db: WorldDb): string {
  return JSON.stringify([
    db.listSessions().map((s) => [s.id, s.islandId]).sort(),
    [...db.listIslandSlugs()].sort(),
    db.listIslandIds().sort(),
    db.listCwdAliases(),
    db.getMeta("canonical_repo_backfilled"),
  ]);
}

describe("runCanonicalRepoBackfill", () => {
  it("moves pre-existing worktree/subfolder islands onto the repo, vacates them, and is idempotent", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    const { legacy } = seedLegacy(t, db);

    await runCanonicalRepoBackfill(db, t.home);

    for (const [id, cwd] of legacy) {
      expect(db.getSession(id)?.islandId).toBe("main-repo");
      expect(db.getSession(id)?.cwd).toBe(cwd);
      expect(db.getIslandForCwd(cwd)).toBe("main-repo");
    }
    expect(db.getSession("33333333-0000-0000-0000-000000000003")?.islandId).toBe("main-repo"); // home placement, canonicalized
    expect(db.getIslandCwd("main-repo")).toBe(t.main);
    const islandIds = new Set(db.listIslandIds());
    expect(islandIds.has("wt-1")).toBe(false); // vacated: its objects moved too
    expect(islandIds.has("server")).toBe(false);
    expect(islandIds.has("deleted-wt")).toBe(true); // unresolvable: left exactly as it was
    // One row says where each cwd came from.
    expect(db.listCwdAliases().map((a) => [a.cwd, a.islandId, a.prevIslandId])).toEqual(
      [
        [join(t.main, "server"), "main-repo", "server"],
        [t.wt, "main-repo", "wt-1"],
      ].sort(),
    );

    const after = dump(db);
    await runCanonicalRepoBackfill(db, t.home); // flagged: no-op
    expect(dump(db)).toBe(after);
    db.setMeta("canonical_repo_backfilled", "0");
    await runCanonicalRepoBackfill(db, t.home); // even unflagged, recomputing changes nothing
    db.setMeta("canonical_repo_backfilled", "1");
    expect(dump(db)).toBe(after);
    db.close();
  });

  it("converges after a crash between phases, or inside the final transaction", async () => {
    const reference = await makeTree();
    const refDb = await makeTempDb(reference.dir);
    seedLegacy(reference, refDb);
    await runCanonicalRepoBackfill(refDb, reference.home);
    // Dumps hold absolute temp paths: compare with each tree's own prefix stripped.
    const norm = (t: Tree, db: WorldDb): string => dump(db).split(t.dir).join("<T>");
    const expected = norm(reference, refDb);
    refDb.close();

    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    seedLegacy(t, db);
    const crash = (): never => {
      throw new Error("simulated crash");
    };
    await expect(runCanonicalRepoBackfill(db, t.home, { beforeCommit: crash })).rejects.toThrow("simulated crash");
    expect(db.getMeta("canonical_repo_backfilled")).toBeNull();
    // A crash half-way through the transaction's writes rolls every one of them back.
    let calls = 0;
    const realMove = db.moveIslandObjects.bind(db);
    db.moveIslandObjects = (from, to) => {
      realMove(from, to);
      if (++calls === 1) crash();
    };
    await expect(runCanonicalRepoBackfill(db, t.home)).rejects.toThrow("simulated crash");
    expect(db.getMeta("canonical_repo_backfilled")).toBeNull();
    expect(db.listCwdAliases()).toEqual([]);
    db.moveIslandObjects = realMove;

    await runCanonicalRepoBackfill(db, t.home);
    expect(norm(t, db)).toBe(expected);
    db.close();
  });

  it("backs the db up once, WAL-safe, before the first attempt", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    seedLegacy(t, db);
    await expect(runCanonicalRepoBackfill(db, t.home, { beforeCommit: () => { throw new Error("crash"); } })).rejects.toThrow();
    await runCanonicalRepoBackfill(db, t.home);
    db.setMeta("canonical_repo_backfilled", "0");
    await runCanonicalRepoBackfill(db, t.home);
    const backups = (await readdir(t.dir)).filter((f) => /^world\.db\.pre-canonical-.+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    expect(db.getMeta("canonical_repo_backup")).toBe(join(t.dir, backups[0] ?? ""));
    db.close();
  });

  it("a failed backup skips the backfill for this boot instead of throwing, then succeeds later", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    const { legacy } = seedLegacy(t, db);
    const realBackup = db.backupTo.bind(db);
    db.backupTo = async () => {
      throw new Error("unable to open database file");
    };
    const before = dump(db);
    await expect(runCanonicalRepoBackfill(db, t.home)).resolves.toBeUndefined();
    expect(dump(db)).toBe(before); // no backup, no migration
    expect(db.getMeta("canonical_repo_backfilled")).toBeNull();
    db.backupTo = realBackup;
    await runCanonicalRepoBackfill(db, t.home);
    for (const [id] of legacy) expect(db.getSession(id)?.islandId).toBe("main-repo");
    db.close();
  });
});

describe("assignIslandId never reuses an id something still sits on", () => {
  it("skips a freed id that objects still carry", () => {
    const existing = new Map<string, string>(); // "wt-1" no longer owned by any cwd
    expect(assignIslandId("/x/other/wt-1", existing)).toBe("wt-1");
    expect(assignIslandId("/x/other/wt-1", existing, new Set(["wt-1"]))).toBe("other-wt-1");
    expect(assignIslandId("/x/other/wt-1", existing, new Set(["wt-1", "other-wt-1"]))).toBe("other-wt-1-2");
  });
});
