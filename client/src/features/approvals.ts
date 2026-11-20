// A2 — permission prompts answered from the world. A red "!" beacon floats over the
// requesting agent's house; a big comic card shows the tool, a sanitized preview and
// Approve / Deny / Answer in its terminal (A / D when the card has focus). A HUD button
// toggles "Approvals in world: ON/OFF" (OFF = the hook falls straight through to the terminal).
// Every answer says what happened: a toast once the server took it, or why it didn't.

import type { ApprovalBehavior, ApprovalPreview, ApprovalView } from "../../../shared/features/approvals";
import { describeError, runAction } from "../ui/action";
import { chrome, chromeMode, expandSurface, isSurfaceCollapsed, onChromeChange } from "../ui/kit";
import { h, isRecord, overlayLayer, place, toScreen } from "./fleet-overlay";
import type { ClientContext, ClientFeature } from "./registry";
import { agentTitle } from "../../../shared/display";

const pending = new Map<string, ApprovalView>();
const beacons = new Map<string, HTMLElement>();
let enabled = true;
let autoApprove = false;
let card: HTMLElement | null = null;
let shownId: string | null = null;
let minimized = false;
let ticker: ReturnType<typeof setInterval> | null = null;
/** The "courier" feature is flying: it shows approvals in-flight, so the card and "!" beacons stay out of the way. */
let suppressed = false;

function isPreview(v: unknown): v is ApprovalPreview {
  return isRecord(v) && typeof v.title === "string" && typeof v.body === "string" && ["command", "diff", "file", "generic"].includes(String(v.kind));
}

export function parseApproval(v: unknown): ApprovalView | null {
  if (!isRecord(v)) return null;
  const { id, agentId, cwd, toolName, preview, createdAt, expiresAt } = v;
  if (typeof id !== "string" || typeof agentId !== "string" || typeof cwd !== "string" || typeof toolName !== "string") return null;
  if (typeof createdAt !== "string" || typeof expiresAt !== "string" || !isPreview(preview)) return null;
  return { id, agentId, cwd, toolName, preview, createdAt, expiresAt };
}

/** Oldest first: the one that will time out soonest. */
function queue(): ApprovalView[] {
  return [...pending.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function toggleButton(): HTMLElement | null {
  return document.getElementById("hud-f-approvals-toggle");
}

function renderToggle(): void {
  const b = toggleButton();
  if (!b) return;
  const label = `Approvals in world: ${enabled ? "ON" : "OFF"}`;
  b.replaceChildren(h("span", "ap-hand", "✋"), h("span", "ap-state", enabled ? "ON" : "OFF"));
  b.classList.toggle("ap-off", !enabled);
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(enabled));
  b.title = enabled
    ? `${label}. Permission prompts come here first; click to send them straight to the terminal.`
    : `${label}. Permission prompts go straight to the terminal; click to answer them here.`;
}

function renderAuto(): void {
  const b = document.getElementById("hud-f-approvals-auto");
  if (!b) return;
  const label = `Auto-approve: ${autoApprove ? "ON" : "OFF"}`;
  b.replaceChildren(h("span", "ap-hand", "⚡"), h("span", "ap-state", autoApprove ? "AUTO" : "ASK"));
  b.classList.toggle("ap-off", !autoApprove);
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(autoApprove));
  b.title = autoApprove
    ? `${label}. Agents never stop for permission; merges, pushes to main, force pushes and prod deploys still ask. Click to ask again.`
    : `${label}. Permission prompts wait for an answer. Click to approve everything except the hard stops.`;
}

/** A refusal that means the request is no longer pending on the server: it expired / is unknown
 *  (404, or 410 for expired), or someone already answered it (409). Anything else (network, 5xx,
 *  a bad body) leaves it pending, so the card stays. */
export function approvalGone(error: string | null | undefined): "expired" | "settled" | null {
  const e = error ?? "";
  if (/already settled|no longer pending/i.test(e)) return "settled";
  if (/expired|unknown or expired request|^HTTP 4(04|10)$/i.test(e)) return "expired";
  return null;
}

export const TOO_LATE = "Too late: that request expired and the terminal prompt took over.";

/** The toast for a decision the server did not take. */
export function approvalFailureText(error: string | null | undefined): string {
  const gone = approvalGone(error);
  if (gone === "expired") return TOO_LATE;
  if (gone === "settled") return "Already answered elsewhere, so this answer didn't count.";
  return `Could not answer: ${describeError(error)}`;
}

