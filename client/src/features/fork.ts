// H4 "fork": a Git section in the agent panel (branch, ahead/behind, dirty count, the branch's
// PR + checks), a "Fork into worktree" action (optionally starting a plan-mode claude there),
// the forks Alef made for that repo with a "Remove" button (the server refuses unless clean),
// and a small PR chip over the house of agents whose status is already loaded.

import type { ForkMessage, ForkPr, ForkRecord, ForkRemoveResult, ForkRepoStatus, ForkResult, ForkStatusResponse } from "../../../shared/features/fork";
import { log } from "../log";
import { h, isRecord, overlayLayer, place, refreshAgentPanel, toScreen, watchAgentPanel } from "./fleet-overlay";
import "./fork.css";
import type { ClientContext, ClientFeature } from "./registry";

const SLOT = "fx-fork";
const MAX_CHIPS = 6;
const RETRY_MS = 4000;

interface AgentView {
  repos: { root: string; label: string }[];
  root: string;
  status: ForkRepoStatus | null;
  pending: boolean;
  error: string | null;
}

const views = new Map<string, AgentView>();
const pickedRepo = new Map<string, string>();
const busy = new Set<string>();
const chips = new Map<string, HTMLElement>();
let launchPref = true;

function isForkStatus(v: unknown): v is ForkRepoStatus {
  return (
    isRecord(v) &&
    typeof v.root === "string" &&
    (v.branch === null || typeof v.branch === "string") &&
    typeof v.ahead === "number" &&
    typeof v.behind === "number" &&
    typeof v.dirty === "number" &&
    isRecord(v.forkable) &&
    Array.isArray(v.forks)
  );
}

function isStatusResponse(v: unknown): v is ForkStatusResponse {
  if (!isRecord(v) || typeof v.ok !== "boolean") return false;
  if (!v.ok) return typeof v.error === "string";
  return Array.isArray(v.repos) && typeof v.root === "string" && (v.status === null || isForkStatus(v.status)) && typeof v.pending === "boolean";
}

function load(ctx: ClientContext, agentId: string, retry = true): void {
  const repo = pickedRepo.get(agentId);
  const q = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  void ctx.api.getJson<unknown>(`/api/fork/${encodeURIComponent(agentId)}${q}`).then((v) => {
    if (!isStatusResponse(v)) {
      views.set(agentId, { repos: [], root: "", status: null, pending: false, error: v === null ? "no git repo for this agent" : "unreadable answer" });
    } else if (!v.ok) {
      views.set(agentId, { repos: [], root: "", status: null, pending: false, error: v.error });
    } else {
      views.set(agentId, { repos: v.repos, root: v.root, status: v.status, pending: v.pending, error: null });
      // The WS push normally lands first; this covers a dropped socket.
      if (v.pending && retry) setTimeout(() => load(ctx, agentId, false), RETRY_MS);
    }
    rerender(ctx);
  });
}

function rerender(ctx: ClientContext): void {
  refreshAgentPanel(SLOT, (id, el) => renderPanel(id, el, ctx));
}

function checksText(pr: ForkPr): string {
  if (pr.checks === "none") return "no checks";
  const parts = [pr.passed ? `${pr.passed} passed` : "", pr.failed ? `${pr.failed} failed` : "", pr.pending ? `${pr.pending} running` : ""].filter(Boolean);
  return parts.join(" · ");
}

function prLine(st: ForkRepoStatus): HTMLElement {
  const row = h("div", "fk-row fk-pr");
  const pr = st.pr;
  if (!pr) {
    row.append(h("span", "fk-muted", st.prNote ?? (st.branch ? "No PR for this branch" : "Detached HEAD")));
    return row;
  }
  const a = h("a", "fk-prlink", `#${pr.number} ${pr.title}`);
  a.href = pr.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  row.append(h("span", `fk-badge fk-state-${pr.state.toLowerCase()}`, pr.state.toLowerCase()), a, h("span", `fk-badge fk-checks-${pr.checks}`, checksText(pr)));
  return row;
}

async function doFork(ctx: ClientContext, agentId: string, root: string, launch: boolean): Promise<void> {
  busy.add(agentId);
  rerender(ctx);
  const res = await ctx.api.postJson<ForkResult>(`/api/fork/${encodeURIComponent(agentId)}/fork`, { repo: root, launch }, (error) => ({ ok: false, error }), 150_000);
  busy.delete(agentId);
  // postJson is only a typed cast: check the shape before reading the fork record.
  if (res.ok && !(isRecord(res.fork) && typeof res.fork.branch === "string" && typeof res.fork.path === "string")) {
    ctx.toast("Fork: unexpected reply from the server", "error");
  } else if (res.ok) {
    const extra = launch ? (res.launched ? `, plan-mode claude in ${res.fork.tmuxName ?? "tmux"}` : `; claude not started: ${res.launchError ?? "unknown"}`) : "";
    ctx.toast(`Forked into ${res.fork.branch}${extra}`, res.launchError ? "error" : "info");
    log.info("fork", `forked ${res.fork.path}`);
  } else ctx.toast(`Fork refused: ${res.error}`, "error");
  load(ctx, agentId);
}

async function doRemove(ctx: ClientContext, agentId: string, f: ForkRecord): Promise<void> {
  busy.add(agentId);
  rerender(ctx);
  const res = await ctx.api.postJson<ForkRemoveResult>("/api/fork/remove", { id: f.id }, (error) => ({ ok: false, error }), 90_000);
  busy.delete(agentId);
  if (res.ok) ctx.toast(`Removed worktree ${f.branch} (the branch is kept)`);
  else ctx.toast(`Not removed: ${res.error}`, "error");
  load(ctx, agentId);
}

