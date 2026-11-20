// The Library drawer's Overview and Files tabs (library-drawer.ts builds the frame and the Shelf tab):
// one project's facts, notes, sessions and artifacts, and its folder (one level at a time, read
// lazily from GET /api/projects/:id/tree). Names, paths, README
// lines and titles are untrusted text: textContent only. ?redact=1 hides names, paths, README and
// titles (projects-lib.ts decides what).

import { agentTitle } from "../../../shared/display";
import type { ProjectItem, ProjectTreeResponse } from "../../../shared/features/projects";
import { openArtifactsGallery } from "../features/artifacts";
import type { WorldAgent } from "../../../shared/types";
import type { ViewContext } from "../shell/views";
import { fetchResult } from "./code-api";
import { notesFreshness } from "./library-lib";
import { CATEGORY_META, STAGE_META, ago, changeSummary, costLabel, displayName, displayPath, foldedLabel, githubUrl, islandsOf, previewUrl, safeHttpUrl, sessionChips, stackName, textShown } from "./projects-lib";

export interface PanelEnv {
  ctx: ViewContext;
  all: readonly ProjectItem[];
  redact: boolean;
}

const MAX_SESSIONS = 30;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(label: string, value: string, sub?: string): HTMLElement {
  const r = el("div", "pv-row");
  r.append(el("b", "", label), el("span", "", value));
  if (sub) r.append(el("small", "", sub));
  return r;
}

function section(title: string): HTMLElement {
  return el("h3", "pv-h", title);
}

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** The Overview tab body: stage, notes, git, stack, sessions, artifacts, folded folders. */
export function overviewBody(p: ProjectItem, env: PanelEnv): HTMLElement {
  const { ctx, redact } = env;
  const now = Date.now();
  const body = el("div", "pv-panel-body");

  const pill = el("span", "pv-pill", STAGE_META[p.stage].label);
  pill.style.background = STAGE_META[p.stage].color;
  const top = el("div", "pv-row-inline");
  top.append(pill, el("span", "pv-chip", `${CATEGORY_META[p.category].emoji} ${CATEGORY_META[p.category].label}`));
  body.append(top);
  if (p.hasPreview && !redact) {
    const img = document.createElement("img");
    img.className = "pv-shot";
    img.alt = "";
    img.src = previewUrl(p.id);
    img.addEventListener("error", () => img.remove());
    body.append(img);
  }
  const readme = textShown(p.readme, redact);
  if (readme) body.append(el("p", "pv-readme", readme));
  const gh = githubUrl(p.git?.remote ?? null);
  const live = safeHttpUrl(p.notes?.liveUrl ?? null);
  if ((gh || live) && !redact) {
    const links = el("div", "pv-row-inline");
    for (const [label, href] of [["GitHub", gh], ["Live", live]] as const) {
      if (!href) continue;
      const a = el("a", "pv-link", label);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.append(a);
    }
    body.append(links);
  }
  const path = displayPath(p.path, redact);
  if (path) body.append(row("Path", path));
  body.append(row("Stage", STAGE_META[p.stage].label, p.stageReason), row("Category", CATEGORY_META[p.category].label, redact ? undefined : p.categoryReason));
  if (p.unread) body.append(row("Read", "not read", "A privacy-guarded or protected folder: Alef never opens it from the server"));
  if (p.git) {
    const g = p.git;
    body.append(
      row("Git", [g.remote && !redact ? g.remote : null, g.branch ? `branch ${g.branch}` : null].filter(Boolean).join(" · ") || "a git repo", `last commit ${ago(g.lastCommit, now)} · ${g.commits === null ? "commits unknown" : `${g.commits}${g.commits >= 10_000 ? "+" : ""} commits`}`),
    );
  } else if (!p.unread) body.append(row("Git", "not a git repo"));
  if (p.deploy) body.append(row("Deploy", p.deploy));
  const spend = costLabel(p.costUsd30d);
  if (spend) body.append(row("AI cost (30 d)", `≈${spend}`, "Est. API-equivalent, from Alef's own usage store"));
  if (p.notes?.started && !redact) body.append(row("Started", p.notes.started));
  const chips = sessionChips(p.vaultSessions);
  if (chips.length) body.append(row("Session notes", chips.map((k) => `${k.emoji} ${k.n} ${k.label}`).join(" · "), "Obsidian vault notes labelled with this project"));
  if (p.stack.length) body.append(row("Stack", p.stack.map(stackName).join(", ")));
  if (p.vaultNote && !redact) body.append(row("Vault note", `20-Projects/${p.vaultNote}`));

  // Open in editor: the existing /api/open-editor/:agentId route, by session id (never a path).
  const mine = sessionsOf(p, ctx);
  const latest = mine[0];
  if (latest) {
    const open = btn("Open in editor", "pv-open", () => {
      void ctx.api.openEditor(latest.id).then((r) => ctx.toast(r.ok ? "Opened in the editor" : `Couldn't open it: ${r.error ?? "failed"}`, r.ok ? "info" : "error"));
    });
    open.title = "Opens the folder of this project's latest session (the existing open-editor route)";
    body.append(open);
  }

  body.append(section("Recent changes"));
  if (p.changes.length === 0) body.append(el("p", "pv-empty", "Nothing changed between the scans seen so far."));
  for (const c of p.changes.slice(0, 6)) {
    const line = el("div", "pv-fold");
    line.append(el("span", "pv-item-main", changeSummary(c)), el("small", "", ago(c.at, now)));
    body.append(line);
  }

  const notes = redact ? null : p.notes;
  if (notes && (notes.desc || notes.longDesc || notes.nextSteps.length || notes.milestones.length || notes.started)) {
    body.append(section("Notes"));
    if (notes.desc) body.append(el("p", "pv-readme", notes.desc));
    if (notes.longDesc) body.append(el("p", "pv-readme", notes.longDesc));
    for (const [title, list] of [["Next steps", notes.nextSteps], ["Milestones", notes.milestones]] as const) {
      if (!list.length) continue;
      body.append(el("h4", "pv-h4", title));
      const ul = el("ul", "pv-list");
      ul.append(...list.map((t) => el("li", "", t)));
      body.append(ul);
    }
    body.append(el("p", "pv-empty pv-notes-age", notesFreshness(notes)));
  }

  body.append(section("Sessions"));
  if (mine.length === 0) body.append(el("p", "pv-empty", islandsOf(p).length ? "No sessions in the world right now." : "No session has worked here yet."));
  for (const a of mine.slice(0, MAX_SESSIONS)) {
    const b = btn("", "pv-item", () => ctx.selection.set({ kind: "agent", id: a.id }));
    b.append(el("span", "pv-item-main", agentTitle(a)), el("small", "", `${ago(a.lastActive, now)} · ${a.messageCount} msgs`));
    body.append(b);
  }
  if (mine.length > MAX_SESSIONS) body.append(el("p", "pv-empty", `and ${mine.length - MAX_SESSIONS} older`));

  body.append(section("Artifacts"));
  if (!p.artifacts) body.append(el("p", "pv-empty", "Still reading the artifacts."));
  else if (p.artifacts.count === 0) body.append(el("p", "pv-empty", "None published from here."));
  else {
    for (const a of p.artifacts.items) {
      const b = btn("", "pv-item", () => openArtifactsGallery(p.islandId ?? "museum", a.id));
      b.append(el("span", "pv-item-main", redact ? "artifact" : (a.title ?? a.id)));
      body.append(b);
    }
    if (p.artifacts.count > p.artifacts.items.length) body.append(el("p", "pv-empty", `${p.artifacts.count} in all`));
  }

  if (p.folded.length) {
    body.append(section(`Folded here (${foldedLabel(p)})`));
    for (const f of p.folded) {
      const line = el("div", "pv-fold");
      line.append(el("span", "pv-item-main", redact ? f.kind : f.name), el("small", "", [redact ? null : f.reason, f.branch && !redact ? `branch ${f.branch}` : null, f.sessions ? `${f.sessions} sessions` : null, `active ${ago(f.activityAt, now)}`].filter(Boolean).join(" · ")));
      body.append(line);
    }
  }

  return body;
}