/** Sends a REAL decision. On success, or once the server says it is gone, the card moves on and
 *  the Feed item gets its true outcome first (the queue drop alone would read "Closed"). On a
 *  network error or a 5xx the card stays so it can be answered again. Never toasts. */
export async function decideApprovalResult(ctx: ClientContext, id: string, behavior: ApprovalBehavior, message?: string): Promise<{ ok: boolean; error?: string }> {
  const body = message ? { behavior, message } : { behavior };
  const res = await ctx.api.postJson<{ ok: boolean; error?: string }>(`/api/approvals/${encodeURIComponent(id)}/decision`, body, (error) => ({ ok: false, error }));
  const gone = res.ok ? null : approvalGone(res.error);
  if (res.ok || gone) {
    ctx.feed.resolve(`ap:${id}`, res.ok ? behavior : gone === "expired" ? "expired" : "gone");
    pending.delete(id);
    render(ctx);
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "unknown error" };
}

/** Approvals whose decision is in flight. */
const sendingIds = new Set<string>();

function setCardBusy(root: HTMLElement, busy: boolean): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>(".ap-actions button")) b.disabled = busy;
  if (busy) root.setAttribute("aria-busy", "true");
  else root.removeAttribute("aria-busy");
}

const ACTION_LABEL: Record<ApprovalBehavior, string> = { allow: "Approve", deny: "Deny", passthrough: "Answer in its terminal" };

function doneText(behavior: ApprovalBehavior, tool: string): string {
  if (behavior === "allow") return `Approved ${tool}.`;
  if (behavior === "deny") return `Denied ${tool}.`;
  return `Handed back: answer ${tool} in the agent's terminal.`;
}

function agentLine(ctx: ClientContext, a: ApprovalView): string {
  const agent = ctx.store.agents.get(a.agentId);
  const city = agent ? ctx.store.islands.get(agent.islandId)?.name ?? agent.islandId : a.cwd.split("/").filter(Boolean).pop() ?? a.cwd;
  return agent ? `${agentTitle(agent)} · ${city}` : `session ${a.agentId.slice(0, 8)} · ${city}`;
}

function secondsLeft(a: ApprovalView): number {
  return Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 1000));
}

function buildCard(ctx: ClientContext, a: ApprovalView, total: number): HTMLElement {
  const el = h("section", "ap-card");
  el.tabIndex = 0;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `Permission request: ${a.toolName}`);
  const head = h("header", "ap-head");
  head.append(h("span", "ap-bang", "!"), h("h2", undefined, "Permission needed"));
  const chev = h("button", "aw-chev ap-chev");
  chev.type = "button";
  chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  chev.setAttribute("aria-expanded", "true");
  chev.setAttribute("aria-label", "Minimize to its beacon over the house");
  chev.title = "Minimize to its beacon (Esc)";
  chev.addEventListener("click", () => {
    minimized = true;
    render(ctx);
  });
  const timer = h("span", "ap-timer", `${secondsLeft(a)}s`);
  timer.dataset.expires = a.expiresAt;
  head.appendChild(timer);
  if (total > 1) head.appendChild(h("span", "ap-more", `+${total - 1} more`));
  head.appendChild(chev);
  const who = h("button", "ap-who", agentLine(ctx, a));
  who.type = "button";
  who.title = "Fly to this agent";
  who.addEventListener("click", () => ctx.flyTo(a.agentId));
  const tool = h("div", "ap-tool");
  tool.append(h("span", "ap-toolname", a.toolName), h("span", "ap-title", a.preview.title));
  const body = h("pre", `ap-body ap-${a.preview.kind}`);
  if (a.preview.kind === "diff") {
    for (const line of a.preview.body.split("\n")) {
      const cls = line.startsWith("+ ") ? "ap-add" : line.startsWith("- ") ? "ap-del" : "";
      body.appendChild(h("span", cls, `${line}\n`));
    }
  } else {
    body.textContent = a.preview.body || "(no details)";
  }
  const reason = h("input", "ap-reason");
  reason.type = "text";
  reason.maxLength = 500;
  reason.placeholder = "Reason for Claude if you deny (optional)";
  const row = h("div", "ap-actions");
  const approve = h("button", "comic-btn ap-approve", "Approve");
  approve.type = "button";
  approve.title = "Approve (A)";
  const deny = h("button", "comic-btn ap-deny", "Deny");
  deny.type = "button";
  deny.title = "Deny (D)";
  const term = h("button", "comic-btn secondary ap-term", "Answer in its terminal");
  term.type = "button";
  term.title = "Hands this prompt back to the terminal the agent runs in. Opens nothing.";
  // One answer at a time per request: its buttons (and A / D) are off until the server replied,
  // on this card and on any rebuild of it meanwhile (a new request arriving re-renders the card).
  const act = async (behavior: ApprovalBehavior, message?: string): Promise<void> => {
    if (sendingIds.has(a.id)) return;
    sendingIds.add(a.id);
    setCardBusy(el, true);
    await runAction({
      label: ACTION_LABEL[behavior],
      run: () => decideApprovalResult(ctx, a.id, behavior, message),
      success: () => doneText(behavior, a.toolName),
      failure: (r) => approvalFailureText(r.error),
      toast: ctx.toast,
    });
    sendingIds.delete(a.id);
    setCardBusy(el, false);
    if (card && shownId === a.id) setCardBusy(card, false);
  };
  approve.addEventListener("click", () => void act("allow"));
  deny.addEventListener("click", () => void act("deny", reason.value.trim() || undefined));
  term.addEventListener("click", () => void act("passthrough"));
  row.append(approve, deny, term);
  const hint = h("div", "ap-hint", "A approve · D deny · Esc hide");
  el.append(head, who, tool, body, reason, row, hint);
  if (sendingIds.has(a.id)) setCardBusy(el, true);
  el.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === "a") {
      ev.preventDefault();
      void act("allow");
    } else if (k === "d") {
      ev.preventDefault();
      void act("deny", reason.value.trim() || undefined);
    }
  });
  return el;
}

