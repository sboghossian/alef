import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectItem, ProjectsResponse } from "../../shared/features/projects.js";
import { createProjectsFeature } from "../features/projects.js";
import { listPreviews, listPreviewsIn, loadNotes, mirrorPreviews, previewFor, projectLabelOf, readPreview, scanVaultSessions, sessionsFor } from "../features/projects-extra.js";
import { applyScan, diffFacts, emptyState, loadHistory, saveHistory } from "../features/projects-history.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

const mk = async (): Promise<string> => realpath(await mkdtemp(join(tmpdir(), "projects-extra-")));

function item(id: string, o: Partial<ProjectItem> = {}): ProjectItem {
  return { id, name: id, path: `/x/${id}`, kind: "repo", islandId: null, sessions: 0, lastActive: null, git: { remote: null, branch: "main", lastCommit: null, commits: 10 }, readme: null, stack: [], category: "side", categoryReason: "", vaultNote: null, stage: "building", stageReason: "", deploy: null, activityAt: null, hasPreview: false, notes: null, vaultSessions: null, changes: [], costUsd30d: null, artifacts: null, unread: false, folded: [], ...o };
}
const withCommits = (id: string, commits: number | null, o: Partial<ProjectItem> = {}): ProjectItem => item(id, { git: { remote: null, branch: "main", lastCommit: null, commits }, ...o });

describe("previews", () => {
  it("matches by folder name, case-insensitively, decoding %20 and preferring webp", async () => {
    const dir = await mk();
    for (const f of ["Alpha.webp", "alpha.png", "beta.png", "claw3d%202.webp", "notes.txt"]) await writeFile(join(dir, f), "x");
    const m = await listPreviews(dir);
    expect(m.get("alpha")).toBe("Alpha.webp");
    expect(m.get("beta")).toBe("beta.png");
    expect(m.get("claw3d 2")).toBe("claw3d%202.webp");
    expect(m.has("notes")).toBe(false);
    expect(previewFor(["ALPHA"], m)).toBe("Alpha.webp");
    expect(previewFor(["nope", "beta"], m)).toBe("beta.png"); // a folded folder's name counts
    expect(previewFor(["nope"], m)).toBeNull();
    expect((await listPreviews(join(dir, "missing"))).size).toBe(0);
  });

  it("readPreview serves an image, and refuses traversal, symlinks out of the folder, non-images and big files", async () => {
    const dir = await mk();
    const outside = await mk();
    await writeFile(join(outside, "secret.png"), "TOP SECRET");
    await writeFile(join(dir, "ok.webp"), "webp-bytes");
    await writeFile(join(dir, "doc.txt"), "x");
    await writeFile(join(dir, "big.png"), Buffer.alloc(2_100_000, 1));
    await symlink(join(outside, "secret.png"), join(dir, "link.png"));
    expect((await readPreview(dir, "ok.webp"))?.type).toBe("image/webp");
    expect(await readPreview(dir, "../" + outside.split("/").pop() + "/secret.png")).toBeNull();
    expect(await readPreview(dir, "link.png")).toBeNull();
    expect(await readPreview(dir, "doc.txt")).toBeNull();
    expect(await readPreview(dir, "big.png")).toBeNull();
    expect(await readPreview(dir, "missing.png")).toBeNull();
  });

  it("mirrorPreviews copies images only, once, under the cap, never through a symlink out; serving prefers the copy and falls back", async () => {
    const src = await mk();
    const outside = await mk();
    const data = await mk();
    const dest = join(data, "roadmap-previews");
    try {
      await writeFile(join(outside, "secret.png"), "TOP SECRET");
      await writeFile(join(src, "a.webp"), Buffer.alloc(600, 1));
      await writeFile(join(src, "b.png"), Buffer.alloc(600, 2));
      await writeFile(join(src, "c.webp"), Buffer.alloc(600, 3)); // over the 1500-byte cap after a + b
      await writeFile(join(src, "notes.txt"), "x");
      await writeFile(join(src, "huge.png"), Buffer.alloc(2_100_000, 1));
      await mkdir(join(src, "sub.png"));
      await symlink(join(outside, "secret.png"), join(src, "link.png"));
      expect(await mirrorPreviews(join(src, "missing"), dest)).toBeNull();
      expect(await mirrorPreviews(src, dest, 1500)).toBe(2);
      expect((await readdir(dest)).sort()).toEqual(["a.webp", "b.png"]);
      expect((await readdir(data)).sort()).toEqual(["roadmap-previews"]); // no temp folder left behind
      await writeFile(join(src, "d.webp"), "late");
      expect(await mirrorPreviews(src, dest)).toBeNull(); // once: an existing copy is left alone
      expect(await readdir(dest)).not.toContain("d.webp");

      const both = await listPreviewsIn([dest, src]);
      expect(both.get("a")).toEqual({ dir: dest, file: "a.webp" });
      expect(both.get("c")).toEqual({ dir: src, file: "c.webp" }); // not copied: falls back to the roadmap folder
      expect(both.has("link")).toBe(true); // listed, but readPreview still refuses it
      expect(await readPreview(src, "link.png")).toBeNull();
      await rm(src, { recursive: true, force: true }); // the roadmap folder archived
      expect((await listPreviewsIn([dest, src])).get("b")).toEqual({ dir: dest, file: "b.png" });
      expect((await readPreview(dest, "b.png"))?.body.length).toBe(600);
    } finally {
      for (const d of [src, outside, data]) await rm(d, { recursive: true, force: true });
    }
  });
});

