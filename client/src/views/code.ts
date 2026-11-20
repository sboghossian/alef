// 💻 Code: the selected agent's repo, VS Code style, read-only. The main area is the tabbed
// editor (syntax colours, line numbers, a Diff mode per file, unified or side by side vs HEAD)
// over a docked bottom panel: the agent's live terminal + Problems (tool errors from activity) +
// Changes (git status). The explorer (touched files badged) and the agent card (state, todos,
// subagents, Open in VS Code) live in the LEFT SIDEBAR as sections. ⌘P = quick open.
// Data: B's /api/code/:agentId/* (shared/features/code.ts). Never renders a refused file.

import type {
  CodeDiffResponse,
  CodeFileResponse,
  CodeRepo,
  CodeStatusResponse,
  CodeTouchedFile,
  CodeTouchedResponse,
  CodeTreeEntry,
  CodeTreeResponse,
} from "../../../shared/features/code";
import type { TalkActionResult } from "../../../shared/features/talk";
import type { WorldAgent } from "../../../shared/types";
import { resumeStartedText } from "../features/resume-guard";
import { shortModel, subagentData } from "../features/subagent-data";
import { resumeOfferFor } from "../features/talk";
import { onTodosChange, todoListElement, todoListFor } from "../features/todos";
import { log } from "../log";
import type { AlefView, FilterSpec, FilterState, Selection, ViewContext } from "../shell/views";
import { escapeHtml, formatTokens, relativeTime } from "../ui/fuzzy";
import { createTerminal, type TerminalHandle } from "../ui/terminal";
import { explainError, fetchResult } from "./code-api";
import {
  ancestors,
  buildTree,
  diffStats,
  extCounts,
  mergeTouchedEntries,
  parseUnifiedDiff,
  problemsFrom,
  quickOpen,
  sideBySide,
  statusMap,
  touchedLabel,
  type DiffLine,
  type TreeNode,
} from "./code-lib";
import { extOf, langFromPath, lineHtml, tokenize } from "./code-tokenize";
import "./code.css";
import { agentTitle } from "../../../shared/display";

const esc = escapeHtml;

// ---------------------------------------------------------------- agent choice (pure-ish)

/** $HOME itself: not a project, but its sessions can still open the repos they touched. */
export function isHomeCwd(cwd: string): boolean {
  return /^\/(Users|home)\/[^/]+\/?$/.test(cwd);
}

/** Home, "/" (B refuses those) and temp folders are not projects. */
export function isProjectCwd(cwd: string): boolean {
  const c = cwd.replace(/\/+$/, "");
  return c !== "" && !/^\/(Users|home)\/[^/]+$/.test(c) && c !== "/root" && !/^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(c);
}

/** Agents the Code view can open: project folders only, live first, then most recent. */
export function codeAgents(agents: readonly WorldAgent[], repo: string | null): WorldAgent[] {
  return agents
    .filter((a) => (isProjectCwd(a.cwd) || isHomeCwd(a.cwd)) && (!repo || a.islandId === repo))
    .sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || Date.parse(b.lastActive) - Date.parse(a.lastActive));
}

// ---------------------------------------------------------------- state

interface Tab {
  path: string;
  mode: "code" | "diff";
}

interface FileState {
  loading: boolean;
  file: CodeFileResponse | null;
  error: string | null;
  diff: CodeDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
}

interface Dom {
  root: HTMLElement;
  explorer: HTMLElement;
  exHead: HTMLElement;
  tree: HTMLElement;
  editor: HTMLElement;
  tabs: HTMLElement;
  toolbar: HTMLElement;
  body: HTMLElement;
  panel: HTMLElement;
  panelTabs: HTMLElement;
  termHost: HTMLElement;
  problems: HTMLElement;
  changes: HTMLElement;
  card: HTMLElement;
  phoneTabs: HTMLElement;
  quick: HTMLElement;
  quickInput: HTMLInputElement;
  quickList: HTMLElement;
}

let ctx: ViewContext | null = null;
let dom: Dom | null = null;
let filters: FilterState = {};
let agentId: string | null = null;
let root = "";
let entries: CodeTreeEntry[] = [];
let truncated = false;
let touched = new Map<string, CodeTouchedFile>();
let outsideTouched: CodeTouchedFile[] = [];
let status: CodeStatusResponse | null = null;
let dirty = new Map<string, string>();
let repoError: string | null = null;
/** Repos this session can browse (server: cwd repo + git roots of its touched files). */
let repos: CodeRepo[] = [];
/** The repo the user picked in the "Session repo" filter; null = the server's default. */
let pickedRepo: string | null = null;
let loadingRepo = false;
const expanded = new Set<string>();
let tabs: Tab[] = [];
let active = -1;
const files = new Map<string, FileState>();
let split = false;
let panelTab: "terminal" | "problems" | "changes" = "terminal";
let phonePane: "editor" | "terminal" = "editor";
let term: TerminalHandle | null = null;
let termAgent: string | null = null;
let quickSel = 0;
let quickItems: string[] = [];
let abort: AbortController | null = null;
let subscribed = false;
let unTodos: (() => void) | null = null;
let userPickedAgent = false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function currentAgent(): WorldAgent | undefined {
  return agentId ? ctx?.store.agents.get(agentId) : undefined;
}

// ---------------------------------------------------------------- DOM (built once, reused across mounts)

