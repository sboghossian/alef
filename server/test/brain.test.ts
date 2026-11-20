import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainBacklinksResponse, BrainGraphResponse, BrainLegendResponse, BrainNoteResponse, BrainSearchResponse } from "../../shared/features/brain.js";
import { countAttachments, extractTags, LinkResolver, parseWikilinks, slimGraph, vaultLegend } from "../features/brain-lib.js";
import { createBrainFeature } from "../features/brain.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

describe("brain-lib", () => {
  it("parses wikilinks with aliases, headings and embeds", () => {
    expect(parseWikilinks("see [[a]] and [[b|B]] and [[c#h|x]] and ![[img.png]] [[ ]]")).toEqual(["a", "b", "c", "img.png"]);
  });
  it("resolves by exact path first, then shortest basename match", () => {
    const r = new LinkResolver(["x/deep/note.md", "note.md", "p/other.md"]);
    expect(r.resolve("note")).toBe("note.md");
    expect(r.resolve("x/deep/note")).toBe("x/deep/note.md");
    expect(r.resolve("Other")).toBe("p/other.md");
    expect(r.resolve("nope/other")).toBeNull();
  });
  it("slims the graph to top-degree nodes, keeps only internal edges, decodes entities", () => {
    const g = slimGraph(
      {
        nodes: [
          { i: 0, l: "a &quot;q&quot;", p: "30-Knowledge/a", f: "knowledge", d: 5, c: 1 },
          { i: 1, l: "b", p: "50-Wiki/b", f: "wiki", d: 9, c: 0 },
          { i: 2, l: "c", p: "root", f: "other", d: 1, c: 0 },
        ],
        edges: [
          [0, 1],
          [1, 2],
        ],
      },
      2,
      null,
    );
    expect(g.nodes.map((n) => n.id)).toEqual([1, 0]);
    expect(g.nodes[1]?.label).toBe('a "q"');
    expect(g.edges).toEqual([[0, 1]]);
    expect(g.groups).toEqual([
      { id: "50-Wiki", count: 1 },
      { id: "30-Knowledge", count: 1 },
    ]);
    expect(g.total).toEqual({ nodes: 3, edges: 2 });
  });

  it("vaultLegend counts every node/edge in the file, not a top-N slice", () => {
    const raw = {
      nodes: [
        { i: 0, p: "30-Knowledge/a", f: "knowledge", d: 1 },
        { i: 1, p: "30-Knowledge/b", f: "knowledge", d: 1 },
        { i: 2, p: "50-Wiki/c", f: "wiki", d: 0 },
        { i: 3, p: "root-note", f: "other", d: 0 },
      ],
      edges: [
        [0, 1],
        [1, 2],
      ],
    };
    const legend = vaultLegend(raw);
    expect(legend.totalNodes).toBe(4);
    expect(legend.totalLinks).toBe(2);
    expect(legend.folders).toEqual([
      { id: "30-Knowledge", count: 2 },
      { id: "50-Wiki", count: 1 },
      { id: "", count: 1 },
    ]);
    expect(legend.groups).toEqual([
      { id: "knowledge", count: 2 },
      { id: "wiki", count: 1 },
      { id: "other", count: 1 },
    ]);
  });

  it("vaultLegend degrades to zero counts on malformed input rather than throwing", () => {
    expect(vaultLegend(null)).toEqual({ totalNodes: 0, totalLinks: 0, folders: [], groups: [] });
    expect(vaultLegend({ nodes: "nope", edges: "nope" })).toEqual({ totalNodes: 0, totalLinks: 0, folders: [], groups: [] });
  });

  it("extractTags finds real inline #tags, skips frontmatter/code/pure-numeric", () => {
    const md = `---\ntags: [frontmatter-tag]\n---\n# Heading\nSee #growth and #project/foo, not #1 or #123.\n\`\`\`\n# not-a-tag in code\n\`\`\`\nInline \`#also-not-a-tag\` code.\n#Growth again (same tag, different case).`;
    expect(extractTags(md).sort()).toEqual(["growth", "project/foo"]);
  });
  it("extractTags: no tags is an empty array, not an error", () => {
    expect(extractTags("just plain text")).toEqual([]);
  });
});

describe("countAttachments", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await mkdir(dir, { recursive: true }).catch(() => {});
  });
  it("counts recognized attachment extensions, skips dot-dirs/dot-files, .md notes, and non-attachment files", async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-attach-"));
    await mkdir(join(dir, "30-Knowledge"), { recursive: true });
    await mkdir(join(dir, "60-Meta"), { recursive: true });
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    await writeFile(join(dir, "note.md"), "# note");
    await writeFile(join(dir, "30-Knowledge", "photo.png"), "x");
    await writeFile(join(dir, "30-Knowledge", "clip.mp3"), "x");
    await writeFile(join(dir, "60-Meta", "brain-graph.json"), "{}"); // vault infra, not an attachment
    await writeFile(join(dir, ".obsidian", "workspace.json"), "{}"); // skip-dir: not counted
    await writeFile(join(dir, ".DS_Store"), "x"); // dot-file: not counted
    expect(await countAttachments(dir)).toBe(2);
  });
});

