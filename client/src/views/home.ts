// 🏠 Home (Alex, 2026-09-29): the default first view, whose job is "what needs me now" (UX-1).
// A compact "Hi Steph" band (VIS-9: the garden and the greeting, never taller than ~280px), the ONE
// prompt box under it (the same #dispatch element the other views dock above the status bar, moved
// here by ctx.promptBox: same state, same options, same Enter), then:
//   Needs you now       first: the Inbox itself (features/inbox.ts needsPane), its count, the same
//                       rows and the same actions, mounted once and kept across visits. Empty, it
//                       says "Nothing needs you" and what is running. The right rail has no Inbox
//                       tab any more: everything that opened it calls openNeedsYou (#/home/needs).
//   Pick up where you left off
//                       the 3-4 projects whose city had a session most recently (capability #2,
//                       GET /api/project-page/recent): the newest verdict, open todos, spend over
//                       30 days, the vault note (in Brain) and one Resume (project-card.ts: the
//                       Reactivate path every other surface uses; a live session opens its Room).
//   What happened       Today / Week / Month facts, counted by the server from the features that
//                       measure them (server/features/home-lib.ts), each linked to where it comes
//                       from, plus a 3-5 sentence summary Haiku wrote from those facts only. The
//                       server drops a summary that names a number the facts don't hold; what the
//                       summary says about a number is not checked, and the page says so.
//   Automations         the Tower's workers (careers) and the routines no worker claims; a click
//                       opens the Tower at that worker (or the Routines tab).
//   Live feed           the one Feed's items as cards (open pinned ones first, then newest first),
//                       25 at a time, Show more for the next 25 (never on scroll: loading as you
//                       scroll past it kept pushing Jev below); Highlights leaves out activity and
//                       caption lines.
//   Jev decided lately  the president's ledger (every proposal shown and your click on it) and
//                       Jev's rankings of the board (gov:jev Feed items), newest first.
//   The garden          a pixel band above the greeting that grows from today's real sessions
//                       (features/garden.ts): a seed per session, a bloom per merged PR or push.
// On a wide main area (≥1800px) the sections sit in two columns, Needs you now + Pick up + Live feed on the
// left, What happened + Automations + Jev on the right, so both open above the fold (home.css).
// Not a planet view: the shell pauses the 3D frame loop while Home is up (usesPlanet false).
// Untrusted text (PR titles, district and automation names, proposal text, the summary) is set
// with textContent only.

import {
  DIGEST_RANGES,
  isDigestResponse,
  isHomeAutomationsResponse,
  isHomeDecisionsResponse,
  type DigestRange,
  type DigestResponse,
  type HomeAutomationRow,
  type HomeAutomationsResponse,
  type HomeDecisionsResponse,
  type HomeError,
} from "../../../shared/features/home";
import { openTowerAt } from "../features/careers";
import { h } from "../features/fleet-overlay";
import { mountGarden, refreshGarden } from "../features/garden";
import { NEEDS_PARAM, needsPane, needsYouCount, onNeedsCount, onNeedsFocus } from "../features/inbox";
import { currentPresidentBoard } from "../features/president";
import { FEED_KIND_LABEL, kindIcon, type FeedItem } from "../shell/feed-types";
import type { AlefView, FilterSpec, ViewContext } from "../shell/views";
import { log } from "../log";
import { runAction } from "../ui/action";
import { prefersReducedMotion } from "../ui/kit";
import type { ProjectCardsResponse } from "../../../shared/features/project-page";
import { projectCard } from "./project-card";
import { isProjectCardsResponse, PICKUP_CARDS, redactPage } from "./project-lib";
import { redactOn } from "../redact";
import {
  FEED_PAGE,
  GREETING,
  HIGHLIGHT_KINDS,
  HOME_VIEW_ID,
  ago,
  automationWords,
  decisionLabel,
  decisionStatus,
  decisionText,
  factLines,
  jevTimeline,
  needsCalmLine,
  nextShown,
  plural,
  type HomeLink,
} from "./home-lib";
import "./home.css";

