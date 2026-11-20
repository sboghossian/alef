// FN-1: the Jev (TypeSafe) key at boot — the server's env first, then ~/.config/brain-server/.env
// parsed as plain KEY=VALUE (never evaluated), in a temp HOME. The value never reaches Health.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evalJevKey } from "../features/completeness-checks.js";
import { describeAttempts, loadTypesafeKeyAtBoot, parseEnvFile, resolveTypesafeKey, setJevKeyResolutionForTests } from "../jev-key.js";

const SECRET = "sk-test-not-a-real-key-123";

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines, strips one pair of quotes and `export`, skips comments and junk", () => {
    const m = parseEnvFile(['# comment', "", "export A=1", 'B="two words"', "C='three'", "D=four # trailing", "not a pair", "E=$(rm -rf ~)", "A=second"].join("\n"));
    expect(m.get("A")).toBe("1"); // the first one wins
    expect(m.get("B")).toBe("two words");
    expect(m.get("C")).toBe("three");
    expect(m.get("D")).toBe("four");
    expect(m.get("E")).toBe("$(rm -rf ~)"); // literal text, never evaluated
    expect(m.size).toBe(5);
  });
});

describe("resolveTypesafeKey / loadTypesafeKeyAtBoot (temp HOME)", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-jevkey-"));
  });
  afterEach(async () => {
    setJevKeyResolutionForTests(null);
    await rm(home, { recursive: true, force: true });
  });

  async function writeEnvFile(text: string): Promise<void> {
    await mkdir(join(home, ".config", "brain-server"), { recursive: true });
    await writeFile(join(home, ".config", "brain-server", ".env"), text, "utf8");
  }

  it("the process env wins and the file is never read", () => {
    let reads = 0;
    const r = resolveTypesafeKey({ env: { TYPESAFE_API_KEY: SECRET }, home, readFile: () => (reads++, "") });
    expect(r.key).toBe(SECRET);
    expect(r.resolution).toEqual({ source: "env", tried: [{ source: "env", label: "server env", outcome: "found" }] });
    expect(reads).toBe(0);
  });

  it("falls back to ~/.config/brain-server/.env and says so", async () => {
    await writeEnvFile(`OTHER=x\nTYPESAFE_API_KEY="${SECRET}"\n`);
    const env: NodeJS.ProcessEnv = {};
    const res = loadTypesafeKeyAtBoot(env, home);
    expect(env.TYPESAFE_API_KEY).toBe(SECRET);
    expect(res.source).toBe("brain-server-env");
    expect(describeAttempts(res.tried)).toBe("server env: not set; ~/.config/brain-server/.env: found");
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("no file, or a file without the key: nothing set, every source named", async () => {
    const env: NodeJS.ProcessEnv = {};
    expect(describeAttempts(loadTypesafeKeyAtBoot(env, home).tried)).toBe("server env: not set; ~/.config/brain-server/.env: no such file");
    await writeEnvFile("OTHER=x\nTYPESAFE_API_KEY=\n");
    const res = loadTypesafeKeyAtBoot(env, home);
    expect(res.source).toBeNull();
    expect(describeAttempts(res.tried)).toBe("server env: not set; ~/.config/brain-server/.env: no TYPESAFE_API_KEY line");
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });

  it("an unreadable file is reported as unreadable, not missing", async () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file anyway
    await writeEnvFile(`TYPESAFE_API_KEY=${SECRET}\n`);
    await chmod(join(home, ".config", "brain-server", ".env"), 0o000);
    const res = resolveTypesafeKey({ env: {}, home });
    expect(res.key).toBeNull();
    expect(res.resolution.tried.at(-1)?.outcome).toBe("unreadable");
  });
});

describe("evalJevKey: honest wording, says where it looked", () => {
  it("fails naming every source tried", () => {
    const out = evalJevKey({ hasKey: false, status: "disabled", lastTickAgoMs: null, keyFrom: null, tried: "server env: not set; ~/.config/brain-server/.env: no such file" });
    expect(out).toMatchObject({ state: "fail", detail: "TYPESAFE_API_KEY not set (looked in server env: not set; ~/.config/brain-server/.env: no such file)." });
  });
  it("passes naming the source that won", () => {
    const out = evalJevKey({ hasKey: true, status: "online", lastTickAgoMs: 1000, keyFrom: "~/.config/brain-server/.env", tried: "server env: not set; ~/.config/brain-server/.env: found" });
    expect(out.state).toBe("pass");
    expect(out.detail).toBe("Jev is online and ticking. Key from ~/.config/brain-server/.env.");
    expect(out.why).toBe("Looked in server env: not set; ~/.config/brain-server/.env: found.");
  });
  it("never says 'online' while not online", () => {
    expect(evalJevKey({ hasKey: true, status: "fallback", lastTickAgoMs: 1000 }).detail).toBe("status is fallback, not online.");
  });
});
