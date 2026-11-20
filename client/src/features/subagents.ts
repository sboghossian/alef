// "subagents" client feature (round 5 G1b): drones for every subagent a session spawned,
// a "Subagents" section in the agent panel, and a child panel (description, model, status,
// tokens, tools, files, "Open parent"). Data lives in subagent-data.ts so the canvas view
// reads the same records.
// Vision wave 4 (generations and crews): the child panel draws the drone's family tree (parent
// session → children → grandchildren, each with its job and status), and the agent panel's list
// uses the same tree order, so a grandchild sits under its real parent. The rules are in
// family-lib.ts. Read-only: every tree button only opens a panel or flies the camera (through
// runAction, so a target that left the index says so). Descriptions render as text.

import {
  parseRunEndings,
  parseSubagentActivity,
  parseSubagentList,
  parseSubagentStats,
  SUBAGENTS_RECENT_KEY,
  SUBAGENTS_RUNS_KEY,
  SUBAGENTS_STATS_KEY,
  type SubagentActivity,
  type SubagentRecord,
} from "../../../shared/features/subagents";
import { agentTitle } from "../../../shared/display";
import { runAction } from "../ui/action";
import { formatTokens, relativeTime } from "../ui/fuzzy";
import { familyOf, generationLine, treeRows, type TreeRow } from "./family-lib";
import "./family.css";
import { h, isRecord, refreshAgentPanel, watchAgentPanel } from "./fleet-overlay";
import { jobBadge, jobFactRow } from "./jobs";
import { outcomeChip, outcomeOf } from "./outcomes";
import type { ClientContext, ClientFeature } from "./registry";
import { shortModel, subagentData } from "./subagent-data";
import { buildDrones, type Drones } from "./subagents-drones";
import "./subagents.css";

const SLOT = "fx-subagents";
const PANEL_ID = "subagent";
const STATUS_TEXT: Record<SubagentRecord["status"], string> = {
  running: "running (writing, or mid-turn for under 30 min; 2 h awaiting a reply to its prompt)",
  done: "done",
  failed: "failed",
  stopped: "stopped (by its parent, or by the user interrupting its parent)",
  async_launched: "launched, never reported back",
};

let drones: Drones | null = null;
let childId: string | null = null;
/** Rows drawn in the drone panel's family tree (the drone's own line and its children always are). */
const TREE_LIMIT = 24;
/** Rows in the agent panel's Subagents list. */
const SLOT_LIMIT = 30;
/** Each session's whole family is fetched once per page load (GET /api/subagents?parent=): the
 *  snapshot only carries the last 7 days. "failed" = what is loaded may be partial. */
const familyLoads = new Map<string, { state: "loading" | "done" | "failed"; at: number }>();
/** Who waits on a load in flight (a drone panel opened while the agent panel's load runs). */
const familyWaiters = new Map<string, Array<() => void>>();
/** A failed load is tried again on the next render after this (the agent panel re-renders often). */
const FAMILY_RETRY_MS = 30_000;

/** Loads a session's whole family once (again after a failure); `done` runs when it settles. */
function ensureFamily(ctx: ClientContext, sessionId: string, done?: () => void): void {
  const prev = familyLoads.get(sessionId);
  if (prev?.state === "done" || (prev?.state === "failed" && Date.now() - prev.at < FAMILY_RETRY_MS)) return;
  if (prev?.state === "loading") {
    if (done) familyWaiters.get(sessionId)?.push(done);
    return;
  }
  familyLoads.set(sessionId, { state: "loading", at: Date.now() });
  familyWaiters.set(sessionId, done ? [done] : []);
  void subagentData.loadParent(ctx.api, sessionId).then((list) => {
    familyLoads.set(sessionId, { state: list ? "done" : "failed", at: Date.now() });
    const waiters = familyWaiters.get(sessionId) ?? [];
    familyWaiters.delete(sessionId);
    for (const fn of waiters) fn();
  });
}

/** A tree button: navigation only, through runAction so a target that is gone says so. `go`
 *  returns null when it went, or why it couldn't. */
