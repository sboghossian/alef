// The ONE search (left sidebar, top; ⌘K focuses it): views and Vault sections, projects (the
// Library's list, GET /api/project-page, read on first focus and every 5 minutes) and vault projects,
// people and note titles (GET /api/vault/search, debounced), agents, cities, files/objects and
// every feature command, plus "Ask Jev" and "Dispatch" rows. Results are grouped (search-lib.ts, tested) and float over
// the view's sections, so nothing below jumps. Empty box = your recent picks + suggestions.
// Keys: ↑↓ move · ↵ go · ⌘↵ reactivate · ⇧↵ VS Code · Esc clears, then closes.

import type { ProjectIndexItem } from "../../../shared/features/project-page";
import type { VaultSearchHit } from "../../../shared/features/vault";
import { projectIndex, vaultSearch } from "../api-alef";
import type { PaletteAction, PaletteData } from "../ui/palette";
import { escapeHtml } from "../ui/fuzzy";
import { safeLocalStorage } from "../ui/kit";
import { flatRows, groupedResults, liveRecent, loadRecent, pushRecent, saveRecent, stillMatching, VAULT_MIN_CHARS, type NavEntry, type SearchGroup, type SearchRow } from "./search-lib";
import { icon } from "./icons";

/** Wait this long after the last keystroke before asking the vault. */
const VAULT_DEBOUNCE_MS = 160;
/** The project list is read again on a focus this long after the last read. */
const PROJECTS_TTL_MS = 5 * 60_000;

export interface SidebarSearch {
  readonly input: HTMLInputElement;
  focus(query?: string): void;
  /** Empty the box and close the results (a view switch does this). */
  clear(): void;
  isActive(): boolean;
}

/** Each result group's line icon (shell/icons.ts), drawn beside its heading. */
const GROUP_ICON: Record<string, string> = { recent: "clock", go: "compass", agents: "agent", cities: "district", notes: "note", objects: "report", commands: "bolt" };

