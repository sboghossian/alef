import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacActionResult, MacAppsResponse, MacContextResponse, MacScriptResult } from "../../shared/features/mac.js";
import { appendToFeed } from "../features/feed.js";
import { createMacFeature, type MacRunner, type RunResult } from "../features/mac.js";
import {
  JXA_FOCUS,
  JXA_LIST_APPS,
  JXA_QUIT,
  cleanName,
  installedFromListings,
  inverseOf,
  isScreenshotName,
  oneLine,
  osascriptArgs,
  parseAppRequest,
  parseFront,
  parseOpenTarget,
  parsePmsetBatt,
  parseRunningApps,
  parseScriptRequest,
  parseShortcutRequest,
  parseShortcutsList,
  parseSystemRequest,
  parseWifi,
  screenshotName,
} from "../features/mac-lib.js";
import type { RunningServer } from "../index.js";
import { bootTestServer } from "./helpers.js";

vi.mock("../features/feed.js", async (orig) => ({ ...(await orig<typeof import("../features/feed.js")>()), appendToFeed: vi.fn() }));

const APPS_JSON = JSON.stringify([
  { name: "Safari", bundleId: "com.apple.Safari", pid: 10, frontmost: false, hidden: false },
  { name: "Finder", bundleId: "com.apple.finder", pid: 2, frontmost: true, hidden: false },
]);

describe("mac-lib validation", () => {
  it("cleanName rejects empty, control chars, flags and oversize", () => {
    expect(cleanName(" Safari ")).toBe("Safari");
    expect(cleanName("")).toBeNull();
    expect(cleanName("a\nb")).toBeNull();
    expect(cleanName("-a")).toBeNull();
    expect(cleanName("x".repeat(201))).toBeNull();
    expect(cleanName(42)).toBeNull();
  });

  it("parseAppRequest", () => {
    expect(parseAppRequest({ action: "quit", name: "Safari" })).toEqual({ ok: true, value: { action: "quit", name: "Safari" } });
    expect(parseAppRequest({ action: "kill", name: "Safari" }).ok).toBe(false);
    expect(parseAppRequest(null).ok).toBe(false);
    expect(parseAppRequest([]).ok).toBe(false);
  });

  it("parseOpenTarget: urls, absolute and ~ paths only", () => {
    expect(parseOpenTarget({ target: "https://example.com/a b" }, "/Users/me")).toEqual({ ok: true, value: { kind: "url", value: "https://example.com/a%20b" } });
    expect(parseOpenTarget({ target: "~/Desktop" }, "/Users/me")).toEqual({ ok: true, value: { kind: "path", value: "/Users/me/Desktop" } });
    expect(parseOpenTarget({ target: "/tmp" }, "/h")).toEqual({ ok: true, value: { kind: "path", value: "/tmp" } });
    expect(parseOpenTarget({ target: "file:///etc/passwd" }, "/h").ok).toBe(false);
    expect(parseOpenTarget({ target: "-a Calculator" }, "/h").ok).toBe(false);
    expect(parseOpenTarget({ target: "relative/path" }, "/h").ok).toBe(false);
    expect(parseOpenTarget({ target: "" }, "/h").ok).toBe(false);
    expect(parseOpenTarget({}, "/h").ok).toBe(false);
  });

  it("parseScriptRequest / parseShortcutRequest", () => {
    expect(parseScriptRequest({ lang: "jxa", source: "1+1" })).toEqual({ ok: true, value: { lang: "jxa", source: "1+1" } });
    expect(parseScriptRequest({ lang: "python", source: "1" }).ok).toBe(false);
    expect(parseScriptRequest({ lang: "jxa", source: "   " }).ok).toBe(false);
    expect(parseScriptRequest({ lang: "jxa", source: "x".repeat(12_001) }).ok).toBe(false);
    expect(parseShortcutRequest({ name: "Hello" })).toEqual({ ok: true, value: { name: "Hello" } });
    expect(parseShortcutRequest({ name: "Hello", input: "hi" })).toEqual({ ok: true, value: { name: "Hello", input: "hi" } });
    expect(parseShortcutRequest({ name: "Hello", input: 3 }).ok).toBe(false);
    expect(parseShortcutRequest({ name: "" }).ok).toBe(false);
  });

  it("parseSystemRequest validates volume and notify values", () => {
    expect(parseSystemRequest({ action: "volume", value: 42.4 })).toEqual({ ok: true, value: { action: "volume", value: 42 } });
    expect(parseSystemRequest({ action: "volume", value: "70" })).toEqual({ ok: true, value: { action: "volume", value: 70 } });
    expect(parseSystemRequest({ action: "volume", value: 101 }).ok).toBe(false);
    expect(parseSystemRequest({ action: "volume" }).ok).toBe(false);
    expect(parseSystemRequest({ action: "notify", value: "hi\nthere" })).toEqual({ ok: true, value: { action: "notify", value: "hi there" } });
    expect(parseSystemRequest({ action: "notify", value: "" }).ok).toBe(false);
    expect(parseSystemRequest({ action: "lock" })).toEqual({ ok: true, value: { action: "lock" } });
    expect(parseSystemRequest({ action: "shutdown" }).ok).toBe(false);
  });
});

