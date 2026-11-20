// Mac tab (right sidebar, #alef-pane-mac): full control of this Mac from Alef. Owner's call
// (Round 9): no confirm dialogs. Every action here fires ONLY from a click / submit in this pane
// (the ⌘K commands just open the tab and focus a box), and each one lands in the Feed.
// Reads (running apps + context) refresh while the tab is on screen; they never change the Mac.
// App names, window titles and script output come from the Mac: always escaped on render.

import type { MacActionResult, MacAppAction, MacInstalledApp, MacRunningApp, MacScriptLang, MacSystemAction } from "../../../shared/features/mac";
import { log } from "../log"; import { isRecord } from "./fleet-overlay";
import { escapeHtml } from "../ui/fuzzy";
import "./mac.css";
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
import type { ClientContext, ClientFeature } from "./registry";

const REFRESH_MS = 8_000;
const UNDO_MS = 5_000;

interface MacState {
  running: MacRunningApp[] | null;
  /** null = no answer yet (loading); otherwise the last failed read's reason. */
  appsError: string | null;
  installed: MacInstalledApp[];
  shortcuts: string[] | null;
  shortcutsError: boolean;
  lang: MacScriptLang;
}

const state: MacState = { running: null, appsError: null, installed: [], shortcuts: null, shortcutsError: false, lang: "applescript" };
let pane: HTMLElement | null = null;
let feedSeq = 0;

function q<T extends HTMLElement>(sel: string): T | null {
  return pane?.querySelector<T>(sel) ?? null;
}

function paneHtml(): string {
  return `
  <div class="mac-now">
    <div class="mac-now-line"><span class="mac-now-label">Now</span> <span class="mac-context" aria-live="polite">Reading the Mac…</span></div>
    <button type="button" class="mac-btn" data-mac="refresh" title="Read running apps and the frontmost window again">↻ Refresh</button>
  </div>

  <form class="mac-launch" autocomplete="off">
    <input type="search" class="mac-launch-input" placeholder="Open an app, file or URL…" aria-label="Open an app, a file path or a URL (Enter opens)" />
    <button type="submit" class="mac-btn mac-btn-go">Open</button>
    <ul class="mac-suggest" role="listbox" aria-label="Matching apps"></ul>
  </form>

  <h3 class="alef-pane-h">Quick actions</h3>
  <div class="mac-quick">
    <button type="button" class="mac-btn" data-sys="screenshot" title="Take a screenshot (saved in Alef's data/screens)">📸 Screenshot</button>
    <button type="button" class="mac-btn" data-sys="prev" title="Previous track">⏮ Prev</button>
    <button type="button" class="mac-btn" data-sys="play-pause" title="Play or pause whatever is playing">⏯ Play/Pause</button>
    <button type="button" class="mac-btn" data-sys="next" title="Next track">⏭ Next</button>
    <button type="button" class="mac-btn" data-sys="mute" title="Toggle mute">🔇 Mute</button>
    <button type="button" class="mac-btn mac-btn-hot" data-sys="lock" title="Lock the screen now">🔒 Lock</button>
  </div>
  <label class="mac-volume">🔊 Volume <input type="range" min="0" max="100" step="5" value="50" class="mac-volume-range" aria-label="Output volume (sets it when you let go)" /><output class="mac-volume-out">50%</output></label>
  <form class="mac-notify">
    <input type="text" class="mac-input mac-notify-input" maxlength="200" placeholder="Notification text…" aria-label="Notification text" />
    <button type="submit" class="mac-btn">🔔 Notify</button>
  </form>
  <div class="mac-shot" hidden></div>

  <h3 class="alef-pane-h">Running apps <span class="alef-fcount mac-app-count"></span></h3>
  <ul class="mac-apps" aria-label="Running apps"></ul>

  <h3 class="alef-pane-h">Shortcuts <span class="alef-fcount mac-sc-count"></span></h3>
  <input type="search" class="mac-input mac-sc-filter" placeholder="Find a shortcut…" aria-label="Filter shortcuts" />
  <input type="text" class="mac-input mac-sc-input" placeholder="Optional input for the shortcut" aria-label="Optional input passed to the shortcut you run" />
  <ul class="mac-shortcuts" aria-label="Shortcuts"></ul>

  <h3 class="alef-pane-h">Script console</h3>
  <form class="mac-script">
    <div class="mac-lang" role="radiogroup" aria-label="Script language">
      <button type="button" class="mac-btn mac-lang-btn on" data-lang="applescript" role="radio" aria-checked="true">AppleScript</button>
      <button type="button" class="mac-btn mac-lang-btn" data-lang="jxa" role="radio" aria-checked="false">JavaScript (JXA)</button>
    </div>
    <textarea class="mac-script-src" rows="5" spellcheck="false" aria-label="Script source" placeholder='display dialog "Hello from Alef"'></textarea>
    <div class="mac-script-row"><button type="submit" class="mac-btn mac-btn-go">▶ Run script</button><span class="mac-script-hint">Runs as you, 30s limit. ⌘Enter runs.</span></div>
    <pre class="mac-script-out" hidden></pre>
  </form>

  <div class="mac-undo" role="status" hidden>
    <span class="mac-undo-text"></span>
    <button type="button" class="mac-btn mac-undo-btn">Undo</button>
  </div>`;
}

