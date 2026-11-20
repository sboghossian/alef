// prune-districts.ts + the 2026-10-14 rules behind it: gone loop worktrees fold into agent-world
// (canonical-repo.ts), a later index pass after a `cd` mints no island (indexer.ts), and the
// one-time prune empties phantom islands without deleting anything, crash-safely.

import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRepoRoot, createCanonicalRepoResolver, dbLoopProof } from "../canonical-repo.js";
import type { WorldDb } from "../db.js";
import { runIndexPass } from "../indexer.js";
import { classifyIslands, PRUNE_BACKUP_KEY, PRUNE_DONE_KEY, runPruneDistricts } from "../prune-districts.js";
import { assistantLine, makeTempDb, makeTempProjectsDir, userLine, writeSessionFile } from "./helpers.js";

interface Tree {
  dir: string;
  home: string;
  aw: string; // agent-world's main repo
  loops: string; // <home>/.alef-worktrees
}

async function makeTree(): Promise<Tree> {
  const dir = await makeTempProjectsDir();
  const home = join(dir, "home");
  const aw = join(home, "code", "agent-world");
  const loops = join(home, ".alef-worktrees");
  await mkdir(join(aw, ".git", "worktrees", "live-loop"), { recursive: true });
  await mkdir(join(aw, "server"), { recursive: true });
  await mkdir(join(loops, "live-loop", "client"), { recursive: true });
  await writeFile(join(loops, "live-loop", ".git"), `gitdir: ${join(aw, ".git", "worktrees", "live-loop")}\n`);
  return { dir, home, aw, loops };
}

describe("canonicalRepoRoot: loop worktrees fold into agent-world only with proof", () => {
  it("a removed slug of ANOTHER repo (commandline-links) never becomes agent-world", async () => {
    const t = await makeTree();
    const loop = { root: t.aw };
    const links = join(t.loops, "commandline-links", "src"); // removed commandline worktree
    expect(canonicalRepoRoot(links, t.home)).toBeNull();
    expect(canonicalRepoRoot(links, t.home, loop)).toBeNull(); // no proof: null, as before this rule
    expect(canonicalRepoRoot(links, t.home, { root: t.aw, proof: () => false })).toBeNull();
    expect(canonicalRepoRoot(join(t.loops, "live-loop", "client"), t.home, loop)).toBe(t.aw); // live: normal rules
  });

  it("a removed agent-world slug folds with a db row, or a registration still naming its path", async () => {
    const t = await makeTree();
    const gone = join(t.loops, "archive-sessions", "client");
    const slug = join(t.loops, "archive-sessions");
    expect(canonicalRepoRoot(gone, t.home, { root: t.aw })).toBeNull();
    expect(canonicalRepoRoot(gone, t.home, { root: t.aw, proof: (d) => d === slug })).toBe(t.aw);
    const db = await makeTempDb(t.dir);
    db.setIslandForCwd(t.aw, "agent-world");
    const proof = dbLoopProof(db, t.aw);
    expect(canonicalRepoRoot(gone, t.home, { root: t.aw, proof })).toBeNull(); // no row yet
    db.setIslandForCwd(join(slug, "server"), "agent-world");
    expect(canonicalRepoRoot(gone, t.home, { root: t.aw, proof })).toBe(t.aw);
    db.setIslandForCwd(join(t.loops, "commandline-links"), "commandline");
    expect(canonicalRepoRoot(join(t.loops, "commandline-links", "src"), t.home, { root: t.aw, proof })).toBeNull();
    db.close();
    // Registration left behind (removed folder, worktree not pruned yet): its gitdir names the path.
    await mkdir(join(t.aw, ".git", "worktrees", "reg"), { recursive: true });
    await writeFile(join(t.aw, ".git", "worktrees", "reg", "gitdir"), `${join(t.loops, "reg", ".git")}\n`);
    expect(canonicalRepoRoot(join(t.loops, "reg", "data"), t.home, { root: t.aw })).toBe(t.aw);
  });

  it("an emptied slug needs proof; an orphaned .git file proves itself only into agent-world", async () => {
    const t = await makeTree();
    const emptied = join(t.loops, "emptied", "server");
    await mkdir(emptied, { recursive: true });
    expect(canonicalRepoRoot(emptied, t.home, { root: t.aw })).toBeNull();
    expect(canonicalRepoRoot(emptied, t.home, { root: t.aw, proof: () => true })).toBe(t.aw);
    const orphan = join(t.loops, "orphan");
    await mkdir(join(orphan, "data"), { recursive: true });
    await writeFile(join(orphan, ".git"), `gitdir: ${join(t.aw, ".git", "worktrees", "pruned-long-ago")}\n`);
    expect(canonicalRepoRoot(join(orphan, "data"), t.home)).toBe(orphan); // rule off: its own top
    expect(canonicalRepoRoot(join(orphan, "data"), t.home, { root: t.aw })).toBe(t.aw);
    const stray = join(t.loops, "stray");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, ".git"), `gitdir: ${join(t.home, "code", "other", ".git", "worktrees", "stray")}\n`);
    expect(canonicalRepoRoot(stray, t.home, { root: t.aw })).toBe(stray); // another repo's: unchanged
    // A fork container (~/.alef-worktrees/<repo>/<name>) belongs to another repo: never agent-world.
    const other = join(t.home, "code", "other");
    await mkdir(join(other, ".git", "worktrees", "f1"), { recursive: true });
    await mkdir(join(t.loops, "other", "f1"), { recursive: true });
    await writeFile(join(t.loops, "other", "f1", ".git"), `gitdir: ${join(other, ".git", "worktrees", "f1")}\n`);
    expect(canonicalRepoRoot(join(t.loops, "other", "gone-fork", "src"), t.home, { root: t.aw, proof: () => true })).toBeNull();
    expect(canonicalRepoRoot(join(t.loops, "other", "f1"), t.home, { root: t.aw })).toBe(other);
  });
});

