// ⚡ Automations: the content of the Automations modal (the button + modal shell live in
// quick-prompts.ts). A card grid of everything on this Mac that runs on a schedule or as a
// ritual (GET /api/automations), grouped Instant · Daily rituals · Growth · Brain · Dev, with:
// - 📄 Open latest output: an embedded reader that re-renders the doc's CONTENT in Alef's comic
//   style (sanitized allowlist only, see automations-sanitize.ts; scripts never run).
// - ▶ Run now (launchd routines only): a confirm step, then POST …/run { confirm: true }.
// - ✍️ Send to prompt box (skills): fills the prompt box with the skill command; the user sends it.
// The first two cards are "instant": they answer from live data in the browser.

import "./automations.css";
import type { Automation, AutomationRunResult, AutomationsResponse } from "../../../shared/features/automations";
import type { ReplayResponse } from "../../../shared/features/replay";
import { log } from "../log";
import { fillDispatchBox, WORKFLOW_DRAG_MIME } from "../ui/dispatch";
import { relativeTime } from "../ui/fuzzy";
import { renderMarkdown } from "../views/brain-md";
import { inboxAnswer, todayAnswer } from "../views/voice-intents";
import { cityForOutputDir, countdown, emojiOf, GROUPS, groupAutomations, readerStyle, runFinished, shortDescription, statusOf, workflowPrompt, type ReaderStyle } from "./automations-lib";
import { renderSafe, sanitizeHtml, type SafeNode } from "./automations-sanitize";
import { openNeedsYou } from "./inbox";
import type { ClientContext } from "./registry";
import { cityIdByDisplayName, fillDispatchBar } from "./voice";
import { agentTitle } from "../../../shared/display";

