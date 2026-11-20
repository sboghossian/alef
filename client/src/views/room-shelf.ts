// The Room's shelf: what the session produced or referenced (B's GET /api/shelf/:agentId).
// Learnings are jars, pages/images are frames, other files are books, links are postcards.
// Previewable files open in-app in a sandboxed iframe (sandbox="" + the server's strict CSP,
// scripts never run); links and claude.ai artifacts open in a new browser tab.

import type { ShelfError, ShelfFile, ShelfResponse } from "../../../shared/features/shelf";
import { h, isRecord } from "../features/fleet-overlay";
import type { ClientApi } from "../features/registry";

export type ShelfResult = ShelfResponse | ShelfError;

const MAX_BOOKS = 8;
const MAX_LINKS = 6;
const MAX_FRAMES = 6;

export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function previewUrl(agentId: string, path: string): string {
  return `/api/shelf/preview?path=${encodeURIComponent(path)}&agentId=${encodeURIComponent(agentId)}`;
}

/** http(s) only: anything else (javascript:, data:, file:) is never turned into a link. */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export async function loadShelf(api: ClientApi, agentId: string): Promise<ShelfResult> {
  const res = await api.getJson<unknown>(`/api/shelf/${encodeURIComponent(agentId)}`, 15_000);
  if (!isRecord(res)) return { ok: false, error: "The shelf is not reachable right now." };
  if (res.ok !== true) return { ok: false, error: typeof res.error === "string" ? res.error : "The shelf is empty." };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const file = (v: unknown): ShelfFile | null =>
    isRecord(v) && typeof v.path === "string" && typeof v.type === "string"
      ? {
          path: v.path,
          type: v.type as ShelfFile["type"],
          op: v.op === "edit" ? "edit" : "write",
          count: typeof v.count === "number" ? v.count : 1,
          lastAt: typeof v.lastAt === "string" ? v.lastAt : null,
          previewable: v.previewable === true,
          exists: v.exists !== false,
        }
      : null;
  const files = (v: unknown): ShelfFile[] => arr(v).map(file).filter((f): f is ShelfFile => f !== null);
  return {
    ok: true,
    agentId,
    urls: arr(res.urls).flatMap((u) =>
      isRecord(u) && typeof u.url === "string"
        ? [{ url: u.url, host: typeof u.host === "string" ? u.host : "", count: typeof u.count === "number" ? u.count : 1, firstAt: typeof u.firstAt === "string" ? u.firstAt : null }]
        : [],
    ),
    artifacts: arr(res.artifacts).flatMap((a) => (isRecord(a) && typeof a.url === "string" ? [{ url: a.url, firstAt: typeof a.firstAt === "string" ? a.firstAt : null }] : [])),
    files: files(res.files),
    media: files(res.media),
    learnings: files(res.learnings),
  };
}

export interface ShelfActions {
  preview(file: ShelfFile): void;
  /** Non-previewable file: show it in the Code view. */
  openInCode(file: ShelfFile): void;
}

const ICON: Record<ShelfFile["type"], string> = { html: "🖼️", markdown: "📜", image: "🌄", code: "📘", data: "📗", text: "📙", other: "📓" };

function fileButton(f: ShelfFile, cls: string, icon: string, actions: ShelfActions): HTMLButtonElement {
  const b = h("button", `rm-shelf-item ${cls}`);
  b.type = "button";
  b.append(h("span", "rm-shelf-ico", icon), h("span", "rm-shelf-name", baseName(f.path)));
  const verb = !f.exists ? "was deleted" : f.previewable ? "click to preview here" : "click to open in Code";
  b.title = `${f.path}\n${f.op === "edit" ? "edited" : "written"} ${f.count}× · ${verb}`;
  b.classList.toggle("rm-gone", !f.exists);
  b.disabled = !f.exists;
  b.addEventListener("click", () => (f.previewable ? actions.preview(f) : actions.openInCode(f)));
  return b;
}

function linkButton(url: string, label: string, cls: string, icon: string): HTMLElement {
  const safe = safeHttpUrl(url);
  if (!safe) return h("span", `rm-shelf-item ${cls} rm-gone`, label);
  const a = h("a", `rm-shelf-item ${cls}`);
  a.href = safe;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = `${safe}\nopens in a new tab`;
  a.append(h("span", "rm-shelf-ico", icon), h("span", "rm-shelf-name", label));
  return a;
}

function plank(title: string, items: HTMLElement[], empty: string): HTMLElement {
  const row = h("div", "rm-plank");
  row.append(h("div", "rm-plank-title", title));
  const shelf = h("div", "rm-plank-items");
  if (items.length) shelf.append(...items);
  else shelf.append(h("span", "rm-plank-empty", empty));
  row.append(shelf);
  return row;
}

/** Fills `el` with the shelf. Counts are real; nothing is invented to fill a plank. */
export function renderShelf(el: HTMLElement, res: ShelfResult, actions: ShelfActions): { total: number } {
  el.replaceChildren();
  if (!res.ok) {
    el.append(h("p", "rm-shelf-note", res.error));
    return { total: 0 };
  }
  const mediaPaths = new Set(res.media.map((m) => m.path));
  const learnPaths = new Set(res.learnings.map((m) => m.path));
  const books = res.files.filter((f) => !mediaPaths.has(f.path) && !learnPaths.has(f.path));
  const frames = [
    ...res.media.slice(0, MAX_FRAMES).map((f) => fileButton(f, "rm-frame", ICON[f.type], actions)),
    ...res.artifacts.slice(0, 3).map((a) => linkButton(a.url, "artifact", "rm-frame", "✨")),
  ];
  el.append(
    plank("Learnings", res.learnings.slice(0, 6).map((f) => fileButton(f, "rm-jar", "🫙", actions)), "no lessons written"),
    plank("Pages & pictures", frames, "no pages or images"),
    plank(`Files written (${res.files.length})`, books.slice(0, MAX_BOOKS).map((f) => fileButton(f, "rm-book", ICON[f.type], actions)), "no files written"),
    plank("Links", res.urls.slice(0, MAX_LINKS).map((u) => linkButton(u.url, u.host || u.url, "rm-card", "🔗")), "no links"),
  );
  return { total: res.files.length + res.urls.length + res.artifacts.length };
}
