// P2 "cleanup" (🪦 Retire & tidy up), client side. The Tidy UI (`renderCleanup`, also mounted by
// P3's Health view), a "Tidy up" panel + palette/menu entries, and `retireAgents` with a 10 s
// Undo toast. Every action is a click; "Retire all" needs a second click on a confirm button that
// shows the count and size. The server re-checks every live-guard itself.

import type {
  BucketId,
  CandidatesResponse,
  CleanupMessage,
  CleanupSessionItem,
  CleanupTmuxItem,
  CleanupWorktreeItem,
  RestoreResult,
  RetireItemResult,
  RetireResult,
  TmuxCloseResult,
  TrashManifest,
} from "../../../shared/features/cleanup";
import { DEFAULT_DORMANT_DAYS, DEFAULT_TINY, DORMANT_CHIPS, TINY_CHIPS } from "../../../shared/features/cleanup";
import { log } from "../log";
import {
  BUCKETS,
  ago,
  batchLabel,
  bucketCount,
  chunk,
  diskSentence,
  formatBytes,
  inTrash,
  isCandidatesResponse,
  isObj,
  isRestoreResult,
  isRetireResult,
  isTrashList,
  plural,
  retireSummary,
  selectableIds,
  selectionSummary,
  sessionItems,
  type BucketMeta,
} from "./cleanup-lib";
import "./cleanup.css";
import type { ClientContext, ClientFeature } from "./registry";

const CANDIDATES_TIMEOUT_MS = 60_000;
const UNDO_MS = 10_000;
const RELOAD_NOTE = "Restored. It comes back after the next index pass (about 10 s); reload the page to see its house again.";

/** Refreshers of every mounted Tidy UI (panel and/or Health tab). */
const mounted = new Set<() => void>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `cu-btn ${cls}`.trim(), label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

// ── retire / restore (exported) ────────────────────────────────────────────

async function postRetire(ctx: ClientContext, ids: readonly string[]): Promise<{ batchIds: string[]; results: RetireItemResult[]; error?: string }> {
  const batchIds: string[] = [];
  const results: RetireItemResult[] = [];
  for (const part of chunk(ids)) {
    const r = await ctx.api.postJson<unknown>("/api/cleanup/retire", { ids: part }, (error) => ({ ok: false, error }), 120_000);
    if (!isRetireResult(r)) return { batchIds, results, error: "unreadable answer from the world server" };
    if (!r.ok) return { batchIds, results, error: r.error };
    batchIds.push(r.batchId);
    results.push(...r.results);
  }
  return { batchIds, results };
}

async function restore(ctx: ClientContext, batchId: string, ids?: readonly string[]): Promise<RestoreResult> {
  const r = await ctx.api.postJson<unknown>("/api/cleanup/restore", ids ? { batchId, ids } : { batchId }, (error) => ({ ok: false, error }), 60_000);
  return isRestoreResult(r) ? r : { ok: false, error: "unreadable answer from the world server" };
}

let undoEl: HTMLElement | null = null;

/** A toast with an Undo button for 10 s (ctx.toast is text-only). */
function undoToast(ctx: ClientContext, text: string, batchIds: readonly string[]): void {
  undoEl?.remove();
  const box = el("div", "cu-undo");
  box.setAttribute("role", "status");
  box.append(el("span", "", text));
  const timer = window.setTimeout(() => box.remove(), UNDO_MS);
  box.append(
    button("Undo", "Move these sessions back into ~/.claude/projects", () => {
      window.clearTimeout(timer);
      box.remove();
      void (async () => {
        let ok = 0;
        // Each batch holds exactly what this click retired (≤200 ids), so restore it whole:
        // sending every id to every batch would trip the server's 200-id cap once N > 200.
        for (const b of batchIds) {
          const r = await restore(ctx, b);
          if (r.ok) ok += r.results.filter((x) => x.ok).length;
        }
        ctx.toast(ok > 0 ? `${plural(ok, "session")} restored. Reload the page to see their houses again.` : "Nothing was restored.", ok > 0 ? "info" : "error");
        refreshAll();
      })();
    }),
  );
  document.body.append(box);
  undoEl = box;
}

function refreshAll(): void {
  for (const r of mounted) r();
}

