// "mac": full control of this Mac and its apps from the Mac tab (owner's call, Round 9: no
// confirm dialogs). What stays: the hub guard (loopback bind, Host/Origin check, JSON-only
// writes — every route here goes through server/index.ts → checkRequest before the registry),
// actions only from an explicit click / submit in the Mac tab (no timer, Jev, council, voice or
// automation path calls these routes), and every POST appended to the Feed with what ran.
// Processes run via execFile with an argv array; user values reach osascript as argv to a
// fixed script, never spliced into its source (except /script, whose job is user source).
// The runner is injectable so tests never touch the real Mac.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAC_SCRIPT_TIMEOUT_MS,
  type MacActionResult,
  type MacAppsResponse,
  type MacContextResponse,
  type MacInstalledApp,
  type MacInstalledResponse,
  type MacRunningApp,
  type MacScriptResult,
  type MacShortcutsResponse,
} from "../../shared/features/mac.js";
import { readJsonBody, respondJson } from "../http.js";
import { appendToFeed } from "./feed.js";
import {
  AS_LOCK,
  AS_MUTE_TOGGLE,
  AS_VOLUME,
  JXA_FOCUS,
  JXA_FRONT,
  JXA_HIDE,
  JXA_LIST_APPS,
  JXA_MEDIA_KEY,
  JXA_NOTIFY,
  JXA_QUIT,
  MEDIA_KEY_CODE,
  inverseOf,
  installedFromListings,
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
} from "./mac-lib.js";
import type { FeatureContext, ServerFeature } from "./registry.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Runs one program with an argv array. Never throws: failures come back as code/stderr. */
export type MacRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export const realMacRunner: MacRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr, code: 0, timedOut: false });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null };
      const timedOut = e.killed === true && e.signal === "SIGTERM";
      const code = typeof e.code === "number" ? e.code : null;
      resolve({ stdout: stdout ?? "", stderr: stderr || (timedOut ? "" : String(e.message)), code, timedOut });
    });
  });

export interface MacOptions {
  runner?: MacRunner;
  home?: string;
  appDirs?: string[];
  /** Where screenshots go (default data/screens beside the world db). */
  screensDir?: (ctx: FeatureContext) => string;
  now?: () => Date;
  installedTtlMs?: number;
}

const READ_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;

/** screencapture can exit 0 having written nothing (or a 0-byte file) when macOS's Screen
 *  Recording permission is denied for the process that ran it — the exit code alone used to be
 *  trusted, so that case answered ok:true with an imageUrl that then 404'd. */
const SCREENSHOT_EMPTY_ERROR =
  "The screenshot came back empty. macOS is probably blocking screen capture: allow Screen Recording for the app that runs Alef's server (Terminal or VS Code) in System Settings › Privacy & Security › Screen Recording.";

function errText(r: RunResult): string {
  if (r.timedOut) return "timed out";
  return oneLine(r.stderr || r.stdout || `exit ${r.code ?? "?"}`, 300);
}

