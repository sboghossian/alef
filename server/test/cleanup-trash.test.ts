// "cleanup" (P2) against a real filesystem, always inside a temp fake home with its own
// .claude/projects: retire → restore round trips, the path guards on disk (symlinks, memory*),
// never-overwrite, crash safety, and the HTTP routes on a booted test server. The real ~/.claude,
// ~/.alef-trash, tmux and ps are never touched.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { CandidatesResponse, RestoreResult, RetireResult, TrashListResponse } from "../../shared/features/cleanup.js";
import type { ServerMessage } from "../../shared/types.js";
import { createCleanupFeature, type CleanupDeps } from "../features/cleanup.js";
import { listTrash, realTrashFs, restoreBatch, retireSessions, type TrashDeps, type TrashFs } from "../features/cleanup-trash.js";
import type { RunningServer } from "../index.js";
import { assistantLine, bootTestServer, userLine } from "./helpers.js";

const A = "aaaaaaaa-2222-3333-4444-555555555555";
const B = "bbbbbbbb-2222-3333-4444-555555555555";
const PROJ = "-w-proj";
const OLD = new Date(Date.now() - 3 * 86_400_000);

let home: string;
let projects: string;
let deps: TrashDeps;

async function makeSession(id: string, opts: { withDir?: boolean; proj?: string; old?: boolean } = {}): Promise<string> {
  const dir = join(projects, opts.proj ?? PROJ);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const at = OLD.toISOString();
  await writeFile(file, `${userLine({ cwd: "/w/proj", timestamp: at, text: `hello ${id}` })}\n${assistantLine({ cwd: "/w/proj", timestamp: at })}\n`);
  if (opts.withDir !== false) {
    await mkdir(join(dir, id, "subagents"), { recursive: true });
    await writeFile(join(dir, id, "subagents", "agent-x.jsonl"), "{}\n");
  }
  if (opts.old !== false) await utimes(file, OLD, OLD);
  return file;
}

const noGuard = (): null => null;
const item = (id: string) => ({ id, title: "t", cwd: "/w/proj", messageCount: 2, lastActive: OLD.toISOString() });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-cleanup-home-"));
  projects = join(home, ".claude", "projects");
  await mkdir(projects, { recursive: true });
  deps = { home, projectsDir: projects, fs: realTrashFs, now: () => new Date() };
});

describe("retire → restore on disk", () => {
  it("moves the jsonl + its uuid folder, keeps bytes and mtime, and restores them", async () => {
    const file = await makeSession(A);
    const before = await stat(file);
    const bytesBefore = await readFile(file, "utf8");
    const out = await retireSessions(deps, [item(A)], noGuard);
    expect(out.results).toEqual([{ id: A, ok: true, bytes: expect.any(Number) }]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(projects, PROJ, A))).toBe(false);
    const moved = join(out.batchDir, PROJ, `${A}.jsonl`);
    expect(await readFile(moved, "utf8")).toBe(bytesBefore);
    expect((await stat(moved)).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(out.batchDir, PROJ, A, "subagents", "agent-x.jsonl"))).toBe(true);
    expect(out.batchDir.startsWith(join(home, ".alef-trash"))).toBe(true);

    const manifest = JSON.parse(await readFile(join(out.batchDir, "manifest.json"), "utf8"));
    expect(manifest.items[0]).toMatchObject({ sessionId: A, state: "retired" });
    expect(await readFile(join(home, ".alef-trash", "log.jsonl"), "utf8")).toContain(A);

    const back = await restoreBatch(deps, out.batchId, null);
    expect(back.restoredIds).toEqual([A]);
    expect(await readFile(file, "utf8")).toBe(bytesBefore);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(projects, PROJ, A, "subagents", "agent-x.jsonl"))).toBe(true);
    expect((await listTrash(deps))[0]?.items[0]?.state).toBe("restored");
    // Nothing was deleted: the batch folder and its manifest stay as history.
    expect(existsSync(join(out.batchDir, "manifest.json"))).toBe(true);
  });

  it("restores one id of a batch", async () => {
    await makeSession(A);
    await makeSession(B, { withDir: false });
    const out = await retireSessions(deps, [item(A), item(B)], noGuard);
    const back = await restoreBatch(deps, out.batchId, [B]);
    expect(back.restoredIds).toEqual([B]);
    expect(existsSync(join(projects, PROJ, `${B}.jsonl`))).toBe(true);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(false);
  });

  it("restore never overwrites a file that came back", async () => {
    const file = await makeSession(A);
    const out = await retireSessions(deps, [item(A)], noGuard);
    await writeFile(file, "a new session with the same id\n");
    const back = await restoreBatch(deps, out.batchId, null);
    expect(back.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/not overwriting/) });
    expect(await readFile(file, "utf8")).toBe("a new session with the same id\n");
    expect(existsSync(join(out.batchDir, PROJ, `${A}.jsonl`))).toBe(true);
  });

  it("a guard hit moves nothing", async () => {
    const file = await makeSession(A);
    const out = await retireSessions(deps, [item(A)], () => "it is live right now");
    expect(out.results[0]).toMatchObject({ ok: false, error: "protected: it is live right now" });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(home, ".alef-trash"))).toBe(false);
  });

  it("the guard sees the real on-disk mtime", async () => {
    await makeSession(A, { old: false });
    const seen: number[] = [];
    await retireSessions(deps, [item(A)], (_id, m) => (seen.push(m), "recent"));
    expect(Date.now() - (seen[0] ?? 0)).toBeLessThan(60_000);
  });
});

