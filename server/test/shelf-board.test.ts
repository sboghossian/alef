import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "../../shared/features/artifacts.js";
import type { ShelfBoardResponse, ShelfPinsResponse, ShelfSeedResponse } from "../../shared/features/shelf-board.js";
import { createShelfBoardFeature, redactBoard } from "../features/shelf-board.js";
import { bootTestServer, writeSessionFile } from "./helpers.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const ART: ArtifactItem = { id: "AbCdEf123456", url: "https://claude.ai/artifact/AbCdEf123456", title: "Board", origin: "published", islandId: null, sessions: [S1], firstAt: "2026-10-10T00:00:00Z", lastAt: "2026-10-12T00:00:00Z", publishCount: 2, hasPreview: true };
const SEED = [
  { section: "Product", url: "https://claude.ai/artifact/AbCdEf123456", title: "Justinian" },
  { section: "Benchmarks", url: "https://lawgraph.dashable.dev", title: "Law graph" },
  { section: "Side projects", url: "https://claude.ai/code/artifact/d9b6be0a-b231-4c73-b014-6da81c9900d5", title: "Testimonial" },
  { section: "Growth", url: "https://claude.ai/artifact/AbCdEf123456", title: "Justinian" },
];

const json = { "Content-Type": "application/json" };
async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`${base}${path}`, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: (await r.json()) as T };
}

function feature(home: string) {
  return createShelfBoardFeature({ home, tickIntervalMs: 100, services: async () => [{ host: "lawgraph", up: true }, { host: "crypto", up: false }], artifacts: () => [ART] });
}

