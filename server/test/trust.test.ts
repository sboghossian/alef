// folderTrust reads a temp ~/.claude.json fixture, never the real one, and must never write it.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderTrust } from "../trust.js";

describe("folderTrust", () => {
  let dir = "";
  let claudeJson = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aw-trust-"));
    claudeJson = join(dir, ".claude.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fixture(projects: Record<string, unknown>): Promise<void> {
    await writeFile(claudeJson, JSON.stringify({ numStartups: 3, projects }), "utf8");
  }

  it("is trusted when the exact cwd has accepted the dialog", async () => {
    await fixture({ "/Users/s/Documents/Code/agent-world": { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, "/Users/s/Documents/Code/agent-world")).toBe("trusted");
  });

  async function dirs(...paths: string[]): Promise<void> {
    for (const p of paths) await mkdir(join(dir, p), { recursive: true });
  }

  it("outside a git repo, any trusted ancestor trusts it (Claude Code skips the dialog there)", async () => {
    await dirs("Documents/plain/sub");
    await fixture({ [join(dir, "Documents")]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, join(dir, "Documents/plain"))).toBe("trusted");
    expect(await folderTrust(claudeJson, join(dir, "Documents/plain/sub"))).toBe("trusted");
  });

  // The shape on this machine on 2026-09-28: ~/Documents accepted, acme-www a git repo under it with
  // its own entry false. Claude Code 2.1.283 stops its walk at the git root, so it asks.
  it("inside a git repo, a trusted folder above the repo root does not count", async () => {
    await dirs("Documents/Code/acme-www/.git", "Documents/Code/acme-www/app");
    await fixture({
      [join(dir, "Documents")]: { hasTrustDialogAccepted: true },
      [join(dir, "Documents/Code/acme-www")]: { hasTrustDialogAccepted: false },
    });
    expect(await folderTrust(claudeJson, join(dir, "Documents/Code/acme-www"))).toBe("untrusted");
    expect(await folderTrust(claudeJson, join(dir, "Documents/Code/acme-www/app"))).toBe("untrusted");
  });

  it("inside a git repo, trust on the repo root or a folder below it counts", async () => {
    await dirs("repo/.git", "repo/a/deep", "repo/b");
    await fixture({ [join(dir, "repo")]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, join(dir, "repo/a/deep"))).toBe("trusted");
    await fixture({ [join(dir, "repo/a")]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, join(dir, "repo/a/deep"))).toBe("trusted");
    expect(await folderTrust(claudeJson, join(dir, "repo/b"))).toBe("untrusted");
  });

  it("a .git file (a worktree or submodule) also marks the repo root", async () => {
    await dirs("Documents/wt/src");
    await writeFile(join(dir, "Documents/wt/.git"), "gitdir: /elsewhere/.git/worktrees/wt\n", "utf8");
    await fixture({ [join(dir, "Documents")]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, join(dir, "Documents/wt/src"))).toBe("untrusted");
  });

  function git(cwd: string, ...args: string[]): void {
    const cfg = ["core.hooksPath=/dev/null", "user.name=t", "user.email=t@t", "init.defaultBranch=main", "commit.gpgsign=false"];
    execFileSync("git", [...cfg.flatMap((c) => ["-c", c]), "-C", cwd, ...args], { stdio: "pipe" });
  }

  /** A real main checkout with one commit. Paths are realpaths (macOS tmp is /private/var), since
   *  git records realpaths in a worktree's `.git` file and that is the key Claude Code looks up. */
  async function mainRepo(): Promise<{ root: string; main: string }> {
    const root = await realpath(dir);
    const main = join(root, "Documents/Code/acme-ai-next");
    await mkdir(main, { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    return { root, main };
  }

  // The shape on this machine on 2026-09-28: acme-www is a `git worktree add` of acme-ai-next, which
  // is trusted, and has no entry of its own. Claude Code 2.1.283's iN also accepts the canonical
  // root's entry (MTe -> Lo -> Le/Qt), which for a linked worktree is the main checkout: no dialog.
  it("a linked worktree of a trusted main checkout is trusted, beside it or inside it", async () => {
    const { root, main } = await mainRepo();
    const www = join(root, "Documents/Code/acme-www");
    git(main, "worktree", "add", "-q", www);
    git(main, "worktree", "add", "-q", join(main, ".claude/worktrees/feat"));
    await mkdir(join(www, "app"));
    await fixture({
      [join(root, "Documents")]: { hasTrustDialogAccepted: true },
      [join(root, "Documents/Code")]: { hasTrustDialogAccepted: false },
      [main]: { hasTrustDialogAccepted: true },
    });
    expect(await folderTrust(claudeJson, www)).toBe("trusted");
    expect(await folderTrust(claudeJson, join(www, "app"))).toBe("trusted");
    expect(await folderTrust(claudeJson, join(main, ".claude/worktrees/feat"))).toBe("trusted");
  });

  it("a worktree is untrusted when only a folder above its main checkout is trusted", async () => {
    const { root, main } = await mainRepo();
    const www = join(root, "Documents/Code/acme-www");
    git(main, "worktree", "add", "-q", www);
    await fixture({ [join(root, "Documents")]: { hasTrustDialogAccepted: true }, [main]: { hasTrustDialogAccepted: false } });
    expect(await folderTrust(claudeJson, www)).toBe("untrusted");
  });

  // Claude Code only maps a worktree to its main checkout when the gitdir's back-reference points at
  // this `.git`. A worktree moved without `git worktree repair` fails that, so only its own walk counts.
  it("a moved worktree whose gitdir no longer points back does not borrow the main checkout's trust", async () => {
    const { root, main } = await mainRepo();
    git(main, "worktree", "add", "-q", join(root, "wt"));
    await rename(join(root, "wt"), join(root, "moved"));
    await fixture({ [main]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, join(root, "moved"))).toBe("untrusted");
  });

  // A district under ~/Downloads (a folder macOS privacy controls guard, privacy-guard.ts): its
  // `.git` is stat'ed but never opened, so the folder is its own checkout. `root` is the fake home.
  it("in a guarded folder, a worktree is its own checkout: listed and trustable, its .git never read", async () => {
    const { root, main } = await mainRepo();
    const downloads = join(root, "Downloads");
    const wt = join(downloads, "wt");
    await mkdir(downloads);
    git(main, "worktree", "add", "-q", wt);
    await fixture({ [main]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, wt, "/nonexistent-home")).toBe("trusted"); // control: unguarded, it borrows main's trust
    expect(await folderTrust(claudeJson, wt, root)).toBe("untrusted");
    expect(await folderTrust(claudeJson, downloads, root)).toBe("untrusted");
    await fixture({ [main]: { hasTrustDialogAccepted: true }, [wt]: { hasTrustDialogAccepted: true }, [downloads]: { hasTrustDialogAccepted: true } });
    expect(await folderTrust(claudeJson, wt, root)).toBe("trusted");
    expect(await folderTrust(claudeJson, downloads, root)).toBe("trusted");
  });

  // These paths don't exist, so there is no git root and the walk goes all the way to /.
  it("is untrusted when neither the cwd nor any ancestor has accepted it", async () => {
    await fixture({
      "/Users/s": { hasTrustDialogAccepted: false },
      "/Users/s/Documents/Code/agent-world": { allowedTools: [] },
      "/Users/s/Documents/Code/other": { hasTrustDialogAccepted: true },
    });
    expect(await folderTrust(claudeJson, "/Users/s/Documents/Code/agent-world")).toBe("untrusted");
    expect(await folderTrust(claudeJson, "/Users/s/Documents/Code/acme-www")).toBe("untrusted");
  });

  it("treats a truthy non-true value as not accepted", async () => {
    await fixture({ "/Users/s/p": { hasTrustDialogAccepted: "true" } });
    expect(await folderTrust(claudeJson, "/Users/s/p")).toBe("untrusted");
  });

  it("is untrusted when the file parses but has no projects map", async () => {
    await writeFile(claudeJson, JSON.stringify({ numStartups: 1 }), "utf8");
    expect(await folderTrust(claudeJson, "/Users/s/p")).toBe("untrusted");
  });

  it("is unknown when the file is missing", async () => {
    expect(await folderTrust(join(dir, "nope.json"), "/Users/s/p")).toBe("unknown");
  });

  it("is unknown when the file is malformed or not a JSON object", async () => {
    await writeFile(claudeJson, '{"projects": {"/Users/s/p": {"hasTrustDialogAccepted": tr', "utf8");
    expect(await folderTrust(claudeJson, "/Users/s/p")).toBe("unknown");
    await writeFile(claudeJson, "[1,2,3]", "utf8");
    expect(await folderTrust(claudeJson, "/Users/s/p")).toBe("unknown");
  });

  it("never reads inherited keys as project entries", async () => {
    await fixture({});
    expect(await folderTrust(claudeJson, "constructor")).toBe("untrusted");
  });

  it("never writes the file", async () => {
    await fixture({ "/Users/s/p": { hasTrustDialogAccepted: true } });
    const before = await stat(claudeJson);
    const content = await readFile(claudeJson, "utf8");
    await new Promise((r) => setTimeout(r, 20));
    for (const cwd of ["/Users/s/p", "/Users/s/q", "/Users/s/p/child"]) await folderTrust(claudeJson, cwd);
    const after = await stat(claudeJson);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await readFile(claudeJson, "utf8")).toBe(content);
  });
});