// ---------------------------------------------------------------- feed + undo

function toFeed(ctx: ClientContext, r: { ok: boolean; ran?: string; error?: string }, fallback: string): void {
  const at = Date.now();
  ctx.feed.push({
    id: `mac:${at}:${++feedSeq}`,
    kind: "system",
    at,
    title: `🖥️ Mac: ${r.ran ?? fallback}${r.ok ? "" : " (failed)"}`,
    ...(r.ok ? {} : { detail: r.error ?? "failed" }),
  });
}

let undoTimer: ReturnType<typeof setInterval> | null = null;

function hideUndo(): void {
  if (undoTimer) clearInterval(undoTimer);
  undoTimer = null;
  const bar = q<HTMLElement>(".mac-undo");
  if (bar) bar.hidden = true;
}

function showUndo(ctx: ClientContext, text: string, result: MacActionResult): void {
  const undo = result.undo;
  const bar = q<HTMLElement>(".mac-undo");
  const label = q<HTMLElement>(".mac-undo-text");
  const btn = q<HTMLButtonElement>(".mac-undo-btn");
  if (!undo || !bar || !label || !btn) return;
  hideUndo();
  const started = Date.now();
  const paint = (): void => {
    const s = undoSecondsLeft(started, Date.now(), UNDO_MS);
    if (s <= 0) return hideUndo();
    btn.textContent = `${undo.label} (${s}s)`;
  };
  label.textContent = text;
  bar.hidden = false;
  paint();
  undoTimer = setInterval(paint, 250);
  btn.onclick = () => {
    hideUndo();
    void appAction(ctx, undo.action, undo.name, false);
  };
}

// ---------------------------------------------------------------- actions (click / submit only)

async function appAction(ctx: ClientContext, action: MacAppAction, name: string, offerUndo = true): Promise<void> {
  const r = asActionResult(await ctx.api.postJson<unknown>("/api/mac/app", { action, name }, (error) => ({ ok: false, error })));
  toFeed(ctx, r, `${action} ${name}`);
  if (!r.ok) {
    ctx.toast(`Mac: could not ${action} ${name}: ${r.error ?? "unknown error"}`, "error");
  } else if (offerUndo && r.undo) {
    const verb = { open: "Opened", focus: "Focused", hide: "Hid", quit: "Quit" }[action];
    showUndo(ctx, `${verb} ${name}.`, r);
  } else {
    ctx.toast(`Mac: ${r.ran ?? `${action} ${name}`}`);
  }
  setTimeout(() => void refresh(ctx), 700);
}

async function openTarget(ctx: ClientContext, target: string): Promise<void> {
  const r = asActionResult(await ctx.api.postJson<unknown>("/api/mac/open", { target }, (error) => ({ ok: false, error })));
  toFeed(ctx, r, `open ${target}`);
  ctx.toast(r.ok ? `Mac: opened ${target}` : `Mac: could not open ${target}: ${r.error ?? "unknown error"}`, r.ok ? "info" : "error");
}

