// 📌 Project (UX-3): ONE page per project, where "project" used to mean three things (a World city,
// a Library entry, a vault 20-Projects/<slug> note). #/project/<key> takes a Library id, a vault
// slug or a city id; the server resolves it and joins (GET /api/project-page/:key):
//   header   name, stage, category, the notes' line, and Resume · Library · Vault note · District
//   facts    sessions (live now), open todos, spend over 30 days, the newest verdict, git
//   cards    the sessions in its city (live first; a click opens the Room), their open todos,
//            the last verdicts, the vault note's summary (opened in Brain, not Obsidian) and git
// #/project with no key lists every Library project, newest first. Reached from ⌘K (projects are
// "Go to" results), the Library drawer, Vault's Projects list, the district card and Home's cards.
// Not a planet view. Untrusted text (names, titles, todos, reasons, the summary) is set with
// textContent only; ?redact=1 swaps it out (project-lib.ts redactPage).

import type { ProjectIndexItem, ProjectIndexResponse, ProjectPage, ProjectPageResponse } from "../../../shared/features/project-page";
import { h } from "../features/fleet-overlay";
import { redactOn } from "../redact";
import type { AlefView, FilterSpec, ViewContext } from "../shell/views";
import { prefersReducedMotion } from "../ui/kit";
import { explainError, fetchResult } from "./code-api";
import { resumeButton } from "./project-card";
import { brainNoteRoute, cardFacts, matchWords, plural, PROJECT_VIEW_ID, redactPage, verdictText } from "./project-lib";
import { ago, CATEGORY_META, costLabel, STAGE_META } from "./projects-lib";
import "./project.css";

const SECTIONS: readonly { id: string; label: string }[] = [
  { id: "head", label: "The project" },
  { id: "sessions", label: "Sessions in its city" },
  { id: "todos", label: "Open todos" },
  { id: "verdicts", label: "Last verdicts" },
  { id: "vault", label: "Vault note" },
  { id: "git", label: "Code" },
];

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
/** Bumped on every load and unmount: an answer for an older one is dropped. */
let seq = 0;

