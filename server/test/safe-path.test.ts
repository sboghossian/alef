import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isSecretPath, readTextCapped, resolveInside } from "../features/safe-path.js";

let root = "";
let outside = "";

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "aw-safepath-"));
  root = join(base, "repo");
  outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(outside, "secret.txt"), "nope");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  await symlink(outside, join(root, "escape-dir"));
  await symlink(join(root, "src", "a.ts"), join(root, "inner-link.ts"));
  await writeFile(join(root, ".env.local"), "TOKEN=x");
  await writeFile(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
});

describe("resolveInside", () => {
  it("resolves a normal relative path", async () => {
    const r = await resolveInside(root, "src/a.ts");
    expect(r.ok && r.rel).toBe("src/a.ts");
  });
  it("rejects ../ traversal", async () => {
    expect(await resolveInside(root, "../outside/secret.txt")).toEqual({ ok: false, error: "outside-root" });
    expect(await resolveInside(root, "src/../../outside/secret.txt")).toEqual({ ok: false, error: "outside-root" });
  });
  it("rejects absolute paths unless explicitly allowed, and even then only inside", async () => {
    expect(await resolveInside(root, join(outside, "secret.txt"))).toEqual({ ok: false, error: "bad-path" });
    expect(await resolveInside(root, "/etc/passwd")).toEqual({ ok: false, error: "bad-path" });
    expect(await resolveInside(root, "~/x")).toEqual({ ok: false, error: "bad-path" });
    expect(await resolveInside(root, join(outside, "secret.txt"), { allowAbsolute: true })).toEqual({ ok: false, error: "outside-root" });
    const ok = await resolveInside(root, join(root, "src", "a.ts"), { allowAbsolute: true });
    expect(ok.ok).toBe(true);
  });
  it("rejects symlink escapes (file and directory) but allows links that stay inside", async () => {
    expect(await resolveInside(root, "escape.txt")).toEqual({ ok: false, error: "outside-root" });
    expect(await resolveInside(root, "escape-dir/secret.txt")).toEqual({ ok: false, error: "outside-root" });
    const inner = await resolveInside(root, "inner-link.ts");
    expect(inner.ok && inner.rel).toBe("src/a.ts");
  });
  it("rejects NUL bytes and refuses secret files", async () => {
    expect(await resolveInside(root, "src/a.ts\0.png")).toEqual({ ok: false, error: "bad-path" });
    expect(await resolveInside(root, ".env.local")).toEqual({ ok: false, error: "secret" });
  });
});

describe("isSecretPath", () => {
  it("matches the refused families", () => {
    for (const p of [".env", ".env.production", "config/.env.local", "certs/server.pem", "id_rsa", "id_ed25519.pub", "keys/app.key", ".ssh/config", "a/.git/config", ".aws/credentials", "store.p12",
      ".git-credentials", ".config/gh/hosts.yml", ".docker/config.json", ".kube/config", ".claude.json", "home/.Kube/Config"]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of ["src/env.ts", "README.md", "keyboard.ts", "docs/identity.md", "environment.md", "ansible/hosts.yml", "config.json", "k8s/config", ".claude/settings.json"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});

describe("readTextCapped", () => {
  it("refuses binaries and oversized files", async () => {
    expect(await readTextCapped(join(root, "bin.dat"), 1024)).toMatchObject({ ok: false, status: 415 });
    expect(await readTextCapped(join(root, "src", "a.ts"), 4)).toMatchObject({ ok: false, status: 413 });
    expect(await readTextCapped(join(root, "src", "a.ts"), 1024)).toMatchObject({ ok: true, text: "export const a = 1;\n" });
  });
});