async function systemAction(ctx: ClientContext, action: MacSystemAction, value?: number | string): Promise<void> {
  const r = asActionResult(await ctx.api.postJson<unknown>("/api/mac/system", value === undefined ? { action } : { action, value }, (error) => ({ ok: false, error })));
  toFeed(ctx, r, action);
  if (!r.ok) return ctx.toast(`Mac: ${action} failed: ${r.error ?? "unknown error"}`, "error");
  if (action === "screenshot" && r.imageUrl) {
    const box = q<HTMLElement>(".mac-shot");
    if (box) {
      const url = escapeHtml(r.imageUrl);
      box.innerHTML = `<a href="${url}" target="_blank" rel="noopener" title="Open the full screenshot in a new tab"><img src="${url}" alt="Screenshot just taken" /></a><span class="mac-shot-cap">Saved · click to open full size</span>`;
      box.hidden = false;
    }
  }
  if (action === "mute") {
    const b = q<HTMLButtonElement>('[data-sys="mute"]');
    if (b) b.textContent = r.muted ? "🔈 Unmute" : "🔇 Mute";
  }
  ctx.toast(`Mac: ${r.ran ?? action}`);
}

async function runShortcut(ctx: ClientContext, name: string): Promise<void> {
  const input = q<HTMLInputElement>(".mac-sc-input")?.value ?? "";
  const r = asScriptResult(await ctx.api.postJson<unknown>("/api/mac/shortcut", input ? { name, input } : { name }, (error) => ({ ok: false, error }), 40_000));
  toFeed(ctx, r, `run shortcut ${name}`);
  const out = r.stdout.trim();
  ctx.toast(r.ok ? `Shortcut "${name}" ran${out ? `: ${out.slice(0, 120)}` : "."}` : `Shortcut "${name}" failed: ${r.error ?? "unknown error"}`, r.ok ? "info" : "error");
}

async function runScript(ctx: ClientContext): Promise<void> {
  const src = q<HTMLTextAreaElement>(".mac-script-src")?.value ?? "";
  const out = q<HTMLElement>(".mac-script-out");
  if (!src.trim() || !out) return;
  out.hidden = false;
  out.className = "mac-script-out";
  out.textContent = "Running…";
  const r = asScriptResult(await ctx.api.postJson<unknown>("/api/mac/script", { lang: state.lang, source: src }, (error) => ({ ok: false, error }), 40_000));
  toFeed(ctx, r, `${state.lang} script`);
  out.classList.toggle("mac-script-err", !r.ok);
  const body = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
  out.textContent = r.timedOut ? "Timed out after 30s." : body || (r.ok ? "(no output)" : (r.error ?? "failed"));
}

// ---------------------------------------------------------------- reads + render

function renderApps(): void {
  const list = q<HTMLElement>(".mac-apps");
  const count = q<HTMLElement>(".mac-app-count");
  if (!list) return;
  if (!state.running) {
    // Only blame permissions when macOS said so (-1743 / "not allowed"); a slow or failed read
    // just says so, and before the first answer it's loading, not an error.
    const why = state.appsError;
    list.innerHTML =
      why === null
        ? `<li class="mac-empty">Loading running apps…</li>`
        : /-1743|not allowed|not authori[sz]ed/i.test(why)
          ? `<li class="mac-empty">Alef needs Automation access to System Events (System Settings → Privacy &amp; Security → Automation).</li>`
          : `<li class="mac-empty">Couldn't read the app list (${escapeHtml(why)}). Try Refresh.</li>`;
    if (count) count.textContent = "";
    return;
  }
  if (count) count.textContent = String(state.running.length);
  list.innerHTML = state.running
    .map((a) => {
      const av = appAvatar(a.name);
      const n = escapeHtml(a.name);
      const status = a.frontmost ? `<span class="mac-tag mac-tag-front">in front</span>` : a.hidden ? `<span class="mac-tag">hidden</span>` : "";
      return `<li class="mac-app${a.frontmost ? " front" : ""}" data-name="${n}">
        <span class="mac-avatar${av.emoji ? " emoji" : ""}" style="--mac-tile:${av.color}" aria-hidden="true">${escapeHtml(av.glyph)}</span>
        <span class="mac-app-name" title="${escapeHtml(a.bundleId ?? a.name)}">${n}</span>${status}
        <span class="mac-app-actions">
          <button type="button" class="mac-btn" data-app="focus" title="Bring ${n} to the front">Focus</button>
          <button type="button" class="mac-btn" data-app="hide" title="Hide ${n}">Hide</button>
          <button type="button" class="mac-btn mac-btn-hot" data-app="quit" title="Quit ${n} (Undo relaunches it for 5s)">Quit</button>
        </span>
      </li>`;
    })
    .join("");
}