function buildDom(): Dom {
  const r = h("div", "cdv-root");
  const phoneTabs = h("div", "cdv-phone-tabs ch-seg");
  phoneTabs.setAttribute("role", "tablist");
  // Phones: the explorer and the agent card are in the left sheet (🔍); here only the two panes.
  for (const [id, label] of [
    ["editor", "📝 Editor"],
    ["terminal", "⌨️ Terminal"],
  ] as const) {
    const b = h("button", "cdv-phone-tab", label);
    b.type = "button";
    b.dataset.pane = id;
    b.setAttribute("role", "tab");
    phoneTabs.append(b);
  }

  const explorer = h("aside", "cdv-explorer cdv-box");
  explorer.id = "code-explorer";
  explorer.setAttribute("aria-label", "Explorer");
  const exHead = h("div", "cdv-box-head");
  const tree = h("div", "cdv-tree");
  tree.setAttribute("role", "tree");
  explorer.append(exHead, tree);

  const editor = h("section", "cdv-editor cdv-box");
  editor.setAttribute("aria-label", "Editor");
  const tabsEl = h("div", "cdv-tabs");
  tabsEl.setAttribute("role", "tablist");
  const toolbar = h("div", "cdv-toolbar");
  const body = h("div", "cdv-body");
  body.tabIndex = 0;
  editor.append(tabsEl, toolbar, body);

  const panel = h("section", "cdv-panel cdv-box");
  panel.id = "code-panel";
  const panelTabs = h("div", "cdv-box-head cdv-panel-tabs ch-seg");
  panelTabs.setAttribute("role", "tablist");
  const termHost = h("div", "cdv-term-host");
  const problems = h("div", "cdv-problems cdv-scroll");
  const changes = h("div", "cdv-changes cdv-scroll");
  panel.append(panelTabs, termHost, problems, changes);

  const card = h("aside", "cdv-card cdv-box");
  card.id = "code-agent-card";
  card.setAttribute("aria-label", "Agent");

  const quick = h("div", "cdv-quick");
  quick.hidden = true;
  const qcard = h("div", "cdv-quick-card");
  qcard.setAttribute("role", "dialog");
  qcard.setAttribute("aria-label", "Quick open a file");
  const quickInput = h("input", "cdv-quick-input");
  quickInput.type = "search";
  quickInput.placeholder = "Go to file… (type part of a name)";
  quickInput.setAttribute("aria-label", "File name");
  const quickList = h("ul", "cdv-quick-list");
  quickList.setAttribute("role", "listbox");
  qcard.append(quickInput, quickList);
  quick.append(qcard);

  // The explorer and the card are re-parented into left-sidebar sections (filters()).
  r.append(phoneTabs, editor, panel, quick);

  const d: Dom = { root: r, explorer, exHead, tree, editor, tabs: tabsEl, toolbar, body, panel, panelTabs, termHost, problems, changes, card, phoneTabs, quick, quickInput, quickList };
  wire(d);
  return d;
}

function wire(d: Dom): void {
  d.phoneTabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-pane]");
    if (!b) return;
    phonePane = (b.dataset.pane as typeof phonePane) ?? "editor";
    if (phonePane === "terminal") panelTab = "terminal";
    renderLayout();
    renderPanel();
  });
  d.tree.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-path]");
    if (!row) return;
    const path = row.dataset.path ?? "";
    if (row.dataset.dir === "1") {
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      renderTree();
      return;
    }
    openFile(path, dirty.has(path) && row.dataset.mode === "diff" ? "diff" : "code");
  });
  d.exHead.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "collapse-all") {
      expanded.clear();
      renderTree();
    } else if (b.dataset.act === "quick") openQuick();
  });
  d.tabs.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const close = t.closest<HTMLElement>("[data-close]");
    if (close) {
      ev.stopPropagation();
      closeTab(Number(close.dataset.close));
      return;
    }
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      active = Number(tab.dataset.tab);
      renderEditor();
    }
  });
  d.tabs.addEventListener("auxclick", (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (tab && ev.button === 1) closeTab(Number(tab.dataset.tab));
  });
  d.toolbar.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    const tab = tabs[active];
    if (!b || !tab) return;
    const act = b.dataset.act;
    if (act === "code" || act === "diff") {
      tab.mode = act;
      if (act === "diff") ensureDiff(tab.path);
      renderEditor();
    } else if (act === "split" || act === "unified") {
      split = act === "split";
      renderEditor();
    } else if (act === "reveal") {
      for (const a of ancestors(tab.path)) expanded.add(a);
      renderTree(tab.path);
    }
  });
  d.body.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-open]");
    if (b) openFile(b.dataset.open ?? "", b.dataset.mode === "diff" ? "diff" : "code");
  });
  d.panelTabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-ptab]");
    if (!b) return;
    panelTab = (b.dataset.ptab as typeof panelTab) ?? "terminal";
    renderPanel();
  });
  d.changes.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-open]");
    if (b) openFile(b.dataset.open ?? "", "diff");
  });
  d.card.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!b || !ctx || !agentId) return;
    const id = agentId;
    const c = ctx;
    if (b.dataset.act === "vscode") {
      b.disabled = true;
      void c.api.openEditor(id).then((r) => {
        b.disabled = false;
        c.toast(r.ok ? "Opening VS Code…" : `Could not open VS Code: ${r.error ?? "unknown error"}`, r.ok ? "info" : "error");
      });
    } else if (b.dataset.act === "room") c.showView("room", id);
    else if (b.dataset.act === "orbit") {
      c.selection.set({ kind: "agent", id });
      c.showView("orbit");
    }
  });
  d.quick.addEventListener("click", (ev) => {
    if (ev.target === d.quick) closeQuick();
    const li = (ev.target as HTMLElement).closest<HTMLElement>("[data-qi]");
    if (li) pickQuick(Number(li.dataset.qi));
  });
  d.quickInput.addEventListener("input", () => {
    quickSel = 0;
    renderQuick();
  });
  d.quickInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = quickItems.length;
      if (n) quickSel = (quickSel + (ev.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderQuick();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pickQuick(quickSel);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeQuick();
    }
  });
}

// ---------------------------------------------------------------- loading

/** `repo=<root>` for every /api/code call once a repo is known ("" = server default). */
function repoQuery(r: string | null): string {
  return r ? `repo=${encodeURIComponent(r)}` : "";
}

