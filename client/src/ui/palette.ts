import { agentTitle, displayIslandName, displayTitle } from "../../../shared/display";
import type { Island, WorldAgent, WorldObject } from "../../../shared/types";
import type { PaletteCommand } from "../features/registry";
import { modalDialog } from "./kit";
import { escapeHtml, fuzzyRank, relativeTime } from "./fuzzy";

export type PaletteAction =
  | { type: "city"; id: string }
  | { type: "agent"; id: string }
  | { type: "reactivate"; id: string }
  | { type: "editor"; id: string }
  | { type: "object"; id: string }
  | { type: "ask"; query: string }
  | { type: "dispatch"; query: string; islandId: string }
  | { type: "command"; id: string } // a feature's PaletteCommand (namespaced id)
  | { type: "view"; view: string; param: string | null } // a view or a Vault section (#/vault/<section>)
  | { type: "note"; path: string }; // a vault note, opened in Obsidian like the Vault sections do

interface Row {
  action: PaletteAction;
  kind: string;
  title: string;
  meta: string;
}

export interface PaletteData {
  islands(): Island[];
  agents(): WorldAgent[];
  objects(): WorldObject[];
  /** City a "Dispatch to" action targets (selected or most recent). */
  dispatchCity(): string;
  /** Feature plugin commands, fuzzy-matched alongside cities/agents/objects. */
  commands?(): PaletteCommand[];
}

export interface Palette {
  open(query?: string): void;
  close(): void;
  isOpen(): boolean;
}

const cityName = (i: Island): string => (i.id === "harness" ? "Harness City" : displayIslandName(i));

/** Builds the ranked rows for a query (exported for tests). */
export function paletteRows(query: string, data: PaletteData, limit = 12): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  const islands = data.islands();
  const agents = data.agents();
  const objects = data.objects();

  if (!q) {
    for (const a of agents.filter((x) => x.awaitingInput === true).slice(0, 3)) {
      rows.push({ action: { type: "agent", id: a.id }, kind: "waiting", title: agentTitle(a), meta: `${a.islandId} · waiting for you` });
    }
    const recent = agents
      .filter((a) => a.status === "live")
      .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))
      .slice(0, 5);
    for (const a of recent) rows.push({ action: { type: "agent", id: a.id }, kind: "agent", title: agentTitle(a), meta: `${a.islandId} · live` });
    for (const i of islands.slice().sort((a, b) => b.agentCount - a.agentCount).slice(0, 4)) {
      rows.push({ action: { type: "city", id: i.id }, kind: "city", title: cityName(i), meta: `${i.agentCount} agents` });
    }
    return rows.slice(0, limit);
  }

  type Cand = { row: Row; keys: string[] };
  const cands: Cand[] = [
    ...islands.map((i) => ({
      row: { action: { type: "city", id: i.id } as PaletteAction, kind: "city", title: cityName(i), meta: `${i.agentCount} agents` },
      keys: [cityName(i), i.path],
    })),
    ...agents.map((a) => ({
      row: {
        action: { type: "agent", id: a.id } as PaletteAction,
        kind: a.status === "live" ? "live agent" : "agent",
        title: agentTitle(a),
        meta: `${a.islandId} · ${relativeTime(a.lastActive)}`,
      },
      // Both the raw title and its display form are searchable, so a query matching either
      // the original prompt or the friendly "/skill · role" text still finds the agent.
      keys: [a.title, agentTitle(a), displayTitle(a.title), a.islandId, `${a.islandId} ${a.title}`],
    })),
    ...objects.map((o) => ({
      row: { action: { type: "object", id: o.id } as PaletteAction, kind: o.kind, title: o.name, meta: `${o.islandId} · used ${o.usage}×` },
      keys: [o.name],
    })),
    ...(data.commands?.() ?? []).map((c) => ({
      row: { action: { type: "command", id: c.id } as PaletteAction, kind: c.kind ?? "command", title: c.title, meta: c.meta ?? "" },
      keys: [c.title, ...(c.keywords ?? [])],
    })),
  ];
  const ranked = fuzzyRank(q, cands, (c) => c.keys, limit - 2);
  rows.push(...ranked.map((r) => r.item.row));
  const target = islands.find((i) => i.id === data.dispatchCity());
  rows.push({ action: { type: "ask", query: q }, kind: "ask jev", title: `Ask Jev “${q}”`, meta: "who worked on this?" });
  if (target) {
    rows.push({
      action: { type: "dispatch", query: q, islandId: target.id },
      kind: "dispatch",
      title: `Dispatch to ${cityName(target)}: “${q}”`,
      meta: "prefills the build bar, you press Enter",
    });
  }
  return rows;
}