function renderShortcuts(): void {
  const list = q<HTMLElement>(".mac-shortcuts");
  const count = q<HTMLElement>(".mac-sc-count");
  if (!list) return;
  if (state.shortcutsError) {
    list.innerHTML = `<li class="mac-empty">Could not read your Shortcuts (the <code>shortcuts</code> command failed).</li>`;
    return;
  }
  if (!state.shortcuts) {
    list.innerHTML = `<li class="mac-empty">Loading shortcuts…</li>`;
    return;
  }
  if (count) count.textContent = String(state.shortcuts.length);
  const f = (q<HTMLInputElement>(".mac-sc-filter")?.value ?? "").trim().toLowerCase();
  const shown = state.shortcuts.filter((s) => !f || s.toLowerCase().includes(f));
  list.innerHTML = shown.length
    ? shown
        .slice(0, 80)
        .map((s) => `<li class="mac-sc"><span class="mac-sc-name">${escapeHtml(s)}</span><button type="button" class="mac-btn" data-shortcut="${escapeHtml(s)}" title="Run the shortcut “${escapeHtml(s)}”">▶ Run</button></li>`)
        .join("")
    : `<li class="mac-empty">${state.shortcuts.length ? "No shortcut matches." : "You have no Shortcuts yet."}</li>`;
}

function renderSuggest(): void {
  const input = q<HTMLInputElement>(".mac-launch-input");
  const ul = q<HTMLElement>(".mac-suggest");
  if (!input || !ul) return;
  const intent = launcherIntent(input.value);
  if (intent.kind === "empty") {
    ul.innerHTML = "";
    return;
  }
  if (intent.kind === "target") {
    ul.innerHTML = `<li><button type="button" class="mac-sug" data-target="${escapeHtml(intent.target)}">↗ Open ${escapeHtml(intent.target)}</button></li>`;
    return;
  }
  const hits = rankApps(state.installed, intent.query);
  ul.innerHTML = hits.length
    ? hits
        .map((a, i) => {
          const av = appAvatar(a.name);
          return `<li><button type="button" class="mac-sug${i === 0 ? " first" : ""}" data-open="${escapeHtml(a.name)}" title="${escapeHtml(a.path)}"><span class="mac-avatar sm${av.emoji ? " emoji" : ""}" style="--mac-tile:${av.color}" aria-hidden="true">${escapeHtml(av.glyph)}</span>${escapeHtml(a.name)}${i === 0 ? `<kbd>Enter</kbd>` : ""}</button></li>`;
        })
        .join("")
    : `<li class="mac-empty">No installed app matches.</li>`;
}

let refreshing = false;

async function refresh(ctx: ClientContext): Promise<void> {
  if (!pane || refreshing) return;
  refreshing = true;
  try {
    const [apps, context] = await Promise.all([ctx.api.getJson<unknown>("/api/mac/apps", 12_000), ctx.api.getJson<unknown>("/api/mac/context", 12_000)]);
    // A slow / failed read keeps the last good list; the error shows only when we never had one.
    const parsed = parseRunningApps(apps);
    state.running = parsed ?? state.running;
    if (!parsed) state.appsError = isRecord(apps) && typeof apps.error === "string" ? apps.error : "no answer from the world server";
    const line = q<HTMLElement>(".mac-context");
    if (line) line.textContent = contextLine(parseContext(context));
    renderApps();
  } finally {
    refreshing = false;
  }
}

async function loadOnce(ctx: ClientContext): Promise<void> {
  const [installed, shortcuts] = await Promise.all([ctx.api.getJson<unknown>("/api/mac/installed"), ctx.api.getJson<unknown>("/api/mac/shortcuts", 15_000)]);
  state.installed = parseInstalledApps(installed) ?? [];
  state.shortcuts = parseShortcuts(shortcuts);
  state.shortcutsError = state.shortcuts === null;
  renderShortcuts();
  renderSuggest();
}

// ---------------------------------------------------------------- wiring

