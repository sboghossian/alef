// The Feed tab: filter chips by kind + one list. Open approvals sit pinned on top with
// hold-to-confirm Approve / Deny (FeedHolds → the courier's HoldToConfirm), sending the same
// real decision as the big approval card. Clicking an item selects + flies to its agent / city.
// Above it all, the Town square's top 5 (features/workspace-lib.ts): what cleared the salience
// bar, with the reason; the list below stays the full chronological log.

import { stationOf, STATIONS, type Station } from "../../../shared/stations";
import type { HoldAction } from "../features/courier/hold";
import { workspaceData } from "../features/workspace-data";
import { WORKSPACE, type WorkspaceEntry, type WorkspaceUrgency } from "../features/workspace-lib";
import { escapeHtml, relativeTime } from "../ui/fuzzy";
import { FEED_KINDS, FEED_KIND_LABEL, kindIcon, type FeedItem, type FeedKind, type FeedStore } from "./feed";
import { FeedHolds, FeedSends, sendDecision } from "./feed-hold";
import { icon } from "./icons";
import "./feed-ui.css";

export interface FeedUiDeps {
  feed: FeedStore;
  onPick(item: FeedItem): void;
  decide(approvalId: string, action: HoldAction): Promise<void>;
  /** True while the Feed tab is on screen (marks items seen). */
  visible(): boolean;
  onBadge(open: number, unseen: number): void;
}

const OUTCOME_TEXT: Record<string, string> = {
  allow: "Approved",
  deny: "Denied",
  passthrough: "Handed to its terminal",
  expired: "Timed out",
  answered: "Answered",
  gone: "Closed",
};

export interface FeedUi {
  render(): void;
  /** Keep only these kinds (empty = all). */
  setKinds(kinds: FeedKind[]): void;
}

/** Each Town square urgency's line icon (shell/icons.ts); its colour comes from feed-ui.css. */
const URGENCY_ICON: Record<WorkspaceUrgency, string> = { waiting: "hourglass", failure: "failure", tripwire: "alert", message: "message", info: "info" };
const TOWN = icon("town", 15) ?? "";

/** The Town square's top 5 above the Feed (pure, tested): escaped HTML, plus what a click on each
 *  row picks (a FeedItem-shaped pick: onPick selects its agent, else its district). */
export function workspaceTopHtml(top: readonly WorkspaceEntry[]): { html: string; picks: Map<string, FeedItem> } {
  const picks = new Map<string, FeedItem>();
  if (!top.length) return { html: `<p class="alef-feed-top-empty">${TOWN} Town square: nothing clears the bar (${WORKSPACE.enter}) right now.</p>`, picks };
  const row = (e: WorkspaceEntry): string => {
    const pick: FeedItem = { id: e.key, kind: "system", at: e.at, title: e.text, agentId: e.agentIds[0], cityId: e.districts[0] };
    picks.set(e.key, pick);
    const canPick = Boolean(pick.agentId || pick.cityId);
    return `<li class="alef-feed-top-item u-${e.urgency}"><button type="button" class="alef-feed-main" data-top="${escapeHtml(e.key)}" ${canPick ? "" : "disabled"} title="${canPick ? "Select and fly there" : ""}">
          <span class="alef-feed-emoji" aria-hidden="true">${icon(URGENCY_ICON[e.urgency], 15) ?? ""}</span>
          <span class="alef-feed-text"><span class="alef-feed-title">${escapeHtml(e.text)}</span><span class="alef-feed-top-reason">${escapeHtml(e.reason)}</span></span>
        </button></li>`;
  };
  return { html: `<h3 class="alef-feed-top-title">${TOWN} Town square · top ${top.length}</h3><ol class="alef-feed-top-list">${top.map(row).join("")}</ol>`, picks };
}

/** An innerHTML writer that skips the write when the HTML is what it wrote last time. The
 *  workspace notifies on count changes too (about once a second while the fleet is busy), and
 *  rebuilding the same rows would drop keyboard focus from them. */
export function htmlWriter(el: { innerHTML: string }): (html: string) => void {
  let last: string | null = null;
  return (html) => {
    if (html === last) return;
    last = html;
    el.innerHTML = html;
  };
}

/** The Feed's one screen-reader line (A11Y-1). The list itself is not a live region: it is rebuilt
 *  on every change and its approval rows count down each second, so a polite region on it talked
 *  nonstop. Instead this says "N new: <top title>" about the rows that arrived, at most once per
 *  `everyMs`; what lands in between is held and folded into the next line. History is not news:
 *  the first look only learns what is there, and a row stamped before `since` (the page load: the
 *  bridge's backfill arrives a moment later) is never announced. */