/** Images, archives, fonts…: never the file Code opens for you on arrival. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|mp[34]|mov|wav|woff2?|ttf|otf|sqlite|db)$/i;

/** Agents the server said have no repo to show (409), skipped when Code picks an agent for you. */
const noRepo = new Set<string>();

async function loadRepo(id: string): Promise<void> {
  abort?.abort();
  const ac = new AbortController();
  abort = ac;
  loadingRepo = true;
  repoError = null;
  entries = [];
  touched = new Map();
  outsideTouched = [];
  status = null;
  dirty = new Map();
  root = "";
  tabs = [];
  active = -1;
  files.clear();
  expanded.clear();
  renderAll();
  const base = `/api/code/${encodeURIComponent(id)}`;
  // touched first: it names the repo (the pick, or the server's default) the rest must use.
  const tch = await fetchResult<CodeTouchedResponse>(`${base}/touched?${repoQuery(pickedRepo)}`, ac.signal);
  if (ac.signal.aborted || agentId !== id) return;
  const chosen = tch.ok ? tch.data.root : pickedRepo;
  const [tree, st] = await Promise.all([
    fetchResult<CodeTreeResponse>(`${base}/tree?path=&${repoQuery(chosen)}`, ac.signal, 60_000),
    fetchResult<CodeStatusResponse>(`${base}/status?${repoQuery(chosen)}`, ac.signal),
  ]);
  if (ac.signal.aborted || agentId !== id) return;
  repos = tree.ok ? tree.data.repos : tch.ok ? tch.data.repos : [];
  loadingRepo = false;
  if (!tree.ok) {
    // A home-folder agent that touched no git repo (409): if we picked it for you, skip to the next.
    if (tree.status === 409 && !userPickedAgent) {
      noRepo.add(id);
      const next = defaultAgent();
      if (next && next !== id) {
        setAgent(next);
        return;
      }
    }
    repoError = tree.error;
    renderAll();
    return;
  }
  root = tree.data.root;
  truncated = tree.data.truncated;
  if (tch.ok) {
    for (const f of tch.data.files) if (f.insideRepo) touched.set(f.path, f);
    outsideTouched = tch.data.files.filter((f) => !f.insideRepo);
  }
  entries = mergeTouchedEntries(tree.data.entries, tch.ok ? tch.data.files : []);
  if (st.ok) {
    status = st.data;
    dirty = statusMap(st.data.dirty);
  }
  for (const p of touched.keys()) for (const a of ancestors(p)) expanded.add(a);
  // Open the most recent touched file inside the repo, so the view starts on real work.
  const openable = tch.ok ? tch.data.files.filter((f) => f.insideRepo && entries.some((e) => e.path === f.path && !e.blocked)) : [];
  const first = openable.find((f) => !BINARY_EXT.test(f.path)) ?? openable[0];
  if (first) openFile(first.path, dirty.has(first.path) ? "diff" : "code");
  renderAll();
  ctx?.refreshFilters();
}

function fileState(path: string): FileState {
  let s = files.get(path);
  if (!s) {
    s = { loading: false, file: null, error: null, diff: null, diffError: null, diffLoading: false };
    files.set(path, s);
  }
  return s;
}

function ensureFile(path: string): void {
  const id = agentId;
  const s = fileState(path);
  if (!id || s.loading || s.file || s.error) return;
  const entry = entries.find((e) => e.path === path);
  if (entry?.blocked) {
    s.error = explainError(403, "secret");
    return;
  }
  s.loading = true;
  void fetchResult<CodeFileResponse>(`/api/code/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&${repoQuery(root)}`, abort?.signal).then((r) => {
    if (agentId !== id) return;
    s.loading = false;
    if (r.ok) s.file = r.data;
    else if (r.error !== "cancelled") s.error = explainError(r.status, r.error);
    if (tabs[active]?.path === path) renderEditor();
  });
}

function ensureDiff(path: string): void {
  const id = agentId;
  const s = fileState(path);
  if (!id || s.diffLoading || s.diff || s.diffError) return;
  s.diffLoading = true;
  void fetchResult<CodeDiffResponse>(`/api/code/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}&${repoQuery(root)}`, abort?.signal).then((r) => {
    if (agentId !== id) return;
    s.diffLoading = false;
    if (r.ok) s.diff = r.data;
    else if (r.error !== "cancelled") s.diffError = explainError(r.status, r.error);
    if (tabs[active]?.path === path) renderEditor();
  });
}

function openFile(path: string, mode: "code" | "diff"): void {
  if (!path) return;
  let i = tabs.findIndex((t) => t.path === path);
  if (i < 0) {
    tabs.push({ path, mode });
    i = tabs.length - 1;
  } else tabs[i] = { path, mode };
  active = i;
  ensureFile(path);
  if (mode === "diff") ensureDiff(path);
  if (document.body.classList.contains("alef-phone")) phonePane = "editor";
  renderTabs();
  renderEditor();
  renderLayout();
  renderTree();
}

function closeTab(i: number): void {
  if (i < 0 || i >= tabs.length) return;
  tabs.splice(i, 1);
  if (active >= tabs.length) active = tabs.length - 1;
  else if (i < active) active--;
  renderTabs();
  renderEditor();
}

// ---------------------------------------------------------------- rendering

function renderAll(): void {
  renderLayout();
  renderExplorer();
  renderTabs();
  renderEditor();
  renderPanel();
  renderCard();
}

function renderLayout(): void {
  if (!dom) return;
  dom.root.dataset.pane = phonePane;
  for (const b of dom.phoneTabs.querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset.pane === phonePane;
    b.setAttribute("aria-selected", String(on));
    b.classList.toggle("cdv-on", on);
  }
}