describe("vault session notes", () => {
  it("reads the explicit project label, folds legacy names, drops generic ones", () => {
    expect(projectLabelOf('---\ntype: session\nproject: "Acme-Legal-AI"\n---\nbody')).toBe("acme-ai");
    expect(projectLabelOf("---\nproject: home\n---\n")).toBeNull();
    expect(projectLabelOf('---\nproject: ""\n---\n')).toBeNull();
    expect(projectLabelOf("no frontmatter\nproject: x")).toBeNull();
    expect(projectLabelOf("---\nproject: my  proj\n---")).toBe("my-proj");
  });

  it("counts notes per project and source", async () => {
    const dir = await mk();
    for (const src of ["claude-code", "chatgpt"]) await mkdir(join(dir, src));
    await writeFile(join(dir, "claude-code", "a.md"), "---\nproject: alpha\n---\n");
    await writeFile(join(dir, "claude-code", "b.md"), "---\nproject: alpha\n---\n");
    await writeFile(join(dir, "chatgpt", "c.md"), "---\nproject: Alpha\n---\n");
    await writeFile(join(dir, "chatgpt", "d.md"), "---\nproject: home\n---\n");
    const m = await scanVaultSessions(dir);
    expect(sessionsFor(["alpha"], m)).toEqual({ "claude-code": 2, chatgpt: 1 });
    expect(sessionsFor(["none"], m)).toBeNull();
  });
});

describe("notes file", () => {
  it("validates the shape, keeps only http(s) links and caps lists; absent or broken gives nothing", async () => {
    const dir = await mk();
    const path = join(dir, "n.json");
    await writeFile(path, JSON.stringify({ Alpha: { desc: "d", milestones: ["m", 4, ""], nextSteps: ["n"], url: "javascript:alert(1)", started: "2024-01-02" }, Beta: { url: "https://b.dev" }, Bad: 5 }));
    const n = await loadNotes(path);
    expect(n.get("alpha")).toMatchObject({ desc: "d", milestones: ["m"], nextSteps: ["n"], liveUrl: null, started: "2024-01-02" });
    expect(n.get("beta")?.liveUrl).toBe("https://b.dev");
    expect(n.has("bad")).toBe(false);
    expect(n.get("alpha")).toMatchObject({ asOf: null, sources: [], stale: false }); // old files still load
    await writeFile(path, JSON.stringify({ Gamma: { desc: "g", liveUrl: "https://g.dev", asOf: "2026-10-14", sources: ["README", 3, "git log"], stale: true }, Delta: { desc: "d", asOf: "yesterday" } }));
    const v2 = await loadNotes(path);
    expect(v2.get("gamma")).toMatchObject({ liveUrl: "https://g.dev", asOf: "2026-10-14", sources: ["README", "git log"], stale: true });
    expect(v2.get("delta")).toMatchObject({ asOf: null, stale: false });
    expect((await loadNotes(join(dir, "nope.json"))).size).toBe(0);
    await writeFile(path, "{not json");
    expect((await loadNotes(path)).size).toBe(0);
    expect((await loadNotes(null)).size).toBe(0);
  });
});

