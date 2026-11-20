import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillsOpenEditorResult, SkillsSessionResult, SkillsSnapshotResult } from "../../shared/features/skills.js";
import { createSkillsFeature } from "../features/skills.js";
import type { RunningServer } from "../index.js";
import { assistantLine, bootTestServer, writeSessionFile } from "./helpers.js";

const AGENT_ID = "11111111-2222-3333-4444-555555555555";

describe("skills feature — wired into a real server", () => {
  let server: RunningServer | null = null;
  let opened: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = null;
    opened = [];
  });

  async function setup(): Promise<{ base: string; dir: string; home: string }> {
    // Resolved immediately: macOS's tmpdir() lives under /var, itself a symlink to
    // /private/var, so an unresolved mkdtemp() result would never equal the
    // realpath()-resolved paths the skills-inventory scanners always return.
    const home = await realpath(await mkdtemp(join(tmpdir(), "aw-skills-home-")));
    const skillsDir = join(home, ".claude", "skills");
    await mkdir(join(skillsDir, "grill-me"), { recursive: true });
    await writeFile(join(skillsDir, "grill-me", "SKILL.md"), "---\nname: grill-me\ndescription: interviews the user relentlessly\n---\n");
    await mkdir(join(skillsDir, "_proposed", "candidate-a"), { recursive: true });
    await writeFile(
      join(skillsDir, "_proposed", "candidate-a", "SKILL.md"),
      "---\nname: candidate-a\ndescription: a staged candidate\nfrequency: 5\nconfidence: 0.7\n---\n",
    );

    const feature = createSkillsFeature({
      home,
      skillsDir,
      skillsRepoDir: join(home, ".claude", "skills-repo"),
      pluginsCacheDir: join(home, ".claude", "plugins", "cache"),
      inventoryTtlMs: 0,
    });
    const boot = await bootTestServer({ openEditorExecutor: async (p) => void opened.push(p), configOverrides: { features: [feature] } });
    server = boot.server;
    return { base: boot.base, dir: boot.dir, home };
  }

  it("detects a Skill tool_use via onIndexPass and surfaces it in both the session and snapshot routes, joined to its installed metadata; onTick's backfill finishes alongside it", async () => {
    const { base, dir } = await setup();
    const timestamp = new Date().toISOString();
    const line = assistantLine({ cwd: "/ws/p", timestamp, toolUses: [{ name: "Skill", input: { skill: "grill-me" } }] });
    await writeSessionFile(join(dir, "projects"), "-ws-p", AGENT_ID, `${line}\n`);

    let snapshot: SkillsSnapshotResult | undefined;
    await vi.waitFor(
      async () => {
        const res = (await (await fetch(`${base}/api/skills/session/${AGENT_ID}`)).json()) as SkillsSessionResult;
        expect(res.events).toEqual([{ sessionId: AGENT_ID, skillName: "grill-me", kind: "invoke", at: timestamp }]);
        snapshot = (await (await fetch(`${base}/api/skills/snapshot`)).json()) as SkillsSnapshotResult;
        // this feature's own onTick (real 10s timer, same as the indexer's) has run its
        // historical backfill pass at least once by now — with no pre-existing history to
        // read here, that pass completes almost instantly.
        expect(snapshot.backfillProgress.done).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );

    expect(snapshot?.ok).toBe(true);
    expect(snapshot?.installedCount).toBe(1);
    // The one session file this test wrote is also the one file backfill's independent,
    // always-from-0 file scan finds — its cutoffMs is only set on first use (here, ~10s in,
    // whichever of onTick/onIndexPass fires first), well after this file's own timestamp,
    // so backfill legitimately treats that same line as "historical" and tries to insert it
    // too. It lands as a no-op (skills-store.ts's UNIQUE constraint) — proven right below by
    // firedTotal staying at 1, not 2 — which is the whole point of the belt-and-suspenders.
    expect(snapshot?.backfillProgress).toEqual({ filesTotal: 1, filesDone: 1, percent: 100, done: true });
    const row = snapshot?.topUsed.find((r) => r.slug === "grill-me");
    expect(row).toMatchObject({ firedTotal: 1, fired30d: 1, fired90d: 1 });
    expect(row?.installed).toMatchObject({ slug: "grill-me", name: "grill-me", description: "interviews the user relentlessly", origin: "user" });
    expect(snapshot?.graveyard).toEqual([]); // the only installed skill just fired
  }, 20_000);

  it("lists the candidate queue and opens a candidate's SKILL.md via the file-scoped executor", async () => {
    const { base, home } = await setup();
    const snapshot = (await (await fetch(`${base}/api/skills/snapshot`)).json()) as SkillsSnapshotResult;
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({
      slug: "candidate-a",
      name: "candidate-a",
      description: "a staged candidate",
      evidenceCount: 5,
      confidence: 0.7,
      path: join(home, ".claude", "skills", "_proposed", "candidate-a", "SKILL.md"),
    });
    // no .autoskiller-meta.json in this fixture, so queuedAt falls back to the SKILL.md mtime
    expect(Number.isNaN(Date.parse(snapshot.candidates[0]?.queuedAt ?? ""))).toBe(false);
    // Fetched immediately after boot, before onTick's first 10s-interval backfill pass has
    // had any chance to run: the server is honest that history hasn't been read yet. `skills`
    // client feature is the one that turns this into "still reading history (N%)" instead of
    // showing the (here, coincidentally correct, but not yet trustworthy) graveyard below.
    expect(snapshot.backfillProgress).toEqual({ filesTotal: 0, filesDone: 0, percent: 0, done: false });
    // an untracked installed skill with 0 events lands in the graveyard
    expect(snapshot.graveyard.map((r) => r.slug)).toEqual(["grill-me"]);

    const path = snapshot.candidates[0]?.path ?? "";
    const openRes = await fetch(`${base}/api/skills/open-editor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    expect(openRes.status).toBe(200);
    expect((await openRes.json()) as SkillsOpenEditorResult).toEqual({ ok: true });
    expect(opened).toEqual([path]);
  });

  it("refuses to open a file outside every allowed skills root", async () => {
    const { base, home } = await setup();
    const outside = join(home, "not-a-skills-dir", "SKILL.md");
    const res = await fetch(`${base}/api/skills/open-editor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: outside }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as SkillsOpenEditorResult).ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it("rejects an invalid agent id on the session route", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/api/skills/session/not-a-uuid`)).status).toBe(400);
  });
});