describe("path guards on disk", () => {
  it("refuses a symlinked jsonl that points outside the projects dir", async () => {
    const outside = join(home, "secret.jsonl");
    await writeFile(outside, "x\n");
    await mkdir(join(projects, PROJ), { recursive: true });
    await symlink(outside, join(projects, PROJ, `${A}.jsonl`));
    const out = await retireSessions(deps, [item(A)], noGuard);
    expect(out.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/symlink/) });
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses a symlinked uuid folder", async () => {
    await makeSession(A, { withDir: false });
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(projects, PROJ, A));
    const out = await retireSessions(deps, [item(A)], noGuard);
    expect(out.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/symlink/) });
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
  });

  it("never looks inside a symlinked project folder, memory/ or memory.bak-*", async () => {
    const outsideProj = join(home, "outside-proj");
    await mkdir(outsideProj);
    await writeFile(join(outsideProj, `${A}.jsonl`), "x\n");
    await symlink(outsideProj, join(projects, "linked"));
    await makeSession(B, { proj: "memory" });
    await makeSession(B, { proj: "memory.bak-x" });
    const out = await retireSessions(deps, [item(A), item(B)], noGuard);
    expect(out.results.every((r) => !r.ok && /not found/.test(r.error ?? ""))).toBe(true);
    expect(existsSync(join(outsideProj, `${A}.jsonl`))).toBe(true);
    expect(existsSync(join(projects, "memory", `${B}.jsonl`))).toBe(true);
  });

  it("refuses a tampered manifest pointing outside the projects dir", async () => {
    await makeSession(A);
    const out = await retireSessions(deps, [item(A)], noGuard);
    const mPath = join(out.batchDir, "manifest.json");
    const m = JSON.parse(await readFile(mPath, "utf8"));
    m.items[0].from[0] = join(home, ".claude", "settings.json");
    await writeFile(mPath, JSON.stringify(m));
    const back = await restoreBatch(deps, out.batchId, null);
    expect(back.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) });
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});