/** ⌘K / Ctrl+K command palette: fuzzy over cities, agents, objects + actions. Keyboard navigable, Esc closes. */
export function mountPalette(data: PaletteData, run: (a: PaletteAction) => void): Palette {
  const root = document.getElementById("palette");
  const input = document.getElementById("palette-input");
  const list = document.getElementById("palette-list");
  if (!root || !(input instanceof HTMLInputElement) || !list) throw new Error("palette DOM missing from index.html");
  const inputEl: HTMLInputElement = input;

  let rows: Row[] = [];
  let active = 0;

  function render(): void {
    rows = paletteRows(inputEl.value, data);
    active = Math.min(active, Math.max(0, rows.length - 1));
    list!.innerHTML = rows.length
      ? rows
          .map((r, i) => {
            const agentExtras =
              r.action.type === "agent"
                ? `<span class="p-acts"><span data-act="reactivate" title="⌘Enter">Reactivate</span><span data-act="editor" title="⇧Enter">VS Code</span></span>`
                : "";
            return `<li role="option" id="p-opt-${i}" aria-selected="${i === active}" class="${i === active ? "active" : ""}" data-i="${i}">
              <span class="p-kind k-${r.kind.replace(/\s+/g, "-")}">${escapeHtml(r.kind)}</span>
              <span class="p-main"><span class="p-title">${escapeHtml(r.title)}</span><span class="p-meta">${escapeHtml(r.meta)}</span></span>
              ${agentExtras}
            </li>`;
          })
          .join("")
      : `<li class="p-empty">No matches. Try a city, an agent's words, a file name, or ask Jev a question.</li>`;
    if (rows.length) inputEl.setAttribute("aria-activedescendant", `p-opt-${active}`);
    else inputEl.removeAttribute("aria-activedescendant");
    list!.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  }

  function choose(i: number, variant: "main" | "reactivate" | "editor" = "main"): void {
    const r = rows[i];
    if (!r) return;
    close();
    if (r.action.type === "agent" && variant !== "main") run({ type: variant, id: r.action.id });
    else run(r.action);
  }

  // role=dialog + aria-modal, Tab trapped, focus restored to the opener on close.
  const dialog = modalDialog(root, root.querySelector<HTMLElement>(".palette-card") ?? root, "Command palette");

  function open(query = ""): void {
    inputEl.value = query;
    active = 0;
    render();
    dialog.open(inputEl);
    inputEl.select();
  }

  function close(): void {
    dialog.close();
  }

  input.addEventListener("input", () => {
    active = 0;
    render();
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
      close();
    }
  });
  list.addEventListener("click", (ev) => {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    const li = target?.closest<HTMLElement>("li[data-i]");
    if (!li) return;
    const act = target?.closest<HTMLElement>("[data-act]")?.dataset.act;
    choose(Number(li.dataset.i), act === "reactivate" ? "reactivate" : act === "editor" ? "editor" : "main");
  });
  list.addEventListener("mousemove", (ev) => {
    const li = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("li[data-i]") : null;
    const i = li ? Number(li.dataset.i) : -1;
    if (i >= 0 && i !== active) {
      active = i;
      list.querySelectorAll("li").forEach((el, k) => {
        el.classList.toggle("active", k === i);
        el.setAttribute("aria-selected", String(k === i));
      });
    }
  });
  return { open, close, isOpen: () => !root.hidden };
}
