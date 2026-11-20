import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivedMemoryDir, memoryDir, vaultRoot } from "../config.js";
import { defaultCorpusRoots } from "../features/recall/corpus.js";
import { vaultFeedDir } from "../features/vault-feed.js";

describe("vaultRoot", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.ALEF_VAULT_DIR;
    delete process.env.ALEF_VAULT_DIR;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.ALEF_VAULT_DIR;
    else process.env.ALEF_VAULT_DIR = before;
  });

  it("defaults to ~/Documents/Code/alex_claude", () => {
    expect(vaultRoot("/Users/s")).toBe("/Users/s/Documents/Code/alex_claude");
  });

  it("honours $ALEF_VAULT_DIR, and every reader follows it", () => {
    process.env.ALEF_VAULT_DIR = "/v";
    expect(vaultRoot("/Users/s")).toBe("/v");
    expect(vaultFeedDir()).toBe(join("/v", "60-Meta", "graph-feed"));
    const roots = defaultCorpusRoots();
    expect(roots.vaultProjectsDir).toBe(join("/v", "20-Projects"));
    expect(roots.brainGraphPath).toBe(join("/v", "60-Meta", "brain-graph.json"));
  });

  it("ignores an empty $ALEF_VAULT_DIR", () => {
    process.env.ALEF_VAULT_DIR = "";
    expect(vaultRoot("/Users/s")).toBe("/Users/s/Documents/Code/alex_claude");
  });

  it("reads working memory from the vault copy, falling back to the derived ~/.claude path", async () => {
    const vault = await mkdtemp(join(tmpdir(), "alef-config-"));
    process.env.ALEF_VAULT_DIR = vault;
    expect(memoryDir("/Users/s")).toBe(derivedMemoryDir("/Users/s"));
    expect(derivedMemoryDir("/Users/s")).toBe("/Users/s/.claude/projects/-Users-s/memory");
    const canonical = join(vault, "60-Meta", "claude-config", "memory");
    await mkdir(canonical, { recursive: true });
    expect(memoryDir("/Users/s")).toBe(canonical);
    expect(defaultCorpusRoots().memoryDir).toBe(canonical);
  });
});