function navButton(ctx: ClientContext, btn: HTMLButtonElement, label: string, go: () => string | null): void {
  btn.type = "button";
  btn.addEventListener("click", () => {
    void runAction({
      label,
      run: async () => {
        const why = go();
        return why === null ? { ok: true } : { ok: false, error: why };
      },
      success: () => null,
      toast: ctx.toast,
      button: btn,
    });
  });
}

/** The tree's top row: the parent session, with its status, outcome and job. */
function sessionRow(ctx: ClientContext, sessionId: string): HTMLElement {
  const li = h("li", "fam-row");
  li.dataset.level = "0";
  const agent = ctx.store.agents.get(sessionId);
  const outcome = outcomeOf(sessionId);
  const chip = outcome ? outcomeChip(outcome) : null;
  const status = agent ? (agent.status === "live" ? "live" : "dormant") : "not in the world now";
  const parts: HTMLElement[] = [h("span", "fam-tag", "🏠 session"), h("span", "fam-text", agent ? agentTitle(agent) : sessionId.slice(0, 8)), h("span", "fam-tag", chip ? `${status} · ${chip.emoji} ${chip.label}` : status), jobBadge(ctx, sessionId)];
  if (!agent) {
    const box = h("div", "fam-node fam-root");
    box.append(...parts);
    li.append(box);
    return li;
  }
  const b = h("button", "fam-node fam-root");
  b.title = "Fly to this session's house";
  b.append(...parts);
  navButton(ctx, b, "Open the parent session", () => {
    if (!ctx.store.agents.has(sessionId)) return "that session is no longer in the world";
    ctx.flyTo(sessionId);
    return null;
  });
  li.append(b);
  return li;
}

/** One subagent row of the tree: its status, job, description and model. The open drone is not a button. */
function subagentRow(ctx: ClientContext, row: TreeRow): HTMLElement {
  const r = row.record;
  const li = h("li", "fam-row");
  li.dataset.level = String(Math.min(row.level, 4));
  const parts: HTMLElement[] = [statusChip(r.status), jobBadge(ctx, r.id), h("span", "fam-text", r.description), h("span", "fam-tag", shortModel(r.model))];
  if (row.kids > 0) parts.push(h("span", "fam-tag", `${row.kids} ${row.kids === 1 ? "child" : "children"}`));
  if (row.orphan) parts.push(h("span", "fam-orphan", "its parent subagent isn't loaded"));
  if (row.focus) {
    const box = h("div", "fam-node fam-focus");
    box.setAttribute("aria-current", "true");
    box.title = "This subagent";
    box.append(...parts);
    li.append(box);
    return li;
  }
  const b = h("button", "fam-node");
  b.title = r.description;
  b.append(...parts);
  navButton(ctx, b, "Open subagent", () => {
    if (!subagentData.records.has(r.id)) return "that subagent is no longer in the index";
    openSubagent(ctx, r.id);
    return null;
  });
  li.append(b);
  return li;
}

/** The drone panel's family: parent session → children → grandchildren (family-lib.ts). */
function familySection(ctx: ClientContext, r: SubagentRecord): HTMLElement {
  const box = h("section", "fam-box");
  const session = r.parentSessionId;
  const draw = (): void => {
    const f = familyOf(subagentData.records.values(), session);
    const load = familyLoads.get(session)?.state;
    const head = h("h4", undefined, "Family tree");
    head.title = "Parent session → children → grandchildren, from GET /api/subagents (parentSessionId, parentAgentId, depth). A subagent handing its result back to its parent is family, not a merge.";
    const note = load === "loading" ? " Loading its older members…" : load === "failed" ? " Its older members couldn't be loaded: this tree may be missing some." : "";
    const ul = h("ul", "fam-tree");
    ul.append(sessionRow(ctx, session));
    const { rows, hidden } = treeRows(f, { focusId: r.id, limit: TREE_LIMIT });
    for (const row of rows) ul.append(subagentRow(ctx, row));
    box.replaceChildren(head, h("p", "fam-chain", `${generationLine(f)}${note}`), ul);
    if (hidden > 0) box.append(h("p", "sa-empty", `+${hidden} more in this family — see them all in the canvas (V)`));
    // The list scrolls on its own; bring this drone's row into it (the panel itself stays put).
    requestAnimationFrame(() => {
      const row = ul.querySelector(".fam-focus");
      if (row && ul.isConnected) ul.scrollTop += row.getBoundingClientRect().top - ul.getBoundingClientRect().top - 40;
    });
  };
  ensureFamily(ctx, session, () => {
    if (box.isConnected) draw();
  });
  draw();
  return box;
}

