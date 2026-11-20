import type { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchiveList, ArchiveMessage, ArchiveSummary } from "../../shared/features/archive.js";
import type { Island, WorldAgent } from "../../shared/types.js";
import { createArchiveFeature, isDataless, NoteCache, RESCAN_MS } from "../features/archive.js";
import type { FeatureContext } from "../features/registry.js";

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function sessionNote(id: string, project: string, summary = "do a thing"): string {
  return `---\ntype: session\nsession_id: ${id}\ndate: 2026-06-0${(Number(id.slice(-1)) % 9) + 1}\nproject: ${project}\nsummary: ${summary}\n---\n# body\n`;
}

let root = "";
let notesDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alef-archive-"));
  notesDir = join(root, "vault", "10-Sessions", "claude-code");
  await mkdir(notesDir, { recursive: true });
  await mkdir(join(root, "groups"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NoteCache", () => {
  it("parses each note once and re-reads only a changed file; forgets deleted ones; skips _hub and folders", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "crucible"));
    await writeFile(join(notesDir, "b.md"), sessionNote(ID(2), "crucible"));
    await writeFile(join(notesDir, "_hub.md"), "---\ntype: hub\n---\n");
    await mkdir(join(notesDir, "backups.md"));
    const cache = new NoteCache(notesDir);
    const first = await cache.scan();
    expect(first.files).toBe(2);
    expect(cache.reads).toBe(2);

    await cache.scan();
    expect(cache.reads).toBe(2); // nothing changed: zero reads

    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "acme-ai-next", "changed"));
    const later = new Date(Date.now() + 5000);
    await utimes(join(notesDir, "a.md"), later, later);
    const third = await cache.scan();
    expect(cache.reads).toBe(3);
    const a = third.results.find((r) => r.file === "a.md")?.result;
    expect(a?.ok && a.note.project).toBe("acme-ai-next");

    await rm(join(notesDir, "b.md"));
    const fourth = await cache.scan();
    expect(fourth.results.map((r) => r.file)).toEqual(["a.md"]);
  });

  it("a hung read is skipped as read-timeout, stays skipped while hung, and is re-read once it settles", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "crucible"));
    await writeFile(join(notesDir, "b.md"), sessionNote(ID(2), "crucible"));
    let release: () => void = () => {};
    let hang = true;
    const read = async (path: string): Promise<string> => {
      if (hang && path.endsWith("a.md")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return readFile(path, "utf8");
    };
    // b.md is a real read racing this timeout: 20 ms failed under load (load avg 20, 2026-09-28).
    const cache = new NoteCache(notesDir, { read, timeoutMs: 250 });
    const first = await cache.scan();
    expect(first.results.find((r) => r.file === "a.md")?.result).toEqual({ ok: false, reason: "read-timeout" });
    expect(first.results.find((r) => r.file === "b.md")?.result.ok).toBe(true);
    const second = await cache.scan();
    expect(second.results.find((r) => r.file === "a.md")?.result).toEqual({ ok: false, reason: "read-timeout" });
    hang = false;
    release();
    await new Promise((r) => setTimeout(r, 10));
    const third = await cache.scan();
    expect(third.results.find((r) => r.file === "a.md")?.result.ok).toBe(true);
  });

  it("never re-opens a note while its earlier read is still hanging", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "crucible"));
    let opens = 0;
    let release: (v: string) => void = () => {};
    const read = (): Promise<string> => {
      opens++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const cache = new NoteCache(notesDir, { read, timeoutMs: 20 });
    await cache.scan();
    await cache.scan();
    expect(opens).toBe(1);
    release(sessionNote(ID(1), "crucible"));
    await new Promise((r) => setTimeout(r, 0));
    await cache.scan().catch(() => undefined);
    expect(opens).toBe(2);
  });

  it("isDataless: size without allocated blocks means evicted to iCloud", () => {
    expect(isDataless({ size: 1200, blocks: 0 })).toBe(true);
    expect(isDataless({ size: 1200, blocks: 8 })).toBe(false);
    expect(isDataless({ size: 0, blocks: 0 })).toBe(false);
  });

  it("a missing folder is an empty archive, not an error", async () => {
    const cache = new NoteCache(join(root, "nope"));
    expect(await cache.scan()).toEqual({ files: 0, results: [] });
  });
});

function fakeCtx(agents: Pick<WorldAgent, "id">[], islands: Island[], emitted: unknown[]): FeatureContext {
  const noop = (): void => {};
  return {
    featureId: "archive",
    emit: (p: unknown) => emitted.push(p),
    log: { info: noop, warn: noop, error: noop, debug: noop },
    worldViews: () => ({ agents: agents as WorldAgent[], objects: [], edges: [], islands }),
    db: { listCwdAliases: () => [] },
  } as unknown as FeatureContext;
}