const PREVIEW = "/api/shelf/preview";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function previewUrl(path: string): string {
  return `${PREVIEW}?path=${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------- module state

interface Host {
  el: HTMLElement;
  ctx: ClientContext;
  close(): void;
}

let host: Host | null = null;
let list: Automation[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;
/** Esc closes the topmost layer we own: the confirm, then the reader. */
let layers: Array<() => void> = [];
const watching = new Map<string, ReturnType<typeof setInterval>>();

/** Esc inside the modal: close the confirm / reader first. True when handled. */
export function automationsEscape(): boolean {
  const top = layers.pop();
  if (!top) return false;
  top();
  return true;
}

/** Open the ⚡ Automations modal (quick-prompts owns the button). */
export function openAutomations(): void {
  const b = document.getElementById("qp-automations");
  if (b instanceof HTMLElement) b.click();
}

// ---------------------------------------------------------------- grid

/** Fill `el` (the modal body) with the automations grid. Called on every open. */
export function renderAutomations(target: HTMLElement, ctx: ClientContext, opts: { close(): void }): void {
  host = { el: target, ctx, close: opts.close };
  layers = [];
  target.classList.add("aut-body");
  target.replaceChildren(el("p", "aut-loading", "Checking your automations…"));
  startTicker();
  void load();
}

async function load(): Promise<void> {
  const h = host;
  if (!h) return;
  const res = await h.ctx.api.getJson<AutomationsResponse>("/api/automations", 60_000);
  if (host !== h) return;
  list = res?.ok ? res.automations : [];
  drawGrid(res ? null : "The world server didn't answer. Your routines are still in the Routines tab.");
}

function drawGrid(error: string | null): void {
  const h = host;
  if (!h) return;
  const wrap = el("div", "aut-grid-wrap");
  const sub = el("p", "aut-sub", list.length ? `${list.length} automations on this Mac, plus two instant ones. Nothing runs without you pressing a button.` : "");
  wrap.append(sub);
  if (error) wrap.append(el("p", "aut-error", error));

  wrap.append(section("instant", instantCards(h)));
  const grouped = groupAutomations(list);
  for (const g of GROUPS) {
    if (g.id === "instant") continue;
    const items = grouped.get(g.id);
    if (items?.length) wrap.append(section(g.id, items.map((a) => card(a, h))));
  }
  h.el.replaceChildren(wrap);
  tick();
}

function section(id: string, cards: HTMLElement[]): HTMLElement {
  const g = GROUPS.find((x) => x.id === id);
  const s = el("section", `aut-group aut-g-${id}`);
  const head = el("h3", "aut-group-h");
  head.append(el("span", "aut-group-emoji", g?.emoji ?? ""), document.createTextNode(` ${g?.label ?? id}`), el("span", "aut-count", String(cards.length)));
  const grid = el("div", "aut-grid");
  grid.append(...cards);
  s.append(head, grid);
  return s;
}

function instantCards(h: Host): HTMLElement[] {
  const waiting = [...h.ctx.store.agents.values()].filter((a) => a.awaitingInput === true).length;
  const mk = (emoji: string, name: string, what: string, meta: string, run: () => void): HTMLElement => {
    const c = el("article", "aut-card aut-instant");
    const top = el("div", "aut-card-top");
    top.append(el("span", "aut-emoji", emoji), el("h4", "aut-name", name));
    c.append(top, el("p", "aut-desc", what), el("div", "aut-meta", meta));
    const actions = el("div", "aut-actions");
    actions.append(btn("⚡ Ask now", "comic-btn small", run));
    c.append(actions);
    return c;
  };
  return [
    mk("📬", "Who's waiting on me?", "Agents that stopped and are waiting for your answer.", waiting ? `${waiting} waiting right now` : "live · from the world", () => openWaiting(h)),
    mk("📊", "What happened today?", "Today's sessions, events, busiest cities and top tools.", "live · daily report", () => void openToday(h)),
  ];
}

function card(a: Automation, h: Host): HTMLElement {
  const c = el("article", `aut-card aut-kind-${a.kind}`);
  c.dataset.id = a.id;
  // Round 11, package D: "Automations -> prompt". The workflow is the real skill command when
  // one exists (dispatchCommand), same text "Send to prompt box" already uses below. This modal
  // is a full-screen backdrop (z-index 45) over the dispatch box, so a real drag can't just fly
  // through it: HIDING the backdrop mid-drag (e.g. h.close(), which sets `hidden`) was tried and
  // measured to wedge the browser's native drag session (verified with a real headless-Chrome
  // drag simulation — a hidden/unrendered drag source kills the gesture). Making the backdrop
  // pointer-events:none for the gesture's duration keeps the dragged node fully rendered (the
  // drag survives) while letting drop/dragover reach #dispatch underneath; only close the modal
  // afterwards, and only if the drop actually landed (dropEffect stays "none" otherwise).
  const wf = { prompt: workflowPrompt(a), cityId: cityForOutputDir(a.outputDir, [...h.ctx.store.islands.values()]) };
  c.draggable = true;
  c.title = "Drag to the prompt box, or use → prompt";
  c.addEventListener("dragstart", (ev) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData(WORKFLOW_DRAG_MIME, JSON.stringify(wf));
    ev.dataTransfer.setData("text/plain", wf.prompt);
    document.getElementById("automations")?.classList.add("aut-dragging-out");
  });
  c.addEventListener("dragend", () => {
    document.getElementById("automations")?.classList.remove("aut-dragging-out");
  });
  const st = statusOf(a);
  const top = el("div", "aut-card-top");
  const dot = el("span", `aut-dot aut-${st.status}`);
  dot.title = st.label;
  dot.setAttribute("aria-label", st.label);
  top.append(el("span", "aut-emoji", emojiOf(a)), el("h4", "aut-name", a.name), dot);
  c.append(top);
  const desc = shortDescription(a.description);
  if (desc) c.append(el("p", "aut-desc", desc));

  const meta = el("dl", "aut-meta");
  const row = (k: string, v: string, attr?: [string, string]): void => {
    const dd = el("dd", undefined, v);
    if (attr) dd.setAttribute(attr[0], attr[1]);
    meta.append(el("dt", undefined, k), dd);
  };
  row("When", a.schedule?.trim() || (a.kind === "skill" ? "on demand" : "manual"));
  row("Last", a.lastRunAt ? `${relativeTime(a.lastRunAt)} · ${st.label}` : st.label);
  if (a.nextRunAt) row("Next", countdown(a.nextRunAt, Date.now()) ?? "—", ["data-next", a.nextRunAt]);
  c.append(meta);

  const actions = el("div", "aut-actions");
  if (a.latestOutput && a.latestOutput.kind !== "json") {
    actions.append(btn("📄 Open latest", "comic-btn small", () => void openReader(a, h), `Read ${a.latestOutput.path.split("/").pop() ?? "the latest output"} here`));
  }
  if (a.runnable) {
    actions.append(btn("▶ Run now", "comic-btn small secondary", () => confirmRun(a, h), a.launchdLabel ? `Kickstart ${a.launchdLabel}` : "Run it now"));
  } else if (a.dispatchCommand) {
    const cmd = a.dispatchCommand;
    actions.append(btn("✍️ Send to prompt box", "comic-btn small secondary", () => sendToPrompt(cmd, h), `Put “${cmd}” in the prompt box; you press Enter`));
  }
  // "Send to prompt box" above already covers a non-runnable, dispatchCommand card; everything
  // else (every runnable/launchd card) gets this instead, for non-drag/keyboard users.
  if (a.runnable || !a.dispatchCommand) {
    actions.append(
      btn(
        "→ prompt",
        "comic-btn small secondary",
        () => {
          h.close();
          fillDispatchBox(wf);
        },
        "Send this workflow to the prompt box",
      ),
    );
  }
  if (a.link && /^https:\/\//.test(a.link)) {
    const link = el("a", "comic-btn small secondary aut-link", "🔗 Open");
    link.href = a.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  c.append(actions);
  return c;
}

function tick(): void {
  const h = host;
  if (!h) return;
  const now = Date.now();
  h.el.querySelectorAll<HTMLElement>("[data-next]").forEach((dd) => {
    dd.textContent = countdown(dd.getAttribute("data-next"), now) ?? "—";
  });
}

function startTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    const h = host;
    if (!h || !h.el.isConnected || h.el.closest("[hidden]")) {
      if (ticker) clearInterval(ticker);
      ticker = null;
      return;
    }
    tick();
  }, 1000);
}

// ---------------------------------------------------------------- actions

function sendToPrompt(command: string, h: Host): void {
  h.close();
  fillDispatchBar(command, null, cityIdByDisplayName(h.ctx), h.ctx);
}

function confirmRun(a: Automation, h: Host): void {
  const scrim = el("div", "aut-confirm-scrim");
  const box = el("div", "aut-confirm");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", `Run ${a.name} now?`);
  box.append(
    el("div", "aut-burst", "RUN IT?"),
    el("h4", undefined, `${emojiOf(a)} Run ${a.name} now?`),
    el("p", undefined, `This starts the real launchd job${a.launchdLabel ? ` ${a.launchdLabel}` : ""} right now, outside its schedule${a.schedule ? ` (${a.schedule})` : ""}. It does what it always does.`),
  );
  const row = el("div", "aut-confirm-actions");
  const close = (): void => {
    scrim.remove();
    layers = layers.filter((l) => l !== close);
  };
  const cancel = btn("Cancel", "comic-btn small secondary", close);
  const go = btn("▶ Yes, run it", "comic-btn small aut-go", () => {
    close();
    void run(a, h);
  });
  row.append(cancel, go);
  box.append(row);
  scrim.append(box);
  scrim.addEventListener("click", (ev) => {
    if (ev.target === scrim) close();
  });
  h.el.append(scrim);
  layers.push(close);
  cancel.focus();
}

async function run(a: Automation, h: Host): Promise<void> {
  const startedAt = Date.now();
  const res = await h.ctx.api.postJson<AutomationRunResult>(`/api/automations/${encodeURIComponent(a.id)}/run`, { confirm: true }, (error) => ({ ok: false, error }));
  if (!res.ok) {
    h.ctx.toast(`Couldn't start ${a.name}: ${res.error}`, "error");
    return;
  }
  if (res.mode === "dispatch") {
    sendToPrompt(res.command, h);
    return;
  }
  h.ctx.toast(`${a.name} started.`);
  h.ctx.feed.push({ id: `routine:${a.id}:${startedAt}`, kind: "routine", at: startedAt, title: `${a.name} started`, detail: `Run now · ${res.label}` });
  const card = h.el.querySelector<HTMLElement>(`.aut-card[data-id="${CSS.escape(a.id)}"] .aut-dot`);
  if (card) card.className = "aut-dot aut-running";
  watchRun(a, startedAt, h.ctx);
}

