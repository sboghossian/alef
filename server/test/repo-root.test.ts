// repo-root.ts findGitRoot: nearest ancestor holding `.git`, never walked inside a folder macOS
// privacy controls guard. Temp dirs fake the home; no real ~/Desktop or ~/Downloads is touched.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot } from "../repo-root.js";

describe("findGitRoot", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-repo-root-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds the nearest `.git` dir or file above a cwd", async () => {
    await mkdir(join(home, "code", "repo", ".git"), { recursive: true });
    await mkdir(join(home, "code", "repo", "src", "deep"), { recursive: true });
    await mkdir(join(home, "code", "wt", "app"), { recursive: true });
    await writeFile(join(home, "code", "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(findGitRoot(join(home, "code", "repo", "src", "deep"), home)).toBe(join(home, "code", "repo"));
    expect(findGitRoot(join(home, "code", "wt", "app"), home)).toBe(join(home, "code", "wt"));
  });

  it("returns null for a cwd in a guarded folder, even with a repo right there", async () => {
    for (const folder of ["Desktop", "Downloads", "Library"]) {
      await mkdir(join(home, folder, "repo", ".git"), { recursive: true });
      await mkdir(join(home, folder, "repo", "src"), { recursive: true });
      expect(findGitRoot(join(home, folder, "repo", "src"), home)).toBeNull();
      expect(findGitRoot(join(home, folder, "repo"), home)).toBeNull();
    }
  });
});