const REFRESH_MS = 60_000;
const WRITING_POLL_MS = 4_000;
const WRITING_POLLS_MAX = 40;
const AUTOMATIONS_SHOWN = 8;
const JEV_SHOWN = 10;
const RANGE_NAME: Readonly<Record<DigestRange, string>> = { today: "Today", week: "Week", month: "Month" };
const SECTIONS: readonly { id: string; label: string }[] = [
  { id: "top", label: "Hi · the prompt box" },
  { id: "needs", label: "Needs you now" },
  { id: "pickup", label: "Pick up where you left off" },
  { id: "digest", label: "What happened" },
  { id: "automations", label: "Automations" },
  { id: "live", label: "Live feed" },
  { id: "jev", label: "Jev decided lately" },
];

let ctx: ViewContext | null = null;
let root: HTMLElement | null = null;
/** Bumped on every mount and unmount: an answer that lands after it changed is dropped. */
let mountSeq = 0;
let restorePrompt: (() => void) | null = null;
let feedUnsub: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polls = 0;
let feedQueued = false;
let unGarden: (() => void) | null = null;
/** The store has no unsubscribe: register the garden refresh once, for the page's life. */
let gardenWired = false;

let range: DigestRange = "today";
const digests = new Map<DigestRange, DigestResponse>();
/** Ranges whose facts couldn't be loaded yet (no answer, nothing cached). */
const digestFailed = new Set<DigestRange>();
let regenerating: DigestRange | null = null;
let pickup: ProjectCardsResponse | null = null;
let pickupFailed = false;
let automations: HomeAutomationsResponse | null = null;
let automationsFailed = false;
let automationsAll = false;
let decisions: HomeDecisionsResponse | null = null;
let decisionsFailed = false;
let jevAll = false;
let feedMode: "highlights" | "all" = "highlights";
let feedShown = FEED_PAGE;
let unNeedsCount: (() => void) | null = null;
let unNeedsFocus: (() => void) | null = null;
/** The store has no unsubscribe: register Needs you now's "what's running" line once. */
let needsWired = false;

function q<T extends HTMLElement>(sel: string): T | null {
  return root?.querySelector<T>(sel) ?? null;
}

function follow(link: HomeLink): void {
  const c = ctx;
  if (!c) return;
  if (link.kind === "view") c.showView(link.view);
  else if (link.kind === "panel") c.openPanel(link.panel);
  else if (link.kind === "needs") jumpTo("needs", true);
  else c.openRightTab(link.tab);
}

function linkButton(link: HomeLink, cls = "home-link"): HTMLButtonElement {
  const b = h("button", cls, `${link.label} →`);
  b.type = "button";
  b.title = `Open where this comes from: ${link.label}`;
  b.addEventListener("click", () => follow(link));
  return b;
}

// ---------------------------------------------------------------- What happened