describe("shelf-board feature on a real server", () => {
  it("lists typed items, pins them, survives a restart, imports a seed once, redacts", async () => {
    const first = await bootTestServer({ configOverrides: { features: [] } });
    const home = first.dir;
    await first.server.close();
    await mkdir(join(home, "Documents", "Code", "proj"), { recursive: true });
    await writeFile(join(home, "notes.md"), "# notes");
    const at = new Date().toISOString();
    const lines = [
      { type: "user", timestamp: at, cwd: `${home}/w`, message: { content: [{ type: "text", text: `ship https://github.com/a/b/pull/3 see https://linear.app/acme/issue/TICK-1/x and ${home}/Documents/Code/proj plus ${home}/notes.md and ${home}/gone/file.txt` }] } },
      { type: "assistant", timestamp: at, cwd: `${home}/w`, message: { content: [{ type: "text", text: "Live at https://lawgraph.dashable.dev/graph and http://localhost:5178" }] } },
      { type: "assistant", timestamp: at, cwd: `${home}/w`, message: { content: [{ type: "tool_use", id: "t", name: "WebFetch", input: { url: "https://docs.vendor.dev/api" } }] } },
      { type: "user", timestamp: at, cwd: `${home}/w`, message: { content: [{ type: "text", text: "signed https://b.s3.amazonaws.com/f?X-Amz-Signature=abc" }] } },
    ].map((l) => JSON.stringify(l));
    const dbPath = join(home, "world.db");
    const boot = await bootTestServer({ configOverrides: { features: [feature(home)], dbPath, projectsDir: join(home, "projects") } });
    await writeSessionFile(join(home, "projects"), "-w", S1, `${lines.join("\n")}\n`);
    let board: ShelfBoardResponse | null = null;
    try {
      await vi.waitFor(
        async () => {
          board = (await call<ShelfBoardResponse>(boot.base, "GET", "/api/shelf/board")).data;
          expect(board.ready).toBe(true);
          expect(board.items.some((i) => i.type === "folder")).toBe(true);
        },
        { timeout: 15_000, interval: 150 },
      );
      const items = (board as ShelfBoardResponse | null)?.items ?? [];
      const byType = (t: string): string[] => items.filter((i) => i.type === t).map((i) => i.title).sort();
      expect(byType("github")).toEqual(["a/b#3"]);
      expect(byType("linear")).toEqual(["TICK-1"]);
      expect(byType("folder")).toEqual(["proj"]);
      expect(byType("file")).toEqual(["notes.md"]);
      expect(byType("artifact")).toEqual(["Board"]);
      expect(items.filter((i) => i.type === "dashable").map((i) => [i.title, i.up])).toEqual([["lawgraph.dashable.dev", true], ["crypto.dashable.dev", false]]);
      expect(items.find((i) => i.type === "github")).toMatchObject({ typed: true, source: "user", sessions: [S1] });
      const all = JSON.stringify(items);
      expect(all).not.toContain("localhost");
      expect(all).not.toContain("docs.vendor.dev"); // fetch-only
      expect(all).not.toContain("amazonaws");
      expect(all).not.toContain("gone");

      const gh = items.find((i) => i.type === "github");
      const pinned = await call<ShelfPinsResponse>(boot.base, "POST", "/api/shelf/pins", { itemId: gh?.id, section: "Growth" });
      expect(pinned.status).toBe(200);
      expect(pinned.data.pins).toMatchObject([{ itemId: gh?.id, section: "Growth", title: "a/b#3" }]);
      const also = await call<ShelfPinsResponse>(boot.base, "POST", "/api/shelf/pins", { itemId: gh?.id, section: "Product" });
      expect(also.data.pins.map((p) => p.section)).toEqual(["Growth", "Product"]); // one item, two shelves
      const moved = await call<ShelfPinsResponse>(boot.base, "POST", "/api/shelf/pins", { itemId: gh?.id, from: "Growth", section: "Sales" });
      expect(moved.data.pins.map((p) => p.section)).toEqual(["Sales", "Product"]);
      expect((await call(boot.base, "POST", "/api/shelf/pins", { itemId: gh?.id, from: "Bandidos", section: "Sales" })).status).toBe(404);
      const one = await call<ShelfPinsResponse>(boot.base, "DELETE", "/api/shelf/pins", { itemId: gh?.id, section: "Product" });
      expect(one.data.pins.map((p) => p.section)).toEqual(["Sales"]); // the other shelf stays
      expect((await call(boot.base, "POST", "/api/shelf/pins", { url: "https://hooks.slack.com/services/T0/B0/abcdefghij1234567890" })).status).toBe(400);
      expect((await call(boot.base, "POST", "/api/shelf/pins", { itemId: "nope" })).status).toBe(404);
      expect((await call(boot.base, "POST", "/api/shelf/pins", { url: "https://x.io/a?token=1" })).status).toBe(400);
      const byUrl = await call<ShelfPinsResponse>(boot.base, "POST", "/api/shelf/pins", { url: "https://news.site/a?utm_source=x", section: "Experiments", title: "A post" });
      expect(byUrl.data.pins.at(-1)).toMatchObject({ url: "https://news.site/a", title: "A post", type: "link" });
      const del = await call<ShelfPinsResponse>(boot.base, "DELETE", "/api/shelf/pins", { url: "https://news.site/a" });
      expect(del.data.pins).toHaveLength(1);
      const secs = await call<ShelfPinsResponse>(boot.base, "PUT", "/api/shelf/sections", { sections: ["Deals", "Product"], renames: { Sales: "Deals" } });
      expect(secs.data.sections).toEqual(["Deals", "Product", "Unsorted"]);
      expect(secs.data.pins[0]?.section).toBe("Deals");

      const seed1 = await call<ShelfSeedResponse>(boot.base, "POST", "/api/shelf/seed", SEED);
      expect(seed1.data).toMatchObject({ added: 4, skipped: 0, invalid: 0 });
      expect(seed1.data.pins.filter((p) => p.title === "Justinian").map((p) => p.section)).toEqual(["Product", "Growth"]);
      const seed2 = await call<ShelfSeedResponse>(boot.base, "POST", "/api/shelf/seed", SEED);
      expect(seed2.data).toMatchObject({ added: 0, skipped: 4 });
      expect(seed2.data.pins).toEqual(seed1.data.pins);
      expect((await call(boot.base, "POST", "/api/shelf/seed", { x: 1 })).status).toBe(400);

      const red = (await call<ShelfBoardResponse>(boot.base, "GET", "/api/shelf/board?redact=1")).data;
      const redText = JSON.stringify(red);
      for (const secret of ["a/b#3", "notes.md", "Justinian", "lawgraph", home, "news.site", "vendor"]) expect(redText).not.toContain(secret);
      const districtIds = new Set(red.items.map((i) => i.district).filter((d): d is string => d !== null));
      for (const d of districtIds) expect(d).toMatch(/^district \d+$/); // island ids are folder names: never shown under redact
    } finally {
      await boot.server.close();
    }

    // A stored item the current filters refuse (e.g. stored before a filter was tightened) is dropped at boot.
    const db = new Database(dbPath);
    const st = JSON.parse((db.prepare("select value from meta where key = ?").get("shelf_board_v1_items") as { value: string }).value) as { items: Record<string, unknown> };
    st.items.stale = { id: "stale", key: "link:x", type: "link", url: "https://img.shields.io/badge/a", path: null, title: "badge", kind: "x", firstSeen: null, lastSeen: null, count: 9, sessions: [], source: "user", typed: true };
    db.prepare("update meta set value = ? where key = ?").run(JSON.stringify(st), "shelf_board_v1_items");
    db.close();
    const again = await bootTestServer({ configOverrides: { features: [feature(home)], dbPath, projectsDir: join(home, "projects") } });
    try {
      const b = (await call<ShelfBoardResponse>(again.base, "GET", "/api/shelf/board")).data;
      expect(b.ready).toBe(true);
      expect(b.pins).toHaveLength(5);
      expect(b.sections).toContain("Deals");
      expect(b.items.filter((i) => i.type === "github")[0]?.count).toBe(1); // not re-counted after the restart
      expect(b.items.some((i) => i.id === "stale")).toBe(false);
    } finally {
      await again.server.close();
    }
  }, 30_000);
});

describe("redactBoard", () => {
  it("blanks titles, URLs, paths, hosts and district ids; districts stay groupable", () => {
    const base = { url: null, path: null, firstSeen: null, lastSeen: null, count: 1, sessions: [], source: "user" as const, typed: true, score: 1 };
    const r = redactBoard({
      ok: true, ready: true, sections: ["Unsorted"], pins: [{ itemId: "a", section: "Unsorted", type: "link", url: "https://client-name.example/deal", path: null, title: "Client deal", pinnedAt: "" }],
      items: [
        { ...base, id: "a", type: "link", url: "https://client-name.example/deal", title: "client-name.example/deal", kind: "client-name.example", district: "acme-litigation" },
        { ...base, id: "b", type: "file", path: "/Users/x/clients/acme/memo.md", title: "memo.md", kind: "file", district: "acme-litigation" },
        { ...base, id: "c", type: "github", url: "https://github.com/acme/secret-repo/pull/7", title: "acme/secret-repo#7", kind: "PR #7", district: "other-client" },
      ],
    });
    const text = JSON.stringify(r);
    for (const s of ["client-name", "Client deal", "acme", "memo", "secret-repo", "other-client", "/Users/x"]) expect(text).not.toContain(s);
    expect(r.items.map((i) => i.district)).toEqual(["district 1", "district 1", "district 2"]);
    expect(r.items.map((i) => i.kind)).toEqual(["link", "file", "PR #…"]);
  });
});
