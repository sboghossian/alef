// The Inbox: live agents waiting on your answer, plus dispatches/launches that never became one
// (stranded), plus the Health keeper's open item for the day, plus Jev's proposals. It lives in one
// place, the 🏠 Home view's first section "Needs you now" (UX-1: the right rail's Inbox tab, which
// mounted the same list a second time, is gone). openNeedsYou() is how anything opens it.

import { STRANDED_CLOSABLE, type StrandedDispatch, type TalkActionResult } from "../../../shared/features/talk";
import type { HealthKeeperInboxItem } from "../../../shared/features/health-keeper";
import type { WorldAgent } from "../../../shared/types";
import { escapeHtml, relativeTime } from "../ui/fuzzy";
import { launchInFlight, trustAndRelaunch } from "../ui/launch-result";
import { onHealthKeeperUpdate, openHealthInboxItem } from "./health-keeper";
import { currentPresidentBoard, dismissProposal, launchProposal, approveMerge, onPresidentUpdate, retireProposal } from "./president";
import { presidentLaunchKey, renderProposalsSection, retireConfirmText } from "./president-lib";
import type { ClientApi, ClientContext, ClientFeature } from "./registry";
import { HOME_VIEW_ID } from "../views/home-lib";
import { onTalkChange, strandedDispatches } from "./talk";
import { agentTitle } from "../../../shared/display";

const STRANDED_LABELS: Record<StrandedDispatch["blockedOn"], string> = {
  trust: "waiting for folder trust",
  chrome: "blocked on the Chrome prompt",
  menu: "waiting on a prompt",
  "empty-prompt": "sitting at an empty prompt",
  exited: "exited before it started",
  unknown: "in an unknown state",
};

/** Close's confirm: it is a stuck dispatch, its tmux session ends, and its scrollback is kept —
 *  the route saves it to ~/.alef-trash before the kill. It states the route's real conditions
 *  rather than promising it can tell a working agent apart (PR #29 review). */
export const STRANDED_CLOSE_CONFIRM =
  "Close this stuck dispatch? Its tmux session is ended. Its scrollback is saved to ~/.alef-trash first. Alef only closes it if it is still on the folder-trust or Chrome dialog, or back at a shell, in a tmux session with one window and one pane, and no session in this project has been active since it was dispatched.";

/** Shown under a row Close would refuse, so the way out is clear. */
const NOT_CLOSABLE_HINT = "A working agent can look like this, so Alef won't close it. Attach and exit it in Terminal.";
/** Shown under a closable screen in a session with other windows or panes: Close would end them too. */
const OTHER_PANES_HINT = "This tmux session has other windows or panes, so Alef won't close it. Attach and exit it in Terminal.";