function renderDigest(): void {
  const card = q<HTMLElement>(".home-digest");
  if (!card) return;
  for (const b of card.querySelectorAll<HTMLButtonElement>("[data-range]")) b.setAttribute("aria-pressed", String(b.dataset.range === range));
  const summary = card.querySelector<HTMLElement>(".home-summary")!;
  const facts = card.querySelector<HTMLElement>(".home-facts")!;
  const d = digests.get(range);
  if (!d) {
    summary.replaceChildren(h("p", "home-quiet", digestFailed.has(range) ? "Couldn't load the facts from the world server." : "Counting…"));
    facts.replaceChildren();
    return;
  }
  const box: HTMLElement[] = [];
  if (d.summary) {
    box.push(h("p", "home-summary-text", d.summary.text));
    const when = ago(d.summary.at, Date.now());
    // A stale summary gets its own note from the server (summaryNote); only say so here when it didn't.
    const stale = !d.summary.current && !d.note ? " The facts below have changed since." : "";
    box.push(h("p", "home-meta", `Written by Haiku ${when} from the facts as they were then. Every number in it appears in the facts; what it says about them is not checked.${stale}`));
  }
  const writingNow = d.writing || regenerating === range;
  if (writingNow) box.push(h("p", "home-quiet home-writing", "Writing a summary of these facts…"));
  else if (d.note) box.push(h("p", "home-note", d.note));
  if (!d.summary && !writingNow && !d.note) box.push(h("p", "home-quiet", "No summary yet: the facts below are complete without it."));
  const row = h("div", "home-summary-actions");
  const regen = h("button", "comic-btn small home-regen", "Regenerate");
  regen.type = "button";
  regen.disabled = d.writing || regenerating !== null;
  regen.title = "Ask Haiku for a new summary of these facts now (the daily cap still applies)";
  regen.addEventListener("click", () => regenerate(regen));
  row.append(regen, h("span", "home-meta", `Summaries today: $${d.spend.todayUsd.toFixed(3)} of $${d.spend.capUsd.toFixed(2)}`));
  const status = h("p", "home-meta home-regen-status");
  status.setAttribute("role", "status");
  box.push(row, status);
  summary.replaceChildren(...box);

  facts.replaceChildren(
    ...factLines(d.facts).map((line) => {
      const li = h("li", `home-fact home-tone-${line.tone}`);
      const main = h("div", "home-fact-main");
      main.append(h("span", "home-fact-text", line.text), linkButton(line.link));
      li.append(main);
      if (line.sub.length) {
        const ul = h("ul", "home-fact-sub");
        for (const s of line.sub) ul.append(h("li", "", s));
        li.append(ul);
      }
      return li;
    }),
  );
}

async function loadDigest(r: DigestRange): Promise<void> {
  const c = ctx;
  if (!c) return;
  const seq = mountSeq;
  const raw = await c.api.getJson<unknown>(`/api/home/digest?range=${r}`, 30_000);
  if (seq !== mountSeq) return;
  if (isDigestResponse(raw)) {
    digests.set(r, raw);
    digestFailed.delete(r);
  } else if (!digests.has(r)) digestFailed.add(r);
  if (r === range) renderDigest();
  schedulePoll();
}

/** While the server writes a summary for the range on screen, ask again every few seconds. */
function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (!digests.get(range)?.writing || polls >= WRITING_POLLS_MAX) return;
  polls += 1;
  pollTimer = setTimeout(() => void loadDigest(range), WRITING_POLL_MS);
}

function pickRange(r: DigestRange): void {
  if (r === range) return;
  range = r;
  polls = 0;
  renderDigest();
  void loadDigest(r);
}

function regenerate(btn: HTMLButtonElement): void {
  const c = ctx;
  if (!c || regenerating) return;
  const r = range;
  regenerating = r;
  renderDigest();
  void runAction<DigestResponse | HomeError>({
    label: "Regenerate summary",
    pending: "Writing a summary of these facts…",
    run: () => c.api.postJson<DigestResponse | HomeError>("/api/home/digest/summary", { range: r }, (error) => ({ ok: false, error }), 150_000),
    success: () => `New ${RANGE_NAME[r].toLowerCase()} summary written; every number in it appears in the facts.`,
    toast: c.toast,
    button: () => (btn.isConnected ? btn : q<HTMLButtonElement>(".home-regen")),
    status: () => q<HTMLElement>(".home-regen-status"),
  }).then(() => {
    regenerating = null;
    polls = 0;
    void loadDigest(r);
  });
}

// ---------------------------------------------------------------- Automations