describe("refresh history", () => {
  const T0 = Date.parse("2026-10-14T08:00:00Z");
  const H = 3_600_000;

  it("first sight sets a baseline only; later scans record deltas, newest first", () => {
    let s = applyScan(emptyState("x"), [withCommits("a", 10)], T0);
    expect(s.projects.a?.changes).toEqual([]);
    s = applyScan(s, [withCommits("a", 22, { sessions: 2 })], T0 + 2 * H);
    expect(s.projects.a?.changes[0]).toMatchObject({ commits: 12, sessions: 2 });
    s = applyScan(s, [withCommits("a", 23, { stage: "shipped" })], T0 + 5 * H);
    expect(s.projects.a?.changes.map((c) => c.commits)).toEqual([1, 12]);
    expect(s.projects.a?.changes[0]?.stage).toEqual({ from: "building", to: "shipped" });
    expect(s.refreshes).toHaveLength(3);
    expect(s.refreshes[0]).toMatchObject({ total: 1, stageCounts: { shipped: 1, building: 0 } });
  });

  it("an unreadable commit count is unknown, not a change, and the old count carries over", () => {
    let s = applyScan(emptyState("x"), [withCommits("a", 10)], T0);
    s = applyScan(s, [withCommits("a", null)], T0 + 2 * H);
    expect(s.projects.a?.changes).toEqual([]);
    s = applyScan(s, [withCommits("a", 14)], T0 + 4 * H);
    expect(s.projects.a?.changes[0]?.commits).toBe(4);
  });

  it("changes seen within 30 minutes fold into one (a live session flickers the session count)", () => {
    let s = applyScan(emptyState("x"), [item("a", { sessions: 1 })], T0);
    s = applyScan(s, [item("a", { sessions: 2 })], T0 + 60_000);
    s = applyScan(s, [item("a", { sessions: 1 })], T0 + 120_000);
    expect(s.projects.a?.changes).toEqual([]); // +1 then -1 cancels
    s = applyScan(s, [item("a", { sessions: 3 })], T0 + 180_000);
    s = applyScan(s, [item("a", { sessions: 4 })], T0 + 240_000);
    expect(s.projects.a?.changes).toHaveLength(1);
    expect(s.projects.a?.changes[0]?.sessions).toBe(3);
  });

  it("keeps at most 12 changes per project and drops projects that disappeared", () => {
    let s = applyScan(emptyState("x"), [withCommits("a", 0), withCommits("gone", 1)], T0);
    for (let i = 1; i <= 20; i++) s = applyScan(s, [withCommits("a", i)], T0 + i * H);
    expect(s.projects.a?.changes).toHaveLength(12);
    expect(s.projects.gone).toBeUndefined();
  });

  it("diffFacts is null when nothing differs", () => {
    const f = { commits: 1, sessions: 0, stage: "idea" as const, branch: "main" };
    expect(diffFacts(f, { ...f }, "t")).toBeNull();
    expect(diffFacts(f, { ...f, branch: "dev" }, "t")?.branch).toEqual({ from: "main", to: "dev" });
  });

  it("round-trips through the file and falls back to a fresh baseline on junk", async () => {
    const dir = await mk();
    const path = join(dir, "sub", "h.json");
    const s = applyScan(emptyState("2026-10-01T00:00:00Z"), [withCommits("a", 1)], T0);
    expect(await saveHistory(path, s)).toBe(true);
    expect((await loadHistory(path, T0)).since).toBe("2026-10-01T00:00:00Z");
    await writeFile(path, "garbage");
    expect((await loadHistory(path, T0)).projects).toEqual({});
    expect(await saveHistory(null, s)).toBe(false);
  });
});

describe("projects feature: previews, history and joins over HTTP", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves the matched preview, 404s the rest, records history on disk and joins notes, sessions and cost", async () => {
    const home = await mk();
    const code = join(home, "Documents", "Code");
    const data = join(home, "data");
    const previews = join(home, "previews");
    await mkdir(join(code, "alpha"), { recursive: true });
    await mkdir(join(code, "beta"), { recursive: true });
    await mkdir(previews, { recursive: true });
    await mkdir(join(home, "sessions", "claude-chat"), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(previews, "alpha.webp"), "WEBPBYTES");
    await writeFile(join(home, "sessions", "claude-chat", "s.md"), "---\nproject: alpha\n---\n");
    await writeFile(join(data, "projects-notes.json"), JSON.stringify({ alpha: { desc: "Alpha notes", nextSteps: ["ship it"] } }));
    const feature = createProjectsFeature({
      home,
      codeDir: code,
      vaultProjectsDir: join(home, "no-vault"),
      previewsDir: previews,
      sessionsDir: join(home, "sessions"),
      dataDir: data,
      ttlMs: 0,
      districts: () => ({ districts: [{ id: "alpha", name: "alpha", path: join(code, "alpha"), sessions: 1, lastActive: null }], skipped: 0 }),
      artifacts: () => [],
      costs: () => Promise.resolve(new Map([["alpha", 12.5]])),
    });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    const list = (await (await fetch(`${b.base}/api/projects`)).json()) as ProjectsResponse;
    const alpha = list.items.find((p) => p.name === "alpha")!;
    const beta = list.items.find((p) => p.name === "beta")!;
    expect(alpha).toMatchObject({ hasPreview: true, costUsd30d: 12.5, vaultSessions: { "claude-chat": 1 }, notes: { desc: "Alpha notes", nextSteps: ["ship it"] } });
    expect(beta).toMatchObject({ hasPreview: false, costUsd30d: null, vaultSessions: null, notes: null });
    expect(list.history.refreshes.length).toBeGreaterThan(0);

    const img = await fetch(`${b.base}/api/projects/alpha/preview`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/webp");
    expect(await img.text()).toBe("WEBPBYTES");
    expect((await fetch(`${b.base}/api/projects/beta/preview`)).status).toBe(404);
    expect((await fetch(`${b.base}/api/projects/nope/preview`)).status).toBe(404);
    expect((await fetch(`${b.base}/api/projects/..%2Fetc/preview`)).status).toBe(400);

    // The save is fire-and-forget after each scan: wait for it rather than race it.
    const saved = JSON.parse(await vi.waitFor(() => readFile(join(data, "projects-history.json"), "utf8"), { timeout: 3000 })) as { version: number; projects: Record<string, unknown> };
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.projects).sort()).toEqual(["alpha", "beta"]);
  });
});