function renderExplorer(): void {
  if (!dom) return;
  const a = currentAgent();
  const name = root ? root.split("/").pop() ?? root : a ? a.islandId : "No agent";
  const branch = status?.git ? `⎇ ${status.branch ?? "detached"}` : status && !status.git ? "not a git repo" : "";
  dom.exHead.innerHTML = `<span class="cdv-box-title" title="${esc(`${root}${branch ? ` · ${branch}` : ""}`)}">📁 ${esc(name)}</span>
    <span class="cdv-head-btns"><button type="button" class="cdv-mini" data-act="quick" title="Go to file (⌘P)">⌘P</button><button type="button" class="cdv-mini" data-act="collapse-all" title="Collapse all folders">⊟</button></span>`;
  renderTree();
}

function treeRows(n: TreeNode, depth: number, out: string[], focusPath?: string): void {
  for (const c of n.children) {
    const open = c.dir && (expanded.has(c.path) || filters.touched?.[0] === "on" || (filters.type?.length ?? 0) > 0);
    const t = touched.get(c.path);
    const st = dirty.get(c.path);
    const activeFile = tabs[active]?.path === c.path;
    const badges = [
      !c.dir && t ? `<span class="cdv-badge cdv-touch" title="${esc(`This session: ${touchedLabel(t)}${t.lastAt ? ` · ${relativeTime(t.lastAt)}` : ""}`)}">✎${t.count}</span>` : "",
      c.dir && c.touched ? `<span class="cdv-dirdot" title="${c.touched} touched file${c.touched === 1 ? "" : "s"} inside">${c.touched}</span>` : "",
      !c.dir && st ? `<span class="cdv-git cdv-git-${esc(st)}" title="git: ${esc(st === "U" ? "untracked" : st === "M" ? "modified" : st === "A" ? "added" : st === "D" ? "deleted" : st)}">${esc(st)}</span>` : "",
      c.blocked ? `<span class="cdv-lock" title="Secret-looking file: never shown">🔒</span>` : "",
    ].join("");
    const icon = c.dir ? (open ? "▾" : "▸") : fileIcon(c.path);
    out.push(
      `<div class="cdv-row${c.dir ? " cdv-dir" : ""}${activeFile ? " cdv-active" : ""}${c.blocked ? " cdv-blocked" : ""}${t ? " cdv-touched" : ""}${focusPath === c.path ? " cdv-flash" : ""}" role="treeitem" tabindex="-1" aria-expanded="${c.dir ? String(open) : ""}" data-path="${esc(c.path)}" data-dir="${c.dir ? "1" : "0"}"${st ? ' data-mode="diff"' : ""} style="--depth:${depth}" title="${esc(c.path)}"><span class="cdv-ico" aria-hidden="true">${icon}</span><span class="cdv-name">${esc(c.name)}</span>${badges}</div>`,
    );
    if (c.dir && open) treeRows(c, depth + 1, out, focusPath);
  }
}

const EXT_ICON: Record<string, string> = { ts: "🟦", tsx: "🟦", js: "🟨", jsx: "🟨", mjs: "🟨", json: "🟫", md: "📘", py: "🐍", css: "🎨", html: "🌐", sh: "🐚", svg: "🖼", png: "🖼", jpg: "🖼" };
function fileIcon(path: string): string {
  return EXT_ICON[extOf(path)] ?? "📄";
}

function renderTree(focusPath?: string): void {
  if (!dom) return;
  if (!agentId) {
    dom.tree.innerHTML = `<p class="cdv-empty">Pick an agent in the sidebar to see its repo.</p>`;
    return;
  }
  if (loadingRepo) {
    dom.tree.innerHTML = `<p class="cdv-empty">Loading the repo… (a big repo can take a few seconds)</p>`;
    return;
  }
  if (repoError) {
    dom.tree.innerHTML = `<p class="cdv-empty cdv-err">${esc(repoError === "this agent's folder is not a project (home or /)" ? "This agent ran in your home folder, not in a project, so there is no repo to show. Pick another agent in the sidebar." : explainError(0, repoError))}</p>`;
    return;
  }
  const t = buildTree(entries, new Set(touched.keys()), { touchedOnly: filters.touched?.[0] === "on", exts: filters.type ?? [] });
  const rows: string[] = [];
  treeRows(t, 0, rows, focusPath);
  const fileCount = entries.filter((e) => e.type !== "dir").length;
  const foot = `<p class="cdv-tree-foot">${fileCount} files${truncated ? " (first 2000 only)" : ""} · ${touched.size} touched by this session${dirty.size ? ` · ${dirty.size} changed` : ""}</p>`;
  const outside = outsideTouched.length
    ? `<details class="cdv-outside"><summary>Outside this repo · ${outsideTouched.length}</summary><ul>${outsideTouched
        .slice(0, 30)
        .map((f) => `<li title="${esc(f.path)}"><span class="cdv-name">${esc(shortAbs(f.path))}</span> <span class="cdv-badge cdv-touch">${esc(f.lastTool)}</span></li>`)
        .join("")}</ul></details>`
    : "";
  dom.tree.innerHTML = (rows.length ? rows.join("") : `<p class="cdv-empty">${filters.touched?.[0] === "on" ? "This session did not touch any file in this repo." : "No file matches the filters."}</p>`) + foot + outside;
  if (focusPath) dom.tree.querySelector<HTMLElement>(".cdv-flash")?.scrollIntoView({ block: "center" });
}

function shortAbs(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^(.{12}).{8,}(.{40})$/, "$1…$2");
}