function automationRow(r: HomeAutomationRow, nowMs: number): HTMLElement {
  const w = automationWords(r, nowMs);
  const li = h("li", "home-row-li");
  const b = h("button", `home-row${w.bad ? " home-row-bad" : ""}`);
  b.type = "button";
  b.title = r.kind === "worker" ? `Open ${r.name} in the Tower` : "Open Setup › Routines";
  const top = h("span", "home-row-top");
  top.append(h("span", "home-row-name", w.name));
  if (w.state) top.append(h("span", `home-chip home-chip-${r.state ?? "routine"}`, w.state));
  b.append(top, h("span", "home-row-line", w.last));
  if (w.next) b.append(h("span", "home-row-line home-row-next", w.next));
  if (r.lastWhy && w.bad) b.append(h("span", "home-row-line home-row-why", r.lastWhy));
  b.addEventListener("click", () => {
    const c = ctx;
    if (!c) return;
    if (r.kind === "worker" && r.key) openTowerAt(c, r.key);
    else c.showView("routines");
  });
  li.append(b);
  return li;
}

function renderAutomations(): void {
  const card = q<HTMLElement>(".home-auto");
  if (!card) return;
  const list = card.querySelector<HTMLElement>(".home-rows")!;
  const more = card.querySelector<HTMLElement>(".home-more")!;
  const count = card.querySelector<HTMLElement>(".home-count")!;
  const note = card.querySelector<HTMLElement>(".home-card-note")!;
  if (!automations) {
    list.replaceChildren(h("li", "home-quiet", automationsFailed ? "Couldn't load the automations from the world server." : "Loading the Tower and the routines…"));
    more.replaceChildren();
    count.textContent = "";
    note.textContent = "";
    return;
  }
  const rows = automations.rows;
  count.textContent = String(rows.length);
  note.textContent = automations.ready ? "" : "The Tower is still reading the archive: only the routines are listed for now.";
  if (rows.length === 0) {
    list.replaceChildren(h("li", "home-quiet", "No automation lineage and no com.stephane routine found."));
    more.replaceChildren();
    return;
  }
  const now = Date.now();
  const shown = automationsAll ? rows : rows.slice(0, AUTOMATIONS_SHOWN);
  list.replaceChildren(...shown.map((r) => automationRow(r, now)));
  if (rows.length > AUTOMATIONS_SHOWN) {
    const b = h("button", "comic-btn small secondary", automationsAll ? "Show fewer" : `Show all ${rows.length}`);
    b.type = "button";
    b.addEventListener("click", () => {
      automationsAll = !automationsAll;
      renderAutomations();
    });
    more.replaceChildren(b, linkButton({ kind: "panel", panel: "careers", label: "Tower" }));
  } else more.replaceChildren(linkButton({ kind: "panel", panel: "careers", label: "Tower" }));
}

async function loadAutomations(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const seq = mountSeq;
  const raw = await c.api.getJson<unknown>("/api/home/automations", 20_000);
  if (seq !== mountSeq) return;
  if (isHomeAutomationsResponse(raw)) {
    automations = raw;
    automationsFailed = false;
  } else if (!automations) automationsFailed = true;
  renderAutomations();
}

// ---------------------------------------------------------------- Pick up where you left off

function renderPickup(): void {
  const card = q<HTMLElement>(".home-pickup");
  const c = ctx;
  if (!card || !c) return;
  const grid = card.querySelector<HTMLElement>(".pc-grid")!;
  if (!pickup) {
    grid.replaceChildren(h("p", "home-quiet", pickupFailed ? "Couldn't load your projects from the world server." : "Reading your recent projects…"));
    return;
  }
  if (pickup.cards.length === 0) {
    grid.replaceChildren(h("p", "home-quiet", "No project has a session yet."));
    return;
  }
  const now = Date.now();
  grid.replaceChildren(...pickup.cards.map((p, i) => projectCard(c, redactOn() ? redactPage(p, i + 1) : p, now)));
}

async function loadPickup(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const seq = mountSeq;
  const raw = await c.api.getJson<unknown>(`/api/project-page/recent?n=${PICKUP_CARDS}`, 20_000);
  if (seq !== mountSeq) return;
  if (isProjectCardsResponse(raw)) {
    pickup = raw;
    pickupFailed = false;
  } else if (!pickup) pickupFailed = true;
  renderPickup();
}