function render(ctx: ClientContext): void {
  const list = queue();
  const top = list[0];
  // isSurfaceCollapsed: H / focus / zen own the chrome, so the beacon stays and the card waits.
  if (!top || minimized || suppressed || isSurfaceCollapsed("approval")) {
    card?.remove();
    card = null;
    shownId = null;
    if (!top) minimized = false;
  } else if (top.id !== shownId || card?.querySelector(".ap-more")?.textContent !== (list.length > 1 ? `+${list.length - 1} more` : undefined)) {
    const hadFocus = card?.contains(document.activeElement) ?? false;
    card?.remove();
    card = buildCard(ctx, top, list.length);
    document.body.appendChild(card);
    shownId = top.id;
    // Take focus only when nothing else has it, so typing in the dispatch bar is never hijacked.
    if (hadFocus || document.activeElement === document.body || document.activeElement === null) card.focus();
  }
  for (const [id, el] of beacons) {
    if (![...pending.values()].some((a) => a.agentId === id)) {
      el.remove();
      beacons.delete(id);
    }
  }
  for (const a of list) {
    if (beacons.has(a.agentId)) continue;
    const b = h("button", "ap-beacon", "!");
    b.type = "button";
    b.title = `${a.toolName} is waiting for your approval`;
    b.addEventListener("click", () => {
      minimized = false;
      if (chromeMode() === "hidden") expandSurface("approval");
      shownId = null;
      render(ctx);
    });
    overlayLayer().appendChild(b);
    beacons.set(a.agentId, b);
  }
  for (const fn of changeListeners) fn();
}

function tickTimers(): void {
  for (const t of document.querySelectorAll<HTMLElement>(".ap-timer")) {
    const left = Math.max(0, Math.round((Date.parse(t.dataset.expires ?? "") - Date.now()) / 1000));
    t.textContent = `${left}s`;
    t.classList.toggle("ap-urgent", left <= 10);
  }
}