function wire(ctx: ClientContext, el: HTMLElement): void {
  el.addEventListener("click", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null;
    const btn = t?.closest<HTMLButtonElement>("button");
    if (!btn) return;
    if (btn.dataset.mac === "refresh") return void refresh(ctx);
    const appAct = btn.dataset.app as MacAppAction | undefined;
    const name = btn.closest<HTMLElement>(".mac-app")?.dataset.name;
    if (appAct && name) return void appAction(ctx, appAct, name);
    const sys = btn.dataset.sys as MacSystemAction | undefined;
    if (sys) return void systemAction(ctx, sys);
    if (btn.dataset.open) return void launch(ctx, btn.dataset.open);
    if (btn.dataset.target) return void openTarget(ctx, btn.dataset.target);
    if (btn.dataset.shortcut) return void runShortcut(ctx, btn.dataset.shortcut);
    const lang = btn.dataset.lang;
    if (lang === "applescript" || lang === "jxa") {
      state.lang = lang;
      el.querySelectorAll<HTMLButtonElement>(".mac-lang-btn").forEach((b) => {
        const on = b.dataset.lang === lang;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      });
    }
  });

  const launchInput = el.querySelector<HTMLInputElement>(".mac-launch-input");
  launchInput?.addEventListener("input", renderSuggest);
  el.querySelector<HTMLFormElement>(".mac-launch")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const intent = launcherIntent(launchInput?.value ?? "");
    if (intent.kind === "target") return void openTarget(ctx, intent.target);
    if (intent.kind !== "app") return;
    const top = rankApps(state.installed, intent.query, 1)[0];
    void launch(ctx, top ? top.name : intent.query);
  });

  const range = el.querySelector<HTMLInputElement>(".mac-volume-range");
  const out = el.querySelector<HTMLOutputElement>(".mac-volume-out");
  range?.addEventListener("input", () => {
    if (out) out.textContent = `${range.value}%`;
  });
  // "change" fires when the user lets go: one action per drag, not one per pixel.
  range?.addEventListener("change", () => void systemAction(ctx, "volume", Number(range.value)));

  el.querySelector<HTMLFormElement>(".mac-notify")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = el.querySelector<HTMLInputElement>(".mac-notify-input");
    const text = input?.value.trim() ?? "";
    if (!text) return;
    void systemAction(ctx, "notify", text);
    if (input) input.value = "";
  });

  el.querySelector<HTMLInputElement>(".mac-sc-filter")?.addEventListener("input", renderShortcuts);

  const scriptForm = el.querySelector<HTMLFormElement>(".mac-script");
  scriptForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void runScript(ctx);
  });
  el.querySelector<HTMLTextAreaElement>(".mac-script-src")?.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // typing a script never triggers the world's single-key shortcuts
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void runScript(ctx);
    }
  });
}

async function launch(ctx: ClientContext, name: string): Promise<void> {
  const input = q<HTMLInputElement>(".mac-launch-input");
  if (input) input.value = "";
  renderSuggest();
  await appAction(ctx, "open", name);
}

function focusIn(ctx: ClientContext, selector: string): void {
  ctx.openRightTab("mac");
  requestAnimationFrame(() => q<HTMLElement>(selector)?.focus());
}

export const macFeature: ClientFeature = {
  id: "mac",
  mount(ctx) {
    const el = document.getElementById("alef-pane-mac");
    if (!el) return;
    pane = el;
    el.innerHTML = paneHtml();
    wire(ctx, el);
    renderShortcuts();
    let loaded = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // Reads only while the tab is on screen; nothing here ever runs an action.
    const onVisibility = (): void => {
      if (!el.hidden) {
        if (!loaded) {
          loaded = true;
          void loadOnce(ctx).catch((err: unknown) => log.warn("mac", "initial load failed", err));
        }
        void refresh(ctx);
        timer ??= setInterval(() => {
          if (!document.hidden) void refresh(ctx);
        }, REFRESH_MS);
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    new MutationObserver(onVisibility).observe(el, { attributes: true, attributeFilter: ["hidden"] });
    onVisibility();
  },
  paletteCommands(ctx) {
    return [
      { id: "open-app", title: "Open app…", meta: "Mac tab: type an app, file or URL, Enter opens", keywords: ["mac", "launch", "app", "open"], run: () => focusIn(ctx, ".mac-launch-input") },
      { id: "run-shortcut", title: "Run shortcut…", meta: "Mac tab: your macOS Shortcuts", keywords: ["mac", "shortcuts", "automation"], run: () => focusIn(ctx, ".mac-sc-filter") },
    ];
  },
};