function cwdBasename(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** The "Started from Alef but never began" section, oldest first — pure HTML, no DOM, so it's
 *  trivially unit-testable (e.g. that a hostile promptHead renders as inert text). */
export function renderStrandedSection(stranded: readonly StrandedDispatch[]): string {
  if (stranded.length === 0) return "";
  const sorted = [...stranded].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const rows = sorted
    .map((s) => {
      const age = relativeTime(s.startedAt).replace(" ago", "");
      const prompt = s.promptHead ? `<div class="i-stranded-prompt">${escapeHtml(s.promptHead)}</div>` : "";
      // Close only where the server can act: an empty prompt, a menu or an unknown screen can be
      // a working agent, and a session with other windows/panes would lose them too; the route
      // refuses those every time.
      const closableScreen = STRANDED_CLOSABLE.includes(s.blockedOn);
      const closable = closableScreen && s.closable;
      const close = closable ? `<button type="button" class="i-btn-danger" data-close="${escapeHtml(s.tmuxName)}">Close…</button>` : "";
      // Waiting on claude's folder-trust dialog: grant trust (one key of ~/.claude.json), Close it
      // under Close's own checks, relaunch its prompt. Never answers the dialog by keys.
      const trust =
        s.blockedOn === "trust"
          ? `<button type="button" class="i-btn-primary" data-trust-relaunch="${escapeHtml(s.tmuxName)}" data-cwd="${escapeHtml(s.cwd)}">Trust ${escapeHtml(cwdBasename(s.cwd))} &amp; relaunch</button>`
          : "";
      // Said on the row, not only in a hover title: otherwise a row just offers Attach, silently.
      const noClose = closable ? "" : `<small class="i-stranded-why">${escapeHtml(closableScreen ? OTHER_PANES_HINT : NOT_CLOSABLE_HINT)}</small>`;
      return `<li class="i-stranded">
        <div class="i-stranded-head">
          <span class="i-city">${escapeHtml(cwdBasename(s.cwd))}</span>
          <span class="i-wait">${escapeHtml(STRANDED_LABELS[s.blockedOn])} · ${escapeHtml(age)}</span>
        </div>
        ${prompt}
        <div class="i-stranded-actions">
          ${trust}
          <button type="button" data-attach="${escapeHtml(s.tmuxName)}">Attach</button>
          ${close}
        </div>
        ${noClose}
      </li>`;
    })
    .join("");
  return `<h3 class="alef-pane-h">Started from Alef but never began <span class="alef-fcount">${sorted.length}</span></h3><ul class="alef-inbox alef-stranded">${rows}</ul>`;
}

/** "Inbox zero" — shown only when there is truly nothing to see, not just nothing waiting. Pure
 *  and testable like renderStrandedSection: the old version baked "nobody waiting" into the
 *  waiting-list markup alone, so it could render right above a non-empty stranded section.
 *  `otherCount`: other open items (the Health keeper's). */
export function renderEmptyState(waitingCount: number, strandedCount: number, otherCount = 0): string {
  return waitingCount === 0 && strandedCount === 0 && otherCount === 0 ? `<div class="i-empty"><b>Inbox zero.</b> Nobody is waiting on you.</div>` : "";
}

/** The Health keeper's item for the day (server/features/health-keeper.ts): the score, then each
 *  failing / warning check with its fix, and a button that opens Health. Empty when there is none
 *  open (Health read 100 again, or no pass under 100 yet). Pure: every value is escaped. */
export function renderHealthSection(item: HealthKeeperInboxItem | null): string {
  if (!item) return "";
  const rows = item.issues
    .map((i) => `<li class="i-health-issue"><b>${escapeHtml(i.label)}</b> — ${escapeHtml(i.fix)}</li>`)
    .join("");
  return `<h3 class="alef-pane-h">Health check <span class="alef-fcount">${escapeHtml(String(item.score))}%</span></h3><ul class="alef-inbox alef-stranded alef-health"><li class="i-stranded">
      <div class="i-stranded-head"><span class="i-city">Health ${escapeHtml(String(item.score))}%</span><span class="i-wait">night check · ${escapeHtml(relativeTime(item.at))}</span></div>
      <ul class="i-health-issues">${rows}</ul>
      <div class="i-stranded-actions"><button type="button" class="i-btn-primary" data-open-health="1">Open Health</button></div>
    </li></ul>`;
}

/** What a successful Attach/Close did. Attach's Terminal window can open behind the browser, so
 *  the toast says where to look and what to answer there. */
export function strandedSuccessText(action: "attach" | "close", tmuxName: string): string {
  return action === "attach"
    ? `Opened Terminal on ${tmuxName}. Answer Claude's question there (look for trust this folder, or a menu).`
    : `Closed ${tmuxName}. Its screen was saved in ~/.alef-trash.`;
}

/** Attach/Close for a stranded row: reports ANY failure through the toast instead of dropping it
 *  silently — a 404 when the server doesn't list (Attach) or know (Close) that session, a 409 when
 *  tmux is missing or Close refuses a session that no longer re-verifies as stranded, or a 500
 *  when kill-session/the scrollback save fails — and says what a success did. */
export function makeStrandedActions(api: ClientApi, toast: (text: string, kind?: "info" | "error") => void): { attach: (tmuxName: string) => void; close: (tmuxName: string) => void } {
  function run(tmuxName: string, action: "attach" | "close"): void {
    void api.postJson<TalkActionResult>(`/api/talk/stranded/${encodeURIComponent(tmuxName)}/${action}`, undefined, (error) => ({ ok: false, error })).then((r) => {
      if (!r.ok) toast(r.error ?? `could not ${action} this session`, "error");
      else toast(strandedSuccessText(action, r.tmuxName ?? tmuxName));
    });
  }
  return { attach: (tmuxName) => run(tmuxName, "attach"), close: (tmuxName) => run(tmuxName, "close") };
}

export interface Inbox {
  render(agents: WorldAgent[]): void;
  /** Round 10: repaints the "Jev proposes" section below the waiting list, without disturbing
   *  it — called whenever the president board changes (see president.ts's onPresidentUpdate). */
  renderProposals(): void;
  /** Repaints the stranded-dispatches section and the combined badge, without disturbing the
   *  waiting list — called from talk.ts's onTalkChange whenever bindings/stranded change. */
  renderStranded(): void;
  /** Repaints the Health keeper's item and the badge (health-keeper.ts's onHealthKeeperUpdate). */
  renderHealth(): void;
}

/** The right sidebar's Inbox tab (#alef-pane-inbox): live agents waiting on your answer, oldest
 *  first. The row dives through the house into the agent's Room (`onPick` → ctx.diveToRoom,
 *  round 9). Below the waiting list (round 10): "Jev proposes" — at most a few session/merge
 *  proposals, plus the 🎓 Commencement block (schedule / retire / first job / lesson → hook) and
 *  Jev's record line; Launch/Merge/Retire always through a real user click here (Retire confirms
 *  first), never automatically. Below
 *  that: dispatches/launches that never became an agent (stranded) — Attach opens Terminal on
 *  the real tmux session; Close is destructive (kills that tmux session) and confirms first. */
export function mountInbox(
  pane: HTMLElement,
  onPick: (agentId: string) => void,
  setBadge: (n: number) => void,
  onLaunch: (id: string) => void,
  onDismiss: (id: string) => void,
  onMerge: (id: string) => void,
  onAttachStranded: (tmuxName: string) => void,
  onCloseStranded: (tmuxName: string) => void,
  onTrustRelaunch: (tmuxName: string, cwd: string, button: () => HTMLButtonElement | null) => void = () => {},
  onRetire: (id: string) => void = () => {},
  onOpenHealth: () => void = () => {},
): Inbox {
  pane.addEventListener("click", (ev) => {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    const launch = target?.closest<HTMLButtonElement>("button[data-launch]");
    if (launch?.dataset.launch) {
      if (!launch.disabled) onLaunch(launch.dataset.launch);
      return;
    }
    const retire = target?.closest<HTMLElement>("button[data-retire]");
    if (retire?.dataset.retire) {
      if (confirm(retireConfirmText(retire.dataset.subject ?? "this worker"))) onRetire(retire.dataset.retire);
      return;
    }
    const merge = target?.closest<HTMLElement>("button[data-merge]");
    if (merge?.dataset.merge) {
      onMerge(merge.dataset.merge);
      return;
    }
    const dismiss = target?.closest<HTMLElement>("button[data-dismiss]");
    if (dismiss?.dataset.dismiss) {
      onDismiss(dismiss.dataset.dismiss);
      return;
    }
    const trustBtn = target?.closest<HTMLButtonElement>("button[data-trust-relaunch]");
    if (trustBtn?.dataset.trustRelaunch && trustBtn.dataset.cwd) {
      const name = trustBtn.dataset.trustRelaunch;
      if (!trustBtn.disabled) onTrustRelaunch(name, trustBtn.dataset.cwd, () => pane.querySelector<HTMLButtonElement>(`button[data-trust-relaunch="${CSS.escape(name)}"]`));
      return;
    }
    if (target?.closest("button[data-open-health]")) {
      onOpenHealth();
      return;
    }
    const attach = target?.closest<HTMLElement>("button[data-attach]");
    if (attach?.dataset.attach) {
      onAttachStranded(attach.dataset.attach);
      return;
    }
    const close = target?.closest<HTMLElement>("button[data-close]");
    if (close?.dataset.close) {
      if (confirm(STRANDED_CLOSE_CONFIRM)) onCloseStranded(close.dataset.close);
      return;
    }
    const b = target?.closest<HTMLElement>("button[data-agent]");
    const id = b?.dataset.agent;
    if (id) onPick(id);
  });
  let waitingCount = 0;
  let waitingHtml = "";
  let strandedCount = 0;
  let strandedHtml = "";
  let proposalsHtml = "";
  let healthCount = 0;
  let healthHtml = "";
  function paint(): void {
    pane.innerHTML = renderEmptyState(waitingCount, strandedCount, healthCount) + waitingHtml + strandedHtml + healthHtml + proposalsHtml;
  }
  function repaintStranded(): void {
    const stranded = strandedDispatches();
    strandedCount = stranded.length;
    setBadge(waitingCount + stranded.length + healthCount);
    strandedHtml = renderStrandedSection(stranded);
    paint();
  }
  return {
    render(agents) {
      const waiting = agents
        .filter((a) => a.awaitingInput === true)
        .sort((a, b) => Date.parse(a.lastActive) - Date.parse(b.lastActive));
      waitingCount = waiting.length;
      waitingHtml = waiting.length
        ? `<h3 class="alef-pane-h">Waiting for you <span class="alef-fcount">${waiting.length}</span></h3><ul class="alef-inbox">${waiting
            .map(
              (a) => `<li><button type="button" data-agent="${escapeHtml(a.id)}">
              <span class="i-city">${escapeHtml(a.islandId)}</span>
              <span class="i-title">${escapeHtml(agentTitle(a))}</span>
              <span class="i-wait">waiting ${relativeTime(a.lastActive).replace(" ago", "")}</span>
            </button></li>`,
            )
            .join("")}</ul>`
        : "";
      repaintStranded();
    },
    renderProposals() {
      proposalsHtml = renderProposalsSection(currentPresidentBoard(), (id) => launchInFlight(presidentLaunchKey(id)));
      paint();
    },
    renderStranded: repaintStranded,
    renderHealth() {
      const item = openHealthInboxItem();
      healthCount = item ? 1 : 0;
      healthHtml = renderHealthSection(item);
      repaintStranded(); // the badge and the paint
    },
  };
}

/** The whole Inbox, live, in `pane`: the waiting list, the stranded dispatches and Jev's proposals,
 *  with the same actions (Launch / Dismiss / Merge / Retire through president.ts, Attach / Close /
 *  Trust & relaunch through talk). needsPane() below is the one the app shows (Home's "Needs you
 *  now"). Its subscriptions live as long as the page: mount it once per host element. */
export function mountInboxPane(pane: HTMLElement, ctx: ClientContext, setBadge: (n: number) => void): Inbox {
  const strandedActions = makeStrandedActions(ctx.api, ctx.toast);
  const launchFromInbox = (id: string): void => {
    const done = launchProposal(ctx, id, () => pane.querySelector<HTMLButtonElement>(`button[data-launch="${CSS.escape(id)}"]`));
    box.renderProposals(); // draws its button busy: the launch is in flight by now
    void done.finally(() => box.renderProposals());
  };
  const box = mountInbox(
    pane,
    (id) => ctx.diveToRoom(id),
    setBadge,
    launchFromInbox,
    (id) => void dismissProposal(ctx, id),
    (id) => void approveMerge(ctx, id),
    strandedActions.attach,
    strandedActions.close,
    (tmuxName, cwd, button) => void trustAndRelaunch(ctx.api, ctx.toast, tmuxName, cwd, button),
    (id) => void retireProposal(ctx, id),
    () => ctx.showView("health"),
  );
  const refresh = (): void => box.render([...ctx.store.agents.values()]);
  ctx.store.onAgents(refresh);
  ctx.store.onSnapshot(refresh);
  refresh();
  onPresidentUpdate(() => box.renderProposals());
  onTalkChange(() => box.renderStranded());
  onHealthKeeperUpdate(() => box.renderHealth());
  return box;
}

// ---------------------------------------------------------------- Needs you now (Home)

/** #/home/needs: Home opened at its Needs you now section. */
export const NEEDS_PARAM = "needs";

let needsHost: HTMLElement | null = null;
let needsN = 0;
const countFns = new Set<(n: number) => void>();
let focusFn: (() => void) | null = null;
let focusPending = false;

/** The one live Inbox, mounted on first ask and kept for the page's life (Home re-attaches it on
 *  every visit, so its rows, busy buttons and subscriptions survive a view switch). */
export function needsPane(ctx: ClientContext): HTMLElement {
  if (!needsHost) {
    needsHost = document.createElement("div");
    needsHost.className = "alef-pane home-inbox";
    mountInboxPane(needsHost, ctx, (n) => {
      needsN = n;
      for (const fn of countFns) fn(n);
    });
  }
  return needsHost;
}

/** What needs you now: waiting + stranded + the Health keeper's item. */
export function needsYouCount(): number {
  return needsN;
}

/** Called with the count on every change; returns its unsubscribe. */
export function onNeedsCount(fn: (n: number) => void): () => void {
  countFns.add(fn);
  return () => countFns.delete(fn);
}

/** Open Home at Needs you now and bring the section into view: what the old Inbox tab did, for
 *  the status bar's waiting count, "Who's waiting on me?", the Automations "Who's waiting" card,
 *  ?tab=inbox and Home's own links. Home mounts synchronously inside showView (or is already up),
 *  and its onNeedsFocus() handler scrolls and focuses. */
export function openNeedsYou(ctx: Pick<ClientContext, "showView">): void {
  focusPending = true;
  ctx.showView(HOME_VIEW_ID, NEEDS_PARAM);
  // Still pending: Home was already up (showView changed nothing or only its param), or the
  // switch didn't happen; never leave it armed for some later mount.
  const pending = focusPending;
  focusPending = false;
  if (pending) focusFn?.();
}

/** Home registers while mounted: `fn` brings Needs you now into view. A request made just before
 *  (openNeedsYou mounting Home) runs it at once. Returns its unregister. */
export function onNeedsFocus(fn: () => void): () => void {
  focusFn = fn;
  if (focusPending) {
    focusPending = false;
    fn();
  }
  return () => {
    if (focusFn === fn) focusFn = null;
  };
}

export const inboxFeature: ClientFeature = {
  id: "inbox",
  mount(ctx: ClientContext) {
    // Mounted at boot, not on Home's first visit: the list (and its count) is live from the start.
    needsPane(ctx);
  },
};