export const approvalsFeature: ClientFeature = {
  id: "approvals",
  hudButtons: [
    {
      id: "toggle",
      label: "✋",
      title: "Approvals in world: ON/OFF",
      text: "Approvals in the world",
      onClick(ctx) {
        const next = !enabled;
        void ctx.api
          .postJson<{ enabled?: boolean; error?: string }>("/api/approvals/settings", { enabled: next }, (error) => ({ error }))
          .then((r) => {
            if (typeof r.enabled === "boolean") {
              enabled = r.enabled;
              renderToggle();
              ctx.toast(enabled ? "Approvals now come to the world." : "Approvals go straight to the terminal.");
            } else ctx.toast(`Toggle failed: ${r.error ?? "unknown error"}`, "error");
          });
      },
    },
    {
      id: "auto",
      label: "⚡",
      title: "Auto-approve: ON/OFF",
      text: "Auto-approve permissions",
      onClick(ctx) {
        const next = !autoApprove;
        void ctx.api
          .postJson<{ autoApprove?: boolean; error?: string }>("/api/approvals/settings", { autoApprove: next }, (error) => ({ error }))
          .then((r) => {
            if (typeof r.autoApprove === "boolean") {
              autoApprove = r.autoApprove;
              renderAuto();
              ctx.toast(autoApprove ? "Agents no longer stop for permission (hard stops still ask)." : "Permission prompts wait for an answer again.");
            } else ctx.toast(`Toggle failed: ${r.error ?? "unknown error"}`, "error");
          });
      },
    },
  ],
  mount(ctx) {
    renderAuto();
    if (!chrome().has("approval")) chrome().register("approval", false, false);
    onChromeChange(() => render(ctx));
    renderToggle();
    ticker = ticker ?? setInterval(tickTimers, 1000);
  },
  onSnapshot(world, ctx) {
    const e = world.extras;
    if (typeof e?.["approvals.enabled"] === "boolean") enabled = e["approvals.enabled"];
    if (typeof e?.["approvals.autoApprove"] === "boolean") autoApprove = e["approvals.autoApprove"];
    renderToggle();
    renderAuto();
    pending.clear();
    const list = e?.["approvals.pending"];
    if (Array.isArray(list)) for (const v of list) {
      const a = parseApproval(v);
      if (a) pending.set(a.id, a);
    }
    render(ctx);
  },
  onMessage(msg, ctx) {
    const p = msg.payload;
    if (!isRecord(p)) return;
    if (p.kind === "added") {
      const a = parseApproval(p.approval);
      if (!a) return;
      pending.set(a.id, a);
      minimized = false;
      if (chromeMode() === "hidden") expandSurface("approval"); // H never swallows a new request
      const pos = ctx.agentPosition(a.agentId);
      if (pos) ctx.labels.burst("PERMISSION?", pos);
      render(ctx);
      // Zen steps aside for it; focus mode shows it in the focus card (main.ts listens).
      window.dispatchEvent(new CustomEvent<string>("aw:approval", { detail: a.agentId }));
    } else if (p.kind === "resolved" && typeof p.id === "string") {
      // Record how it ended before the queue drop, which alone reads "Closed" in the Feed.
      if (p.outcome === "allow" || p.outcome === "deny" || p.outcome === "passthrough" || p.outcome === "expired") ctx.feed.resolve(`ap:${p.id}`, p.outcome);
      const had = pending.delete(p.id);
      if (had && p.outcome === "expired") ctx.toast("A permission request timed out; it went back to the terminal.");
      render(ctx);
    } else if (p.kind === "settings" && typeof p.enabled === "boolean") {
      enabled = p.enabled;
      if (typeof p.autoApprove === "boolean") autoApprove = p.autoApprove;
      renderToggle();
      renderAuto();
    }
  },
  onFrame(_dt, ctx) {
    for (const [agentId, el] of beacons) {
      const pos = ctx.agentPosition(agentId);
      if (!pos || suppressed) {
        el.hidden = true;
        continue;
      }
      place(el, toScreen(ctx, pos));
    }
  },
  onEscape(ctx) {
    if (!card) return false;
    minimized = true;
    render(ctx);
    return true;
  },
  paletteCommands: (ctx) =>
    pending.size
      ? [
          {
            id: "show",
            title: `Show ${pending.size} permission request${pending.size === 1 ? "" : "s"}`,
            keywords: ["approve", "permission", "deny"],
            run: () => {
              minimized = false;
              shownId = null;
              render(ctx);
            },
          },
        ]
      : [],
};

// ---- read-only bridge for the "courier" feature (urgent deliveries mid-flight) ----

/** Pending approvals, oldest first. */
export function pendingApprovals(): ApprovalView[] {
  return queue();
}

/** Sends a REAL decision (POST /api/approvals/:id/decision), exactly like the card's buttons,
 *  and toasts when the server did not take it. */
export async function decideApproval(ctx: ClientContext, id: string, behavior: ApprovalBehavior): Promise<void> {
  const r = await decideApprovalResult(ctx, id, behavior);
  if (!r.ok) ctx.toast(approvalFailureText(r.error), "error");
}

/** Hide (true) or restore (false) this feature's card and beacons. */
export function setApprovalCardSuppressed(on: boolean, ctx: ClientContext): void {
  if (suppressed === on) return;
  suppressed = on;
  shownId = null;
  render(ctx);
}

// ---- round 5 E: focus mode reads the queue live ----

const changeListeners = new Set<() => void>();

/** Called after every re-render (added, answered, expired). */
export function onApprovalsChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
