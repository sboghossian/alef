// Pure half of the "mac" feature: body validation, osascript sources (fixed text: user values
// always travel as argv, never concatenated into a script), output parsers and the undo map.
// No I/O here, so every branch is unit-tested (server/test/mac.test.ts).

import {
  MAC_APP_ACTIONS,
  MAC_NAME_MAX,
  MAC_NOTIFY_MAX,
  MAC_SCRIPT_LANGS,
  MAC_SCRIPT_MAX,
  MAC_SHORTCUT_INPUT_MAX,
  MAC_SYSTEM_ACTIONS,
  MAC_TARGET_MAX,
  type MacAppRequest,
  type MacContext,
  type MacInstalledApp,
  type MacOpenRequest,
  type MacRunningApp,
  type MacScriptRequest,
  type MacShortcutRequest,
  type MacSystemRequest,
  type MacUndo,
} from "../../shared/features/mac.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// C0 controls + DEL. Newlines are never part of an app / shortcut name.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An app or shortcut name: 1..200 chars, no control chars, no leading "-" (never read as a flag). */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 1 || s.length > MAC_NAME_MAX || CONTROL.test(s) || s.startsWith("-")) return null;
  return s;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

export function parseAppRequest(body: unknown): Parsed<MacAppRequest> {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const action = oneOf(MAC_APP_ACTIONS, body.action);
  if (!action) return { ok: false, error: `action must be one of ${MAC_APP_ACTIONS.join(", ")}` };
  const name = cleanName(body.name);
  if (!name) return { ok: false, error: `name must be 1..${MAC_NAME_MAX} characters` };
  return { ok: true, value: { action, name } };
}

export type OpenTarget = { kind: "url"; value: string } | { kind: "path"; value: string };

/** http(s) URL, absolute path or ~/path (expanded against `home`). Existence is checked by the caller. */
export function parseOpenTarget(body: unknown, home: string): Parsed<OpenTarget> {
  if (!isRecord(body) || typeof body.target !== "string") return { ok: false, error: "target must be a string" };
  const raw = body.target.trim();
  if (raw.length < 1 || raw.length > MAC_TARGET_MAX || CONTROL.test(raw)) return { ok: false, error: `target must be 1..${MAC_TARGET_MAX} characters` };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "only http(s) URLs" };
      return { ok: true, value: { kind: "url", value: u.toString() } };
    } catch {
      return { ok: false, error: "invalid URL" };
    }
  }
  if (raw === "~" || raw.startsWith("~/")) return { ok: true, value: { kind: "path", value: home + raw.slice(1) } };
  if (raw.startsWith("/")) return { ok: true, value: { kind: "path", value: raw } };
  return { ok: false, error: "target must be an absolute path, ~/path or http(s) URL" };
}

export function parseScriptRequest(body: unknown): Parsed<MacScriptRequest> {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const lang = oneOf(MAC_SCRIPT_LANGS, body.lang);
  if (!lang) return { ok: false, error: "lang must be applescript or jxa" };
  if (typeof body.source !== "string" || body.source.trim().length < 1 || body.source.length > MAC_SCRIPT_MAX) {
    return { ok: false, error: `source must be 1..${MAC_SCRIPT_MAX} characters` };
  }
  return { ok: true, value: { lang, source: body.source } };
}

export function parseShortcutRequest(body: unknown): Parsed<MacShortcutRequest> {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const name = cleanName(body.name);
  if (!name) return { ok: false, error: `name must be 1..${MAC_NAME_MAX} characters` };
  if (body.input === undefined || body.input === null || body.input === "") return { ok: true, value: { name } };
  if (typeof body.input !== "string" || body.input.length > MAC_SHORTCUT_INPUT_MAX) {
    return { ok: false, error: `input must be a string of at most ${MAC_SHORTCUT_INPUT_MAX} characters` };
  }
  return { ok: true, value: { name, input: body.input } };
}

