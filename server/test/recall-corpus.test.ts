import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanMarkdown, titleOf, walkCorpus, type CorpusRoots } from "../features/recall/corpus.js";

async function makeRoots(): Promise<{ dir: string; roots: CorpusRoots }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-world-recall-"));
  const memoryDir = join(dir, "memory");
  const vaultProjectsDir = join(dir, "20-Projects");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(vaultProjectsDir, { recursive: true });
  return { dir, roots: { memoryDir, vaultProjectsDir, brainGraphPath: join(dir, "brain-graph.json") } };
}

describe("cleanMarkdown", () => {
  it("strips frontmatter, the Smart Connections footer, and wiki-link syntax", () => {
    const raw = `---\nname: x\n---\nHello [[some note|alias]] and [[Other Note]].\n\n---\n## Smart Connections\n**Related:** stuff`;
    const clean = cleanMarkdown(raw);
    expect(clean).toContain("Hello some note and Other Note");
    expect(clean).not.toContain("Smart Connections");
    expect(clean).not.toContain("[[");
  });
});

describe("titleOf", () => {
  it("prefers frontmatter name/title", () => {
    expect(titleOf("x.md", '---\nname: "My Title"\n---\nbody')).toBe("My Title");
  });
  it("falls back to the first real heading", () => {
    expect(titleOf("x.md", "# A Heading\nbody text")).toBe("A Heading");
  });
  it("falls back to a cleaned-up filename", () => {
    expect(titleOf("2026-01-01-my-note.md", "")).toBe("my note");
  });
});

describe("walkCorpus", () => {
  it("reads top-level memory *.md and vault */_index.md, redacts secrets, and skips non-.md/oversized files", async () => {
    const { roots } = await makeRoots();
    // A mixed-case+digit token with no markdown-punctuation characters, so cleanMarkdown's
    // char-stripping doesn't mangle it before redactSecrets gets a chance to run on it.
    const secretToken = "AbCdEfGhIjKlMnOpQrStUvWxYz123456";
    await writeFile(join(roots.memoryDir, "feedback_x.md"), `# A memory note\nContains a token ${secretToken} in the body.`);
    await writeFile(join(roots.memoryDir, "not-markdown.txt"), "should be ignored");
    await mkdir(join(roots.memoryDir, "_L2"), { recursive: true });
    await writeFile(join(roots.memoryDir, "_L2", "nested.md"), "should not be walked (top-level only)");

    const projectDir = join(roots.vaultProjectsDir, "agent-world");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "_index.md"), "# agent-world project\nA living 3D world of Claude Code sessions.");

    const docs = await walkCorpus(roots);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain(join(roots.memoryDir, "feedback_x.md"));
    expect(paths).toContain(join(projectDir, "_index.md"));
    expect(paths).not.toContain(join(roots.memoryDir, "not-markdown.txt"));
    expect(paths).not.toContain(join(roots.memoryDir, "_L2", "nested.md"));

    const note = docs.find((d) => d.path.endsWith("feedback_x.md"));
    expect(note?.snippet).not.toContain(secretToken);
    expect(note?.snippet).toContain("[redacted]");
    expect(note?.snippet.length).toBeLessThanOrEqual(160);
  });

  it("reads brain-graph.json titles, ranked by degree, capped, and never crashes on a missing file", async () => {
    const { dir, roots } = await makeRoots();
    const nodes = Array.from({ length: 5 }, (_, i) => ({ i, l: `node ${i}`, d: i, p: `path/${i}` }));
    await writeFile(roots.brainGraphPath, JSON.stringify({ nodes }));

    const docs = await walkCorpus(roots);
    const brainDocs = docs.filter((d) => d.path.startsWith("brain-graph:"));
    expect(brainDocs).toHaveLength(5);
    expect(brainDocs[0]?.title).toBe("node 4"); // highest degree first

    // Missing brain-graph.json (real-world default when the vault isn't present) degrades to [].
    const noGraphRoots: CorpusRoots = { ...roots, brainGraphPath: join(dir, "does-not-exist.json") };
    expect(await walkCorpus(noGraphRoots)).toEqual([]);
  });

  it("degrades to an empty corpus when both directories are missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-world-recall-empty-"));
    const roots: CorpusRoots = {
      memoryDir: join(dir, "nope-memory"),
      vaultProjectsDir: join(dir, "nope-vault"),
      brainGraphPath: join(dir, "nope.json"),
    };
    expect(await walkCorpus(roots)).toEqual([]);
  });
});