/** Poll until the run lands (≤10 min), then post its real result to the Feed. */
function watchRun(a: Automation, startedAt: number, ctx: ClientContext): void {
  const prev = watching.get(a.id);
  if (prev) clearInterval(prev);
  const timer = setInterval(() => {
    void (async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        clearInterval(timer);
        watching.delete(a.id);
        return;
      }
      const res = await ctx.api.getJson<AutomationsResponse>("/api/automations", 15_000);
      const now = res?.ok ? res.automations.find((x) => x.id === a.id) : undefined;
      if (!now || !runFinished(now, startedAt)) return;
      clearInterval(timer);
      watching.delete(a.id);
      const st = statusOf(now);
      ctx.feed.push({
        id: `report:${a.id}:${now.lastRunAt ?? startedAt}`,
        kind: now.latestOutput ? "report" : "routine",
        at: now.lastRunAt ? Date.parse(now.lastRunAt) : Date.now(),
        title: `${a.name} finished`,
        detail: st.label,
        href: now.latestOutput ? previewUrl(now.latestOutput.path) : undefined,
      });
      if (host?.ctx === ctx) {
        list = list.map((x) => (x.id === a.id ? now : x));
        if (!layers.length) drawGrid(null);
      }
    })();
  }, 5_000);
  watching.set(a.id, timer);
}