export function parseSystemRequest(body: unknown): Parsed<MacSystemRequest> {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const action = oneOf(MAC_SYSTEM_ACTIONS, body.action);
  if (!action) return { ok: false, error: `action must be one of ${MAC_SYSTEM_ACTIONS.join(", ")}` };
  if (action === "volume") {
    const n = typeof body.value === "number" ? body.value : typeof body.value === "string" && body.value.trim() !== "" ? Number(body.value) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: "volume value must be 0..100" };
    return { ok: true, value: { action, value: Math.round(n) } };
  }
  if (action === "notify") {
    const text = typeof body.value === "string" ? body.value.trim() : "";
    if (text.length < 1 || text.length > MAC_NOTIFY_MAX) return { ok: false, error: `notify value must be 1..${MAC_NOTIFY_MAX} characters` };
    return { ok: true, value: { action, value: text.replace(/[\u0000-\u001f\u007f]+/g, " ") } };
  }
  return { ok: true, value: { action } };
}

// ---------------------------------------------------------------- fixed osascript sources
// Every script reads user values from `argv` (osascript passes trailing args to run()).

/** Running GUI apps as JSON. */
export const JXA_LIST_APPS = `function run() {
  const se = Application("System Events");
  const ps = se.applicationProcesses.whose({ backgroundOnly: false });
  const names = ps.name(), ids = ps.bundleIdentifier(), pids = ps.unixId(), front = ps.frontmost(), vis = ps.visible();
  return JSON.stringify(names.map((n, i) => ({ name: n, bundleId: ids[i], pid: pids[i], frontmost: front[i], hidden: !vis[i] })));
}`;

export const JXA_FOCUS = `function run(argv) { Application(argv[0]).activate(); return "ok"; }`;
export const JXA_QUIT = `function run(argv) { Application(argv[0]).quit(); return "ok"; }`;
export const JXA_HIDE = `function run(argv) {
  Application("System Events").applicationProcesses.byName(argv[0]).visible = false;
  return "ok";
}`;

/** Frontmost app + its front window title as JSON (window is "" without Accessibility). */
export const JXA_FRONT = `function run() {
  const se = Application("System Events");
  const p = se.applicationProcesses.whose({ frontmost: true })[0];
  let app = "", win = "";
  try { app = p.name(); } catch (e) {}
  try { const w = p.windows(); if (w.length) win = w[0].name(); } catch (e) {}
  return JSON.stringify({ app: app, window: win });
}`;

export const JXA_NOTIFY = `function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(argv[0], { withTitle: "Alef" });
  return "ok";
}`;

export const AS_VOLUME = `on run argv
  set volume output volume ((item 1 of argv) as integer)
  return "ok"
end run`;

export const AS_MUTE_TOGGLE = `set m to not (output muted of (get volume settings))
set volume output muted m
return m`;

export const AS_LOCK = `tell application "System Events" to keystroke "q" using {control down, command down}`;

/** Posts a hardware media key (NX_KEYTYPE_* in argv[0]) down + up. */
export const JXA_MEDIA_KEY = `function run(argv) {
  ObjC.import("Cocoa");
  ObjC.import("CoreGraphics");
  const code = parseInt(argv[0], 10);
  [true, false].forEach(function (down) {
    const flags = down ? 0xa00 : 0xb00;
    const data1 = (code << 16) | ((down ? 0xa : 0xb) << 8);
    const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, $.NSMakePoint(0, 0), flags, 0, 0, $(), 8, data1, -1);
    $.CGEventPost(0, ev.CGEvent);
  });
  return "ok";
}`;

export const MEDIA_KEY_CODE = { "play-pause": 16, next: 17, prev: 18 } as const;

/** argv for osascript running `source` in `lang`, then `args` for its run handler. */
export function osascriptArgs(lang: "applescript" | "jxa", source: string, args: readonly string[] = []): string[] {
  return [...(lang === "jxa" ? ["-l", "JavaScript"] : []), "-e", source, ...args];
}

// ---------------------------------------------------------------- parsers

function asBool(v: unknown): boolean {
  return v === true;
}

