import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSlug, codeKey, FALLBACK_ALIASES, frontmatterOf, matchProjectNote, noteFromText, parseCanonicalAliases, repoKey, type VaultProjectNote } from "../features/project-match-lib.js";
import { taxonomyAliases, vaultProjectNotes } from "../features/projects-scan.js";

const HOME = "/Users/alexboghossian";
const note = (slug: string, o: Partial<VaultProjectNote> = {}): VaultProjectNote => ({ slug, codePath: null, github: null, ...o });
const target = (name: string, o: { remotes?: string[]; path?: string; foldedPaths?: string[] } = {}) => ({ name, path: o.path ?? `${HOME}/Documents/Code/${name}`, remotes: o.remotes ?? [], foldedPaths: o.foldedPaths });

describe("frontmatter and keys", () => {
  it("reads top-level scalars, strips quotes, skips lists and the body", () => {
    const fm = frontmatterOf('---\ntype: project\ntitle: "AI Growth OS"\ngithub: https://github.com/sboghossian/ai-growth-os\ngpt_url: \ntags:\n  - project\n---\ncode_path: /not/frontmatter\n');
    expect(fm).toEqual({ type: "project", title: "AI Growth OS", github: "https://github.com/sboghossian/ai-growth-os" });
    expect(frontmatterOf("no frontmatter\ncode_path: x")).toEqual({});
    expect(noteFromText("x", "---\ncode_path: ~/Documents/Code/x/\n---\n")).toEqual({ slug: "x", codePath: "~/Documents/Code/x/", github: null });
  });

  it("compares paths from Documents/Code on, so the other Mac's home folder still matches", () => {
    expect(codeKey("/Users/alexmacmini/Documents/Code/Go-Or-NoGo", HOME)).toBe("go-or-nogo");
    expect(codeKey("~/Documents/Code/acme-leadgen/", HOME)).toBe("acme-leadgen");
    expect(codeKey("~/elsewhere/x", HOME)).toBe(`${HOME}/elsewhere/x`.toLowerCase());
    expect(codeKey("  ", HOME)).toBeNull();
  });

  it("reads a repo from a URL, an ssh remote or owner/repo", () => {
    expect(repoKey("https://github.com/sboghossian/WAN")).toBe("sboghossian/wan");
    expect(repoKey("git@github.com:a/b.git")).toBe("a/b");
    expect(repoKey("a/b")).toBe("a/b");
    expect(repoKey("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("brain_taxonomy aliases", () => {
  it("parses CANONICAL out of the Python source, and nothing else", () => {
    const py = 'X = {\n "no": "pe",\n}\nCANONICAL = {\n    "acme-ai": "acme",\n    \'bandidos\': "acme-sovereign",  # comment\n}\n\nNOT_A_PROJECT = {"a"}\n';
    expect(parseCanonicalAliases(py)).toEqual(new Map([["acme-ai", "acme"], ["bandidos", "acme-sovereign"]]));
    expect(parseCanonicalAliases("nothing here")).toBeNull();
  });

  it("canonicalSlug mirrors canonical(): worktrees, hyphenation, then the table", () => {
    expect(canonicalSlug("acme-wt-pricing", FALLBACK_ALIASES)).toBe("acme-ai-next");
    expect(canonicalSlug("Alex_Brain", FALLBACK_ALIASES)).toBe("alex-claude-brain");
    expect(canonicalSlug("agent world", FALLBACK_ALIASES)).toBe("agent-world");
  });
});

describe("matchProjectNote: code_path, then github, then alias, then name", () => {
  const aliases = FALLBACK_ALIASES;

  it("code_path wins over a note that only shares the folder name", () => {
    const notes = [note("wan"), note("wan-research", { codePath: "/Users/alexmacmini/Documents/Code/wan" })];
    expect(matchProjectNote(target("wan"), notes, aliases, HOME)).toEqual({ slug: "wan-research", by: "code_path" });
  });

  it("a folded worktree's path counts as the project's", () => {
    const notes = [note("site", { codePath: "~/Documents/Code/site-wt" })];
    expect(matchProjectNote(target("site-main", { foldedPaths: [`${HOME}/Documents/Code/site-wt`] }), notes, aliases, HOME)).toEqual({ slug: "site", by: "code_path" });
  });

  it("github matches the project's remote or a folded clone's", () => {
    const notes = [note("mail", { github: "https://github.com/sboghossian/vibemind-mail" })];
    expect(matchProjectNote(target("vm", { remotes: ["sboghossian/VibeMind-Mail"] }), notes, aliases, HOME)).toEqual({ slug: "mail", by: "github" });
    expect(matchProjectNote(target("vm", { remotes: [] }), notes, aliases, HOME)).toBeNull();
  });

  it("an alias files the folder under the taxonomy's slug before the bare name", () => {
    const notes = [note("alex-brain"), note("alex-claude-brain")];
    expect(matchProjectNote(target("alex-brain"), notes, aliases, HOME)).toEqual({ slug: "alex-claude-brain", by: "alias" });
    expect(matchProjectNote(target("acme-ai"), [note("acme")], aliases, HOME)).toEqual({ slug: "acme", by: "alias" });
  });

  it("falls back to the folder name, ignoring case and separators", () => {
    expect(matchProjectNote(target("agent_world"), [note("Agent-World"), note("other")], aliases, HOME)).toEqual({ slug: "Agent-World", by: "name" });
    expect(matchProjectNote(target("nothing"), [note("a")], aliases, HOME)).toBeNull();
    expect(matchProjectNote(target("___"), [note("a")], aliases, HOME)).toBeNull();
  });
});

describe("vault readers", () => {
  it("lists every 20-Projects slug with its frontmatter, and rereads only a changed index", async () => {
    const vault = await realpath(await mkdtemp(join(tmpdir(), "match-vault-")));
    const dir = join(vault, "20-Projects");
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await mkdir(join(dir, ".hidden"), { recursive: true });
    const idx = join(dir, "a", "_index.md");
    await writeFile(idx, "---\ncode_path: ~/Documents/Code/alpha\n---\n");
    const first = await vaultProjectNotes(dir);
    expect(first.sort((x, y) => x.slug.localeCompare(y.slug))).toEqual([note("a", { codePath: "~/Documents/Code/alpha" }), note("b")]);
    await writeFile(idx, "---\ngithub: a/b\n---\n");
    await utimes(idx, new Date(), new Date(Date.now() + 5_000));
    expect((await vaultProjectNotes(dir)).find((n) => n.slug === "a")).toEqual(note("a", { github: "a/b" }));
    expect(await vaultProjectNotes(join(vault, "missing"))).toEqual([]);
  });

  it("reads the aliases from the vault's brain_taxonomy.py, else the built-in copy", async () => {
    const vault = await realpath(await mkdtemp(join(tmpdir(), "match-tax-")));
    expect(await taxonomyAliases(vault)).toBe(FALLBACK_ALIASES);
    await mkdir(join(vault, "60-Meta", "scripts"), { recursive: true });
    await writeFile(join(vault, "60-Meta", "scripts", "brain_taxonomy.py"), 'CANONICAL = {\n    "old": "new",\n}\n');
    expect(await taxonomyAliases(vault)).toEqual(new Map([["old", "new"]]));
  });
});
