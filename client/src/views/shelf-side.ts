// The Shelf view's two left-sidebar sections: "Pin a link" (URL + shelf + optional title) and
// "Shelves" (rename, remove, add; Unsorted is fixed and last). Each registers an updater in `hosts`
// so the section follows the pins state in place, and removes it on unmount.

import type { ShelfPinsState } from "../../../shared/features/shelf-board";
import { el } from "./shelf-cards";

function fillSelect(sel: HTMLSelectElement, sections: readonly string[]): void {
  const keep = sel.value;
  sel.replaceChildren(
    ...sections.map((s) => {
      const o = el("option", "", s);
      o.value = s;
      return o;
    }),
  );
  sel.value = sections.includes(keep) ? keep : (sections[0] ?? "Unsorted");
}

export function renderAddLink(host: HTMLElement, hosts: Array<() => void>, sections: () => readonly string[], pin: (url: string, section: string, title: string | undefined) => void): () => void {
  const form = el("form", "sv-side-form");
  const url = el("input", "sv-input");
  url.type = "url";
  url.placeholder = "https://…";
  url.setAttribute("aria-label", "Link to pin");
  const title = el("input", "sv-input");
  title.placeholder = "Title (optional)";
  title.setAttribute("aria-label", "Title");
  const sel = el("select", "sv-input");
  sel.setAttribute("aria-label", "Shelf");
  const go = el("button", "sv-btn", "Pin");
  go.type = "submit";
  form.append(url, title, sel, go);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const u = url.value.trim();
    if (!u) return;
    pin(u, sel.value, title.value.trim() || undefined);
    url.value = "";
    title.value = "";
  });
  host.append(form);
  const update = (): void => fillSelect(sel, sections());
  update();
  hosts.push(update);
  return () => {
    const at = hosts.indexOf(update);
    if (at >= 0) hosts.splice(at, 1);
  };
}

export function renderSections(host: HTMLElement, hosts: Array<() => void>, state: () => ShelfPinsState, save: (sections: string[], renames: Record<string, string>) => void): () => void {
  const list = el("div", "sv-sections");
  const add = el("form", "sv-side-form");
  const name = el("input", "sv-input");
  name.placeholder = "New shelf";
  name.setAttribute("aria-label", "New shelf name");
  const go = el("button", "sv-btn", "Add");
  go.type = "submit";
  add.append(name, go);
  const current = (): string[] => state().sections.filter((s) => s !== "Unsorted");
  add.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (n) save([...current(), n], {});
    name.value = "";
  });
  const update = (): void => {
    const s = state();
    list.replaceChildren(
      ...s.sections.map((sec) => {
        const row = el("div", "sv-sec-row");
        const count = s.pins.filter((p) => p.section === sec).length;
        if (sec === "Unsorted") {
          row.append(el("span", "sv-sec-fixed", sec), el("small", "", String(count)));
          return row;
        }
        const input = el("input", "sv-input");
        input.value = sec;
        input.setAttribute("aria-label", `Rename ${sec}`);
        input.addEventListener("change", () => {
          const to = input.value.trim();
          if (to && to !== sec) save(current().map((x) => (x === sec ? to : x)), { [sec]: to });
        });
        const rm = el("button", "sv-x", "✕");
        rm.type = "button";
        rm.title = count ? `Remove (its ${count} pins go to Unsorted)` : "Remove";
        rm.setAttribute("aria-label", `Remove ${sec}`);
        rm.addEventListener("click", () => save(current().filter((x) => x !== sec), {}));
        row.append(input, el("small", "", String(count)), rm);
        return row;
      }),
    );
  };
  host.append(list, add);
  update();
  hosts.push(update);
  return () => {
    const at = hosts.indexOf(update);
    if (at >= 0) hosts.splice(at, 1);
  };
}
