// Library, "By type" and "Pinned" lenses: the pinned shelves (one row per section, drag to pin or move,
// "N more →" sideways) and the "Found in sessions" grid. Moved here from the retired shelf.ts;
// behaviour is unchanged. Titles and URLs are untrusted: the cards use textContent.

import type { ShelfBoardItem, ShelfPinsState } from "../../../shared/features/shelf-board";
import { card, DRAG_FROM, DRAG_ID, el, pinAsItem, type CardEnv } from "./shelf-cards";
import { hiddenAfter, shelvesOf } from "./shelf-lib";

/** "N more →" / "←" on a shelf row that scrolls sideways; hidden when everything fits. */
function rowNav(scroller: HTMLElement, back: HTMLButtonElement, more: HTMLButtonElement): void {
  const sync = (): void => {
    const cards = [...scroller.querySelectorAll<HTMLElement>(".sv-card")].map((c) => ({ left: c.offsetLeft, right: c.offsetLeft + c.offsetWidth })); // .sv-row is their offsetParent
    const n = hiddenAfter(cards, scroller.scrollLeft, scroller.clientWidth);
    more.hidden = n === 0;
    more.textContent = `${n} more →`;
    back.hidden = scroller.scrollLeft <= 1;
  };
  const page = (dir: 1 | -1): void => scroller.scrollBy({ left: dir * Math.max(200, scroller.clientWidth - 80), behavior: "smooth" });
  more.addEventListener("click", () => page(1));
  back.addEventListener("click", () => page(-1));
  scroller.addEventListener("scroll", sync, { passive: true });
  new ResizeObserver(sync).observe(scroller);
}

export interface ShelvesInput {
  env: CardEnv;
  state: ShelfPinsState;
  /** Live item for an id, else null (the pin stands in for it). */
  find(id: string): ShelfBoardItem | null;
  /** Search: false hides a pinned card (empty shelves stay, so they can be dropped onto). */
  visible(i: ShelfBoardItem): boolean;
}

export function shelvesEl(inp: ShelvesInput): HTMLElement {
  const { env: e } = inp;
  const wrap = el("section", "sv-shelves");
  let n = 0;
  for (const s of shelvesOf(inp.state)) {
    const pins = s.pins.map((p) => inp.find(p.itemId) ?? pinAsItem(p)).filter(inp.visible);
    const row = el("div", "sv-shelf");
    row.dataset.section = s.section;
    row.append(el("h2", "sv-shelf-h", `${s.section} `));
    row.lastElementChild?.append(el("small", "", String(pins.length === s.pins.length ? s.pins.length : `${pins.length} of ${s.pins.length}`)));
    const cards = el("div", "sv-row");
    if (s.pins.length === 0) cards.append(el("p", "sv-empty", "Drop a card here, or pin one with ☆ or ⋯"));
    for (const i of pins) cards.append(card(i, n++, e, s.section));
    row.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes(DRAG_ID)) return;
      ev.preventDefault();
      row.classList.add("is-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
    row.addEventListener("drop", (ev) => {
      row.classList.remove("is-drop");
      const id = ev.dataTransfer?.getData(DRAG_ID);
      const from = ev.dataTransfer?.getData(DRAG_FROM);
      if (!id || from === s.section) return;
      if (from) e.move(id, from, s.section);
      else e.pin(id, s.section);
    });
    const track = el("div", "sv-track");
    const back = el("button", "sv-nav is-back", "←");
    back.type = "button";
    back.setAttribute("aria-label", `Scroll ${s.section} back`);
    const more = el("button", "sv-nav is-more");
    more.type = "button";
    back.hidden = more.hidden = true;
    track.append(cards, back, more);
    row.append(track);
    wrap.append(row);
    if (pins.length) rowNav(cards, back, more);
  }
  return wrap;
}

/** "Found in sessions": the filtered list as a grid, PAGE at a time. */
export function foundEl(list: readonly ShelfBoardItem[], shown: number, page: number, e: CardEnv, showMore: () => void): HTMLElement {
  const found = el("section", "sv-found");
  found.append(el("h2", "sv-found-h", `Found in sessions · ${list.length}`));
  const grid = el("div", "sv-grid");
  list.slice(0, shown).forEach((i, n) => grid.append(card(i, n, e, null)));
  if (list.length === 0) grid.append(el("p", "sv-note", "Nothing matches these filters."));
  found.append(grid);
  if (list.length > shown) {
    const more = el("button", "sv-more", `Show ${Math.min(page, list.length - shown)} more of ${list.length - shown}`);
    more.type = "button";
    more.addEventListener("click", showMore);
    found.append(more);
  }
  return found;
}