describe("mac-lib parsers", () => {
  it("parseRunningApps: frontmost first, then A–Z; malformed dropped", () => {
    const apps = parseRunningApps(APPS_JSON);
    expect(apps.map((a) => a.name)).toEqual(["Finder", "Safari"]);
    expect(parseRunningApps("not json")).toEqual([]);
    expect(parseRunningApps("")).toEqual([]);
    expect(parseRunningApps('{"a":1}')).toEqual([]);
    expect(parseRunningApps('[{"name":""},{"x":1},{"name":"A","bundleId":null,"pid":"x"}]')).toEqual([{ name: "A", bundleId: null, pid: -1, frontmost: false, hidden: false }]);
  });

  it("installedFromListings: .app only, first dir wins, A–Z", () => {
    const apps = installedFromListings([
      { dir: "/Applications/", entries: ["Safari.app", "Utilities", ".hidden.app", "zed.app"] },
      { dir: "/System/Applications", entries: ["safari.app", "Calculator.app"] },
    ]);
    expect(apps).toEqual([
      { name: "Calculator", path: "/System/Applications/Calculator.app" },
      { name: "Safari", path: "/Applications/Safari.app" },
      { name: "zed", path: "/Applications/zed.app" },
    ]);
    expect(installedFromListings([])).toEqual([]);
  });

  it("parsePmsetBatt / parseWifi / parseFront / parseShortcutsList", () => {
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t81%; discharging; 5:10 remaining present: true")).toEqual({ percent: 81, charging: false, source: "battery" });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining")).toEqual({ percent: 100, charging: true, source: "ac" });
    expect(parsePmsetBatt("Now drawing from 'AC Power'")).toBeNull();
    expect(parseWifi("Current Wi-Fi Network: Home 5G\n")).toBe("Home 5G");
    expect(parseWifi("You are not associated with an AirPort network.")).toBeNull();
    expect(parseFront('{"app":"Code","window":"x.ts"}')).toEqual({ app: "Code", window: "x.ts" });
    expect(parseFront('{"app":"","window":""}')).toEqual({ app: null, window: null });
    expect(parseFront("garbage")).toEqual({ app: null, window: null });
    expect(parseShortcutsList("B\n\nA\nB\n")).toEqual(["A", "B"]);
  });

  it("inverseOf maps each action to its undo", () => {
    const before = parseRunningApps(APPS_JSON);
    expect(inverseOf("open", "Notes", before)).toEqual({ action: "quit", name: "Notes", label: "Quit Notes" });
    expect(inverseOf("open", "Safari", before)).toEqual({ action: "focus", name: "Finder", label: "Back to Finder" });
    expect(inverseOf("focus", "Safari", before)).toEqual({ action: "focus", name: "Finder", label: "Back to Finder" });
    expect(inverseOf("focus", "Finder", before)).toBeUndefined();
    expect(inverseOf("hide", "Safari", before)).toEqual({ action: "focus", name: "Safari", label: "Show Safari" });
    expect(inverseOf("quit", "Safari", [])).toEqual({ action: "open", name: "Safari", label: "Relaunch Safari" });
  });

  it("screenshot names, osascript argv, oneLine", () => {
    const n = screenshotName(new Date(2026, 8, 25, 9, 5, 7, 42));
    expect(n).toBe("shot-20260925-090507-042.png");
    expect(isScreenshotName(n)).toBe(true);
    expect(isScreenshotName("../world.db")).toBe(false);
    expect(osascriptArgs("jxa", "s", ["a"])).toEqual(["-l", "JavaScript", "-e", "s", "a"]);
    expect(osascriptArgs("applescript", "s")).toEqual(["-e", "s"]);
    expect(oneLine("a\n\tb  c")).toBe("a b c");
    expect(oneLine("x".repeat(10), 5)).toBe("xxxx…");
  });
});