describe("brain routes", () => {
  let server: RunningServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function setup(): Promise<{ base: string; feature: ReturnType<typeof createBrainFeature> }> {
    const scratch = await mkdtemp(join(tmpdir(), "aw-brain-"));
    const vault = join(scratch, "vault");
    await mkdir(join(vault, "50-Wiki"), { recursive: true });
    await mkdir(join(vault, "60-Meta"), { recursive: true });
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await mkdir(join(scratch, "outside"), { recursive: true });
    await writeFile(join(vault, "50-Wiki", "pricing.md"), "# Pricing\nOur pricing notes. Links to [[growth]] and [[missing]].\n");
    await writeFile(join(vault, "growth.md"), "# Growth\nSee [[pricing]] for the plan. token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n");
    await writeFile(join(vault, "hub.md"), "# Hub\n[[50-Wiki/pricing|Pricing]] [[growth#top]]\n");
    await writeFile(join(vault, ".obsidian", "workspace.md"), "[[pricing]]");
    await writeFile(join(vault, ".env.md"), "SECRET");
    await writeFile(join(scratch, "outside", "leak.md"), "private");
    await symlink(join(scratch, "outside", "leak.md"), join(vault, "leak.md"));
    await writeFile(
      join(vault, "60-Meta", "brain-graph.json"),
      JSON.stringify({ nodes: [{ i: 0, l: "pricing", p: "50-Wiki/pricing", f: "wiki", d: 3, c: 0 }, { i: 1, l: "growth", p: "growth", f: "other", d: 2, c: 0 }], edges: [[0, 1]] }),
    );
    const feature = createBrainFeature({ vaultRoot: vault, cacheDir: join(scratch, "data") });
    const b = await bootTestServer({ configOverrides: { features: [feature] } });
    server = b.server;
    return { base: b.base, feature };
  }
  const get = async <T>(base: string, path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };

  it("serves the slimmed graph", async () => {
    const { base } = await setup();
    const { status, body } = await get<BrainGraphResponse>(base, "/api/brain/graph?limit=10");
    expect(status).toBe(200);
    expect(body.nodes.map((n) => n.label)).toEqual(["pricing", "growth"]);
    expect(body.edges).toEqual([[0, 1]]);
  });

  it("serves the vault-wide legend: folders/types/links from the file, tags from the index, real attachment count", async () => {
    const { base, feature } = await setup();
    const first = await get<BrainLegendResponse>(base, "/api/brain/legend");
    expect(first.status).toBe(200);
    expect(first.body.totalNodes).toBe(2);
    expect(first.body.totalLinks).toBe(1);
    expect(first.body.folders.find((f) => f.id === "50-Wiki")).toEqual({ id: "50-Wiki", count: 1 });
    expect(first.body.groups.find((g) => g.id === "wiki")).toEqual({ id: "wiki", count: 1 });
    expect(first.body.attachments).toBe(0); // the fixture vault has only .md files
    await feature.whenIndexed();
    const second = await get<BrainLegendResponse>(base, "/api/brain/legend");
    expect(second.body.tagsReady).toBe(true);
  });

  it("serves a note with secrets redacted, then backlinks + outlinks once indexed", async () => {
    const { base, feature } = await setup();
    const first = await get<BrainNoteResponse>(base, "/api/brain/note?path=growth");
    expect(first.status).toBe(200);
    expect(first.body.markdown).not.toContain("sk-ant-api03");
    expect(first.body.title).toBe("Growth");
    await feature.whenIndexed();
    const note = await get<BrainNoteResponse>(base, "/api/brain/note?path=50-Wiki/pricing.md");
    expect(note.body.outlinks.map((l) => l.path)).toEqual(["growth.md"]);
    expect(note.body.backlinks?.map((l) => l.path).sort()).toEqual(["growth.md", "hub.md"]);
    const bl = await get<BrainBacklinksResponse>(base, "/api/brain/backlinks?path=growth.md");
    expect(bl.body).toMatchObject({ ready: true });
    expect(bl.body.backlinks.map((l) => l.path).sort()).toEqual(["50-Wiki/pricing.md", "hub.md"]);
  });

  it("searches the vault with BM25 (dot dirs excluded)", async () => {
    const { base, feature } = await setup();
    await get(base, "/api/brain/search?q=pricing");
    await feature.whenIndexed();
    const { body } = await get<BrainSearchResponse>(base, "/api/brain/search?q=pricing%20plan");
    expect(body.ready).toBe(true);
    expect(body.indexed).toBe(3);
    expect(body.hits.map((h) => h.path)).toContain("50-Wiki/pricing.md");
    expect(body.hits.some((h) => h.path.startsWith(".obsidian"))).toBe(false);
    expect((await get(base, "/api/brain/search?q=")).status).toBe(400);
  });

  it("keeps note reads inside the vault (traversal, absolute, symlink, secrets)", async () => {
    const { base } = await setup();
    expect((await get(base, "/api/brain/note?path=../outside/leak.md")).status).toBe(403);
    expect((await get(base, `/api/brain/note?path=${encodeURIComponent("/etc/passwd")}`)).status).toBe(400);
    expect((await get(base, "/api/brain/note?path=leak.md")).status).toBe(403);
    expect((await get(base, "/api/brain/note?path=.env.md")).status).toBe(403);
    expect((await get(base, "/api/brain/note?path=nope.md")).status).toBe(404);
  });
});