// ---------------------------------------------------------------- Needs you now

function renderNeeds(): void {
  const card = q<HTMLElement>(".home-needs");
  const c = ctx;
  if (!card || !c) return;
  const n = needsYouCount();
  card.classList.toggle("home-needs-hot", n > 0);
  card.querySelector<HTMLElement>(".home-count")!.textContent = n ? String(n) : "";
  const calm = card.querySelector<HTMLElement>(".home-calm")!;
  calm.hidden = n > 0;
  // The Inbox's own "Inbox zero" line is hidden on Home (home.css): this is the one empty state.
  if (n === 0) calm.replaceChildren(h("p", "home-calm-head", "Nothing needs you."), h("p", "home-meta", needsCalmLine(c.store.effectiveStats().liveCount)));
}

function attachInbox(c: ViewContext): void {
  q<HTMLElement>(".home-inbox-slot")?.append(needsPane(c));
  unNeedsCount = onNeedsCount(renderNeeds);
  renderNeeds();
}

// ---------------------------------------------------------------- Live feed

function feedItems(c: ViewContext): FeedItem[] {
  return c.feedStream.list(feedMode === "highlights" ? { kinds: new Set(HIGHLIGHT_KINDS) } : {});
}

function feedCard(item: FeedItem, nowMs: number): HTMLElement {
  const li = h("li", `home-feed-card home-kind-${item.kind}${item.pinned && !item.outcome ? " home-pinned" : ""}`);
  const head = h("div", "home-feed-head");
  const glyph = h("span", "home-feed-emoji");
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = kindIcon(item.kind);
  head.append(glyph, h("span", "home-feed-kind", FEED_KIND_LABEL[item.kind]), h("span", "home-feed-at", ago(new Date(item.at).toISOString(), nowMs)));
  li.append(head, h("p", "home-feed-title", item.title));
  if (item.detail) li.append(h("p", "home-feed-detail", item.detail));
  const actions = h("div", "home-feed-actions");
  const c = ctx;
  if (item.approval && !item.outcome) {
    const b = h("button", "comic-btn small", "Answer in the Feed");
    b.type = "button";
    b.title = "Approvals are answered with hold-to-confirm in the Feed tab";
    b.addEventListener("click", () => c?.openRightTab("feed"));
    actions.append(b);
  }
  if (item.agentId || item.cityId) {
    const b = h("button", "home-link", item.agentId ? "Session →" : "District →");
    b.type = "button";
    b.addEventListener("click", () => {
      if (!c) return;
      if (item.agentId && c.store.agents.has(item.agentId)) c.selection.set({ kind: "agent", id: item.agentId });
      else if (item.cityId) c.selection.set({ kind: "city", id: item.cityId });
      else c.toast("That session isn't in the world index any more.");
    });
    actions.append(b);
  }
  if (item.href && /^(https?:\/\/|\/)/.test(item.href)) {
    const a = h("a", "home-link", "Open ↗");
    a.href = item.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    actions.append(a);
  }
  if (actions.childElementCount) li.append(actions);
  return li;
}

function renderFeed(): void {
  const c = ctx;
  const card = q<HTMLElement>(".home-live");
  if (!c || !card) return;
  for (const b of card.querySelectorAll<HTMLButtonElement>("[data-feed-mode]")) b.setAttribute("aria-pressed", String(b.dataset.feedMode === feedMode));
  const items = feedItems(c);
  const list = card.querySelector<HTMLElement>(".home-cards")!;
  const end = card.querySelector<HTMLElement>(".home-end")!;
  const more = card.querySelector<HTMLButtonElement>(".home-feed-more")!;
  const now = Date.now();
  const shown = items.slice(0, feedShown);
  list.replaceChildren(...shown.map((i) => feedCard(i, now)));
  if (items.length === 0) end.textContent = feedMode === "highlights" ? "Nothing in the Feed but activity lines right now. Everything shows those too." : "The Feed is empty right now.";
  else if (shown.length < items.length) end.textContent = `${shown.length} of ${items.length} shown.`;
  else end.textContent = `That's everything the Feed holds right now (${plural(items.length, "item")}; it keeps the last 300).`;
  more.hidden = shown.length >= items.length;
}

