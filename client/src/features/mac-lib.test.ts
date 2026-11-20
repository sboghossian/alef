import { describe, expect, it } from "vitest";
import {
  appAvatar,
  asActionResult,
  asScriptResult,
  contextLine,
  launcherIntent,
  parseContext,
  parseInstalledApps,
  parseRunningApps,
  parseShortcuts,
  rankApps,
  undoSecondsLeft,
} from "./mac-lib";

const APPS = [
  { name: "Safari", path: "/Applications/Safari.app" },
  { name: "Visual Studio Code", path: "/Applications/Visual Studio Code.app" },
  { name: "Script Editor", path: "/System/Applications/Utilities/Script Editor.app" },
  { name: "Notes", path: "/System/Applications/Notes.app" },
  { name: "Obsidian", path: "/Applications/Obsidian.app" },
];

describe("mac-lib response parsing", () => {
  it("parseRunningApps drops malformed rows and rejects error replies", () => {
    expect(parseRunningApps({ ok: true, apps: [{ name: "Finder", bundleId: "com.apple.finder", pid: 1, frontmost: true, hidden: false }, { name: "" }, 5, { name: "X", pid: "1" }] })).toEqual([
      { name: "Finder", bundleId: "com.apple.finder", pid: 1, frontmost: true, hidden: false },
      { name: "X", bundleId: null, pid: -1, frontmost: false, hidden: false },
    ]);
    expect(parseRunningApps({ ok: false, error: "nope" })).toBeNull();
    expect(parseRunningApps(null)).toBeNull();
  });

  it("parseInstalledApps / parseShortcuts", () => {
    expect(parseInstalledApps({ ok: true, apps: [...APPS.slice(0, 1), { name: "x" }, null] })).toEqual(APPS.slice(0, 1));
    expect(parseInstalledApps({ ok: true })).toBeNull();
    expect(parseShortcuts({ ok: true, shortcuts: ["A", 3, ""] })).toEqual(["A"]);
    expect(parseShortcuts({ ok: false })).toBeNull();
  });

  it("parseContext clamps battery and nulls unknown parts", () => {
    expect(parseContext({ ok: true, app: "Code", window: "", battery: { percent: 140, charging: true, source: "ac" }, wifi: null })).toEqual({
      app: "Code",
      window: null,
      battery: { percent: 100, charging: true, source: "ac" },
      wifi: null,
    });
    expect(parseContext({ ok: true, battery: { percent: "x" } })).toEqual({ app: null, window: null, battery: null, wifi: null });
    expect(parseContext(undefined)).toBeNull();
  });

  it("asActionResult keeps only well-formed fields", () => {
    expect(asActionResult({ ok: true, ran: "quit Safari", undo: { action: "open", name: "Safari", label: "Relaunch Safari" } })).toEqual({
      ok: true,
      ran: "quit Safari",
      undo: { action: "open", name: "Safari", label: "Relaunch Safari" },
    });
    expect(asActionResult({ ok: true, undo: { action: "rm", name: "x", label: "y" }, imageUrl: "https://evil/x.png" })).toEqual({ ok: true });
    expect(asActionResult({ ok: true, imageUrl: "/api/mac/screens/shot-1.png", muted: true })).toEqual({ ok: true, imageUrl: "/api/mac/screens/shot-1.png", muted: true });
    expect(asActionResult("x")).toEqual({ ok: false, error: "no reply" });
  });

  it("asScriptResult fills defaults", () => {
    expect(asScriptResult({ ok: true, stdout: "2\n", code: 0 })).toEqual({ ok: true, stdout: "2\n", stderr: "", code: 0, timedOut: false });
    expect(asScriptResult({ ok: false, error: "timed out", timedOut: true })).toMatchObject({ ok: false, error: "timed out", timedOut: true, code: null });
    expect(asScriptResult(null).ok).toBe(false);
  });
});

describe("mac-lib launcher + display", () => {
  it("launcherIntent splits targets from app searches", () => {
    expect(launcherIntent("  ")).toEqual({ kind: "empty" });
    expect(launcherIntent("https://x.dev")).toEqual({ kind: "target", target: "https://x.dev" });
    expect(launcherIntent("~/Desktop")).toEqual({ kind: "target", target: "~/Desktop" });
    expect(launcherIntent("/tmp")).toEqual({ kind: "target", target: "/tmp" });
    expect(launcherIntent("saf")).toEqual({ kind: "app", query: "saf" });
  });

  it("rankApps: exact, prefix, word-prefix, substring", () => {
    expect(rankApps(APPS, "notes").map((a) => a.name)).toEqual(["Notes"]);
    expect(rankApps(APPS, "s").map((a) => a.name)).toEqual(["Safari", "Script Editor", "Visual Studio Code", "Notes", "Obsidian"]);
    expect(rankApps(APPS, "code").map((a) => a.name)).toEqual(["Visual Studio Code"]);
    expect(rankApps(APPS, "sid").map((a) => a.name)).toEqual(["Obsidian"]);
    expect(rankApps(APPS, "")).toEqual([]);
    expect(rankApps([], "x")).toEqual([]);
    expect(rankApps(APPS, "s", 2)).toHaveLength(2);
  });

  it("appAvatar: known emoji, first letter otherwise, stable color", () => {
    expect(appAvatar("Safari")).toMatchObject({ glyph: "🧭", emoji: true });
    expect(appAvatar("zed")).toMatchObject({ glyph: "Z", emoji: false });
    expect(appAvatar("  ")).toMatchObject({ glyph: "?" });
    expect(appAvatar("zed").color).toBe(appAvatar("zed").color);
  });

  it("contextLine", () => {
    expect(contextLine({ app: "Code", window: "x.ts", battery: { percent: 81, charging: false, source: "battery" }, wifi: "Home" })).toBe("Code — x.ts · 🔋 81% · 📶 Home");
    expect(contextLine({ app: null, window: null, battery: null, wifi: null })).toBe("No frontmost app");
    expect(contextLine(null)).toMatch(/Could not/);
  });

  it("undoSecondsLeft counts down to 0", () => {
    expect(undoSecondsLeft(0, 0)).toBe(5);
    expect(undoSecondsLeft(0, 4100)).toBe(1);
    expect(undoSecondsLeft(0, 5000)).toBe(0);
    expect(undoSecondsLeft(0, 9999)).toBe(0);
  });
});