function button(label: string, cls: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function card(id: string, title: string, count?: number): { root: HTMLElement; body: HTMLElement } {
  const sec = h("section", "pj-card");
  sec.id = `pj-${id}`;
  const head = h("h2", "pj-card-h", title);
  if (count !== undefined) head.append(" ", h("span", "alef-fcount", String(count)));
  const body = h("div", "pj-card-body");
  sec.append(head, body);
  return { root: sec, body };
}

const empty = (text: string): HTMLElement => h("p", "pj-empty", text);

function renderPage(c: ViewContext, host: HTMLElement, raw: ProjectPage): void {
  const p = redactOn() ? redactPage(raw, 1) : raw;
  const now = Date.now();
  const f = cardFacts(p, now);

  const head = h("header", "pj-head");
  head.id = "pj-head";
  const kicker = ["📌 Project", p.stage ? STAGE_META[p.stage].label : null, p.category ? CATEGORY_META[p.category].label : null, p.vault?.umbrella ?? null].filter((x): x is string => x !== null);
  head.append(h("p", "pj-kicker", kicker.join(" · ")), h("h1", "pj-name", p.name));
  if (p.desc) head.append(h("p", "pj-desc", p.desc));
  const acts = h("div", "pj-acts");
  const resume = resumeButton(c, p, "pj-btn pj-primary");
  if (resume) acts.append(resume);
  const libraryId = p.libraryId;
  if (libraryId) acts.append(button("Library", "pj-btn", "Its Library card: shelf, files and notes", () => c.showView("library", libraryId)));
  const vault = p.vault;
  if (vault) acts.append(button("Vault note", "pj-btn", `Read ${vault.path} in Brain`, () => openInBrain(c, vault.path)));
  for (const city of p.cities) acts.append(button(`District: ${city.name}`, "pj-btn", "Its district on the planet", () => c.showView("district", city.id)));
  head.append(acts);

  const facts = h("ul", "pj-facts");
  const fact = (value: string, label: string, hot = false): void => {
    const li = h("li", hot ? "pj-fact pj-hot" : "pj-fact");
    li.append(h("b", undefined, value), h("span", undefined, label));
    facts.append(li);
  };
  fact(String(p.sessionsTotal), p.live > 0 ? `sessions · ${p.live} live` : "sessions", p.live > 0);
  fact(String(p.todos.open), "open todos", p.todos.open > 0);
  fact(costLabel(p.spendUsd30d) ?? "—", "spent in 30 days");
  fact(p.activityAt ? ago(p.activityAt, now) : "—", "last activity");
  if (f.verdict) fact(f.verdict, "newest verdict");

  const grid = h("div", "pj-grid");

  const s = card("sessions", "Sessions in its city", p.sessionsTotal);
  if (p.sessions.length === 0) s.body.append(empty(p.cities.length ? "No sessions in its city yet." : "No city: no session has worked in this project's folder."));
  else {
    const ul = h("ul", "pj-rows");
    for (const x of p.sessions) {
      const li = h("li", "pj-row");
      const b = button("", "pj-row-main", x.status === "live" ? "Running now: open its Room" : "Open its Room", () => c.showView("room", x.id));
      b.append(h("span", `pj-dot pj-${x.status}`), h("span", "pj-row-title", x.title));
      const meta = [x.awaitingInput ? "waits on you" : null, x.outcome && x.outcome !== "unknown" ? verdictText({ outcome: x.outcome, reason: null }) : null, x.openTodos ? plural(x.openTodos, "open todo") : null, ago(x.lastActive, now)].filter((m): m is string => m !== null);
      li.append(b, h("span", "pj-row-meta", meta.join(" · ")));
      ul.append(li);
    }
    s.body.append(ul);
    if (p.sessionsTotal > p.sessions.length) s.body.append(h("p", "pj-more", `+${p.sessionsTotal - p.sessions.length} older sessions (see the district)`));
  }

  const t = card("todos", "Open todos", p.todos.open);
  if (p.todos.items.length === 0) t.body.append(empty("Nothing open: no session here has a todo left."));
  else {
    const ul = h("ul", "pj-rows");
    for (const x of p.todos.items) {
      const li = h("li", `pj-row pj-todo pj-${x.status}`);
      li.append(h("span", "pj-row-title", x.content), h("span", "pj-row-meta", x.status === "in_progress" ? "in progress" : "pending"));
      ul.append(li);
    }
    t.body.append(ul);
  }

  const v = card("verdicts", "Last verdicts");
  if (p.verdicts.length === 0) v.body.append(empty("No verdict yet: no session here has shipped, delivered, failed or stopped."));
  else {
    const ul = h("ul", "pj-rows");
    for (const x of p.verdicts) {
      const li = h("li", "pj-row");
      const b = button("", "pj-row-main", "Open its Room", () => c.showView("room", x.sessionId));
      b.append(h("span", "pj-row-title", x.title));
      li.append(b, h("span", "pj-row-meta", `${verdictText(x)} · ${ago(x.at, now)}`));
      ul.append(li);
    }
    v.body.append(ul);
  }

  const n = card("vault", "Vault note");
  if (!vault) n.body.append(empty("No 20-Projects note matches this project (by code_path, github, alias or name)."));
  else {
    n.body.append(h("p", "pj-note-title", vault.title ?? vault.slug));
    const meta = [vault.status, vault.umbrella ? `under ${vault.umbrella}` : null, matchWords(vault.matchedBy)].filter((x): x is string => x !== null);
    n.body.append(h("p", "pj-row-meta", meta.join(" · ")));
    n.body.append(vault.summary ? h("p", "pj-summary", vault.summary) : empty(vault.title === null && !redactOn() ? "The slug has no _index.md yet." : "No summary paragraph in the note."));
    n.body.append(button("Open in Brain →", "pj-btn", "Read the note, its backlinks and its local graph in Brain", () => openInBrain(c, vault.path)));
  }

  const g = card("git", "Code");
  const rows: [string, string][] = [];
  if (p.git) {
    rows.push(["Repo", [p.git.remote, p.git.branch ? `branch ${p.git.branch}` : null].filter(Boolean).join(" · ") || "a git repo"]);
    rows.push(["Commits", `${p.git.commits === null ? "unknown" : p.git.commits.toLocaleString("en-US")} · last ${ago(p.git.lastCommit, now)}`]);
  }
  if (p.deploy) rows.push(["Deploys with", p.deploy]);
  if (p.liveUrl) rows.push(["Live at", p.liveUrl]);
  if (p.path) rows.push(["Folder", p.path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")]);
  if (p.stageReason) rows.push(["Stage", p.stageReason]);
  if (rows.length === 0) g.body.append(empty(p.libraryId ? "No git facts for this folder." : "Not a folder Alef knows: the Library has no entry for it."));
  else {
    const dl = h("dl", "pj-dl");
    for (const [k, val] of rows) dl.append(h("dt", undefined, k), h("dd", undefined, val));
    g.body.append(dl);
  }

  grid.append(s.root, t.root, v.root, n.root, g.root);
  host.replaceChildren(head, facts, grid);
}

function openInBrain(c: ViewContext, path: string): void {
  const r = brainNoteRoute(path);
  c.showView(r.view, r.param);
}

function renderPicker(c: ViewContext, host: HTMLElement, items: readonly ProjectIndexItem[]): void {
  const now = Date.now();
  const head = h("header", "pj-head");
  head.id = "pj-head";
  head.append(h("p", "pj-kicker", "📌 Projects"), h("h1", "pj-name", "Pick a project"), h("p", "pj-desc", "Every Library project, newest first. ⌘K finds one by name too."));
  const ul = h("ul", "pj-rows pj-picker");
  items.forEach((p, i) => {
    const li = h("li", "pj-row");
    const b = button("", "pj-row-main", "Open its page", () => c.showView(PROJECT_VIEW_ID, p.key));
    b.append(h("span", "pj-row-title", redactOn() ? `project ${i + 1}` : p.name));
    li.append(b, h("span", "pj-row-meta", [STAGE_META[p.stage].label, p.vaultSlug ? "vault note" : null, p.activityAt ? ago(p.activityAt, now) : null].filter(Boolean).join(" · ")));
    ul.append(li);
  });
  host.replaceChildren(head, items.length ? ul : empty("No projects yet."));
}

async function load(key: string | null): Promise<void> {
  const c = ctx;
  const host = root?.querySelector<HTMLElement>(".pj-main");
  if (!c || !host) return;
  const mine = ++seq;
  host.replaceChildren(h("p", "pj-loading", key ? "Reading the project…" : "Reading the projects…"));
  if (!key) {
    const r = await fetchResult<ProjectIndexResponse>("/api/project-page");
    if (mine !== seq) return;
    if (!r.ok) return void host.replaceChildren(h("p", "pj-error", explainError(r.status, r.error)));
    return renderPicker(c, host, r.data.items);
  }
  const r = await fetchResult<ProjectPageResponse>(`/api/project-page/${encodeURIComponent(key)}`);
  if (mine !== seq) return;
  if (!r.ok) {
    const back = button("All projects", "pj-btn", "Every Library project", () => c.showView(PROJECT_VIEW_ID));
    return void host.replaceChildren(h("p", "pj-error", r.status === 404 ? "No project, vault note or district goes by that name." : explainError(r.status, r.error)), back);
  }
  renderPage(c, host, r.data.project);
}

function jumpTo(id: string): void {
  root?.querySelector<HTMLElement>(`#pj-${id}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
}

export const projectView: AlefView = {
  id: PROJECT_VIEW_ID,
  emoji: "📌",
  name: "Project",
  hint: "One project: its city's sessions, open todos, verdicts, spend, git and vault note",
  mount(r, c) {
    ctx = c;
    root = r;
    const main = h("div", "pj-main");
    const wrap = h("div", "pj-root");
    wrap.append(main);
    r.append(wrap);
    void load(c.route().param);
  },
  onParam(param) {
    root?.querySelector(".pj-root")?.scrollTo({ top: 0 });
    void load(param);
  },
  unmount() {
    seq += 1;
    ctx = null;
    root = null;
  },
  filters(): FilterSpec[] {
    return [
      {
        id: "sections",
        label: "On this page",
        type: "section",
        render: (host) => {
          const ul = h("ul", "pj-jump");
          for (const s of SECTIONS) {
            const li = h("li");
            li.append(button(s.label, "pj-jump-btn", `Scroll to ${s.label}`, () => jumpTo(s.id)));
            ul.append(li);
          }
          host.replaceChildren(ul);
        },
      },
    ];
  },
};