/** Retire sessions (a user click upstream). Toasts "Retired N · Undo" for 10 s. */
export async function retireAgents(ctx: ClientContext, ids: readonly string[]): Promise<RetireResult> {
  if (ids.length === 0) return { ok: false, error: "nothing selected" };
  const out = await postRetire(ctx, ids);
  const okIds = out.results.filter((r) => r.ok).map((r) => r.id);
  if (out.error && okIds.length === 0) {
    ctx.toast(`Retire failed: ${out.error}`, "error");
    return { ok: false, error: out.error };
  }
  if (okIds.length > 0) {
    ctx.store.removeAgents(okIds);
    undoToast(ctx, retireSummary(out.results), out.batchIds);
  } else {
    ctx.toast(retireSummary(out.results), "error");
  }
  refreshAll();
  return { ok: true, batchId: out.batchIds[0] ?? "", results: out.results };
}

// ── the Tidy UI ────────────────────────────────────────────────────────────

interface UiState {
  tiny: number;
  dormantDays: number;
  data: CandidatesResponse | null;
  loading: boolean;
  error: string | null;
  trash: TrashManifest[];
  open: Set<BucketId>;
  selected: Map<BucketId, Set<string>>;
  confirming: BucketId | null;
  busy: boolean;
  openBatches: Set<string>;
  note: string | null;
}