function renderTabs(): void {
  if (!dom) return;
  dom.tabs.innerHTML = tabs
    .map((t, i) => {
      const name = t.path.split("/").pop() ?? t.path;
      const on = i === active;
      return `<div class="cdv-tab${on ? " cdv-on" : ""}" role="tab" aria-selected="${on}" data-tab="${i}" title="${esc(t.path)}"><span aria-hidden="true">${fileIcon(t.path)}</span><span class="cdv-tab-name">${esc(name)}</span>${t.mode === "diff" ? '<span class="cdv-tab-diff">diff</span>' : ""}${touched.has(t.path) ? '<span class="cdv-tab-dot" title="touched by this session">●</span>' : ""}<button type="button" class="cdv-tab-x" data-close="${i}" aria-label="Close ${esc(name)}">×</button></div>`;
    })
    .join("");
}

function renderEditor(): void {
  if (!dom) return;
  renderTabs();
  const tab = tabs[active];
  if (!tab) {
    dom.toolbar.innerHTML = "";
    dom.body.innerHTML = welcomeHtml();
    return;
  }
  const s = fileState(tab.path);
  const st = dirty.get(tab.path);
  const lang = langFromPath(tab.path);
  const lines = s.file ? s.file.content.split("\n").length : 0;
  const dl = s.diff ? parseUnifiedDiff(s.diff.diff) : null;
  const ds = dl ? diffStats(dl) : null;
  const crumbs = tab.path.split("/").map((p) => `<span>${esc(p)}</span>`).join('<span class="cdv-sep">›</span>');
  dom.toolbar.innerHTML = `<div class="cdv-crumbs" title="${esc(`${root}/${tab.path}`)}">${crumbs}</div>
    <div class="cdv-tools">
      ${st ? `<span class="cdv-git cdv-git-${esc(st)}">${esc(st)}</span>` : ""}
      <span class="cdv-meta">${esc(lang === "text" ? extOf(tab.path) || "text" : lang)}${s.file ? ` · ${lines} lines · ${fmtBytes(s.file.size)}` : ""}</span>
      <span class="cdv-seg ch-seg" role="group" aria-label="View">
        <button type="button" data-act="code" aria-pressed="${tab.mode === "code"}">Code</button>
        <button type="button" data-act="diff" aria-pressed="${tab.mode === "diff"}">Diff${ds ? ` <b class="cdv-plus">+${ds.add}</b> <b class="cdv-minus">−${ds.del}</b>` : ""}</button>
      </span>
      ${tab.mode === "diff" ? `<span class="cdv-seg ch-seg" role="group" aria-label="Diff layout"><button type="button" data-act="unified" aria-pressed="${!split}">Unified</button><button type="button" data-act="split" aria-pressed="${split}">Side by side</button></span>` : ""}
      <button type="button" class="cdv-mini" data-act="reveal" title="Show in the explorer">⌖</button>
    </div>`;
  if (tab.mode === "diff") {
    dom.body.innerHTML = diffHtml(tab.path, s);
    return;
  }
  if (s.error) {
    dom.body.innerHTML = `<div class="cdv-refused">${esc(s.error)}</div>`;
    return;
  }
  if (!s.file) {
    dom.body.innerHTML = `<p class="cdv-empty">Opening ${esc(tab.path)}…</p>`;
    return;
  }
  dom.body.innerHTML = codeHtml(s.file.content, lang);
  dom.body.scrollTop = 0;
}

function codeHtml(content: string, lang: ReturnType<typeof langFromPath>): string {
  const toks = tokenize(content, lang);
  if (toks.length > 1 && toks[toks.length - 1]?.length === 0) toks.pop();
  let out = `<div class="cdv-code" style="--gw:${String(toks.length).length + 1}ch">`;
  toks.forEach((line, i) => {
    out += `<div class="cdv-ln"><span class="cdv-no">${i + 1}</span><span class="cdv-tx">${lineHtml(line) || " "}</span></div>`;
  });
  return `${out}</div>`;
}

function diffLineHtml(l: DiffLine | null, lang: ReturnType<typeof langFromPath>, side?: "old" | "new"): string {
  if (!l) return `<div class="cdv-dl cdv-dnone"><span class="cdv-no"></span><span class="cdv-sign"></span><span class="cdv-tx"></span></div>`;
  const no = side === "old" ? l.oldNo : side === "new" ? l.newNo : null;
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
  const body = lineHtml(tokenize(l.text, lang)[0] ?? []) || " ";
  if (side) return `<div class="cdv-dl cdv-d${l.kind}"><span class="cdv-no">${no ?? ""}</span><span class="cdv-sign">${sign}</span><span class="cdv-tx">${body}</span></div>`;
  return `<div class="cdv-dl cdv-d${l.kind}"><span class="cdv-no">${l.oldNo ?? ""}</span><span class="cdv-no">${l.newNo ?? ""}</span><span class="cdv-sign">${sign}</span><span class="cdv-tx">${body}</span></div>`;
}

function diffHtml(path: string, s: FileState): string {
  if (s.diffError) return `<div class="cdv-refused">${esc(s.diffError)}</div>`;
  if (!s.diff) return `<p class="cdv-empty">Loading the diff…</p>`;
  if (!s.diff.git) return `<p class="cdv-empty">This folder is not a git repo, so there is nothing to diff against.</p>`;
  if (!s.diff.diff.trim()) {
    const st = dirty.get(path);
    return `<p class="cdv-empty">${st === "U" ? "This file is new and not tracked by git yet: the whole file is the change. Switch to Code to read it." : "No changes vs HEAD: this file is the same as the last commit."}</p>`;
  }
  const lang = langFromPath(path);
  const lines = parseUnifiedDiff(s.diff.diff);
  const note = s.diff.truncated ? `<p class="cdv-note">The diff is long; only the first 200 KB is shown.</p>` : "";
  if (!split) {
    return `${note}<div class="cdv-diff cdv-unified">${lines
      .map((l) => (l.kind === "hunk" || l.kind === "meta" ? `<div class="cdv-dl cdv-d${l.kind}"><span class="cdv-tx">${esc(l.text)}</span></div>` : diffLineHtml(l, lang)))
      .join("")}</div>`;
  }
  return `${note}<div class="cdv-diff cdv-split">${sideBySide(lines)
    .map((r) =>
      r.span
        ? `<div class="cdv-dl cdv-d${r.span.kind} cdv-span"><span class="cdv-tx">${esc(r.span.text)}</span></div>`
        : `<div class="cdv-pair">${diffLineHtml(r.left?.kind === "add" ? null : r.left, lang, "old")}${diffLineHtml(r.right?.kind === "del" ? null : r.right, lang, "new")}</div>`,
    )
    .join("")}</div>`;
}