async function writeLines(t: Tree, db: WorldDb, id: string, lines: string[], append = false): Promise<void> {
  const body = `${lines.join("\n")}\n`;
  if (append) await appendFile(join(t.dir, "-p", `${id}.jsonl`), body);
  else await writeSessionFile(t.dir, "-p", id, body);
  await runIndexPass(db, { projectsDir: t.dir, homeDir: t.home });
}

describe("indexer: a later pass after a `cd`", () => {
  it("mints no island for the new cwd and keeps the pass's files on the session's island", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    const id = "44444444-0000-0000-0000-000000000001";
    const deck = join(t.home, "decks", "gov5");
    await mkdir(deck, { recursive: true });
    const edit = (p: string) => ({ name: "Edit", input: { file_path: p } });
    await writeLines(t, db, id, [userLine({ cwd: t.home, timestamp: "2026-10-14T08:00:00.000Z", text: "go" }), assistantLine({ cwd: t.home, timestamp: "2026-10-14T08:00:01.000Z" })]);
    const home = db.getSession(id)?.islandId;
    await writeLines(t, db, id, [assistantLine({ cwd: deck, timestamp: "2026-10-14T08:01:00.000Z", toolUses: [edit(join(deck, "index.html"))] })], true);
    expect(db.getIslandForCwd(deck)).toBeNull();
    expect(db.getSession(id)?.islandId).toBe(home);
    expect(db.listIslandIds().sort()).toEqual([home]);
    db.close();
  });
});

const S = (n: number): string => `55555555-0000-0000-0000-00000000000${n}`;

function seed(db: WorldDb, id: string, cwd: string, islandId: string, at = "2026-10-01T10:00:00.000Z"): void {
  db.upsertSession({ id, cwd, islandId, title: "t", startedAt: at, lastActive: at, jsonlMtime: 0, messageCountDelta: 1, model: null, cntEditDelta: 0, cntResearchDelta: 0, cntBashDelta: 0, cntTextOnlyDelta: 0, cntAssistantTotalDelta: 0 });
}