export function mountSearch(
  host: HTMLElement,
  data: PaletteData,
  run: (a: PaletteAction) => void,
  onResultsShown: (shown: boolean) => void,
  exists: (a: PaletteAction) => boolean,
  nav: () => readonly NavEntry[],
): SidebarSearch {
  const store = safeLocalStorage();
  let recent = loadRecent(store);
  /** The vault's answer for `vaultQ`; shown (narrowed) while the next query is in flight. */
  let vaultQ = "";
  let vaultHits: readonly VaultSearchHit[] = [];
  let vaultTimer = 0;
  let vaultSeq = 0;
  let projects: readonly ProjectIndexItem[] = [];
  let projectsAt = 0;
  const wrap = document.createElement("div");
  wrap.className = "alef-search";
  wrap.setAttribute("role", "search");
  wrap.innerHTML = `
    <label class="sr-only" for="alef-search">Search views, vault notes, projects, people, agents, cities, files and commands</label>
    <span class="alef-search-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
    <input id="alef-search" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="alef-search-list" aria-autocomplete="list"
      placeholder="Search anything…" title="Views, vault sections, projects, people, notes, agents, cities, files, commands, or a question for Jev" />
    <button type="button" class="alef-search-x" aria-label="Clear the search" hidden>✕</button>
    <kbd class="alef-search-kbd" aria-hidden="true">⌘K</kbd>`;
  const pop = document.createElement("div");
  pop.className = "alef-search-pop";
  pop.hidden = true;
  const list = document.createElement("div");
  list.id = "alef-search-list";
  list.className = "alef-search-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Search results");
  const hint = document.createElement("div");
  hint.className = "alef-search-hint";
  hint.innerHTML = `<span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> go</span><span><kbd>⌘↵</kbd> reactivate</span><span><kbd>esc</kbd> close</span>`;
  pop.append(list, hint);
  host.append(wrap, pop);
  const input = wrap.querySelector<HTMLInputElement>("#alef-search")!;
  const xBtn = wrap.querySelector<HTMLButtonElement>(".alef-search-x")!;

  let groups: SearchGroup[] = [];
  let rows: SearchRow[] = [];
  let active = 0;
  let open = false;

  function setOpen(on: boolean): void {
    if (open === on) return;
    open = on;
    pop.hidden = !on;
    input.setAttribute("aria-expanded", String(on));
    onResultsShown(on);
  }

  function render(): void {
    recent = liveRecent(recent, exists);
    groups = groupedResults(input.value, data, recent, { nav: nav(), projects, vault: stillMatching(vaultQ, vaultHits, input.value) });
    rows = flatRows(groups);
    active = Math.min(active, Math.max(0, rows.length - 1));
    xBtn.hidden = !input.value;
    let i = 0;
    list.innerHTML = rows.length
      ? groups
          .map(
            (g) => `<div class="as-group" role="group" aria-label="${escapeHtml(g.label)}">
              <div class="as-group-h" aria-hidden="true"><span>${icon(GROUP_ICON[g.id] ?? "", 14) ?? ""}</span>${escapeHtml(g.label)}${g.id === "recent" ? `<button type="button" class="as-forget" data-forget="1" tabindex="-1">clear</button>` : ""}</div>
              ${g.rows
                .map((r) => {
                  const idx = i++;
                  const extras =
                    r.action.type === "agent"
                      ? `<span class="p-acts"><span data-act="reactivate" title="Reactivate in Terminal (⌘↵)">Reactivate</span><span data-act="editor" title="Open in VS Code (⇧↵)">VS Code</span></span>`
                      : "";
                  return `<div role="option" id="as-opt-${idx}" aria-selected="${idx === active}" class="as-row${idx === active ? " active" : ""}" data-i="${idx}">
                    <span class="p-kind k-${escapeHtml(r.kind.replace(/\s+/g, "-"))}">${escapeHtml(r.kind)}</span>
                    <span class="p-main"><span class="p-title">${escapeHtml(r.title)}</span>${r.meta ? `<span class="p-meta">${escapeHtml(r.meta)}</span>` : ""}</span>${extras}
                  </div>`;
                })
                .join("")}
            </div>`,
          )
          .join("")
      : `<p class="as-empty">No matches for “${escapeHtml(input.value.trim())}”. Try a city, an agent's words or a file name.</p>`;
    if (rows.length) input.setAttribute("aria-activedescendant", `as-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
    list.querySelector(".as-row.active")?.scrollIntoView({ block: "nearest" });
  }

  function choose(i: number, variant: "main" | "reactivate" | "editor"): void {
    const r = rows[i];
    if (!r) return;
    const action: PaletteAction = r.action.type === "agent" && variant !== "main" ? { type: variant, id: r.action.id } : r.action;
    recent = pushRecent(recent, r);
    saveRecent(store, recent);
    input.value = "";
    setOpen(false);
    input.blur();
    run(action);
  }

  /** The Library's projects, for the Go to group; a failed read keeps the last list. */
  function loadProjects(): void {
    if (Date.now() - projectsAt < PROJECTS_TTL_MS) return;
    projectsAt = Date.now();
    void projectIndex().then((r) => {
      if (!r?.ok) return;
      projects = r.items;
      if (open) render();
    });
  }

  input.addEventListener("focus", () => {
    loadProjects();
    render();
    setOpen(true);
  });
  /** Ask the vault for the box's words once typing pauses; a stale answer is dropped. */
  function askVault(): void {
    window.clearTimeout(vaultTimer);
    const q = input.value.trim();
    if (q.length < VAULT_MIN_CHARS || q === vaultQ) return;
    vaultTimer = window.setTimeout(() => {
      const seq = ++vaultSeq;
      void vaultSearch(q).then((r) => {
        if (seq !== vaultSeq) return;
        vaultQ = q;
        vaultHits = r?.hits ?? [];
        if (open && input.value.trim() === q) render();
      });
    }, VAULT_DEBOUNCE_MS);
  }

  input.addEventListener("input", () => {
    active = 0;
    render();
    setOpen(true);
    askVault();
  });
  input.addEventListener("blur", () => {
    // Let a click on a result land first.
    window.setTimeout(() => {
      if (document.activeElement !== input && !pop.contains(document.activeElement)) setOpen(false);
    }, 150);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      active = (active + 1) % Math.max(1, rows.length);
      render();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      active = (active - 1 + rows.length) % Math.max(1, rows.length);
      render();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      choose(active, ev.metaKey || ev.ctrlKey ? "reactivate" : ev.shiftKey ? "editor" : "main");
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (input.value) {
        input.value = "";
        render();
      } else {
        setOpen(false);
        input.blur();
      }
    }
  });
  xBtn.addEventListener("click", () => {
    input.value = "";
    input.focus();
    render();
  });
  pop.addEventListener("mousedown", (ev) => ev.preventDefault()); // keep focus in the box
  list.addEventListener("click", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null;
    if (t?.closest("[data-forget]")) {
      recent = [];
      saveRecent(store, recent);
      render();
      return;
    }
    const row = t?.closest<HTMLElement>("[data-i]");
    if (!row) return;
    const act = t?.closest<HTMLElement>("[data-act]")?.dataset.act;
    choose(Number(row.dataset.i), act === "reactivate" ? "reactivate" : act === "editor" ? "editor" : "main");
  });
  list.addEventListener("mousemove", (ev) => {
    const row = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-i]") : null;
    const i = row ? Number(row.dataset.i) : -1;
    if (i < 0 || i === active) return;
    list.querySelector(".as-row.active")?.classList.remove("active");
    row?.classList.add("active");
    active = i;
  });

  return {
    input,
    focus(query) {
      if (query !== undefined) input.value = query;
      active = 0;
      input.focus();
      input.select();
      render();
      setOpen(true);
      askVault();
    },
    clear() {
      input.value = "";
      xBtn.hidden = true;
      if (document.activeElement === input) input.blur();
      setOpen(false);
    },
    isActive: () => open,
  };
}
