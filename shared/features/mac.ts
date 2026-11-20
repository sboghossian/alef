// Wire types for the "mac" feature: full control of this Mac and its apps from Alef's Mac tab.
// Owner decision (Round 9): FULL control, no confirm dialogs. Guardrails that stay: the hub's
// loopback bind + Host/Origin guard + JSON-only writes, actions only from an explicit click /
// submit in the Mac tab (never Jev, the council, automations, voice or timers), and every
// action is appended to the Feed with what ran.
//
//   GET  /api/mac/apps        → MacAppsResponse      running GUI apps (System Events)
//   GET  /api/mac/installed   → MacInstalledResponse  /Applications, /System/Applications, ~/Applications (cached 5 min)
//   GET  /api/mac/context     → MacContextResponse    frontmost app + window, battery, wifi
//   GET  /api/mac/shortcuts   → MacShortcutsResponse  macOS Shortcuts names
//   GET  /api/mac/screens/:file → image/png            a screenshot taken by POST /api/mac/system
//   POST /api/mac/app         MacAppRequest      → MacActionResult (open/focus/hide/quit carry an `undo`)
//   POST /api/mac/open        MacOpenRequest     → MacActionResult
//   POST /api/mac/script      MacScriptRequest   → MacScriptResult (30s timeout)
//   POST /api/mac/shortcut    MacShortcutRequest → MacScriptResult
//   POST /api/mac/system      MacSystemRequest   → MacActionResult (screenshot adds imageUrl)

export const MAC_APP_ACTIONS = ["open", "focus", "hide", "quit"] as const;
export type MacAppAction = (typeof MAC_APP_ACTIONS)[number];

export const MAC_SYSTEM_ACTIONS = ["screenshot", "volume", "mute", "play-pause", "next", "prev", "notify", "lock"] as const;
export type MacSystemAction = (typeof MAC_SYSTEM_ACTIONS)[number];

export const MAC_SCRIPT_LANGS = ["applescript", "jxa"] as const;
export type MacScriptLang = (typeof MAC_SCRIPT_LANGS)[number];

export const MAC_NAME_MAX = 200;
export const MAC_TARGET_MAX = 2000;
export const MAC_SCRIPT_MAX = 12_000;
export const MAC_NOTIFY_MAX = 200;
export const MAC_SHORTCUT_INPUT_MAX = 4000;
export const MAC_SCRIPT_TIMEOUT_MS = 30_000;

export interface MacRunningApp {
  name: string;
  bundleId: string | null;
  pid: number;
  frontmost: boolean;
  hidden: boolean;
}

export interface MacInstalledApp {
  name: string; // "Safari" (no .app)
  path: string; // absolute .app path
}

export interface MacContext {
  app: string | null;
  window: string | null;
  battery: { percent: number; charging: boolean; source: "ac" | "battery" } | null;
  wifi: string | null;
}

export type MacError = { ok: false; error: string };
export type MacAppsResponse = { ok: true; apps: MacRunningApp[] } | MacError;
export type MacInstalledResponse = { ok: true; apps: MacInstalledApp[] } | MacError;
export type MacContextResponse = ({ ok: true } & MacContext) | MacError;
export type MacShortcutsResponse = { ok: true; shortcuts: string[] } | MacError;

export interface MacAppRequest {
  action: MacAppAction;
  name: string;
}

export interface MacOpenRequest {
  target: string; // absolute path, ~/path or http(s) URL
}

export interface MacScriptRequest {
  lang: MacScriptLang;
  source: string;
}

export interface MacShortcutRequest {
  name: string;
  input?: string;
}

export interface MacSystemRequest {
  action: MacSystemAction;
  /** volume: 0..100 · notify: the message text. */
  value?: number | string;
}

/** The inverse of an app action; the client POSTs it back to /api/mac/app to undo. */
export interface MacUndo {
  action: MacAppAction;
  name: string;
  label: string; // "Relaunch Safari"
}

export interface MacActionResult {
  ok: boolean;
  error?: string;
  /** One line of what ran, e.g. "quit Safari". Also the Feed title. */
  ran?: string;
  undo?: MacUndo;
  /** screenshot: GET URL of the saved PNG. */
  imageUrl?: string;
  /** mute: the new muted state. */
  muted?: boolean;
}

export interface MacScriptResult {
  ok: boolean;
  error?: string;
  ran?: string;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}