function obj(db: WorldDb, path: string, islandId: string, touchers: Array<[string, string]> = []): void {
  db.upsertObjectShell({ id: `file:${path}`, kind: "file", name: "f", islandId });
  for (const [from, at] of touchers) db.upsertEdge({ from, to: `file:${path}`, kind: "touched", at });
}

/** The live db's shape before the fix: home sessions' `cd` targets as islands holding their files. */
async function seedPhantoms(t: Tree, db: WorldDb): Promise<void> {
  const deck = join(t.home, "decks", "gov5");
  const aleph = join(t.home, "code", "aleph");
  await mkdir(deck, { recursive: true });
  await mkdir(join(aleph, ".git"), { recursive: true });
  db.setIslandForCwd(t.home, "home");
  db.setIslandForCwd(t.aw, "agent-world");
  seed(db, S(1), t.home, "home");
  seed(db, S(2), t.aw, "agent-world");
  seed(db, S(3), join(t.loops, "archive-sessions", "client"), "client"); // gone loop worktree
  db.setIslandForCwd(join(t.loops, "archive-sessions", "client"), "client");
  db.setIslandForCwd(join(t.loops, "archive-sessions"), "agent-world"); // proof: it was agent-world's
  seed(db, S(4), join(t.loops, "commandline-links", "src"), "links"); // gone, no proof: stays
  db.setIslandForCwd(join(t.loops, "commandline-links", "src"), "links");
  db.setIslandForCwd(deck, "gov5"); // loose: a cd target
  obj(db, join(deck, "a.html"), "gov5", [[S(1), "2026-10-02T00:00:00.000Z"], [S(2), "2026-10-03T00:00:00.000Z"]]);
  obj(db, join(deck, "b.html"), "gov5", [[S(1), "2026-10-02T00:00:00.000Z"]]);
  obj(db, join(deck, "orphan.html"), "gov5"); // no session reaches it: stays
  db.setIslandForCwd(join(t.aw, "server"), "server"); // folds into agent-world
  obj(db, join(t.aw, "server", "x.ts"), "server", [[S(1), "2026-10-02T00:00:00.000Z"]]);
  db.setIslandForCwd(aleph, "aleph"); // a repo with only fossils: kept
  obj(db, join(aleph, "README.md"), "aleph", [[S(1), "2026-10-02T00:00:00.000Z"]]);
  db.setIslandForCwd(join(t.home, "Downloads"), "downloads"); // privacy-guarded: never read
  obj(db, join(t.home, "Downloads", "z.pdf"), "downloads", [[S(1), "2026-10-02T00:00:00.000Z"]]);
}

function dump(db: WorldDb, t: Tree): string {
  const objects = db.listObjectsWithUsage().map((o) => [o.id, o.islandId]).sort();
  return JSON.stringify([db.listSessions().map((s) => [s.id, s.islandId]).sort(), [...db.listIslandSlugs()].sort(), objects, db.listCwdAliases(), db.getMeta(PRUNE_DONE_KEY)]).split(t.dir).join("<T>");
}

const resolverFor = (t: Tree, db: WorldDb) => createCanonicalRepoResolver(t.home, { loop: { root: t.aw, proof: dbLoopProof(db, t.aw) } });

