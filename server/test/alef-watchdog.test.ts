// scripts/alef-watchdog.sh against a FAKE $HOME (a stub alef-live that only records its call) and a
// throwaway port: it starts nothing while the API answers 200, starts alef-live when the port is
// down and free, never touches a port something listens on, and always exits 0. The real
// ~/.alef-loop, :5179 and launchd are never involved.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/alef-watchdog.sh", import.meta.url));
const PLIST = fileURLToPath(new URL("../../hooks/launchd/com.stephane.alef-watchdog.plist.example", import.meta.url));

/** A top-level boolean key of the plist example ("true"/"false"), or null when absent or unparsable.
 *  plutil on macOS; elsewhere (CI on Linux has no plutil) the XML is read directly. */
function plistValue(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", PLIST], async (err, stdout) => {
      if (!err) return resolve(stdout.trim());
      const xml = await readFile(PLIST, "utf8").catch(() => "");
      const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(xml);
      resolve(m?.[1] ?? null);
    });
  });
}

function pgidOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "pgid=", "-p", String(pid)], (err, stdout) => resolve(err ? null : Number(stdout.trim())));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(home: string, port: number): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", [SCRIPT], { env: { HOME: home, ALEF_WATCHDOG_PORT: String(port) }, timeout: 30_000 }, (err) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0 });
    });
  });
}

function listen(status: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function freePort(): Promise<number> {
  const { server, port } = await listen(200);
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("scripts/alef-watchdog.sh (fake $HOME, throwaway port)", () => {
  let home = "";
  let server: Server | null = null;
  let spawnedPid = 0;
  const log = (): string => join(home, "Library", "Logs", "alef", "watchdog.log");
  const called = (): string => join(home, "alef-live-called.txt");

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-watchdog-"));
    await mkdir(join(home, ".alef-loop", "bin"), { recursive: true });
    const stub = join(home, ".alef-loop", "bin", "alef-live");
    await writeFile(stub, `#!/bin/bash\necho "$@" >> "$HOME/alef-live-called.txt"\nexit 0\n`, "utf8");
    await chmod(stub, 0o755);
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    if (spawnedPid && isAlive(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
    spawnedPid = 0;
    await rm(home, { recursive: true, force: true });
  });

  it("API answers 200: does nothing, logs nothing, exits 0", async () => {
    const up = await listen(200);
    server = up.server;
    expect(await run(home, up.port)).toEqual({ code: 0 });
    await expect(readFile(called(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(log(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("down and nothing listening: runs alef-live start once and logs one line", async () => {
    const port = await freePort();
    expect(await run(home, port)).toEqual({ code: 0 });
    expect(await readFile(called(), "utf8")).toBe("start\n");
    const lines = (await readFile(log(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ api=000, :${port} free: ran alef-live start \\(exit 0\\), api now 000$`));
  });

  it("not 200 but something listens: starts nothing, kills nothing, logs why", async () => {
    const sick = await listen(500);
    server = sick.server;
    expect(await run(home, sick.port)).toEqual({ code: 0 });
    await expect(readFile(called(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(log(), "utf8")).toContain(`api=500: :${sick.port} is listening, so not starting anything`);
    // The listener is still up: nothing was killed.
    expect((await fetch(`http://127.0.0.1:${sick.port}/api/health`)).status).toBe(500);
  });

  it("alef-live missing: logs it and still exits 0", async () => {
    await rm(join(home, ".alef-loop"), { recursive: true, force: true });
    expect(await run(home, await freePort())).toEqual({ code: 0 });
    expect(await readFile(log(), "utf8")).toContain("is missing or not executable, nothing started");
  });

  it("the server alef-live starts outlives the job: the plist turns off launchd's process-group kill", async () => {
    // The stub backgrounds a "server" with the real alef-live's spawn line: (cd … && nohup … & echo $! > pid).
    const stub = join(home, ".alef-loop", "bin", "alef-live");
    await writeFile(stub, `#!/bin/bash\n(cd "$HOME" && nohup /bin/sleep 120 </dev/null >/dev/null 2>&1 & echo $! >"$HOME/server.pid")\nexit 0\n`, "utf8");
    // launchd starts a job as its own process group leader; detached (setsid) does the same here.
    const job = spawn("/bin/bash", [SCRIPT], {
      env: { HOME: home, ALEF_WATCHDOG_PORT: String(await freePort()) },
      detached: true,
      stdio: "ignore",
    });
    const jobPgid = job.pid ?? 0;
    expect(jobPgid).toBeGreaterThan(0); // kill(-0) would hit the test runner's own group
    expect(await new Promise<number | null>((resolve) => job.on("exit", (code) => resolve(code)))).toBe(0);
    spawnedPid = Number((await readFile(join(home, "server.pid"), "utf8")).trim());
    // nohup does not leave the job's process group, so the server is in it.
    expect(await pgidOf(spawnedPid)).toBe(jobPgid);
    // launchd.plist(5): "When a job dies, launchd kills any remaining processes with the same process group
    // ID as the job. Setting [AbandonProcessGroup] to true disables that behavior." That step is simulated
    // from the man page; launchd itself is never run here.
    if ((await plistValue("AbandonProcessGroup")) !== "true") process.kill(-jobPgid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(spawnedPid)).toBe(true);
  }, 30_000);

  it("never reads ~/Documents and uses absolute tool paths (the launchd/TCC trap)", async () => {
    const src = await readFile(SCRIPT, "utf8");
    const code = src.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/Documents/);
    expect(code).not.toMatch(/\bkill\b|pkill|launchctl/);
    expect(code).toMatch(/PATH="\/opt\/homebrew\/bin:/);
  });
});