function queueFeed(): void {
  if (feedQueued) return;
  feedQueued = true;
  setTimeout(() => {
    feedQueued = false;
    renderFeed();
    renderJev(); // Jev's rankings and click texts live in the Feed too
  }, 1000);
}

function showMoreFeed(): void {
  const c = ctx;
  if (!c) return;
  const total = feedItems(c).length;
  if (feedShown >= total) return;
  feedShown = nextShown(feedShown, total);
  renderFeed();
}

// ---------------------------------------------------------------- Jev decided lately

function renderJev(): void {
  const c = ctx;
  const card = q<HTMLElement>(".home-jev");
  if (!c || !card) return;
  const board = currentPresidentBoard();
  const rec = board.record;
  const record = card.querySelector<HTMLElement>(".home-record")!;
  record.textContent = rec
    ? `Jev's record, last ${rec.days} days: ${plural(rec.shown, "proposal")} shown · ${rec.actedOn} acted on · ${rec.dismissed} dismissed · ${rec.launched} launched · ${rec.shipped} of those shipped${rec.rulesShown ? ` · ${rec.rulesShown} more ranked by the rules fallback` : ""}.`
    : "Jev's record: not computed yet.";
  const list = card.querySelector<HTMLElement>(".home-rows")!;
  const more = card.querySelector<HTMLElement>(".home-more")!;
  if (!decisions) {
    list.replaceChildren(h("li", "home-quiet", decisionsFailed ? "Couldn't load the president's ledger from the world server." : "Loading the president's ledger…"));
    more.replaceChildren();
    return;
  }
  const feed = c.feedStream.list();
  const timeline = jevTimeline(decisions.rows, feed);
  if (!decisions.ready && timeline.length === 0) {
    list.replaceChildren(h("li", "home-quiet", "The president hasn't read its ledger yet."));
    more.replaceChildren();
    return;
  }
  if (timeline.length === 0) {
    list.replaceChildren(h("li", "home-quiet", "Jev hasn't proposed anything yet."));
    more.replaceChildren();
    return;
  }
  const now = Date.now();
  const shown = jevAll ? timeline : timeline.slice(0, JEV_SHOWN);
  list.replaceChildren(
    ...shown.map((e) => {
      const li = h("li", "home-row-li");
      const b = h("button", "home-row");
      b.type = "button";
      b.title = "Go to Needs you now, where Jev's proposals are";
      b.addEventListener("click", () => jumpTo("needs", true));
      const top = h("span", "home-row-top");
      if (e.ranking) {
        top.append(h("span", "home-row-name", "🌙 Jev ranked the board"), h("span", "home-row-when", ago(new Date(e.ranking.at).toISOString(), now)));
        b.append(top, h("span", "home-row-line", e.ranking.title));
        if (e.ranking.detail) b.append(h("span", "home-row-line home-row-why", e.ranking.detail));
      } else if (e.row) {
        const r = e.row;
        const st = decisionStatus(r);
        top.append(h("span", "home-row-name", decisionLabel(r)), h("span", `home-chip home-status-${st.tone}`, st.text), h("span", "home-row-when", ago(r.actedAt ?? r.proposedAt, now)));
        b.append(top);
        const text = decisionText(r, board, feed);
        b.append(h("span", "home-row-line", text ?? "Its words aren't kept once it leaves the board."));
        const meta = [`ranked by ${r.rankedBy === "jev" ? "Jev" : "the rules fallback"}`, `proposed ${ago(r.proposedAt, now)}`];
        if (r.verdict) meta.push(`its session: ${r.verdict}`);
        else if (r.outcome === "launched") meta.push(r.sessionId ? "its session has no verdict yet" : "its session hasn't been adopted yet");
        b.append(h("span", "home-row-line home-row-next", meta.join(" · ")));
      }
      li.append(b);
      return li;
    }),
  );
  if (timeline.length > JEV_SHOWN) {
    const t = h("button", "comic-btn small secondary", jevAll ? "Show fewer" : `Show all ${timeline.length}`);
    t.type = "button";
    t.addEventListener("click", () => {
      jevAll = !jevAll;
      renderJev();
    });
    more.replaceChildren(t);
  } else more.replaceChildren();
}