/** JXA_LIST_APPS output → apps, frontmost first then A–Z. Malformed rows are dropped. */
export function parseRunningApps(stdout: string): MacRunningApp[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: MacRunningApp[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.name !== "string" || !r.name) continue;
    const pid = typeof r.pid === "number" && Number.isFinite(r.pid) ? r.pid : -1;
    out.push({
      name: r.name,
      bundleId: typeof r.bundleId === "string" && r.bundleId ? r.bundleId : null,
      pid,
      frontmost: asBool(r.frontmost),
      hidden: asBool(r.hidden),
    });
  }
  return out.sort((a, b) => Number(b.frontmost) - Number(a.frontmost) || a.name.localeCompare(b.name));
}

/** Directory listings → installed apps. Earlier dirs win a name clash; A–Z. */
export function installedFromListings(listings: ReadonlyArray<{ dir: string; entries: readonly string[] }>): MacInstalledApp[] {
  const byName = new Map<string, MacInstalledApp>();
  for (const { dir, entries } of listings) {
    for (const e of entries) {
      if (!e.endsWith(".app") || e.startsWith(".")) continue;
      const name = e.slice(0, -4);
      if (!name || byName.has(name.toLowerCase())) continue;
      byName.set(name.toLowerCase(), { name, path: `${dir.replace(/\/+$/, "")}/${e}` });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `pmset -g batt` → battery, or null on a desktop Mac / unreadable output. */
export function parsePmsetBatt(stdout: string): MacContext["battery"] {
  const pct = /(\d{1,3})%/.exec(stdout);
  if (!pct) return null;
  const percent = Math.min(100, Number(pct[1]));
  const source = /'AC Power'/.test(stdout) ? "ac" : "battery";
  const charging = /;\s*(charging|charged|finishing charge)\b/i.test(stdout) || (source === "ac" && !/discharging/i.test(stdout));
  return { percent, charging, source };
}

/** `networksetup -getairportnetwork en0` → SSID, or null when off / not associated / redacted. */
export function parseWifi(stdout: string): string | null {
  const m = /Current Wi-Fi Network:\s*(.+)$/m.exec(stdout);
  const ssid = m?.[1]?.trim();
  return ssid ? ssid : null;
}

/** JXA_FRONT output → { app, window }. */
export function parseFront(stdout: string): { app: string | null; window: string | null } {
  try {
    const r: unknown = JSON.parse(stdout.trim());
    if (!isRecord(r)) return { app: null, window: null };
    const app = typeof r.app === "string" && r.app ? r.app : null;
    const window = typeof r.window === "string" && r.window ? r.window : null;
    return { app, window };
  } catch {
    return { app: null, window: null };
  }
}

/** `shortcuts list` → names (one per line), trimmed, deduped, A–Z. */
export function parseShortcutsList(stdout: string): string[] {
  const set = new Set<string>();
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- undo

/** The inverse of an app action, from the running apps seen just before it ran.
 *  open → quit (only when it was not already running) · focus → re-focus the previous
 *  frontmost app · hide → focus (activating unhides) · quit → relaunch. */
export function inverseOf(action: MacAppRequest["action"], name: string, before: readonly MacRunningApp[]): MacUndo | undefined {
  const lower = name.toLowerCase();
  const wasRunning = before.some((a) => a.name.toLowerCase() === lower);
  const prevFront = before.find((a) => a.frontmost)?.name ?? null;
  switch (action) {
    case "open":
      if (!wasRunning) return { action: "quit", name, label: `Quit ${name}` };
      return prevFront && prevFront.toLowerCase() !== lower ? { action: "focus", name: prevFront, label: `Back to ${prevFront}` } : undefined;
    case "focus":
      return prevFront && prevFront.toLowerCase() !== lower ? { action: "focus", name: prevFront, label: `Back to ${prevFront}` } : undefined;
    case "hide":
      return { action: "focus", name, label: `Show ${name}` };
    case "quit":
      return { action: "open", name, label: `Relaunch ${name}` };
  }
}

// ---------------------------------------------------------------- screenshots + feed text

const SHOT_RE = /^shot-\d{8}-\d{6}-\d{3}\.png$/;

export function screenshotName(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `shot-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}.png`;
}

export function isScreenshotName(name: string): boolean {
  return SHOT_RE.test(name);
}

/** One feed-safe line: control chars folded to spaces, capped with an ellipsis. */
export function oneLine(s: string, max = 140): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