export function createMacFeature(opts: MacOptions = {}): ServerFeature {
  const run = opts.runner ?? realMacRunner;
  const home = opts.home ?? homedir();
  const appDirs = opts.appDirs ?? ["/Applications", "/System/Applications", join(home, "Applications")];
  const screensDir = opts.screensDir ?? ((ctx: FeatureContext) => join(dirname(ctx.config.dbPath), "screens"));
  const now = opts.now ?? (() => new Date());
  const ttl = opts.installedTtlMs ?? 5 * 60_000;
  let installed: { at: number; apps: MacInstalledApp[] } | null = null;

  const osa = (lang: "applescript" | "jxa", source: string, args: readonly string[] = [], timeoutMs = ACTION_TIMEOUT_MS): Promise<RunResult> =>
    run("osascript", osascriptArgs(lang, source, args), timeoutMs);

  async function runningApps(): Promise<MacRunningApp[] | string> {
    const r = await osa("jxa", JXA_LIST_APPS, [], READ_TIMEOUT_MS);
    return r.code === 0 ? parseRunningApps(r.stdout) : errText(r);
  }

  async function listInstalled(): Promise<MacInstalledApp[]> {
    if (installed && Date.now() - installed.at < ttl) return installed.apps;
    const listings: { dir: string; entries: string[] }[] = [];
    for (const dir of appDirs) {
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // ~/Applications often does not exist
      }
      listings.push({ dir, entries });
      // One level of plain folders (e.g. /Applications/Utilities).
      for (const sub of entries) {
        if (sub.endsWith(".app") || sub.startsWith(".")) continue;
        try {
          listings.push({ dir: join(dir, sub), entries: await readdir(join(dir, sub)) });
        } catch {
          // not a folder
        }
      }
    }
    installed = { at: Date.now(), apps: installedFromListings(listings) };
    return installed.apps;
  }

  /** Feed line for a user-clicked action. */
  function record(ran: string, ok: boolean, detail: string | null): void {
    const at = now().toISOString();
    appendToFeed({
      id: `mac:${at}:${Math.random().toString(36).slice(2, 8)}`,
      at,
      kind: "mac",
      agentId: null,
      title: oneLine(`Mac: ${ran}${ok ? "" : " (failed)"}`),
      detail: detail === null ? null : oneLine(detail, 240),
      tag: ok ? "ok" : "failed",
    });
  }

  async function body(req: Parameters<typeof readJsonBody>[0]): Promise<unknown | undefined> {
    try {
      return await readJsonBody(req);
    } catch {
      return undefined;
    }
  }

  return {
    id: "mac",
    routes: [
      {
        method: "GET",
        path: "/api/mac/apps",
        async handler(_req, res) {
          const apps = await runningApps();
          if (typeof apps === "string") return respondJson(res, 502, { ok: false, error: apps } satisfies MacAppsResponse);
          respondJson(res, 200, { ok: true, apps } satisfies MacAppsResponse);
        },
      },
      {
        method: "GET",
        path: "/api/mac/installed",
        async handler(_req, res) {
          respondJson(res, 200, { ok: true, apps: await listInstalled() } satisfies MacInstalledResponse);
        },
      },
      {
        method: "GET",
        path: "/api/mac/context",
        async handler(_req, res) {
          const [front, batt, wifi] = await Promise.all([
            osa("jxa", JXA_FRONT, [], READ_TIMEOUT_MS),
            run("pmset", ["-g", "batt"], READ_TIMEOUT_MS),
            run("networksetup", ["-getairportnetwork", "en0"], READ_TIMEOUT_MS),
          ]);
          const fw = front.code === 0 ? parseFront(front.stdout) : { app: null, window: null };
          respondJson(res, 200, {
            ok: true,
            ...fw,
            battery: batt.code === 0 ? parsePmsetBatt(batt.stdout) : null,
            wifi: wifi.code === 0 ? parseWifi(wifi.stdout) : null,
          } satisfies MacContextResponse);
        },
      },
      {
        method: "GET",
        path: "/api/mac/shortcuts",
        async handler(_req, res) {
          const r = await run("shortcuts", ["list"], READ_TIMEOUT_MS);
          if (r.code !== 0) return respondJson(res, 502, { ok: false, error: errText(r) } satisfies MacShortcutsResponse);
          respondJson(res, 200, { ok: true, shortcuts: parseShortcutsList(r.stdout) } satisfies MacShortcutsResponse);
        },
      },
      {
        method: "GET",
        path: "/api/mac/screens/:file",
        async handler(_req, res, ctx, params) {
          const file = params.file ?? "";
          if (!isScreenshotName(file)) return respondJson(res, 400, { ok: false, error: "invalid screenshot name" });
          try {
            const data = await readFile(join(screensDir(ctx), file));
            res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length, "Cache-Control": "private, max-age=3600" });
            res.end(data);
          } catch {
            respondJson(res, 404, { ok: false, error: "not found" });
          }
        },
      },
      {
        method: "POST",
        path: "/api/mac/app",
        async handler(req, res, ctx) {
          const parsed = parseAppRequest(await body(req));
          if (!parsed.ok) return respondJson(res, 400, { ok: false, error: parsed.error } satisfies MacActionResult);
          const { action, name } = parsed.value;
          const before = await runningApps();
          const r =
            action === "open"
              ? await run("open", ["-a", name], ACTION_TIMEOUT_MS)
              : await osa("jxa", action === "focus" ? JXA_FOCUS : action === "hide" ? JXA_HIDE : JXA_QUIT, [name]);
          const ran = `${action} ${name}`;
          const ok = r.code === 0;
          record(ran, ok, ok ? null : errText(r));
          ctx.log.info("mac", `${ran} → ${ok ? "ok" : errText(r)}`);
          if (!ok) return respondJson(res, 502, { ok: false, error: errText(r), ran } satisfies MacActionResult);
          const undo = inverseOf(action, name, typeof before === "string" ? [] : before);
          respondJson(res, 200, { ok: true, ran, ...(undo ? { undo } : {}) } satisfies MacActionResult);
        },
      },
      {
        method: "POST",
        path: "/api/mac/open",
        async handler(req, res, ctx) {
          const parsed = parseOpenTarget(await body(req), home);
          if (!parsed.ok) return respondJson(res, 400, { ok: false, error: parsed.error } satisfies MacActionResult);
          const t = parsed.value;
          if (t.kind === "path" && !existsSync(t.value)) return respondJson(res, 404, { ok: false, error: "no such file or folder" } satisfies MacActionResult);
          const r = await run("open", [t.value], ACTION_TIMEOUT_MS);
          const ran = `open ${t.value}`;
          const ok = r.code === 0;
          record(ran, ok, ok ? null : errText(r));
          ctx.log.info("mac", `${ran} → ${ok ? "ok" : errText(r)}`);
          respondJson(res, ok ? 200 : 502, ok ? ({ ok: true, ran } satisfies MacActionResult) : ({ ok: false, error: errText(r), ran } satisfies MacActionResult));
        },
      },
      {
        method: "POST",
        path: "/api/mac/script",
        async handler(req, res, ctx) {
          const parsed = parseScriptRequest(await body(req));
          if (!parsed.ok) return respondJson(res, 400, { ok: false, error: parsed.error, stdout: "", stderr: "", code: null, timedOut: false } satisfies MacScriptResult);
          const { lang, source } = parsed.value;
          const r = await osa(lang, source, [], MAC_SCRIPT_TIMEOUT_MS);
          const ok = r.code === 0;
          const ran = `${lang === "jxa" ? "JXA" : "AppleScript"}: ${oneLine(source, 100)}`;
          record(ran, ok, ok ? oneLine(r.stdout, 200) || null : errText(r));
          ctx.log.info("mac", `script (${lang}, ${source.length} chars) → ${ok ? "ok" : errText(r)}`);
          respondJson(res, 200, { ok, ran, stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut, ...(ok ? {} : { error: errText(r) }) } satisfies MacScriptResult);
        },
      },
      {
        method: "POST",
        path: "/api/mac/shortcut",
        async handler(req, res, ctx) {
          const parsed = parseShortcutRequest(await body(req));
          if (!parsed.ok) return respondJson(res, 400, { ok: false, error: parsed.error, stdout: "", stderr: "", code: null, timedOut: false } satisfies MacScriptResult);
          const { name, input } = parsed.value;
          let inputFile: string | null = null;
          const args = ["run", name];
          if (input !== undefined) {
            inputFile = join(tmpdir(), `alef-shortcut-${process.pid}-${Date.now()}.txt`);
            await writeFile(inputFile, input, { mode: 0o600 });
            args.push("--input-path", inputFile);
          }
          const r = await run("shortcuts", args, MAC_SCRIPT_TIMEOUT_MS);
          if (inputFile) await rm(inputFile, { force: true });
          const ok = r.code === 0;
          const ran = `run shortcut ${name}`;
          record(ran, ok, ok ? oneLine(r.stdout, 200) || null : errText(r));
          ctx.log.info("mac", `${ran} → ${ok ? "ok" : errText(r)}`);
          respondJson(res, 200, { ok, ran, stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut, ...(ok ? {} : { error: errText(r) }) } satisfies MacScriptResult);
        },
      },
      {
        method: "POST",
        path: "/api/mac/system",
        async handler(req, res, ctx) {
          const parsed = parseSystemRequest(await body(req));
          if (!parsed.ok) return respondJson(res, 400, { ok: false, error: parsed.error } satisfies MacActionResult);
          const { action, value } = parsed.value;
          let r: RunResult;
          let ran: string = action;
          const extra: Partial<MacActionResult> = {};
          switch (action) {
            case "screenshot": {
              const dir = screensDir(ctx);
              await mkdir(dir, { recursive: true });
              const file = screenshotName(now());
              const dest = join(dir, file);
              r = await run("screencapture", ["-x", dest], ACTION_TIMEOUT_MS);
              ran = `screenshot ${file}`;
              if (r.code === 0) {
                const bytes = await stat(dest)
                  .then((s) => s.size)
                  .catch(() => 0);
                if (bytes > 0) {
                  extra.imageUrl = `/api/mac/screens/${file}`;
                } else {
                  r = { stdout: r.stdout, stderr: SCREENSHOT_EMPTY_ERROR, code: 1, timedOut: false };
                }
              }
              break;
            }
            case "volume":
              r = await osa("applescript", AS_VOLUME, [String(value)]);
              ran = `volume ${String(value)}%`;
              break;
            case "mute":
              r = await osa("applescript", AS_MUTE_TOGGLE);
              extra.muted = r.stdout.trim() === "true";
              ran = extra.muted ? "mute" : "unmute";
              break;
            case "play-pause":
            case "next":
            case "prev":
              r = await osa("jxa", JXA_MEDIA_KEY, [String(MEDIA_KEY_CODE[action])]);
              break;
            case "notify":
              r = await osa("jxa", JXA_NOTIFY, [String(value)]);
              ran = `notify "${String(value)}"`;
              break;
            case "lock":
              r = await osa("applescript", AS_LOCK);
              ran = "lock screen";
              break;
          }
          const ok = r.code === 0;
          record(ran, ok, ok ? null : errText(r));
          ctx.log.info("mac", `${ran} → ${ok ? "ok" : errText(r)}`);
          if (!ok) return respondJson(res, 502, { ok: false, error: errText(r), ran } satisfies MacActionResult);
          respondJson(res, 200, { ok: true, ran, ...extra } satisfies MacActionResult);
        },
      },
    ],
  };
}

export const macFeature = createMacFeature();