function welcomeHtml(): string {
  if (!agentId) return `<div class="cdv-welcome"><h2>💻 Code</h2><p>Pick an agent in the left sidebar. You will see its repo, the files it touched, and its diffs. Everything here is read-only.</p></div>`;
  if (loadingRepo) return `<div class="cdv-welcome"><p>Loading the repo…</p></div>`;
  if (repoError) return `<div class="cdv-welcome"><h2>No repo for this agent</h2><p>${esc(repoError === "this agent's folder is not a project (home or /)" ? "It ran in your home folder, not inside a project. Pick an agent that worked in a repo (the sidebar lists them, live ones first)." : explainError(0, repoError))}</p></div>`;
  const recent = [...touched.values()].slice(0, 8);
  const changed = [...dirty.entries()].slice(0, 8);
  const li = (p: string, extra: string, mode: string): string =>
    `<li><button type="button" class="cdv-link" data-open="${esc(p)}" data-mode="${mode}"><span aria-hidden="true">${fileIcon(p)}</span> ${esc(p)}</button> ${extra}</li>`;
  return `<div class="cdv-welcome">
    <h2>Nothing open yet</h2>
    <p>Pick a file on the left, or press <kbd>⌘P</kbd> to jump to one.</p>
    ${recent.length ? `<h3>Touched by this session</h3><ul>${recent.map((t) => li(t.path, `<span class="cdv-badge cdv-touch">${esc(touchedLabel(t))}</span>`, dirty.has(t.path) ? "diff" : "code")).join("")}</ul>` : `<p class="cdv-meta">This session has not touched a file inside this repo.</p>`}
    ${changed.length ? `<h3>Uncommitted changes</h3><ul>${changed.map(([p, st]) => li(p, `<span class="cdv-git cdv-git-${esc(st)}">${esc(st)}</span>`, "diff")).join("")}</ul>` : ""}
  </div>`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function renderPanel(): void {
  if (!dom || !ctx) return;
  const probs = agentId ? problemsFrom(ctx.store.activities, agentId) : [];
  const onPhoneTerm = phonePane === "terminal";
  const tabsDef: Array<[typeof panelTab, string]> = [
    ["terminal", "⌨️ Terminal"],
    ["problems", `⚠️ Problems${probs.length ? ` <b>${probs.length}</b>` : ""}`],
    ["changes", `± Changes${dirty.size ? ` <b>${dirty.size}</b>` : ""}`],
  ];
  dom.panelTabs.innerHTML = tabsDef
    .map(([id, label]) => `<button type="button" role="tab" data-ptab="${id}" aria-selected="${panelTab === id}" class="${panelTab === id ? "cdv-on" : ""}">${label}</button>`)
    .join("");
  dom.termHost.hidden = panelTab !== "terminal";
  dom.problems.hidden = panelTab !== "problems";
  dom.changes.hidden = panelTab !== "changes";
  if (panelTab === "terminal" || onPhoneTerm) syncTerminal();
  dom.problems.innerHTML = probs.length
    ? `<ul>${probs.map((p) => `<li><span class="cdv-prob-ico" aria-hidden="true">⚠️</span><span class="cdv-prob-tx">${esc(p.summary)}</span><span class="cdv-meta">${esc(p.toolName ?? "")} · ${relativeTime(p.at)}</span></li>`).join("")}</ul>`
    : `<p class="cdv-empty">${agentId ? "No tool errors in this agent's recent activity. (Activity is a short live window: errors from before this page loaded are not listed.)" : "Pick an agent."}</p>`;
  dom.changes.innerHTML = !status
    ? `<p class="cdv-empty">${agentId ? (loadingRepo ? "Loading…" : "No git status for this agent.") : "Pick an agent."}</p>`
    : !status.git
      ? `<p class="cdv-empty">Not a git repo.</p>`
      : dirty.size
        ? `<ul>${[...dirty.entries()].map(([p, s]) => `<li><button type="button" class="cdv-link" data-open="${esc(p)}"><span class="cdv-git cdv-git-${esc(s)}">${esc(s)}</span> ${esc(p)}</button>${touched.has(p) ? ' <span class="cdv-badge cdv-touch">this session</span>' : ""}</li>`).join("")}</ul>${status.truncated ? `<p class="cdv-note">Showing the first 500 changes.</p>` : ""}`
        : `<p class="cdv-empty">Working tree clean on ${esc(status.branch ?? "HEAD")}: nothing uncommitted.</p>`;
}

function syncTerminal(): void {
  if (!dom || !ctx) return;
  if (termAgent === agentId && term) return;
  term?.dispose();
  term = null;
  termAgent = agentId;
  dom.termHost.replaceChildren();
  if (!agentId) {
    dom.termHost.innerHTML = `<p class="cdv-empty">Pick an agent to see its terminal.</p>`;
    return;
  }
  const id = agentId;
  const c = ctx;
  term = createTerminal(dom.termHost, id, {
    title: `Terminal · ${currentAgent()?.islandId ?? id.slice(0, 8)}`,
    onResume: async () => {
      const r = await c.api.postJson<TalkActionResult>(`/api/talk/reactivate/${encodeURIComponent(id)}`, undefined, (error) => ({ ok: false, error }));
      if (!r.ok) c.toast(`Could not resume: ${r.error ?? "unknown error"}`, "error");
      else c.toast(resumeStartedText(r));
    },
    resumeOffer: () => resumeOfferFor(id, c.store.agents.get(id)?.status),
  });
}

function renderCard(): void {
  if (!dom || !ctx) return;
  const a = currentAgent();
  if (!a) {
    dom.card.innerHTML = `<div class="cdv-box-head"><span class="cdv-box-title">🤖 Agent</span></div><p class="cdv-empty">No agent picked.</p>`;
    return;
  }
  const live = a.status === "live";
  const stateTxt = a.awaitingInput ? "Waiting on you" : live ? "Working" : "Asleep";
  const list = todoListFor(ctx, a.id);
  const subs = subagentData.byParent(a.id).slice(-8).reverse();
  dom.card.innerHTML = `<div class="cdv-box-head"><span class="cdv-box-title">🤖 Agent</span></div>
    <div class="cdv-card-body cdv-scroll">
      <p class="cdv-agent-title">${esc(agentTitle(a) || a.id)}</p>
      <p class="cdv-state"><span class="cdv-dot cdv-dot-${a.awaitingInput ? "awaiting" : live ? "live" : "asleep"}" aria-hidden="true"></span>${stateTxt} · ${relativeTime(a.lastActive)}</p>
      <dl class="cdv-facts">
        <dt>City</dt><dd>${esc(a.islandId)}</dd>
        <dt>Model</dt><dd>${esc(shortModel(a.model))}</dd>
        <dt>Tokens</dt><dd>${formatTokens(a.tokens)}</dd>
        <dt>Messages</dt><dd>${a.messageCount}</dd>
        ${root ? `<dt>Repo</dt><dd title="${esc(root)}">${esc(shortAbs(root))}</dd>` : ""}
        ${status?.git ? `<dt>Branch</dt><dd>${esc(status.branch ?? "detached")}</dd>` : ""}
      </dl>
      <div class="cdv-card-btns">
        <button type="button" class="cdv-btn cdv-primary" data-act="vscode" title="Runs: code ${esc(a.cwd)}">Open in VS Code</button>
        <button type="button" class="cdv-btn" data-act="room">🚪 Room</button>
        <button type="button" class="cdv-btn" data-act="orbit">🌍 Orbit</button>
      </div>
      <h4>Todos</h4><div class="cdv-todos"></div>
      <h4>Subagents${subs.length ? ` · ${subs.length}` : ""}</h4>
      ${subs.length ? `<ul class="cdv-subs">${subs.map((s) => `<li><span class="cdv-dot cdv-dot-${s.status === "running" ? "live" : s.status === "failed" ? "awaiting" : "asleep"}" aria-hidden="true"></span><span class="cdv-sub-tx">${esc(s.description || s.agentType || s.id)}</span><span class="cdv-meta">${esc(s.status)}</span></li>`).join("")}</ul>` : `<p class="cdv-empty">No subagents.</p>`}
    </div>`;
  const todos = dom.card.querySelector(".cdv-todos");
  if (todos) {
    if (list && list.items.length) todos.append(todoListElement(list));
    else todos.innerHTML = `<p class="cdv-empty">No todo list.</p>`;
  }
}

// ---------------------------------------------------------------- quick open

function allFiles(): string[] {
  return entries.filter((e) => e.type !== "dir" && !e.blocked).map((e) => e.path);
}

function openQuick(): void {
  if (!dom || !agentId || repoError) return;
  dom.quick.hidden = false;
  dom.quickInput.value = "";
  quickSel = 0;
  renderQuick();
  dom.quickInput.focus();
}

function closeQuick(): boolean {
  if (!dom || dom.quick.hidden) return false;
  dom.quick.hidden = true;
  dom.body.focus({ preventScroll: true });
  return true;
}

function renderQuick(): void {
  if (!dom) return;
  const items = quickOpen(dom.quickInput.value, allFiles().map((p) => ({ path: p, touched: touched.has(p) })), 40);
  quickItems = items.map((i) => i.path);
  if (quickSel >= quickItems.length) quickSel = 0;
  dom.quickList.innerHTML = items.length
    ? items
        .map((it, i) => {
          const base = it.path.split("/").pop() ?? it.path;
          const dir = it.path.slice(0, Math.max(0, it.path.length - base.length - 1));
          return `<li role="option" data-qi="${i}" aria-selected="${i === quickSel}" class="${i === quickSel ? "cdv-on" : ""}"><span aria-hidden="true">${fileIcon(it.path)}</span><b>${esc(base)}</b> <span class="cdv-meta">${esc(dir)}</span>${it.touched ? ' <span class="cdv-badge cdv-touch">✎</span>' : ""}</li>`;
        })
        .join("")
    : `<li class="cdv-empty">No file matches.</li>`;
  dom.quickList.querySelector(".cdv-on")?.scrollIntoView({ block: "nearest" });
}

function pickQuick(i: number): void {
  const p = quickItems[i];
  if (!p) return;
  closeQuick();
  openFile(p, "code");
  for (const a of ancestors(p)) expanded.add(a);
  renderTree(p);
}

function onKey(ev: KeyboardEvent): void {
  if (!(ev.metaKey || ev.ctrlKey)) return;
  const k = ev.key.toLowerCase();
  if (k === "p" && !ev.shiftKey) {
    ev.preventDefault();
    ev.stopPropagation();
    openQuick();
  } else if (k === "f" && ev.shiftKey) {
    ev.preventDefault();
    ctx?.toast("Search in the repo is not available yet: the server has no code-search endpoint. ⌘P finds files by name.");
  }
}

// ---------------------------------------------------------------- agent switching

function setAgent(id: string | null): void {
  if (id === agentId) return;
  agentId = id;
  pickedRepo = null;
  repos = [];
  term?.dispose();
  term = null;
  termAgent = null;
  if (id) void loadRepo(id);
  else {
    repoError = null;
    renderAll();
  }
}

function defaultAgent(): string | null {
  const c = ctx;
  if (!c) return null;
  const sel = c.selection.get();
  const repo = filters.repo?.[0] ?? null;
  if (sel?.kind === "agent") {
    const a = c.store.agents.get(sel.id);
    if (a && isProjectCwd(a.cwd) && (!repo || a.islandId === repo)) return a.id;
  }
  return codeAgents([...c.store.agents.values()], repo).find((a) => !noRepo.has(a.id))?.id ?? null;
}

function onActivity(): void {
  if (dom && ctx && dom.root.isConnected) renderPanel();
}

// ---------------------------------------------------------------- the view

export const codeView: AlefView = {
  id: "code",
  emoji: "💻",
  name: "Code",
  keys: ["8"],
  hint: "The agent's repo, VS Code style: touched files, diffs, its terminal (read-only)",
  mount(r, c) {
    ctx = c;
    dom ??= buildDom();
    r.append(dom.root);
    document.addEventListener("keydown", onKey, true);
    if (!subscribed) {
      subscribed = true;
      c.store.onActivity(onActivity);
      subagentData.onChange(() => {
        if (dom?.root.isConnected) renderCard();
      });
    }
    unTodos = onTodosChange(() => {
      if (dom?.root.isConnected) renderCard();
    });
    const param = c.route().param;
    if (param && c.store.agents.has(param)) {
      userPickedAgent = true;
      setAgent(param);
    }
    if (agentId && termAgent === null) syncTerminal();
    renderAll();
    const id = agentId;
    if (id) void subagentData.loadParent(c.api, id).then(() => renderCard());
  },
  unmount() {
    document.removeEventListener("keydown", onKey, true);
    unTodos?.();
    unTodos = null;
    term?.dispose();
    term = null;
    termAgent = null;
    if (dom) {
      closeQuick();
      dom.root.remove();
    }
    ctx = null;
  },
  filters(c): FilterSpec[] {
    const all = [...c.store.agents.values()];
    const repo = filters.repo?.[0] ?? null;
    const list = codeAgents(all, repo).slice(0, 40);
    const byRepo = new Map<string, number>();
    for (const a of codeAgents(all, null)) byRepo.set(a.islandId, (byRepo.get(a.islandId) ?? 0) + 1);
    const exts = extCounts(entries).slice(0, 10);
    const d = dom;
    return [
      {
        id: "agent",
        label: "Agent",
        type: "list",
        limit: 8,
        options: list.map((a) => ({
          value: a.id,
          label: `${agentTitle(a).slice(0, 48) || a.id.slice(0, 8)}`,
          hint: `${a.islandId} · ${a.cwd} · ${relativeTime(a.lastActive)}`,
          dot: a.awaitingInput ? "awaiting" : a.status === "live" ? "live" : Date.now() - Date.parse(a.lastActive) < 86_400_000 ? "today" : "asleep",
        })),
      },
      ...(repos.length > 0
        ? [
            {
              id: "sessionRepo",
              label: "Repo",
              type: "list" as const,
              default: root ? [root] : [],
              options: repos.map((r) => ({ value: r.root, label: r.label, count: r.files, hint: r.root })),
            },
          ]
        : []),
      ...(d
        ? [
            { id: "explorer", label: "Explorer", type: "section" as const, count: entries.filter((e) => e.type !== "dir").length || undefined, render: (host: HTMLElement) => void host.append(d.explorer) },
            { id: "agentCard", label: "This agent", type: "section" as const, collapsed: true, render: (host: HTMLElement) => void host.append(d.card) },
          ]
        : []),
      { id: "touched", label: "Touched only", type: "toggle" },
      ...(exts.length > 1
        ? [
            {
              id: "type",
              label: "File type",
              type: "chips" as const,
              multi: true,
              options: exts.map((e) => ({ value: e.ext, label: e.ext ? `.${e.ext}` : "no ext", count: e.count })),
            },
          ]
        : []),
      {
        id: "repo",
        label: "Agents in city",
        type: "list",
        collapsed: true,
        options: [...byRepo.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ value: id, label: id, count: n })),
      },
    ];
  },
  onFilter(state) {
    const prevRepo = filters.repo?.[0] ?? null;
    filters = state;
    const picked = state.agent?.[0] ?? null;
    const repo = state.repo?.[0] ?? null;
    const sessionRepo = state.sessionRepo?.[0] ?? null;
    if (picked && picked !== agentId) {
      userPickedAgent = true;
      setAgent(picked);
      ctx?.selection.set({ kind: "agent", id: picked });
    } else if (agentId && sessionRepo && sessionRepo !== root && repos.some((r) => r.root === sessionRepo)) {
      pickedRepo = sessionRepo;
      void loadRepo(agentId);
    } else if (repo !== prevRepo) {
      setAgent(defaultAgent());
      ctx?.refreshFilters();
    } else if (!agentId) setAgent(defaultAgent());
    renderTree();
  },
  onSelect(sel: Selection | null) {
    if (sel?.kind !== "agent" || sel.id === agentId) {
      if (!agentId) setAgent(defaultAgent());
      return;
    }
    const a = ctx?.store.agents.get(sel.id);
    // Only follow selections that have a repo (home-folder agents would just show an error).
    if (a && isProjectCwd(a.cwd)) setAgent(a.id);
    else if (!agentId) setAgent(defaultAgent());
    else if (a && !userPickedAgent) log.info("view:code", "selected agent has no project folder; keeping the current repo");
  },
  onParam(p) {
    if (p && ctx?.store.agents.has(p)) setAgent(p);
  },
  onFocus(on) {
    dom?.root.classList.toggle("cdv-focus", on);
  },
  onEscape() {
    return closeQuick();
  },
};