/** Mounts the whole Tidy UI into `host`. Returns a disposer. */
export function renderCleanup(host: HTMLElement, ctx: ClientContext): () => void {
  const s: UiState = {
    tiny: DEFAULT_TINY,
    dormantDays: DEFAULT_DORMANT_DAYS,
    data: null,
    loading: false,
    error: null,
    trash: [],
    open: new Set(),
    selected: new Map(),
    confirming: null,
    busy: false,
    openBatches: new Set(),
    note: null,
  };
  let disposed = false;
  const root = el("div", "cu-root");
  host.replaceChildren(root);

  async function load(): Promise<void> {
    s.loading = true;
    s.error = null;
    draw();
    const [c, t] = await Promise.all([
      ctx.api.getJson<unknown>(`/api/cleanup/candidates?tiny=${s.tiny}&dormantDays=${s.dormantDays}`, CANDIDATES_TIMEOUT_MS),
      ctx.api.getJson<unknown>("/api/cleanup/trash"),
    ]);
    if (disposed) return;
    s.loading = false;
    if (isCandidatesResponse(c)) s.data = c;
    else s.error = "Could not load suggestions from the world server.";
    s.trash = isTrashList(t) ? t.batches.filter((b) => inTrash(b).length > 0) : [];
    s.confirming = null;
    draw();
  }

  function selectedOf(id: BucketId): Set<string> {
    let set = s.selected.get(id);
    if (!set) {
      set = new Set();
      s.selected.set(id, set);
    }
    return set;
  }

  async function doRetire(ids: string[]): Promise<void> {
    if (ids.length === 0 || s.busy) return;
    s.busy = true;
    draw();
    await retireAgents(ctx, ids);
    s.busy = false;
    for (const set of s.selected.values()) for (const id of ids) set.delete(id);
    // retireAgents refreshes every mounted UI (this one included).
  }

  function chips(): HTMLElement {
    const row = el("div", "cu-chips");
    const group = (label: string, values: readonly number[], current: number, unit: string, set: (n: number) => void): HTMLElement => {
      const g = el("div", "cu-chipgroup");
      g.append(el("span", "cu-chiplabel", label));
      for (const v of values) {
        const b = button(`${v}${unit}`, `${label} ${v}${unit}`, () => {
          if (v === current) return;
          set(v);
          void load();
        }, v === current ? "cu-chip on" : "cu-chip");
        b.setAttribute("aria-pressed", String(v === current));
        g.append(b);
      }
      return g;
    };
    row.append(
      group("Tiny = under", TINY_CHIPS, s.tiny, " msgs", (n) => (s.tiny = n)),
      group("Dormant = idle over", DORMANT_CHIPS, s.dormantDays, " days", (n) => (s.dormantDays = n)),
    );
    return row;
  }

  function sessionRow(bucket: BucketId, it: CleanupSessionItem): HTMLElement {
    const row = el("label", it.protected ? "cu-row cu-protected" : "cu-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.disabled = Boolean(it.protected) || s.busy;
    cb.checked = !it.protected && selectedOf(bucket).has(it.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedOf(bucket).add(it.id);
      else selectedOf(bucket).delete(it.id);
      draw();
    });
    const body = el("div", "cu-rowbody");
    body.append(el("div", "cu-title", it.title || "(untitled)"));
    const meta = [it.islandId || it.projDir, ago(it.lastActive, Date.now()), formatBytes(it.bytes), it.reason].filter(Boolean).join(" · ");
    body.append(el("div", "cu-meta", meta));
    if (it.protected) body.append(el("div", "cu-why", `Protected: ${it.protected}`));
    row.append(cb, body);
    return row;
  }

  function tmuxRow(it: CleanupTmuxItem): HTMLElement {
    const row = el("div", it.protected ? "cu-row cu-protected" : "cu-row");
    const body = el("div", "cu-rowbody");
    body.append(el("div", "cu-title", it.name), el("div", "cu-meta", it.reason));
    if (it.protected) body.append(el("div", "cu-why", `Protected: ${it.protected}`));
    row.append(body);
    if (!it.protected) {
      row.append(
        button("Close", "Save its scrollback to ~/.alef-trash as text, then close this tmux session", () => void closeTmux([it.name]), "cu-small"),
      );
    }
    return row;
  }

  function worktreeRow(it: CleanupWorktreeItem): HTMLElement {
    const row = el("div", it.protected ? "cu-row cu-protected" : "cu-row");
    const body = el("div", "cu-rowbody");
    body.append(el("div", "cu-title", it.name), el("div", "cu-meta", `${it.path} · ${it.reason}`));
    if (it.protected) body.append(el("div", "cu-why", `Protected: ${it.protected}`));
    else if (!it.forkId) body.append(el("div", "cu-why", "Not made by Alef: remove it yourself with git worktree remove."));
    row.append(body);
    if (!it.protected && it.forkId) {
      const forkId = it.forkId;
      row.append(button("Remove", "Remove this clean worktree (the branch stays, so git worktree add brings it back)", () => void removeWorktree(forkId), "cu-small"));
    }
    return row;
  }

  async function closeTmux(names: string[]): Promise<void> {
    if (s.busy) return;
    s.busy = true;
    draw();
    let ok = 0;
    let lastError = "";
    for (const name of names) {
      const r = await ctx.api.postJson<TmuxCloseResult>(`/api/cleanup/tmux/${encodeURIComponent(name)}/close`, {}, (error) => ({ ok: false, error }));
      if (isObj(r) && r.ok) ok += 1;
      else lastError = isObj(r) && typeof r.error === "string" ? r.error : "failed";
    }
    s.busy = false;
    ctx.toast(ok > 0 ? `Closed ${plural(ok, "tmux session")}; scrollback saved in ~/.alef-trash` : `Not closed: ${lastError}`, ok > 0 ? "info" : "error");
    void load();
  }

  async function removeWorktree(forkId: string): Promise<void> {
    if (s.busy) return;
    s.busy = true;
    draw();
    const r = await ctx.api.postJson<unknown>("/api/fork/remove", { id: forkId }, (error) => ({ ok: false, error }));
    s.busy = false;
    if (isObj(r) && r.ok === true) ctx.toast("Worktree removed. Its branch is still there.");
    else {
      const err = isObj(r) && typeof r.error === "string" ? r.error : "failed";
      ctx.toast(/dirty|change/i.test(err) ? `Has changes: open it in Finder and commit or stash first. (${err})` : `Not removed: ${err}`, "error");
    }
    void load();
  }

  function bucketCard(meta: BucketMeta, data: CandidatesResponse): HTMLElement | null {
    const b = data.buckets;
    const { count, bytes, protectedCount } = bucketCount(b, meta.id);
    if (count + protectedCount === 0) return null;
    const card = el("section", "cu-card");
    const head = el("div", "cu-cardhead");
    const title = el("div", "cu-cardtitle");
    title.append(el("span", "cu-emoji", meta.emoji), el("span", "", `${count} ${meta.label(count, data.params)}${meta.action === "retire" ? ` · ${formatBytes(bytes)}` : ""}`));
    head.append(title);
    const isOpen = s.open.has(meta.id);
    const actions = el("div", "cu-actions");
    actions.append(
      button(isOpen ? "Hide ▴" : "Review ▾", isOpen ? "Hide the list" : "See each item before choosing", () => {
        if (isOpen) s.open.delete(meta.id);
        else s.open.add(meta.id);
        draw();
      }),
    );
    if (count > 0 && meta.action !== "remove") {
      const verb = meta.action === "retire" ? "Retire all" : "Close all";
      actions.append(
        button(verb, meta.action === "retire" ? "Move all of these to ~/.alef-trash (asks you to confirm)" : "Close all of these (asks you to confirm)", () => {
          s.confirming = meta.id;
          draw();
        }, "cu-primary"),
      );
    }
    head.append(actions);
    card.append(head, el("p", "cu-blurb", protectedCount ? `${meta.blurb} ${protectedCount} protected (live or recently used).` : meta.blurb));

    if (s.confirming === meta.id) {
      const conf = el("div", "cu-confirm");
      const what = meta.action === "retire" ? `Retire ${plural(count, "session")} · ${formatBytes(bytes)}? They move to ~/.alef-trash; you can restore them.` : `Close ${plural(count, "tmux session")}? Each scrollback is saved as text first.`;
      conf.append(el("span", "", what));
      conf.append(
        button(meta.action === "retire" ? `Yes, retire ${count} · ${formatBytes(bytes)}` : `Yes, close ${count}`, "Confirm", () => {
          s.confirming = null;
          if (meta.action === "retire") void doRetire(selectableIds(sessionItems(b, meta.id)));
          else void closeTmux(b.tmux.filter((t) => !t.protected).map((t) => t.name));
        }, "cu-danger"),
        button("Cancel", "Keep them", () => {
          s.confirming = null;
          draw();
        }),
      );
      card.append(conf);
    }

    if (isOpen) {
      const list = el("div", "cu-list");
      if (meta.action === "retire") {
        const items = sessionItems(b, meta.id);
        const sel = selectedOf(meta.id);
        const all = selectableIds(items);
        if (all.length > 0) {
          const allOn = all.every((id) => sel.has(id));
          list.append(
            button(allOn ? "Clear selection" : `Select all ${all.length}`, "Toggle every selectable row", () => {
              if (allOn) sel.clear();
              else for (const id of all) sel.add(id);
              draw();
            }, "cu-small cu-selall"),
          );
        }
        for (const it of items) list.append(sessionRow(meta.id, it));
      } else if (meta.action === "close") {
        for (const it of b.tmux) list.append(tmuxRow(it));
      } else {
        for (const it of b.worktree) list.append(worktreeRow(it));
      }
      card.append(list);
    }
    return card;
  }

  function footer(data: CandidatesResponse): HTMLElement | null {
    const ids: string[] = [];
    let bytes = 0;
    for (const meta of BUCKETS) {
      if (meta.action !== "retire") continue;
      const sum = selectionSummary(sessionItems(data.buckets, meta.id), selectedOf(meta.id));
      ids.push(...sum.ids);
      bytes += sum.bytes;
    }
    if (ids.length === 0) return null;
    const f = el("div", "cu-footer");
    f.append(
      button(`Retire ${ids.length} selected · ${formatBytes(bytes)}`, "Move the selected sessions to ~/.alef-trash (restorable)", () => void doRetire(ids), "cu-primary"),
      button("Clear", "Unselect everything", () => {
        s.selected.clear();
        draw();
      }),
    );
    return f;
  }

  function trashSection(): HTMLElement {
    const sec = el("section", "cu-card cu-trash");
    const head = el("div", "cu-cardhead");
    head.append(el("div", "cu-cardtitle", "🗑 Trash"));
    head.append(button("Show in Finder", "Reveal ~/.alef-trash in Finder", () => void reveal(ctx)));
    sec.append(head);
    if (s.trash.length === 0) {
      sec.append(el("p", "cu-blurb", "Empty. Retired sessions land here, grouped by batch."));
      return sec;
    }
    sec.append(el("p", "cu-blurb", "Restoring moves the files back. It never overwrites; restored agents reappear after a page reload."));
    for (const m of s.trash) {
      const row = el("div", "cu-batch");
      const line = el("div", "cu-batchhead");
      line.append(el("span", "cu-title", batchLabel(m)));
      const acts = el("div", "cu-actions");
      const open = s.openBatches.has(m.batchId);
      acts.append(
        button(open ? "Hide ▴" : "Items ▾", "Restore one session at a time", () => {
          if (open) s.openBatches.delete(m.batchId);
          else s.openBatches.add(m.batchId);
          draw();
        }, "cu-small"),
        button("Restore all", "Move every session of this batch back", () => void doRestore(m.batchId), "cu-small cu-primary"),
        button("Show in Finder", "Reveal this batch in Finder", () => void reveal(ctx, m.batchId), "cu-small"),
      );
      line.append(acts);
      row.append(line);
      if (open) {
        for (const it of inTrash(m)) {
          const r = el("div", "cu-row");
          const body = el("div", "cu-rowbody");
          body.append(el("div", "cu-title", it.title || it.sessionId), el("div", "cu-meta", `${formatBytes(it.bytes)} · ${plural(it.messageCount, "message")}`));
          r.append(body, button("Restore", "Move this session back", () => void doRestore(m.batchId, [it.sessionId]), "cu-small"));
          row.append(r);
        }
      }
      sec.append(row);
    }
    return sec;
  }

  async function doRestore(batchId: string, ids?: string[]): Promise<void> {
    if (s.busy) return;
    s.busy = true;
    draw();
    const r = await restore(ctx, batchId, ids);
    s.busy = false;
    if (!r.ok) {
      ctx.toast(`Restore failed: ${r.error}`, "error");
    } else {
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.find((x) => !x.ok);
      s.note = ok > 0 ? RELOAD_NOTE : null;
      ctx.toast(ok > 0 ? `${plural(ok, "session")} restored.${bad ? ` Refused: ${bad.error ?? ""}` : ""}` : `Not restored: ${bad?.error ?? "nothing to restore"}`, ok > 0 ? "info" : "error");
    }
    void load();
  }

  function draw(): void {
    if (disposed) return;
    root.replaceChildren();
    const head = el("section", "cu-card cu-hero");
    head.append(el("h3", "cu-h", "🪦 Tidy up"));
    head.append(el("p", "cu-disk", s.data ? diskSentence(s.data.buckets.totals.bytes) : "Looking for sessions that could go…"));
    const acts = el("div", "cu-actions");
    acts.append(button(s.loading ? "Checking…" : "Refresh", "Re-scan ~/.claude/projects (read-only)", () => void load()));
    head.append(acts);
    if (s.note) {
      const n = el("div", "cu-note");
      n.append(el("span", "", s.note), button("Reload now", "Reload the page to rebuild the planet", () => location.reload(), "cu-small"));
      head.append(n);
    }
    root.append(head, chips());
    if (s.error) root.append(el("p", "cu-error", s.error));
    if (s.data) {
      let any = false;
      for (const meta of BUCKETS) {
        const card = bucketCard(meta, s.data);
        if (card) {
          any = true;
          root.append(card);
        }
      }
      if (!any) root.append(el("p", "cu-blurb", "Nothing matches these settings. Try a smaller dormant window."));
      const f = footer(s.data);
      if (f) root.append(f);
    }
    root.append(trashSection());
    root.classList.toggle("cu-busy", s.busy || s.loading);
  }

  const refresh = (): void => void load();
  mounted.add(refresh);
  void load();
  return () => {
    disposed = true;
    mounted.delete(refresh);
    root.remove();
  };
}