/** The Files tab body: the project's folder, one level at a time. */
export function filesBody(p: ProjectItem, env: PanelEnv): HTMLElement {
  const folder = el("div", "pv-folder");
  if (p.unread) folder.append(el("p", "pv-empty", "This folder is not browsed from here."));
  else void loadTree(folder, p, "", env);
  return folder;
}

function sessionsOf(p: ProjectItem, ctx: ViewContext): WorldAgent[] {
  const ids = new Set(islandsOf(p));
  if (ids.size === 0) return [];
  return [...ctx.store.agents.values()].filter((a) => ids.has(a.islandId)).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

async function loadTree(host: HTMLElement, p: ProjectItem, rel: string, env: PanelEnv): Promise<void> {
  host.replaceChildren(el("p", "pv-empty", "Reading the folder…"));
  const r = await fetchResult<ProjectTreeResponse>(`/api/projects/${encodeURIComponent(p.id)}/tree?path=${encodeURIComponent(rel)}`, undefined, 15_000);
  if (!host.isConnected) return;
  host.replaceChildren(crumbs(host, p, rel, env));
  if (!r.ok) return void host.append(el("p", "pv-empty", `Couldn't read it: ${r.error}`));
  if (env.redact) return void host.append(el("p", "pv-empty", `${r.data.entries.length} entries (names hidden)`));
  if (r.data.entries.length === 0) host.append(el("p", "pv-empty", "Empty."));
  for (const e of r.data.entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    const line = e.dir ? btn("", "pv-entry is-dir", () => void loadTree(host, p, next, env)) : el("div", "pv-entry");
    line.append(el("span", "", `${e.dir ? "📁" : "📄"} ${e.name}`));
    if (e.size !== null) line.append(el("small", "", e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`));
    host.append(line);
  }
  if (r.data.truncated) host.append(el("p", "pv-empty", "More entries than shown."));
}

function crumbs(host: HTMLElement, p: ProjectItem, rel: string, env: PanelEnv): HTMLElement {
  const nav = el("nav", "pv-crumbs");
  nav.setAttribute("aria-label", "Folder path");
  const parts = rel ? rel.split("/") : [];
  const root = displayName(p, env.all, env.redact);
  nav.append(parts.length ? btn(root, "pv-crumb", () => void loadTree(host, p, "", env)) : el("span", "pv-crumb is-here", root));
  parts.forEach((part, i) => {
    nav.append(el("span", "pv-sep", "/"));
    const upTo = parts.slice(0, i + 1).join("/");
    nav.append(i === parts.length - 1 ? el("span", "pv-crumb is-here", env.redact ? "…" : part) : btn(env.redact ? "…" : part, "pv-crumb", () => void loadTree(host, p, upTo, env)));
  });
  return nav;
}