export class FeedAnnouncer {
  private known: Set<string> | null = null;
  private pending: FeedItem[] = [];
  private lastAt = -Infinity;

  constructor(
    private readonly everyMs = 10_000,
    private readonly since = -Infinity,
  ) {}

  /** `items` is the whole Feed, top first (pinned, then newest). Returns the line to say now, or null. */
  update(items: readonly FeedItem[], now: number): string | null {
    const known = this.known;
    this.known = new Set(items.map((i) => i.id));
    if (known === null) return null;
    const seen = new Set(this.pending.map((i) => i.id));
    for (const i of items) if (!known.has(i.id) && !seen.has(i.id) && i.at >= this.since) this.pending.push(i);
    // Keep the held rows in the Feed's own order, so the line names the one on top.
    const order = new Map(items.map((i, n) => [i.id, n]));
    this.pending.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    return this.flush(now);
  }

  /** The held line, if the throttle allows it now. */
  flush(now: number): string | null {
    if (this.pending.length === 0 || now - this.lastAt < this.everyMs) return null;
    const line = `${this.pending.length} new: ${this.pending[0]!.title}`;
    this.pending = [];
    this.lastAt = now;
    return line;
  }

  /** How long until a held line may be said (null: nothing held). */
  waitMs(now: number): number | null {
    return this.pending.length ? Math.max(0, this.everyMs - (now - this.lastAt)) : null;
  }
}

/** A raw tool line (an activity row carrying a tool name: a Bash command, an edited path, an MCP
 *  call): drawn as one clamped monospace line (feed-ui.css .cmd), its full text in the title. */
export function isCommandRow(i: FeedItem): boolean {
  if (i.kind !== "activity") return false;
  const seg = (i.detail ?? "").split(" · ").pop()?.trim();
  return Boolean(seg) && seg !== "hook";
}