async function reveal(ctx: ClientContext, batchId?: string): Promise<void> {
  const r = await ctx.api.postJson<unknown>("/api/cleanup/reveal", batchId ? { batchId } : {}, (error) => ({ ok: false, error }));
  if (!isObj(r) || r.ok !== true) ctx.toast(`Could not open Finder: ${isObj(r) && typeof r.error === "string" ? r.error : "failed"}`, "error");
}

function isCleanupMessage(v: unknown): v is CleanupMessage {
  return isObj(v) && (v.kind === "retired" || v.kind === "restored" || v.kind === "tmux-closed") && Array.isArray(v.ids) && v.ids.every((x) => typeof x === "string");
}

let panelDispose: (() => void) | null = null;

export const cleanupFeature: ClientFeature = {
  id: "cleanup",
  onMessage(msg, ctx) {
    if (!isCleanupMessage(msg.payload)) {
      log.warn("cleanup", "ignored a malformed cleanup message");
      return;
    }
    if (msg.payload.kind === "retired") ctx.store.removeAgents(msg.payload.ids);
    refreshAll();
  },
  paletteCommands(ctx) {
    return [
      {
        id: "tidy",
        title: "Tidy up…",
        meta: "Retire old sessions to ~/.alef-trash (restorable)",
        keywords: ["cleanup", "retire", "trash", "disk", "space", "archive", "old sessions"],
        run: () => ctx.openPanel("cleanup"),
      },
      {
        id: "trash",
        title: "Show trash",
        meta: "Reveal ~/.alef-trash in Finder",
        keywords: ["trash", "retired", "restore", "finder"],
        run: () => void reveal(ctx),
      },
    ];
  },
  hudButtons: [{ id: "tidy", label: "🧹", title: "Tidy up: retire old sessions to ~/.alef-trash (restorable)", text: "Tidy up", placement: "menu", onClick: (ctx) => ctx.openPanel("cleanup") }],
  panels: [
    {
      id: "cleanup",
      title: "Tidy up",
      render(elHost, ctx) {
        panelDispose?.();
        panelDispose = renderCleanup(elHost, ctx);
      },
    },
  ],
};