async function loadDecisions(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const seq = mountSeq;
  const raw = await c.api.getJson<unknown>("/api/home/decisions", 20_000);
  if (seq !== mountSeq) return;
  if (isHomeDecisionsResponse(raw)) {
    decisions = raw;
    decisionsFailed = false;
  } else if (!decisions) decisionsFailed = true;
  renderJev();
}

// ---------------------------------------------------------------- the page

function build(r: HTMLElement): void {
  r.classList.add("home-view");
  r.innerHTML = `
    <div class="home-hero" id="home-top">
      <div class="home-greeting">
        <div class="home-garden-slot"></div>
        <h1 class="home-hi"></h1>
      </div>
      <div class="home-prompt"></div>
    </div>
    <div class="home-feed">
      <div class="home-col home-col-now">
      <section class="home-card home-needs" id="home-needs" aria-labelledby="home-needs-h">
        <header class="home-card-head"><h2 id="home-needs-h" tabindex="-1">Needs you now <span class="alef-fcount home-count"></span></h2></header>
        <div class="home-calm" role="status"></div>
        <div class="home-inbox-slot"></div>
      </section>
      <section class="home-card home-pickup" id="home-pickup" aria-labelledby="home-pickup-h">
        <header class="home-card-head"><h2 id="home-pickup-h">Pick up where you left off</h2></header>
        <div class="pc-grid"></div>
      </section>
      <section class="home-card home-live" id="home-live" aria-labelledby="home-live-h">
        <header class="home-card-head">
          <h2 id="home-live-h">Live feed</h2>
          <div class="home-tabs ch-seg" role="group" aria-label="Which items"><button type="button" class="home-tab" data-feed-mode="highlights" aria-pressed="true" title="Everything but the activity and caption lines">Highlights</button><button type="button" class="home-tab" data-feed-mode="all" aria-pressed="false" title="Every Feed item, activity lines included">Everything</button></div>
        </header>
        <ul class="home-cards"></ul>
        <p class="home-end home-meta"></p>
        <button type="button" class="comic-btn small secondary home-feed-more">Show more</button>
      </section>
      </div>
      <div class="home-col home-col-story">
      <section class="home-card home-digest" id="home-digest" aria-labelledby="home-digest-h">
        <header class="home-card-head">
          <h2 id="home-digest-h">What happened</h2>
          <div class="home-tabs ch-seg" role="group" aria-label="Range">${DIGEST_RANGES.map((x) => `<button type="button" class="home-tab" data-range="${x}" aria-pressed="false">${RANGE_NAME[x]}</button>`).join("")}</div>
        </header>
        <div class="home-summary"></div>
        <ul class="home-facts"></ul>
      </section>
      <section class="home-card home-auto" id="home-automations" aria-labelledby="home-auto-h">
        <header class="home-card-head"><h2 id="home-auto-h">Automations <span class="alef-fcount home-count"></span></h2></header>
        <p class="home-card-note home-meta"></p>
        <ul class="home-rows"></ul>
        <div class="home-more"></div>
      </section>
      <section class="home-card home-jev" id="home-jev" aria-labelledby="home-jev-h">
        <header class="home-card-head"><h2 id="home-jev-h">Jev decided lately</h2></header>
        <p class="home-record home-meta"></p>
        <ul class="home-rows"></ul>
        <div class="home-more"></div>
      </section>
      </div>
    </div>`;
  r.querySelector(".home-hi")!.textContent = GREETING;
  for (const b of r.querySelectorAll<HTMLButtonElement>("[data-range]")) {
    const v = DIGEST_RANGES.find((x) => x === b.dataset.range);
    if (v) b.addEventListener("click", () => pickRange(v));
  }
  for (const b of r.querySelectorAll<HTMLButtonElement>("[data-feed-mode]")) {
    b.addEventListener("click", () => {
      const mode = b.dataset.feedMode === "all" ? "all" : "highlights";
      if (mode === feedMode) return;
      feedMode = mode;
      feedShown = FEED_PAGE;
      renderFeed();
    });
  }
  r.querySelector(".home-feed-more")?.addEventListener("click", showMoreFeed);
}