function forkControls(ctx: ClientContext, agentId: string, view: AgentView, st: ForkRepoStatus): HTMLElement {
  const box = h("div", "fk-actions");
  if (!st.forkable.ok) {
    box.append(h("p", "fk-muted fk-refused", `Fork unavailable: ${st.forkable.reason}`));
    return box;
  }
  const label = h("label", "fk-check");
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = launchPref;
  cb.addEventListener("change", () => {
    launchPref = cb.checked;
  });
  label.append(cb, h("span", undefined, "Start a plan-mode claude there"));
  const btn = h("button", "fk-btn", busy.has(agentId) ? "Working…" : "Fork into worktree");
  btn.type = "button";
  btn.disabled = busy.has(agentId);
  btn.title = "New fork/… branch in ~/.alef-worktrees, from this repo's current commit";
  btn.addEventListener("click", () => void doFork(ctx, agentId, view.root, cb.checked));
  box.append(btn, label);
  return box;
}

function forksList(ctx: ClientContext, agentId: string, forks: readonly ForkRecord[]): HTMLElement | null {
  if (forks.length === 0) return null;
  const ul = h("ul", "fk-forks");
  for (const f of forks) {
    const li = h("li");
    const text = h("span", "fk-fork", f.branch);
    text.title = f.path;
    const rm = h("button", "fk-btn fk-btn-small", "Remove");
    rm.type = "button";
    rm.disabled = busy.has(agentId);
    rm.title = "git worktree remove (only when it is clean; the branch is kept)";
    rm.addEventListener("click", () => void doRemove(ctx, agentId, f));
    li.append(text, rm);
    ul.appendChild(li);
  }
  return ul;
}

function renderPanel(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  const view = views.get(agentId);
  slot.replaceChildren();
  if (!view) {
    load(ctx, agentId);
    return;
  }
  const head = h("h3", "fk-head", "Git");
  if (view.error) {
    if (view.error === "no git repo for this agent") return; // nothing to show, keep the panel quiet
    slot.append(head, h("p", "fk-muted", view.error));
    return;
  }
  slot.append(head);
  if (view.repos.length > 1) {
    const sel = h("select", "fk-repo");
    sel.setAttribute("aria-label", "Repository");
    for (const r of view.repos) {
      const o = h("option", undefined, r.label);
      o.value = r.root;
      o.selected = r.root === view.root;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      pickedRepo.set(agentId, sel.value);
      load(ctx, agentId);
    });
    slot.append(sel);
  }
  const st = view.status;
  if (!st) {
    slot.append(h("p", "fk-muted", "Checking git status…"));
    return;
  }
  const row = h("div", "fk-row");
  row.append(h("span", "fk-branch", st.branch ?? "detached HEAD"));
  if (st.upstream) row.append(h("span", "fk-ab", `↑${st.ahead} ↓${st.behind}`));
  row.append(h("span", st.dirty ? "fk-dirty" : "fk-clean", st.dirty ? `${st.dirty} changed` : "clean"));
  slot.append(row, prLine(st), forkControls(ctx, agentId, view, st));
  const list = forksList(ctx, agentId, st.forks);
  if (list) slot.append(h("h4", "fk-sub", "Worktrees Alef made"), list);
}

function chipFor(agentId: string, pr: ForkPr): HTMLElement {
  let el = chips.get(agentId);
  if (!el) {
    el = h("div", "fk-chip");
    overlayLayer().appendChild(el);
    chips.set(agentId, el);
  }
  const text = `PR #${pr.number} ${pr.checks === "success" ? "✓" : pr.checks === "failure" ? "✗" : pr.checks === "pending" ? "…" : ""}`.trim();
  if (el.textContent !== text) el.textContent = text;
  el.className = `fk-chip fk-checks-${pr.checks}`;
  return el;
}

export const forkFeature: ClientFeature = {
  id: "fork",
  mount(ctx) {
    watchAgentPanel(SLOT, (id, slot) => {
      // Reopening the panel refreshes (the server answers from its 60s cache).
      if (views.has(id)) load(ctx, id);
      renderPanel(id, slot, ctx);
    });
  },
  onMessage(msg, ctx) {
    const p: unknown = msg.payload;
    if (!isRecord(p) || p.kind !== "status" || typeof p.root !== "string" || !isForkStatus(p.status)) return;
    const m: ForkMessage = { kind: "status", root: p.root, status: p.status };
    let hit = false;
    for (const view of views.values()) {
      if (view.root !== m.root) continue;
      view.status = m.status;
      view.pending = false;
      hit = true;
    }
    if (hit) rerender(ctx);
  },
  onFrame(_dt, ctx) {
    const keep = new Set<string>();
    for (const [id, view] of views) {
      if (keep.size >= MAX_CHIPS) break;
      const pr = view.status?.pr;
      if (!pr || pr.state !== "OPEN") continue;
      const pos = ctx.agentPosition(id);
      if (!pos) continue;
      keep.add(id);
      place(chipFor(id, pr), toScreen(ctx, pos));
    }
    for (const [id, el] of chips) {
      if (keep.has(id)) continue;
      el.remove();
      chips.delete(id);
    }
  },
};