describe("archive feature", () => {
  it("skips live ids, rescans at most every 10 minutes, emits only when the summary changes", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "acme-ai-next"));
    await writeFile(join(notesDir, "b.md"), sessionNote(ID(2), "crucible"));
    await writeFile(join(notesDir, "c.md"), sessionNote(ID(3), "home", "reply with ok"));
    let t = 1_000_000;
    const feature = createArchiveFeature({ vaultDir: join(root, "vault"), groupsDir: join(root, "groups"), homeDir: "/Users/me", now: () => t });
    const islands: Island[] = [
      { id: "acme-ai-next", name: "acme-ai-next", path: "/Users/me/Documents/Code/acme-ai-next", agentCount: 1, lastActive: "" },
      { id: "me", name: "me", path: "/Users/me", agentCount: 1, lastActive: "" },
    ];
    const emitted: unknown[] = [];
    const ctx = fakeCtx([{ id: ID(3) }], islands, emitted); // ID(3) is live: never a fossil

    expect(feature.snapshotExtras?.(ctx)).toEqual({}); // nothing yet: kicks off the first scan
    await feature.onTick?.(ctx);
    const summary = feature.snapshotExtras?.(ctx)["archive.summary"] as ArchiveSummary;
    expect(summary).toMatchObject({ files: 3, parsed: 3, skippedLive: 1, total: 2, homeIslandId: "me", vault: "vault" });
    expect(summary.places.map((p) => p.key).sort()).toEqual(["archived:crucible", "island:acme-ai-next"]);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as ArchiveMessage).kind).toBe("summary");

    // A new note inside the 10-minute window is not seen yet, and an unchanged pass emits nothing.
    await writeFile(join(notesDir, "d.md"), sessionNote(ID(4), "crucible"));
    t += RESCAN_MS - 1;
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx)["archive.summary"] as ArchiveSummary).total).toBe(2);
    expect(emitted).toHaveLength(1);

    t += 1;
    await feature.onTick?.(ctx);
    expect((feature.snapshotExtras?.(ctx)["archive.summary"] as ArchiveSummary).total).toBe(3);
    expect(emitted).toHaveLength(2);
  });

  it("serves the full list over GET /api/archive", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "crucible", "hello"));
    const feature = createArchiveFeature({ vaultDir: join(root, "vault"), groupsDir: join(root, "groups"), homeDir: "/Users/me" });
    const ctx = fakeCtx([], [], []);
    let status = 0;
    let body = "";
    const res = {
      writeHead: (s: number) => {
        status = s;
        return res;
      },
      setHeader: () => res,
      end: (b?: string) => {
        body = b ?? "";
      },
    };
    const route = feature.routes?.find((r) => r.path === "/api/archive");
    await route?.handler({} as never, res as never, ctx, {});
    expect(status).toBe(200);
    const list = JSON.parse(body) as ArchiveList;
    expect(list.sessions).toEqual([{ id: ID(1), title: "hello", date: "2026-06-02", project: "crucible", place: "archived:crucible", note: "10-Sessions/claude-code/a.md" }]);
  });
});

describe("GET /api/archive while a rescan is due", () => {
  it("answers from the last index at once; the rescan lands for the next request", async () => {
    await writeFile(join(notesDir, "a.md"), sessionNote(ID(1), "crucible"));
    let t = 1_000_000;
    const feature = createArchiveFeature({ vaultDir: join(root, "vault"), groupsDir: join(root, "groups"), homeDir: "/Users/me", now: () => t });
    const ctx = fakeCtx([], [], []);
    const route = feature.routes?.find((r) => r.path === "/api/archive");
    if (!route) throw new Error("no route");
    const get = async (): Promise<ArchiveList> => {
      let data = "";
      const res = { writeHead: () => res, end: (d: string) => void (data = d) } as unknown as ServerResponse;
      await route.handler({} as never, res, ctx, {});
      return JSON.parse(data) as ArchiveList;
    };
    expect((await get()).summary.total).toBe(1); // cold: waits for the first scan
    await writeFile(join(notesDir, "b.md"), sessionNote(ID(2), "crucible"));
    t += RESCAN_MS;
    expect((await get()).summary.total).toBe(1); // due, but served from the last index
    await feature.onTick?.(ctx); // joins the rescan the GET started
    expect((await get()).summary.total).toBe(2);
  });
});