function refreshAll(): void {
  void loadPickup();
  void loadDigest(range);
  void loadAutomations();
  void loadDecisions();
}

/** Scroll a section into view; `focus` also moves keyboard focus to its heading (Needs you now,
 *  opened from elsewhere: the status bar, a quick prompt, Jev's rows). */
function jumpTo(id: string, focus = false): void {
  const el = q<HTMLElement>(`#home-${id}`);
  el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  if (focus) el?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
}

export const homeView: AlefView = {
  id: HOME_VIEW_ID,
  emoji: "🏠",
  name: "Home",
  hint: "Hi Steph: what needs you now, the prompt box, what happened and your automations",
  mount(r, c) {
    ctx = c;
    root = r;
    mountSeq += 1;
    polls = 0;
    feedShown = FEED_PAGE;
    build(r);
    restorePrompt = c.promptBox.mountIn(r.querySelector<HTMLElement>(".home-prompt")!);
    attachInbox(c);
    try {
      unGarden = mountGarden(r.querySelector<HTMLElement>(".home-garden-slot")!, c);
    } catch (err) {
      log.warn("home", "the garden failed to mount; the rest of Home is unaffected", String(err)); // decoration must never take Home down
    }
    if (!gardenWired) {
      gardenWired = true;
      c.store.onAgents(refreshGarden);
      c.store.onSnapshot(refreshGarden);
    }
    if (!needsWired) {
      needsWired = true;
      c.store.onAgents(renderNeeds); // "N agents working" under Nothing needs you; a no-op off Home
    }
    if (c.route().param === NEEDS_PARAM) jumpTo("needs", true);
    unNeedsFocus = onNeedsFocus(() => jumpTo("needs", true));
    renderPickup();
    renderDigest();
    renderAutomations();
    renderFeed();
    renderJev();
    feedUnsub = c.feedStream.onChange(queueFeed);
    refreshAll();
    refreshTimer = setInterval(() => {
      refreshAll();
      renderFeed(); // relative times
    }, REFRESH_MS);
  },
  onParam(param) {
    if (param === NEEDS_PARAM) jumpTo("needs", true);
  },
  unmount() {
    mountSeq += 1;
    restorePrompt?.();
    restorePrompt = null;
    unGarden?.();
    unGarden = null;
    feedUnsub?.();
    feedUnsub = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    unNeedsCount?.();
    unNeedsCount = null;
    unNeedsFocus?.();
    unNeedsFocus = null;
    q<HTMLElement>(".home-inbox")?.remove(); // kept (features/inbox.ts), re-attached next visit
    root = null;
    ctx = null;
  },
  filters(): FilterSpec[] {
    return [
      {
        id: "sections",
        label: "On this page",
        type: "section",
        render: (host) => {
          const ul = h("ul", "home-jump");
          for (const s of SECTIONS) {
            const li = h("li");
            const b = h("button", "home-jump-btn", s.label);
            b.type = "button";
            b.addEventListener("click", () => jumpTo(s.id));
            li.append(b);
            ul.append(li);
          }
          host.replaceChildren(ul);
        },
      },
    ];
  },
};