// ---------------------------------------------------------------- reader

function readerShell(h: Host, title: string, sub: string, style: ReaderStyle | "instant"): { body: HTMLElement } {
  const reader = el("div", `aut-reader aut-style-${style}`);
  const bar = el("div", "aut-reader-bar");
  const back = (): void => {
    layers = layers.filter((l) => l !== back);
    drawGrid(null);
  };
  bar.append(btn("← All automations", "comic-btn small secondary", back));
  const titles = el("div", "aut-reader-titles");
  titles.append(el("h3", undefined, title), el("span", "aut-reader-sub", sub));
  bar.append(titles);
  const body = el("div", "aut-doc");
  reader.append(bar, body);
  h.el.replaceChildren(reader);
  layers.push(back);
  h.el.scrollTop = 0;
  return { body };
}

async function openReader(a: Automation, h: Host): Promise<void> {
  const out = a.latestOutput;
  if (!out) return;
  const file = out.path.split("/").pop() ?? out.path;
  const style = readerStyle(a.id);
  const { body } = readerShell(h, `${emojiOf(a)} ${a.name}`, `${file} · ${relativeTime(out.modifiedAt)}`, style);
  body.append(el("p", "aut-loading", "Opening…"));
  let text: string;
  try {
    const res = await fetch(previewUrl(out.path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    log.warn("automations", "preview failed", err);
    body.replaceChildren(el("p", "aut-error", `Couldn't open ${file}. The preview endpoint refused or failed.`));
    return;
  }
  const opts = { origin: window.location.origin, imagePrefixes: [PREVIEW] };
  let nodes: SafeNode[];
  if (out.kind === "html") nodes = sanitizeHtml(text, opts);
  // W2's Brain renderer (escape-by-construction), then our allowlist on top of it anyway.
  else if (out.kind === "markdown") nodes = sanitizeHtml(renderMarkdown(text).html, opts);
  else nodes = [{ tag: "pre", attrs: {}, children: [{ text }] }];
  if (style === "newspaper") nodes = [{ tag: "div", attrs: { class: "aut-masthead-date" }, children: [{ text: new Date(out.modifiedAt).toDateString() }] }, ...nodes];
  body.replaceChildren(renderSafe(nodes));
  if (!body.textContent?.trim()) body.replaceChildren(el("p", "aut-error", "This output has no readable content."));
}

function openWaiting(h: Host): void {
  const { body } = readerShell(h, "📬 Who's waiting on me?", "live from the world", "instant");
  const waiting = [...h.ctx.store.agents.values()]
    .filter((a) => a.awaitingInput === true)
    .sort((a, b) => Date.parse(a.lastActive) - Date.parse(b.lastActive));
  const city = (id: string): string => {
    const i = h.ctx.store.islands.get(id);
    return i ? (i.name === "/" ? "root" : i.name) : id;
  };
  body.append(el("p", "aut-lede", inboxAnswer(waiting.map((a) => ({ title: agentTitle(a), city: city(a.islandId) })))));
  const ul = el("ul", "aut-rows");
  for (const a of waiting) {
    const li = el("li");
    li.append(
      btn(agentTitle(a), "aut-row", () => {
        h.close();
        h.ctx.showView("room", a.id);
      }, "Open its room"),
      el("span", "aut-row-meta", `${city(a.islandId)} · waiting ${relativeTime(a.lastActive).replace(" ago", "")}`),
    );
    ul.append(li);
  }
  if (waiting.length) body.append(ul);
  body.append(btn("📥 Open Needs you now", "comic-btn small secondary", () => {
    h.close();
    openNeedsYou(h.ctx);
  }));
}

async function openToday(h: Host): Promise<void> {
  const date = localDate();
  const { body } = readerShell(h, "📊 What happened today?", date, "instant");
  body.append(el("p", "aut-loading", "Counting today…"));
  const res = await h.ctx.api.getJson<ReplayResponse>(`/api/replay?date=${date}`, 30_000);
  if (!res?.ok) {
    body.replaceChildren(el("p", "aut-error", "Couldn't load today's report from the world server."));
    return;
  }
  const r = res.report;
  const stats = el("div", "aut-stats");
  const stat = (n: number, label: string): void => {
    const s = el("div", "aut-stat");
    s.append(el("b", undefined, n.toLocaleString("en-US")), el("span", undefined, label));
    stats.append(s);
  };
  stat(r.sessions, "sessions");
  stat(r.events, "events");
  stat(r.perCity.length, "cities");
  if (r.tokens > 0) stat(r.tokens, "tokens");
  body.replaceChildren(el("p", "aut-lede", todayAnswer(r)), stats);
  const table = (title: string, rows: Array<[string, number]>): void => {
    if (!rows.length) return;
    const t = el("table", "aut-table");
    const cap = el("caption", undefined, title);
    const tb = el("tbody");
    for (const [k, v] of rows.slice(0, 6)) {
      const tr = el("tr");
      tr.append(el("td", undefined, k), el("td", "num", v.toLocaleString("en-US")));
      tb.append(tr);
    }
    t.append(cap, tb);
    body.append(t);
  };
  table("Busiest cities (events)", [...r.perCity].sort((a, b) => b.events - a.events).map((c) => [c.name, c.events]));
  table("Top tools", r.topTools.map((x) => [x.name, x.count]));
  table("Top skills", r.topSkills.map((x) => [x.name, x.count]));
  table("Top files", r.topFiles.map((x) => [x.name.split("/").slice(-2).join("/"), x.count]));
}