describe("crash safety", () => {
  it("the manifest is on disk before the first move; a crash after the move is restorable", async () => {
    await makeSession(A);
    let manifestBeforeMove = false;
    let writes = 0;
    const crashy: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (from.endsWith(`${A}.jsonl`)) manifestBeforeMove = existsSync(join(to, "..", "..", "manifest.json"));
        return realTrashFs.rename(from, to);
      },
      async writeFile(p, d, o) {
        writes += 1;
        if (writes === 2) throw new Error("simulated crash after the move"); // 2nd manifest write
        return realTrashFs.writeFile(p, d, o);
      },
    };
    await expect(retireSessions({ ...deps, fs: crashy }, [item(A)], noGuard)).rejects.toThrow("simulated crash");
    expect(manifestBeforeMove).toBe(true);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(false);
    const [batch] = await listTrash(deps);
    expect(batch?.items[0]?.state).toBe("planned");
    const back = await restoreBatch(deps, batch?.batchId ?? "", null);
    expect(back.restoredIds).toEqual([A]);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
    expect(existsSync(join(projects, PROJ, A, "subagents"))).toBe(true);
  });

  it("a failed folder move puts the jsonl back", async () => {
    await makeSession(A);
    const failing: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (from.endsWith(`/${A}`)) throw new Error("EXDEV");
        return realTrashFs.rename(from, to);
      },
    };
    const out = await retireSessions({ ...deps, fs: failing }, [item(A)], noGuard);
    expect(out.results[0]).toMatchObject({ ok: false, error: "EXDEV" });
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
    expect((await listTrash(deps))[0]?.items[0]?.state).toBe("failed");
  });

  it("a failed folder restore moves the jsonl back into the trash, and a retry succeeds", async () => {
    await makeSession(A);
    await retireSessions(deps, [item(A)], noGuard);
    const [batch] = await listTrash(deps);
    const failing: TrashFs = {
      ...realTrashFs,
      async rename(from, to) {
        if (to.endsWith(`/${A}`) && from.includes(".alef-trash")) throw new Error("EXDEV");
        return realTrashFs.rename(from, to);
      },
    };
    const first = await restoreBatch({ ...deps, fs: failing }, batch?.batchId ?? "", null);
    expect(first.restoredIds).toEqual([]);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(false);
    const retry = await restoreBatch(deps, batch?.batchId ?? "", null);
    expect(retry.restoredIds).toEqual([A]);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
    expect(existsSync(join(projects, PROJ, A, "subagents"))).toBe(true);
  });
});

// ── routes on a booted server ────────────────────────────────────────────────

let server: RunningServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(extra: CleanupDeps = {}): Promise<string> {
  const { feature } = createCleanupFeature({
    home,
    tmux: { findTmux: async () => null, list: async () => "", captureAll: async () => "", kill: async () => undefined },
    processCommands: () => [],
    pendingApprovals: () => new Set(),
    currentSessionIds: () => new Set(),
    reveal: async () => undefined,
    ...extra,
  });
  const booted = await bootTestServer({ configOverrides: { projectsDir: projects, features: [feature] } });
  server = booted.server;
  return booted.base;
}

async function post<T>(base: string, path: string, body: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as T };
}