describe("mac routes (fake runner, never the real Mac)", () => {
  let server: RunningServer | null = null;
  let calls: { file: string; args: readonly string[] }[] = [];
  let screens = "";

  function fakeRunner(overrides: (file: string, args: readonly string[]) => RunResult | undefined = () => undefined): MacRunner {
    return async (file, args) => {
      calls.push({ file, args });
      const o = overrides(file, args);
      if (o) return o;
      if (file === "osascript" && args.includes(JXA_LIST_APPS)) return { stdout: APPS_JSON, stderr: "", code: 0, timedOut: false };
      if (file === "screencapture") await writeFile(String(args[1]), "PNGDATA");
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
  }

  async function boot(runner: MacRunner): Promise<string> {
    screens = await mkdtemp(join(tmpdir(), "mac-screens-"));
    const b = await bootTestServer({
      configOverrides: { features: [createMacFeature({ runner, home: "/Users/me", appDirs: [], screensDir: () => screens, now: () => new Date(2026, 8, 25, 9, 5, 7, 42) })] },
    });
    server = b.server;
    return b.base;
  }
  const post = async <T>(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };

  beforeEach(() => {
    calls = [];
    vi.mocked(appendToFeed).mockClear();
  });
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("GET /api/mac/apps parses System Events output", async () => {
    const base = await boot(fakeRunner());
    const body = (await (await fetch(`${base}/api/mac/apps`)).json()) as MacAppsResponse;
    expect(body.ok && body.apps.map((a) => a.name)).toEqual(["Finder", "Safari"]);
    expect(appendToFeed).not.toHaveBeenCalled(); // reads are not actions
  });

  it("quit passes the name as argv (never in the source), returns a relaunch undo and logs to the feed", async () => {
    const base = await boot(fakeRunner());
    const r = await post<MacActionResult>(base, "/api/mac/app", { action: "quit", name: 'Evil"); do shell script "rm' });
    expect(r.status).toBe(200);
    expect(r.body.undo).toEqual({ action: "open", name: 'Evil"); do shell script "rm', label: 'Relaunch Evil"); do shell script "rm' });
    const quit = calls.find((c) => c.args.includes(JXA_QUIT));
    expect(quit?.args).toEqual(["-l", "JavaScript", "-e", JXA_QUIT, 'Evil"); do shell script "rm']);
    expect(appendToFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: "mac", title: expect.stringContaining("quit Evil"), tag: "ok" }));
  });

  it("open uses `open -a <name>`; focus uses JXA with argv", async () => {
    const base = await boot(fakeRunner());
    expect((await post<MacActionResult>(base, "/api/mac/app", { action: "open", name: "Notes" })).body.undo?.action).toBe("quit");
    expect(calls.some((c) => c.file === "open" && c.args.join(" ") === "-a Notes")).toBe(true);
    await post(base, "/api/mac/app", { action: "focus", name: "Safari" });
    expect(calls.find((c) => c.args.includes(JXA_FOCUS))?.args.at(-1)).toBe("Safari");
  });

  it("rejects bad bodies with 400 and runs nothing", async () => {
    const base = await boot(fakeRunner());
    expect((await post(base, "/api/mac/app", { action: "nuke", name: "x" })).status).toBe(400);
    expect((await post(base, "/api/mac/open", { target: "file:///etc" })).status).toBe(400);
    expect((await post(base, "/api/mac/system", { action: "volume", value: 400 })).status).toBe(400);
    expect((await post(base, "/api/mac/script", { lang: "sh", source: "ls" })).status).toBe(400);
    expect(calls).toEqual([]);
    expect(appendToFeed).not.toHaveBeenCalled();
  });

  it("hub guard still applies: non-JSON writes 415, foreign Origin 403", async () => {
    const base = await boot(fakeRunner());
    const plain = await fetch(`${base}/api/mac/system`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"action":"lock"}' });
    expect(plain.status).toBe(415);
    expect((await post(base, "/api/mac/system", { action: "lock" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("open: 404 for a missing path, runs `open <path>` for an existing one", async () => {
    const base = await boot(fakeRunner());
    expect((await post(base, "/api/mac/open", { target: "/definitely/not/here" })).status).toBe(404);
    expect((await post(base, "/api/mac/open", { target: screens })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ file: "open", args: [screens] });
  });

  it("script returns stdout / stderr; failure is ok:false with the error", async () => {
    const base = await boot(fakeRunner((file, args) => (file === "osascript" && args.includes("boom") ? { stdout: "", stderr: "execution error: boom (-2700)", code: 1, timedOut: false } : file === "osascript" && args.includes("1+1") ? { stdout: "2\n", stderr: "", code: 0, timedOut: false } : undefined)));
    const good = await post<MacScriptResult>(base, "/api/mac/script", { lang: "jxa", source: "1+1" });
    expect(good.body).toMatchObject({ ok: true, stdout: "2\n", code: 0, timedOut: false });
    const bad = await post<MacScriptResult>(base, "/api/mac/script", { lang: "applescript", source: "boom" });
    expect(bad.body).toMatchObject({ ok: false, error: "execution error: boom (-2700)" });
    expect(appendToFeed).toHaveBeenCalledTimes(2);
  });

  it("screenshot saves under screensDir and serves it back; bad names are refused", async () => {
    const base = await boot(fakeRunner());
    const r = await post<MacActionResult>(base, "/api/mac/system", { action: "screenshot" });
    expect(r.body.imageUrl).toBe("/api/mac/screens/shot-20260925-090507-042.png");
    const img = await fetch(`${base}${r.body.imageUrl}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(await img.text()).toBe("PNGDATA");
    expect((await fetch(`${base}/api/mac/screens/..%2Fworld.db`)).status).toBe(400);
  });

  it("screenshot: exit 0 but no file written (Screen Recording denied) is 502, not a 200 with a dead imageUrl", async () => {
    // screencapture "succeeds" (code 0) without ever writing the file — the real failure mode.
    const base = await boot(fakeRunner((file) => (file === "screencapture" ? { stdout: "", stderr: "", code: 0, timedOut: false } : undefined)));
    const r = await post<MacActionResult>(base, "/api/mac/system", { action: "screenshot" });
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.imageUrl).toBeUndefined();
    expect(r.body.error).toContain("Screen Recording");
    expect(appendToFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: "mac", tag: "failed" }));
  });

  it("screenshot: exit 0 with a 0-byte file is also 502", async () => {
    const base = await boot(
      fakeRunner((file, args) => {
        if (file !== "screencapture") return undefined;
        return { stdout: "", stderr: "", code: 0, timedOut: false }; // no writeFile — nothing at args[1]
      }),
    );
    // Pre-create an empty file at the expected destination to exercise the "0 bytes" branch
    // specifically (as opposed to "file missing" above).
    await writeFile(join(screens, "shot-20260925-090507-042.png"), "");
    const r = await post<MacActionResult>(base, "/api/mac/system", { action: "screenshot" });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("The screenshot came back empty");
  });

  it("context degrades to nulls when every probe fails", async () => {
    const base = await boot(fakeRunner(() => ({ stdout: "", stderr: "nope", code: 1, timedOut: false })));
    const body = (await (await fetch(`${base}/api/mac/context`)).json()) as MacContextResponse;
    expect(body).toEqual({ ok: true, app: null, window: null, battery: null, wifi: null });
  });

  it("an action that fails is still logged to the feed as failed", async () => {
    const base = await boot(fakeRunner((file) => (file === "open" ? { stdout: "", stderr: "Unable to find application named 'Nope'", code: 1, timedOut: false } : undefined)));
    const r = await post<MacActionResult>(base, "/api/mac/app", { action: "open", name: "Nope" });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("Unable to find");
    expect(appendToFeed).toHaveBeenCalledWith(expect.objectContaining({ tag: "failed" }));
  });
});
