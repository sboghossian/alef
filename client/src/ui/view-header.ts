// One header for every view that has one: a line icon, the title at 22/700 and a muted line
// under it, with the view's own controls on the right. Board, Health and Library each drew
// their own (26/900 italic caps, 22 with an emoji, 24/900), so the page you landed on looked
// like a different app from the one you left. Styling lives in view-header.css.

import { icon } from "../shell/icons";
import { escapeHtml } from "./fuzzy";
import "./view-header.css";

export interface ViewHeaderOpts {
  /** An icon name from shell/icons.ts, usually the view id. No icon when it has none. */
  icon?: string;
  /** Extra classes on the <header>, for a view that lays it out (width, margins). */
  className?: string;
}

/**
 * The header as an HTML string. `title` and `subtitle` are text and are escaped; `actions` is
 * ready-made HTML (the view's tabs or buttons). An empty-string subtitle still renders its line,
 * for a view that fills it in later; leave it undefined for none.
 */
export function viewHeader(title: string, subtitle?: string, actions?: string, opts: ViewHeaderOpts = {}): string {
  const glyph = opts.icon ? icon(opts.icon, 22) : null;
  const cls = opts.className ? `view-head ${opts.className}` : "view-head";
  return (
    `<header class="${escapeHtml(cls)}">` +
    `<h2 class="view-head-title">${glyph ? `<span class="view-head-ico" aria-hidden="true">${glyph}</span>` : ""}${escapeHtml(title)}</h2>` +
    (actions ? `<div class="view-head-actions">${actions}</div>` : "") +
    (subtitle !== undefined ? `<p class="view-head-sub">${escapeHtml(subtitle)}</p>` : "") +
    `</header>`
  );
}

/** The same header as an element, with `actions` given as live nodes (they keep their listeners). */
export function viewHeaderEl(title: string, subtitle?: string, actions: Node[] = [], opts: ViewHeaderOpts = {}): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = viewHeader(title, subtitle, actions.length ? " " : undefined, opts);
  const head = t.content.firstElementChild;
  if (!(head instanceof HTMLElement)) throw new Error("viewHeader rendered no element");
  head.querySelector(".view-head-actions")?.replaceChildren(...actions);
  return head;
}