describe("routes", () => {
  it("candidates → retire (forget + agentsRemoved) → trash → restore", async () => {
    await makeSession(A);
    const base = await boot();
    const world = async (): Promise<string[]> => ((await (await fetch(`${base}/api/world`)).json()) as { agents: { id: string }[] }).agents.map((a) => a.id);
    expect(await world()).toContain(A);

    const cands = (await (await fetch(`${base}/api/cleanup/candidates?tiny=5`)).json()) as CandidatesResponse;
    expect(cands.buckets.tiny.map((i) => i.id)).toEqual([A]);
    expect(cands.buckets.tiny[0]?.bytes).toBeGreaterThan(0);
    expect(cands.buckets.totals.count).toBe(1);

    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const got: ServerMessage[] = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise<void>((r) => ws.on("open", () => r()));

    const retired = await post<RetireResult>(base, "/api/cleanup/retire", { ids: [A] });
    expect(retired.status).toBe(200);
    expect(retired.json.ok && retired.json.results[0]?.ok).toBe(true);
    expect(await world()).not.toContain(A);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContainEqual({ type: "agentsRemoved", ids: [A] });
    expect(got).toContainEqual({ type: "feature", feature: "cleanup", payload: { kind: "retired", ids: [A] } });
    ws.close();

    const trash = (await (await fetch(`${base}/api/cleanup/trash`)).json()) as TrashListResponse;
    expect(trash.batches[0]?.items[0]?.sessionId).toBe(A);

    const restored = await post<RestoreResult>(base, "/api/cleanup/restore", { batchId: trash.batches[0]?.batchId });
    expect(restored.json.ok && restored.json.results[0]?.ok).toBe(true);
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
    // The offset row went with forgetSession, so the next index pass re-reads it from byte 0.
  });

  it("refuses 201 ids, bad JSON and non-uuids with 400", async () => {
    const base = await boot();
    const ids = Array.from({ length: 201 }, (_, i) => `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`);
    expect((await post(base, "/api/cleanup/retire", { ids })).status).toBe(400);
    expect((await post(base, "/api/cleanup/retire", { ids: ["memory"] })).status).toBe(400);
    expect((await post(base, "/api/cleanup/restore", { batchId: "../../x" })).status).toBe(400);
    expect((await post(base, "/api/cleanup/tmux/main/close", {})).status).toBe(400);
  });

  it("refuses a session active in the last 30 min, one in ps argv, one with an approval, the current one", async () => {
    await makeSession(A, { old: false });
    let base = await boot();
    let r = await post<RetireResult>(base, "/api/cleanup/retire", { ids: [A] });
    expect(r.json.ok && r.json.results[0]?.error).toMatch(/protected/);
    await server?.close();

    await utimes(join(projects, PROJ, `${A}.jsonl`), OLD, OLD);
    for (const extra of [
      { processCommands: () => [`claude --resume ${A}`] },
      { pendingApprovals: () => new Set([A]) },
      { currentSessionIds: () => new Set([A]) },
    ] satisfies CleanupDeps[]) {
      base = await boot(extra);
      r = await post<RetireResult>(base, "/api/cleanup/retire", { ids: [A] });
      expect(r.json.ok && r.json.results[0]?.error).toMatch(/protected/);
      await server?.close();
      server = null;
    }
    expect(existsSync(join(projects, PROJ, `${A}.jsonl`))).toBe(true);
    expect(existsSync(join(home, ".alef-trash"))).toBe(false);
  });

  it("worktree bucket: a fork whose repo is gone, never a loop worktree's subfolders", async () => {
    const loops = join(home, ".alef-worktrees");
    // A loop worktree checked out straight at ~/.alef-worktrees/<slug>, its main repo gone too.
    for (const sub of ["client", "server", "data"]) await mkdir(join(loops, "archive-sessions", sub), { recursive: true });
    await writeFile(join(loops, "archive-sessions", ".git"), `gitdir: ${join(home, "gone-repo", ".git", "worktrees", "archive-sessions")}\n`);
    // A removed loop worktree's leftovers: no `.git` anywhere, so no worktree at all.
    await mkdir(join(loops, "clinic-building", ".vite"), { recursive: true });
    // A fork at ~/.alef-worktrees/<repo>/<name> whose repo is gone.
    await mkdir(join(loops, "other", "fork-1"), { recursive: true });
    await writeFile(join(loops, "other", "fork-1", ".git"), `gitdir: ${join(home, "other", ".git", "worktrees", "fork-1")}\n`);
    const base = await boot();
    const cands = (await (await fetch(`${base}/api/cleanup/candidates`)).json()) as CandidatesResponse;
    expect(cands.buckets.worktree.map((w) => [w.path, w.reason])).toEqual([[join(loops, "other", "fork-1"), "its repo is gone"]]);
  });

  it("marks protected candidates and never counts them", async () => {
    await makeSession(A);
    const base = await boot({ pendingApprovals: () => new Set([A]) });
    const cands = (await (await fetch(`${base}/api/cleanup/candidates`)).json()) as CandidatesResponse;
    expect(cands.buckets.tiny[0]?.protected).toMatch(/approval/);
    expect(cands.buckets.totals).toMatchObject({ count: 0, protectedCount: 1 });
  });
});

it("the trash lives under the injected home only", async () => {
  await makeSession(A);
  const out = await retireSessions(deps, [item(A)], noGuard);
  expect((await readdir(join(home, ".alef-trash"))).sort()).toEqual([out.batchDir.split("/").at(-2), "log.jsonl"].sort());
});
