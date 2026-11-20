// Pure half of the Mac tab: response validation (the server is trusted but its data comes from
// the Mac — app names, window titles, script output — so it is shape-checked and always
// escaped on render), launcher ranking, app avatars and the context line.

import type { MacActionResult, MacContext, MacInstalledApp, MacRunningApp, MacScriptResult } from "../../../shared/features/mac";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseRunningApps(v: unknown): MacRunningApp[] | null {
  if (!isRecord(v) || v.ok !== true || !Array.isArray(v.apps)) return null;
  const out: MacRunningApp[] = [];
  for (const a of v.apps) {
    if (!isRecord(a) || !str(a.name)) continue;
    out.push({
      name: String(a.name),
      bundleId: str(a.bundleId),
      pid: typeof a.pid === "number" ? a.pid : -1,
      frontmost: a.frontmost === true,
      hidden: a.hidden === true,
    });
  }
  return out;
}

export function parseInstalledApps(v: unknown): MacInstalledApp[] | null {
  if (!isRecord(v) || v.ok !== true || !Array.isArray(v.apps)) return null;
  return v.apps.filter((a): a is MacInstalledApp => isRecord(a) && !!str(a.name) && !!str(a.path));
}

export function parseShortcuts(v: unknown): string[] | null {
  if (!isRecord(v) || v.ok !== true || !Array.isArray(v.shortcuts)) return null;
  return v.shortcuts.filter((s): s is string => typeof s === "string" && s.length > 0);
}

export function parseContext(v: unknown): MacContext | null {
  if (!isRecord(v) || v.ok !== true) return null;
  const b = v.battery;
  const battery =
    isRecord(b) && typeof b.percent === "number" && Number.isFinite(b.percent)
      ? { percent: Math.max(0, Math.min(100, Math.round(b.percent))), charging: b.charging === true, source: b.source === "ac" ? ("ac" as const) : ("battery" as const) }
      : null;
  return { app: str(v.app), window: str(v.window), battery, wifi: str(v.wifi) };
}

/** Coerces any POST reply (or postJson fallback) to a MacActionResult. */
export function asActionResult(v: unknown): MacActionResult {
  if (!isRecord(v)) return { ok: false, error: "no reply" };
  const out: MacActionResult = { ok: v.ok === true };
  if (str(v.error)) out.error = String(v.error);
  if (str(v.ran)) out.ran = String(v.ran);
  if (str(v.imageUrl) && String(v.imageUrl).startsWith("/api/mac/screens/")) out.imageUrl = String(v.imageUrl);
  if (typeof v.muted === "boolean") out.muted = v.muted;
  const u = v.undo;
  if (isRecord(u) && (u.action === "open" || u.action === "focus" || u.action === "hide" || u.action === "quit") && str(u.name) && str(u.label)) {
    out.undo = { action: u.action, name: String(u.name), label: String(u.label) };
  }
  return out;
}

export function asScriptResult(v: unknown): MacScriptResult {
  if (!isRecord(v)) return { ok: false, error: "no reply", stdout: "", stderr: "", code: null, timedOut: false };
  return {
    ok: v.ok === true,
    ...(str(v.error) ? { error: String(v.error) } : {}),
    ...(str(v.ran) ? { ran: String(v.ran) } : {}),
    stdout: typeof v.stdout === "string" ? v.stdout : "",
    stderr: typeof v.stderr === "string" ? v.stderr : "",
    code: typeof v.code === "number" ? v.code : null,
    timedOut: v.timedOut === true,
  };
}

/** Launcher target: a path / URL typed straight in, or an app search. */
export type LauncherIntent = { kind: "target"; target: string } | { kind: "app"; query: string } | { kind: "empty" };

export function launcherIntent(raw: string): LauncherIntent {
  const q = raw.trim();
  if (!q) return { kind: "empty" };
  if (/^https?:\/\//i.test(q) || q.startsWith("/") || q === "~" || q.startsWith("~/")) return { kind: "target", target: q };
  return { kind: "app", query: q };
}

/** Installed apps ranked for a query: exact, prefix, word-prefix, substring. Case-insensitive. */
export function rankApps(apps: readonly MacInstalledApp[], query: string, limit = 6): MacInstalledApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { app: MacInstalledApp; score: number }[] = [];
  for (const app of apps) {
    const n = app.name.toLowerCase();
    let score = -1;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) score = 2;
    else if (n.includes(q)) score = 3;
    if (score >= 0) scored.push({ app, score });
  }
  scored.sort((a, b) => a.score - b.score || a.app.name.length - b.app.name.length || a.app.name.localeCompare(b.app.name));
  return scored.slice(0, limit).map((s) => s.app);
}

const APP_EMOJI: Record<string, string> = {
  finder: "🗂️",
  safari: "🧭",
  "google chrome": "🌐",
  chrome: "🌐",
  firefox: "🦊",
  arc: "🌈",
  mail: "✉️",
  spark: "✉️",
  messages: "💬",
  whatsapp: "💬",
  slack: "💬",
  "microsoft teams": "👥",
  music: "🎵",
  spotify: "🎧",
  notes: "📝",
  obsidian: "💎",
  calendar: "📅",
  terminal: "⌨️",
  iterm2: "⌨️",
  ghostty: "👻",
  warp: "⌨️",
  "visual studio code": "🧑‍💻",
  code: "🧑‍💻",
  cursor: "🧑‍💻",
  xcode: "🔨",
  photos: "🖼️",
  preview: "👁️",
  "system settings": "⚙️",
  "activity monitor": "📈",
  claude: "✳️",
  figma: "🎨",
  zoom: "📹",
  "zoom.us": "📹",
  facetime: "📹",
  reminders: "✅",
  maps: "🗺️",
  "app store": "🛍️",
  calculator: "🧮",
  shortcuts: "⚡",
};

const TILE_COLORS = ["#ffd23f", "#ff4d8d", "#7bdff2", "#b2f7a5", "#c3a6ff", "#ffb86b", "#8ee3c8"] as const;

/** Avatar for an app tile: a known emoji or the first letter, plus a stable bright color. */
export function appAvatar(name: string): { glyph: string; emoji: boolean; color: string } {
  const key = name.trim().toLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const color = TILE_COLORS[h % TILE_COLORS.length]!;
  const emoji = APP_EMOJI[key];
  if (emoji) return { glyph: emoji, emoji: true, color };
  const first = [...name.trim()].find((c) => /[\p{L}\p{N}]/u.test(c));
  return { glyph: (first ?? "?").toUpperCase(), emoji: false, color };
}

/** "Code — x.ts · 🔋 81% · 📶 Home" (parts are left out when unknown). */
export function contextLine(ctx: MacContext | null): string {
  if (!ctx) return "Could not read the Mac right now.";
  const parts: string[] = [];
  parts.push(ctx.app ? (ctx.window ? `${ctx.app} — ${ctx.window}` : ctx.app) : "No frontmost app");
  if (ctx.battery) parts.push(`${ctx.battery.charging ? "⚡" : "🔋"} ${ctx.battery.percent}%`);
  if (ctx.wifi) parts.push(`📶 ${ctx.wifi}`);
  return parts.join(" · ");
}

/** Remaining whole seconds of an undo window, clamped at 0. */
export function undoSecondsLeft(startedAt: number, now: number, windowMs = 5000): number {
  return Math.max(0, Math.ceil((windowMs - (now - startedAt)) / 1000));
}