export function statusChip(status: SubagentRecord["status"]): HTMLElement {
  const chip = h("span", `sa-chip sa-${status}`, status === "async_launched" ? "silent" : status);
  chip.title = STATUS_TEXT[status];
  return chip;
}

/** Opens the child panel for one subagent (drones, the agent panel list and the canvas use it). */
export function openSubagent(ctx: ClientContext, id: string): void {
  childId = id;
  ctx.openPanel(PANEL_ID);
}

function renderChild(el: HTMLElement, ctx: ClientContext): void {
  el.className = "sa-panel";
  const r = childId ? subagentData.records.get(childId) : undefined;
  if (!r) {
    el.append(h("p", "sa-empty", "This subagent is no longer in the index."));
    return;
  }
  const head = h("div", "sa-head");
  head.append(statusChip(r.status), h("span", "sa-model", shortModel(r.model)));
  el.append(head, h("h3", "sa-title", r.description));
  const dl = h("dl", "sa-facts");
  const fact = (k: string, v: string): void => {
    dl.append(h("dt", undefined, k), h("dd", undefined, v));
  };
  fact("Status", STATUS_TEXT[r.status]);
  if (r.reason) fact("Why", r.reason);
  fact("Type", r.agentType ?? "unknown");
  dl.append(...jobFactRow(ctx, r.id)); // its job + the signal behind it (features/jobs.ts)
  fact("Model", r.model ?? "unknown");
  fact("Tokens", formatTokens(r.tokens));
  fact("Started", relativeTime(r.startedAt));
  fact("Last write", relativeTime(r.lastActive));
  if (r.workflowId) fact("Workflow", r.workflowId);
  fact("Depth", r.depth === 1 ? "spawned by the session" : `level ${r.depth} (spawned by another subagent)`);
  el.append(dl, familySection(ctx, r));

  const tools = Object.entries(r.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (tools.length) {
    el.append(h("h4", undefined, "Tools"));
    const ul = h("ul", "sa-tools");
    for (const [name, n] of tools) {
      const li = h("li");
      li.append(h("span", undefined, name.startsWith("mcp__") ? name.replace(/^mcp__/, "").replace("__", " · ") : name), h("b", undefined, String(n)));
      ul.append(li);
    }
    el.append(ul);
  }
  el.append(h("h4", undefined, "Files it touched"));
  const files = h("ul", "sa-files");
  if (r.files.length === 0) files.append(h("li", "sa-empty", "none recorded"));
  for (const f of r.files) {
    const li = h("li");
    const name = f.path.split("/").pop() ?? f.path;
    const span = h("span", undefined, name);
    span.title = f.path;
    li.append(span, h("b", undefined, String(f.count)));
    files.append(li);
  }
  el.append(files);

  const actions = h("div", "sa-actions");
  const parent = ctx.store.agents.get(r.parentSessionId);
  const openParent = h("button", "comic-btn", parent ? "Open parent" : "Parent not in the world");
  openParent.type = "button";
  openParent.disabled = !parent;
  openParent.addEventListener("click", () => ctx.flyTo(r.parentSessionId));
  actions.append(openParent);
  if (r.parentAgentId) {
    const up = h("button", "comic-btn secondary", "Open parent subagent");
    up.type = "button";
    const pid = r.parentAgentId;
    up.addEventListener("click", () => openSubagent(ctx, pid));
    actions.append(up);
  }
  el.append(actions);
}

function renderAgentSlot(agentId: string, slot: HTMLElement, ctx: ClientContext): void {
  slot.replaceChildren();
  // A load that adds records re-renders this slot through subagentData.onChange (mount).
  ensureFamily(ctx, agentId);
  const f = familyOf(subagentData.records.values(), agentId);
  if (f.size === 0) return;
  let live = 0;
  for (const r of subagentData.records.values()) if (r.parentSessionId === agentId && r.status === "running") live += 1;
  slot.append(h("h3", "sa-slot-head", `Subagents ${f.size}${live ? ` · ${live} running` : ""}`), h("p", "fam-chain", generationLine(f)));
  const ul = h("ul", "sa-kids");
  // Tree order (family-lib.ts): each subagent right under the one that spawned it.
  const { rows, hidden } = treeRows(f, { limit: SLOT_LIMIT });
  for (const row of rows) {
    const k = row.record;
    const li = h("li");
    const b = h("button", "sa-kid");
    b.type = "button";
    b.dataset.depth = String(Math.min(row.level, 4));
    b.append(statusChip(k.status), h("span", "sa-kid-text", k.description), h("span", "sa-kid-meta", shortModel(k.model)));
    b.addEventListener("click", () => openSubagent(ctx, k.id));
    li.append(b);
    ul.append(li);
  }
  slot.append(ul);
  if (hidden > 0) slot.append(h("p", "sa-empty", `+${hidden} more — see them all in the canvas (V)`));
}

function ingest(list: SubagentRecord[]): void {
  subagentData.upsert(list);
}

export const subagentsFeature: ClientFeature = {
  id: "subagents",
  mount(ctx) {
    drones = buildDrones(ctx);
    drones.setRecords(subagentData.records.values());
    subagentData.onChange(() => {
      drones?.setRecords(subagentData.records.values());
      refreshAgentPanel(SLOT, (id, s) => renderAgentSlot(id, s, ctx));
    });
    watchAgentPanel(SLOT, (id, slot) => renderAgentSlot(id, slot, ctx));
    // Drone clicks: capture phase on window so the hub's house click (enter room) never sees it.
    const canvas = document.querySelector<HTMLCanvasElement>("#app canvas");
    let down: { x: number; y: number } | null = null;
    window.addEventListener(
      "pointerdown",
      (ev) => {
        down = ev.target === canvas ? { x: ev.clientX, y: ev.clientY } : null;
      },
      true,
    );
    window.addEventListener(
      "click",
      (ev) => {
        if (ev.target !== canvas || !down || !drones || document.body.classList.contains("in-room")) return;
        if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
        const id = drones.pick(ev.clientX, ev.clientY, ctx);
        if (!id) return;
        ev.stopImmediatePropagation();
        openSubagent(ctx, id);
      },
      true,
    );
  },
  onSnapshot(world) {
    const extras = world.extras ?? {};
    subagentData.setStats(parseSubagentStats(extras[SUBAGENTS_STATS_KEY]));
    ingest(parseSubagentList(extras[SUBAGENTS_RECENT_KEY]));
    if (SUBAGENTS_RUNS_KEY in extras) subagentData.setRunEndings(parseRunEndings(extras[SUBAGENTS_RUNS_KEY]));
  },
  onMessage(msg) {
    const p = msg.payload;
    if (!isRecord(p)) return;
    if (p.kind === "upsert") {
      subagentData.setStats(parseSubagentStats(p.stats));
      ingest(parseSubagentList(p.subagents));
    } else if (p.kind === "runs") {
      subagentData.setRunEndings(parseRunEndings(p.endings));
    } else if (p.kind === "activity" && Array.isArray(p.items)) {
      const items = p.items.map(parseSubagentActivity).filter((a): a is SubagentActivity => a !== null);
      subagentData.activity(items);
    }
  },
  onFrame(_dt, ctx) {
    drones?.setVisible(!document.body.classList.contains("in-room"));
    drones?.update(ctx.elapsed(), ctx);
  },
  panels: [{ id: PANEL_ID, title: "Subagent", render: renderChild }],
  paletteCommands: (ctx) =>
    [...subagentData.records.values()]
      .filter((r) => r.status === "running")
      .slice(0, 10)
      .map((r) => ({ id: `open-${r.id}`, title: `Subagent: ${r.description}`, kind: "subagent", keywords: ["subagent", "drone", r.agentType ?? ""], run: () => openSubagent(ctx, r.id) })),
};