export function mountFeedUi(host: HTMLElement, deps: FeedUiDeps): FeedUi {
  const kinds = new Set<FeedKind>();
  const holds = new FeedHolds();
  const sends = new FeedSends();
  let raf = 0;
  let dirty = false;

  host.innerHTML = `<section class="alef-feed-top" aria-label="Town square: what the whole system should know right now"></section>
    <div class="alef-feed-chips" role="group" aria-label="Show in the feed"></div>
    <p class="sr-only alef-feed-status" role="status"></p>
    <ol class="alef-feed-list"></ol>`;
  const top = host.querySelector<HTMLElement>(".alef-feed-top")!;
  const chips = host.querySelector<HTMLElement>(".alef-feed-chips")!;
  const status = host.querySelector<HTMLElement>(".alef-feed-status")!;
  const list = host.querySelector<HTMLOListElement>(".alef-feed-list")!;
  const writeList = htmlWriter(list);
  const announcer = new FeedAnnouncer(10_000, Date.now());
  let announceTimer = 0;
  function announce(): void {
    const now = Date.now();
    const line = announcer.update(deps.feed.list({ limit: 120 }), now);
    if (line) status.textContent = line;
    const wait = announcer.waitMs(now);
    if (wait !== null && !announceTimer)
      announceTimer = window.setTimeout(() => {
        announceTimer = 0;
        const held = announcer.flush(Date.now());
        if (held) status.textContent = held;
      }, wait);
  }

  /** The workspace's slots as FeedItem-shaped picks (onPick selects agent, else city). */
  let topPicks = new Map<string, FeedItem>();
  const writeTop = htmlWriter(top);
  function renderTop(): void {
    const view = workspaceTopHtml(workspaceData.result.top);
    topPicks = view.picks;
    writeTop(view.html);
  }
  top.addEventListener("click", (ev) => {
    const b = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-top]") : null;
    const item = b?.dataset.top ? topPicks.get(b.dataset.top) : undefined;
    if (item) deps.onPick(item);
  });
  workspaceData.onChange(renderTop);
  renderTop();

  function renderChips(): void {
    const counts = deps.feed.counts();
    const all = `<button type="button" class="alef-fchip${kinds.size === 0 ? " on" : ""}" data-kind="" aria-pressed="${kinds.size === 0}">All <span class="alef-fcount">${deps.feed.size()}</span></button>`;
    chips.innerHTML =
      all +
      FEED_KINDS.filter((k) => counts[k] > 0 || kinds.has(k))
        .map(
          (k) =>
            `<button type="button" class="alef-fchip${kinds.has(k) ? " on" : ""}" data-kind="${k}" aria-pressed="${kinds.has(k)}"><span aria-hidden="true">${kindIcon(k, 14)}</span> ${FEED_KIND_LABEL[k]} <span class="alef-fcount">${counts[k]}</span></button>`,
        )
        .join("");
  }

  /** Best-effort station for a row, read out of what feed.ts's activityToFeed already puts in
   *  `detail`/`title` (this builder owns only feed-ui.ts, not feed.ts/feed-types.ts, so there is no
   *  dedicated field to read instead). For a "activity" row, `detail`'s last " · " segment is
   *  `toolName ?? stage` — a real tool name, or the literal stage "hook" for a toolless new-prompt
   *  line. A "caption" row (Skill, TodoWrite/plan mode, or plain reasoning) never carries a tool
   *  name in `detail`, so it is read off `title`'s known summary shapes instead; plain reasoning
   *  text matches neither shape, so it gets no chip. */
  function activityStation(i: FeedItem): Station | null {
    if (i.kind === "activity") {
      const seg = (i.detail ?? "").split(" · ").pop()?.trim();
      if (!seg) return null;
      return STATIONS[seg === "hook" ? "hook" : stationOf(seg)];
    }
    if (i.kind === "caption") {
      if (/^Skill\s/.test(i.title)) return STATIONS.skill;
      if (i.title === "TodoWrite" || i.title === "EnterPlanMode" || i.title === "ExitPlanMode") return STATIONS.plan;
    }
    return null;
  }

  function itemHtml(i: FeedItem, now: number): string {
    const open = i.pinned === true && i.outcome === undefined;
    const when = relativeTime(new Date(i.at).toISOString(), now);
    const outcome = i.outcome ? `<span class="alef-feed-outcome o-${i.outcome}">${OUTCOME_TEXT[i.outcome] ?? i.outcome}</span>` : "";
    const send = i.approval ? sends.get(i.approval.id) : undefined;
    const off = send?.phase === "sending" ? " disabled" : "";
    const sendNote =
      send?.phase === "sending"
        ? `<div class="alef-feed-send sending">Sending…</div>`
        : send?.phase === "failed"
          ? `<div class="alef-feed-send failed">Not sent: ${escapeHtml(send.reason)}</div>`
          : "";
    const actions =
      i.approval && open
        ? `<div class="alef-feed-actions" data-ap="${escapeHtml(i.approval.id)}">
            <button type="button" class="alef-hold ap-yes" data-act="allow" aria-label="Hold to approve ${escapeHtml(i.approval.toolName)}" title="Hold 1 second to approve"${off}><span class="alef-hold-fill" aria-hidden="true"></span><span class="alef-hold-label">Hold to approve</span></button>
            <button type="button" class="alef-hold ap-no" data-act="deny" aria-label="Hold to deny ${escapeHtml(i.approval.toolName)}" title="Hold 1 second to deny"${off}><span class="alef-hold-fill" aria-hidden="true"></span><span class="alef-hold-label">Hold to deny</span></button>
            <span class="alef-feed-timer" aria-live="off" data-expires="${i.approval.expiresAt}">${Math.max(0, Math.round((i.approval.expiresAt - now) / 1000))}s</span>
          </div>${sendNote}`
        : "";
    const link = i.href ? `<a class="alef-feed-link" href="${escapeHtml(i.href)}" target="_blank" rel="noopener">Open ↗</a>` : "";
    const st = activityStation(i);
    const stationChip = st
      ? `<span class="alef-feed-station" style="--sc:${st.color}" title="${escapeHtml(st.label)} station: ${escapeHtml(st.description)}"><span aria-hidden="true">${st.emoji}</span>${escapeHtml(st.label)}</span>`
      : "";
    const cmd = isCommandRow(i);
    return `<li class="alef-feed-item k-${i.kind}${open ? " open" : ""}${cmd ? " cmd" : ""}" data-id="${escapeHtml(i.id)}">
        <button type="button" class="alef-feed-main" ${i.agentId || i.cityId ? "" : "disabled"} title="${i.agentId || i.cityId ? "Select and fly there" : ""}">
          <span class="alef-feed-emoji" aria-hidden="true">${kindIcon(i.kind)}</span>
          ${stationChip}
          <span class="alef-feed-text"><span class="alef-feed-title"${cmd ? ` title="${escapeHtml(i.title)}"` : ""}>${escapeHtml(i.title)}</span>${i.detail ? `<span class="alef-feed-detail">${escapeHtml(i.detail)}</span>` : ""}</span>
          <span class="alef-feed-when">${escapeHtml(when)}</span>
        </button>${outcome}${link}${actions}
      </li>`;
  }

  function render(): void {
    if (holds.busy()) {
      dirty = true; // never rebuild under a finger that is holding
      return;
    }
    dirty = false;
    const now = Date.now();
    renderChips();
    const items = deps.feed.list({ kinds, limit: 120 });
    writeList(
      items.length
        ? items.map((i) => itemHtml(i, now)).join("")
        : `<li class="alef-feed-empty">${deps.feed.size() ? "Nothing of that kind yet." : "Quiet for now. Live activity, Jev's results, approvals and routine runs land here."}</li>`,
    );
    announce();
    const openIds = items.filter((i) => i.approval && i.outcome === undefined).map((i) => i.approval!.id);
    holds.sync(openIds, performance.now());
    sends.sync(openIds);
    if (deps.visible()) deps.feed.markSeen();
    deps.onBadge(deps.feed.openCount(), deps.visible() ? 0 : deps.feed.unseen());
  }

  function loop(): void {
    raf = 0;
    const now = performance.now();
    // The row reads "Approved" / "Denied" only once the server took it (it used to say so first).
    for (const fire of holds.tick(now)) {
      void sendDecision(sends, fire.targetId, fire.action, { decide: deps.decide, resolve: (id, outcome) => deps.feed.resolve(id, outcome), changed: render });
    }
    for (const box of list.querySelectorAll<HTMLElement>(".alef-feed-actions")) {
      const id = box.dataset.ap ?? "";
      const p = holds.progress(id, now);
      for (const b of box.querySelectorAll<HTMLElement>(".alef-hold")) {
        const mine = p.action === b.dataset.act;
        b.style.setProperty("--p", mine ? p.value.toFixed(3) : "0");
        b.classList.toggle("holding", mine);
      }
      box.classList.toggle("armed", holds.armed(id, now));
    }
    if (holds.busy()) raf = requestAnimationFrame(loop);
    else if (dirty) render();
  }
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(loop);
  };

  const holdTarget = (ev: Event): { id: string; act: HoldAction } | null => {
    const b = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>(".alef-hold") : null;
    const box = b?.closest<HTMLElement>(".alef-feed-actions");
    const act = b?.dataset.act;
    if (!b || !box?.dataset.ap || (act !== "allow" && act !== "deny")) return null;
    return { id: box.dataset.ap, act };
  };
  const refuse = (id: string, r: string): void => {
    const box = list.querySelector<HTMLElement>(`.alef-feed-actions[data-ap="${CSS.escape(id)}"]`);
    if (r === "not-armed" && box) {
      box.classList.remove("nudge");
      void box.offsetWidth;
      box.classList.add("nudge");
    }
  };
  list.addEventListener("pointerdown", (ev) => {
    const t = holdTarget(ev);
    if (!t || sends.sending(t.id)) return;
    ev.preventDefault();
    const r = holds.press(t.id, t.act, performance.now());
    if (r === "started") {
      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
      kick();
    } else refuse(t.id, r);
  });
  const up = (ev: Event): void => {
    const t = holdTarget(ev);
    if (t) holds.release(t.id, t.act);
    kick();
  };
  list.addEventListener("pointerup", up);
  list.addEventListener("pointercancel", up);
  list.addEventListener("lostpointercapture", up);
  list.addEventListener("keydown", (ev) => {
    if (ev.key !== " " && ev.key !== "Enter") return;
    const t = holdTarget(ev);
    if (!t || sends.sending(t.id)) return;
    ev.preventDefault();
    const r = holds.press(t.id, t.act, performance.now(), ev.repeat);
    if (r === "started") kick();
    else if (!ev.repeat) refuse(t.id, r);
  });
  list.addEventListener("keyup", (ev) => {
    if (ev.key === " " || ev.key === "Enter") up(ev);
  });
  list.addEventListener("click", (ev) => {
    const main = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>(".alef-feed-main") : null;
    const id = main?.closest<HTMLElement>("[data-id]")?.dataset.id;
    const item = id ? deps.feed.get(id) : undefined;
    if (item) deps.onPick(item);
  });
  chips.addEventListener("click", (ev) => {
    const b = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[data-kind]") : null;
    if (!b) return;
    const k = b.dataset.kind as FeedKind | "";
    if (!k) kinds.clear();
    else if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    render();
  });
  // Countdown text on open approvals.
  window.setInterval(() => {
    for (const t of list.querySelectorAll<HTMLElement>(".alef-feed-timer")) {
      const left = Math.max(0, Math.round((Number(t.dataset.expires) - Date.now()) / 1000));
      t.textContent = `${left}s`;
      t.classList.toggle("urgent", left <= 10);
    }
  }, 1000);

  let queued = false;
  deps.feed.onChange(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  });
  render();
  return {
    render,
    setKinds(next) {
      kinds.clear();
      for (const k of next) kinds.add(k);
      render();
    },
  };
}
