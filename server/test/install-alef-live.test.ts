// scripts/install-alef-live.sh against a FAKE $HOME: it refuses while the live checkout has no
// scripts/alef-live (so it never installs a dangling link), keeps an existing hand-edited alef-live as a
// backup, links ~/.alef-loop/bin/alef-live into ~/.alef-live, and is idempotent. The real ~/.alef-loop
// and ~/.alef-live are never involved.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/install-alef-live.sh", import.meta.url));
const ALEF_LIVE = fileURLToPath(new URL("../../scripts/alef-live", import.meta.url));

function run(file: string, args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", [file, ...args], { env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

describe("install-alef-live.sh", () => {
  let home: string;
  const src = () => join(home, ".alef-live/scripts/alef-live");
  const dest = () => join(home, ".alef-loop/bin/alef-live");

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "install-alef-live-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("refuses while the live checkout has no scripts/alef-live", async () => {
    const r = await run(SCRIPT, [], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("alef-live deploy");
    await expect(readdir(join(home, ".alef-loop/bin"))).rejects.toThrow();
  });

  it("keeps the hand-edited file as a backup and links into the live checkout", async () => {
    await mkdir(join(home, ".alef-live/scripts"), { recursive: true });
    await writeFile(src(), "repo\n");
    await mkdir(join(home, ".alef-loop/bin"), { recursive: true });
    await writeFile(dest(), "hand-edited\n");

    const r = await run(SCRIPT, [], home);
    expect(r.code).toBe(0);
    expect(await readlink(dest())).toBe(src());
    const backups = (await readdir(join(home, ".alef-loop/bin"))).filter((n) => n.startsWith("alef-live.pre-repo-"));
    expect(backups).toHaveLength(1);
    const [backup = ""] = backups;
    expect(await readFile(join(home, ".alef-loop/bin", backup), "utf8")).toBe("hand-edited\n");
    expect(r.stderr).toContain("differs from the repo copy");
  });

  it("is idempotent", async () => {
    await mkdir(join(home, ".alef-live/scripts"), { recursive: true });
    await writeFile(src(), "repo\n");
    expect((await run(SCRIPT, [], home)).code).toBe(0);
    const again = await run(SCRIPT, [], home);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already linked");
    expect(await readdir(join(home, ".alef-loop/bin"))).toEqual(["alef-live"]);
  });
});

describe("scripts/alef-live", () => {
  it("rejects an unknown command with usage and exit 2, touching nothing outside the fake HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "alef-live-"));
    try {
      const r = await run(ALEF_LIVE, ["bogus"], home);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("usage: alef-live");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