describe("runPruneDistricts", () => {
  it("classifies every island by why it exists", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await seedPhantoms(t, db);
    const cls = Object.fromEntries(classifyIslands(db, t.home, resolverFor(t, db)).map((v) => [v.islandId, v.cls]));
    expect(cls).toEqual({ "agent-world": "live", home: "live", client: "live", links: "live", gov5: "loose", server: "folds-into-repo", aleph: "repo", downloads: "loose" });
    db.close();
  });

  it("remaps sessions, empties phantoms, keeps repos and history, and is idempotent", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await seedPhantoms(t, db);
    const slugsBefore = db.listIslandSlugs().size;
    const out = await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) });
    expect(out).toMatchObject({ ran: true, sessionsRemapped: 1, islandsBefore: 8, islandsAfter: 5 });
    expect(db.getSession(S(3))?.islandId).toBe("agent-world");
    expect(db.getSession(S(4))?.islandId).toBe("links"); // no proof it was agent-world's: today's island
    expect(db.listSessions()).toHaveLength(4); // nothing deleted
    expect(db.listIslandSlugs().size).toBe(slugsBefore); // every cwd row kept
    const islandOf = (p: string): string | undefined => db.listObjectsWithUsage().find((o) => o.id === `file:${p}`)?.islandId;
    const deck = join(t.home, "decks", "gov5");
    expect(islandOf(join(deck, "a.html"))).toBe("agent-world"); // its latest toucher
    expect(islandOf(join(deck, "b.html"))).toBe("home");
    expect(islandOf(join(deck, "orphan.html"))).toBe("gov5");
    expect(islandOf(join(t.aw, "server", "x.ts"))).toBe("agent-world");
    expect(islandOf(join(t.home, "code", "aleph", "README.md"))).toBe("aleph");
    expect(db.listIslandIds().sort()).toEqual(["agent-world", "aleph", "gov5", "home", "links"]);
    const after = dump(db, t);
    expect((await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) })).ran).toBe(false);
    db.setMeta(PRUNE_DONE_KEY, "0");
    await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) }); // unflagged rerun: nothing left
    expect(dump(db, t)).toBe(after);
    db.close();
  });

  it("converges after a crash inside the transaction, with exactly one backup", async () => {
    const ref = await makeTree();
    const refDb = await makeTempDb(ref.dir);
    await seedPhantoms(ref, refDb);
    await runPruneDistricts(refDb, ref.home, { resolver: resolverFor(ref, refDb) });
    const expected = dump(refDb, ref);
    refDb.close();

    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await seedPhantoms(t, db);
    const before = dump(db, t);
    const crash = (): never => {
      throw new Error("simulated crash");
    };
    await expect(runPruneDistricts(db, t.home, { resolver: resolverFor(t, db), beforeCommit: crash })).rejects.toThrow("simulated crash");
    expect(dump(db, t)).toBe(before); // all or nothing
    await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) });
    expect(dump(db, t)).toBe(expected);
    const backups = (await readdir(t.dir)).filter((f) => /^world\.db\.pre-prune-districts-.+\.bak$/.test(f));
    expect(backups).toHaveLength(1);
    expect(db.getMeta(PRUNE_BACKUP_KEY)).toBe(join(t.dir, backups[0] ?? ""));
    db.close();
  });

  it("a db too busy to record its backup reuses that backup next boot, never a second copy", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await seedPhantoms(t, db);
    const realSet = db.setMeta.bind(db);
    db.setMeta = (key: string, value: string) => {
      if (key === PRUNE_BACKUP_KEY) throw new Error("SQLITE_BUSY: database is locked");
      realSet(key, value);
    };
    for (let boot = 0; boot < 3; boot++) await expect(runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) })).rejects.toThrow("SQLITE_BUSY");
    db.setMeta = realSet;
    await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) });
    const files = await readdir(t.dir);
    const backups = files.filter((f) => f.startsWith("world.db.pre-prune-districts-"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/\.bak$/);
    expect(db.getMeta(PRUNE_BACKUP_KEY)).toBe(join(t.dir, backups[0] ?? ""));
    expect(db.getMeta(PRUNE_DONE_KEY)).toBe("1");
    db.close();
  });

  it("a failed backup skips the prune this boot and writes nothing", async () => {
    const t = await makeTree();
    const db = await makeTempDb(t.dir);
    await seedPhantoms(t, db);
    const before = dump(db, t);
    db.backupTo = async () => {
      throw new Error("disk full");
    };
    expect((await runPruneDistricts(db, t.home, { resolver: resolverFor(t, db) })).ran).toBe(false);
    expect(dump(db, t)).toBe(before);
    db.close();
  });
});
