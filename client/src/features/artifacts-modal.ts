// The artifact modal (Alex's explicit exception to "nothing floats outside the details panel"):
// a gallery list grouped by month on the left, the picked artifact on the right. With a saved copy
// it shows in a sandboxed iframe (sandbox="allow-scripts" and nothing else: its scripts run in an
// opaque origin, with no same-origin, top navigation, popups or forms, under the server's CSP:
// connect-src 'none'); without one, a card with its date, sessions, district and an "Open on
// claude.ai" link (claude.ai itself can't be framed). ?redact=1 hides titles and never loads a preview.

import { displayIslandName } from "../../../shared/display";
import { MUSEUM_ISLAND_ID, type ArtifactItem } from "../../../shared/features/artifacts";
import { redactOn } from "../redact";
import { modalDialog, type Dialog } from "../ui/kit";
import { artifactLabel, groupByMonth } from "./artifacts-lib";
import { h } from "./fleet-overlay";
import type { ClientContext } from "./registry";

export interface GalleryScope {
  /** MUSEUM_ISLAND_ID = everything; any other city = that district's artifacts. */
  cityId: string;
  selectedId?: string;
}

export interface Gallery {
  open(items: readonly ArtifactItem[], scope: GalleryScope): void;
  close(): void;
  isOpen(): boolean;
}

export const previewUrl = (id: string): string => `/api/artifacts/${encodeURIComponent(id)}/preview`;

function when(iso: string | null): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "date unknown" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function mountGallery(ctx: ClientContext): Gallery {
  const root = h("div", "ui-backdrop art-backdrop");
  root.id = "artifacts-gallery";
  root.hidden = true;
  const card = h("div", "ui-dialog art-card");
  card.setAttribute("aria-labelledby", "art-title");
  const head = h("header", "ui-dialog-head");
  const title = h("h2", undefined, "🖼 Museum");
  title.id = "art-title";
  const close = h("button", "ui-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close the artifact gallery");
  close.title = "Close (Esc)";
  head.append(title, close);
  const list = h("nav", "art-list");
  list.setAttribute("aria-label", "Artifacts by month");
  const view = h("section", "art-view");
  view.setAttribute("aria-live", "polite");
  const body = h("div", "art-body");
  body.append(list, view);
  card.append(head, body);
  root.append(card);
  document.body.append(root);
  const dialog: Dialog = modalDialog(root, card, "Artifacts", () => {
    view.replaceChildren(); // drop the iframe: nothing keeps rendering behind a closed modal
  });
  close.addEventListener("click", () => dialog.close());

  let rows: HTMLButtonElement[] = [];

  function cityName(id: string | null): string {
    if (!id) return "no district (referenced only)";
    const island = ctx.store.islands.get(id);
    return island ? displayIslandName(island) : id;
  }

  function show(item: ArtifactItem): void {
    const redact = redactOn();
    for (const r of rows) r.setAttribute("aria-current", String(r.dataset.id === item.id));
    const meta = h("div", "art-meta");
    meta.append(h("h3", "art-name", artifactLabel(item, redact)));
    const facts = [
      item.origin === "published" ? `Published ${item.publishCount}× · last ${when(item.lastAt)}` : `Referenced · seen ${when(item.lastAt)}`,
      `First seen ${when(item.firstAt)}`,
      `District: ${cityName(item.islandId)}`,
      `${item.sessions.length} session${item.sessions.length === 1 ? "" : "s"}`,
    ];
    meta.append(h("p", "art-facts", facts.join(" · ")));
    const tools = h("div", "art-tools");
    const open = h("a", "comic-btn small", "Open on claude.ai ↗");
    open.href = item.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    tools.append(open);
    const session = item.sessions.find((s) => ctx.store.agents.has(s));
    if (session) {
      const go = h("button", "comic-btn small secondary", "Go to its session");
      go.type = "button";
      go.addEventListener("click", () => {
        dialog.close();
        ctx.flyTo(session);
      });
      tools.append(go);
    }
    meta.append(tools);
    let stage: HTMLElement;
    if (redact) {
      stage = h("div", "art-empty", "Preview hidden in screenshot mode.");
    } else if (item.hasPreview) {
      const frame = h("iframe", "art-frame");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.loading = "lazy";
      frame.title = `Preview of ${artifactLabel(item, false)}`;
      frame.src = previewUrl(item.id);
      stage = frame;
    } else {
      stage = h("div", "art-empty");
      stage.append(
        h("p", undefined, "No local copy of this one."),
        h("p", "art-note", item.origin === "published" ? "Its source page was gone (or off limits) by the time Alef looked, so only claude.ai has it." : "No session here published it, so Alef never saw its source page."),
      );
    }
    view.replaceChildren(meta, stage);
  }

  function render(items: readonly ArtifactItem[], scope: GalleryScope): void {
    const redact = redactOn();
    const museum = scope.cityId === MUSEUM_ISLAND_ID;
    const mine = museum ? [...items] : items.filter((i) => i.islandId === scope.cityId);
    title.textContent = museum ? `🖼 Museum · ${mine.length}` : `🖼 ${cityName(scope.cityId)} · ${mine.length}`;
    rows = [];
    list.replaceChildren();
    for (const g of groupByMonth(mine)) {
      const sec = h("section", "art-month");
      sec.append(h("h4", undefined, `${g.label} · ${g.items.length}`));
      const ul = h("ul");
      for (const item of g.items) {
        const li = h("li");
        const b = h("button", "art-row");
        b.type = "button";
        b.dataset.id = item.id;
        b.append(h("span", "art-row-title", artifactLabel(item, redact)), h("span", "art-row-badge", item.hasPreview ? "preview" : "link"));
        b.addEventListener("click", () => show(item));
        b.addEventListener("keydown", (ev) => {
          if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
          ev.preventDefault();
          const next = rows[rows.indexOf(b) + (ev.key === "ArrowDown" ? 1 : -1)];
          next?.focus();
          next?.click();
        });
        rows.push(b);
        li.append(b);
        ul.append(li);
      }
      sec.append(ul);
      list.append(sec);
    }
    const first = mine.find((i) => i.id === scope.selectedId) ?? groupByMonth(mine)[0]?.items[0];
    if (first) show(first);
    else view.replaceChildren(h("div", "art-empty", museum ? "No artifacts found in the transcripts yet." : "No artifacts from this district yet."));
  }

  return {
    open(items, scope) {
      render(items, scope);
      dialog.open(rows.find((r) => r.dataset.id === scope.selectedId) ?? rows[0] ?? close);
    },
    close: () => dialog.close(),
    isOpen: () => dialog.isOpen(),
  };
}
