// 🏠 Home mounted for real (review of PR #71): the real homeView, the real ViewHost and the real
// prompt-box mover (shell/prompt-box.ts) on a small stub DOM. This project has no jsdom (client
// tests run in Node; ui/panel.test.ts and ui/toast.test.ts stub `document` the same way), so the
// stub below implements just what Home touches: elements, classes, attributes, innerHTML for its
// own template, simple selectors, click listeners, and moving a node between parents.
//
// It covers:
//   - the ONE #dispatch moves into Home and back on every switch, with body.alef-prompt-inline;
//   - the Live feed grows with Show more only (a scroll observer kept "Jev decided lately" out of
//     reach: every scroll toward it loaded 25 more cards above it);
//   - the summary's meta line claims no more than the number check does;
//   - every element Home shows with untrusted text is blurred under ?redact=1, including the real
//     Inbox it mounts in "Needs you now" (a stranded launch's typed prompt; review of PR #71).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestResponse, HomeAutomationsResponse, HomeDecisionsResponse } from "../../../shared/features/home";
import type { StrandedDispatch } from "../../../shared/features/talk";
import { talkFeature } from "../features/talk";
import type { ClientContext, FeatureMessage } from "../features/registry";
import type { FeedQuery } from "../shell/feed";
import type { FeedItem } from "../shell/feed-types";
import { promptBoxHost } from "../shell/prompt-box";
import { ViewHost, ViewRegistry, type AlefView, type ViewContext } from "../shell/views";
import { openNeedsYou } from "../features/inbox";
import { homeView } from "./home";

// ---------------------------------------------------------------- the stub DOM

interface FakeEvent {
  type: string;
  target: FakeEl;
  preventDefault(): void;
  stopPropagation(): void;
}

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
const ATTR_RE = /([^\s=]+)(?:="([^"]*)")?/g;
const SEL_RE = /([.#]?)([-\w]+)|\[([-\w]+)(?:="([^"]*)")?\]/g;

class FakeEl {
  readonly tagName: string;
  parentElement: FakeEl | null = null;
  kids: FakeEl[] = [];
  isDocumentRoot = false;
  type = "";
  title = "";
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  href = "";
  target = "";
  rel = "";
  private ownText = "";
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(ev: FakeEvent) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  readonly classList = {
    add: (...c: string[]): void => void (this.className = [...new Set([...this.classes(), ...c])].join(" ")),
    remove: (...c: string[]): void => void (this.className = this.classes().filter((x) => !c.includes(x)).join(" ")),
    contains: (c: string): boolean => this.classes().includes(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classes().includes(c);
      if (on) this.classList.add(c);
      else this.classList.remove(c);
      return on;
    },
  };
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())] = v;
    return out;
  }
  setAttribute(name: string, v: string): void {
    this.attrs.set(name, String(v));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  append(...nodes: Array<FakeEl | string>): void {
    for (const n of nodes) {
      const el = typeof n === "string" ? textNode(n) : n;
      el.remove(); // a node lives in one place: appending moves it
      el.parentElement = this;
      this.kids.push(el);
    }
  }
  appendChild(n: FakeEl): FakeEl {
    this.append(n);
    return n;
  }
  remove(): void {
    if (this.parentElement) this.parentElement.kids = this.parentElement.kids.filter((k) => k !== this);
    this.parentElement = null;
  }
  replaceChildren(...nodes: Array<FakeEl | string>): void {
    for (const k of [...this.kids]) k.remove();
    this.append(...nodes);
  }
  get childElementCount(): number {
    return this.kids.filter((k) => k.tagName !== "#TEXT").length;
  }
  get isConnected(): boolean {
    let n: FakeEl | null = this;
    while (n) {
      if (n.isDocumentRoot) return true;
      n = n.parentElement;
    }
    return false;
  }
  /** This node's own text (not its children's). */
  get text(): string {
    return this.ownText;
  }
  get textContent(): string {
    return this.ownText + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    for (const k of [...this.kids]) k.remove();
    this.ownText = v;
  }
  set innerHTML(html: string) {
    this.textContent = "";
    const stack: FakeEl[] = [this];
    for (const m of html.matchAll(TAG_RE)) {
      const top = stack[stack.length - 1]!;
      if (m[4] !== undefined) {
        if (m[4].trim()) top.append(m[4]);
      } else if (m[1]) stack.pop();
      else {
        const el = new FakeEl(m[2]!);
        for (const a of (m[3] ?? "").matchAll(ATTR_RE)) el.setAttribute(a[1]!, a[2] ?? "");
        top.append(el);
        stack.push(el);
      }
    }
  }

  /** One compound selector: tag, .class, #id, [attr] or [attr="v"], in any combination. */
  matches(sel: string): boolean {
    for (const m of sel.matchAll(SEL_RE)) {
      if (m[3] !== undefined) {
        const v = this.attrs.get(m[3]);
        if (v === undefined || (m[4] !== undefined && v !== m[4])) return false;
      } else if (m[1] === ".") {
        if (!this.classes().includes(m[2]!)) return false;
      } else if (m[1] === "#") {
        if (this.id !== m[2]) return false;
      } else if (this.tagName !== m[2]!.toUpperCase()) return false;
    }
    return true;
  }
  descendants(): FakeEl[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]).filter((k) => k.tagName !== "#TEXT");
  }
  /** Compound selectors joined by the descendant combinator (a space). */
  querySelectorAll(sel: string): FakeEl[] {
    const parts = sel.trim().split(/\s+/);
    const last = parts.pop() ?? "";
    return this.descendants().filter((d) => {
      if (!d.matches(last)) return false;
      let need = parts.length - 1;
      for (let n = d.parentElement; n && n !== this && need >= 0; n = n.parentElement) if (n.matches(parts[need]!)) need -= 1;
      return need < 0;
    });
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  addEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  click(): void {
    if (this.disabled) return;
    const ev: FakeEvent = { type: "click", target: this, preventDefault: () => {}, stopPropagation: () => {} };
    for (const fn of this.listeners.get("click") ?? []) fn(ev);
  }
  /** Calls, so Needs you now's scroll + focus can be checked. */
  scrolled = 0;
  focused = 0;
  scrollIntoView(): void {
    this.scrolled += 1;
  }
  focus(): void {
    this.focused += 1;
  }
}

function textNode(t: string): FakeEl {
  const n = new FakeEl("#text");
  n.textContent = t;
  return n;
}

const asEl = (x: FakeEl): HTMLElement => x as unknown as HTMLElement;
const asFake = (x: HTMLElement): FakeEl => x as unknown as FakeEl;

// ---------------------------------------------------------------- fixtures

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const at = (minsAgo: number): string => new Date(NOW - minsAgo * 60_000).toISOString();
/** Every untrusted string in the fixtures carries this, so the redact check can find it. */
const PRIVATE = "PRIVATE-TEXT";

function digestResponse(): DigestResponse {
  return {
    ok: true,
    facts: {
      range: "today",
      label: "today, since midnight",
      days: null,
      from: at(600),
      to: at(0),
      sessions: { started: 4, active: 6, ended: 3, liveNow: 2, waitingNow: 1, districts: 1, topDistricts: [{ name: `${PRIVATE} district`, sessions: 3 }] },
      outcomes: { ready: true, shipped: 1, delivered: 0, failed: 1, stopped: 0, abandoned: 0, finished: 0, noEvidence: 1, unjudged: 0 },
      mergedPrs: { ready: true, total: 1, repos: 1, byRepo: [{ repo: `${PRIVATE}/private-repo`, count: 1 }] },
      alefUpgrades: { ready: true, error: null, total: 1, latestPrs: [{ number: 70, title: `${PRIVATE} PR title` }] },
      sickness: { ready: true, opened: 1, healed: 1, openNow: 1, openedByKind: [{ kind: "broken-build", count: 1 }] },
      automations: { ready: true, runs: 3, clean: 1, wrote: 1, bad: 1, unknown: 0, workersRan: 1, topWorkers: [{ key: "/upskill", runs: 3, clean: 1, wrote: 1, bad: 1, unknown: 0 }] },
      jev: { ready: true, shown: 1, launched: 1, dismissed: 0, merged: 0, retired: 0 },
    },
    summary: { text: `${PRIVATE} summary: 6 sessions were active and 1 shipped.`, at: at(5), current: true, costUsd: 0.005 },
    writing: false,
    note: null,
    spend: { todayUsd: 0.005, capUsd: 0.2 },
  };
}

const automationsResponse: HomeAutomationsResponse = {
  ok: true,
  ready: true,
  rows: [
    { id: "worker:/upskill", kind: "worker", name: "/upskill", key: "/upskill", state: "probation", lastRunAt: at(60), lastMark: "failed", lastWhy: `${PRIVATE} why it failed`, lastExit: 1, schedule: "daily 08:10", nextRunAt: at(-600), running: false },
  ],
};

const decisionsResponse: HomeDecisionsResponse = {
  ok: true,
  ready: true,
  rows: [{ id: "treat-93802b548000", kind: "session", action: "launch", rankedBy: "jev", proposedAt: at(120), actedAt: at(90), outcome: "launched", status: "clicked", sessionId: null, verdict: null }],
};

function feedItems(n: number): FeedItem[] {
  const out: FeedItem[] = [
    { id: `srv:gov:click:president:treat-93802b548000:launched:${NOW}`, kind: "decision", at: NOW - 90 * 60_000, title: "You launched Jev's proposal", detail: `${PRIVATE} proposal words · ranked by Jev` },
    { id: "srv:gov:jev:1", kind: "decision", at: NOW - 30 * 60_000, title: `${PRIVATE} Jev ranking`, detail: `${PRIVATE} ranking detail` },
  ];
  for (let i = 0; i < n; i++) out.push({ id: `rep:${i}`, kind: "report", at: NOW - (i + 1) * 60_000, title: `${PRIVATE} feed title ${i}`, detail: `${PRIVATE} feed detail ${i}` });
  return out;
}

// ---------------------------------------------------------------- the page around Home

interface Page {
  body: FakeEl;
  dock: FakeEl;
  dispatch: FakeEl;
  main: FakeEl;
  host: ViewHost;
  ctx: ViewContext;
  /** Clicks on the prompt box's own Dispatch button, counted by a listener bound once at boot. */
  clicks: () => number;
}

let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

function bootPage(feed: FeedItem[]): Page {
  const body = new FakeEl("body");
  body.isDocumentRoot = true;
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => new FakeEl(tag),
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id: string) => body.querySelector(`#${id}`),
  });
  // A page that has one: an observer Home might use for "load more on scroll".
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observers.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );

  // The shell's layout: the docked prompt bar holding the ONE #dispatch, and the view root.
  const dock = new FakeEl("div");
  dock.id = "alef-prompt";
  const dispatch = new FakeEl("div");
  dispatch.id = "dispatch";
  const send = new FakeEl("button");
  send.className = "dispatch-send";
  let clicks = 0;
  send.addEventListener("click", () => void clicks++);
  dispatch.append(send);
  dock.append(dispatch);
  const main = new FakeEl("main");
  body.append(main, dock);

  const json: Record<string, unknown> = {
    "/api/home/digest?range=today": digestResponse(),
    "/api/home/automations": automationsResponse,
    "/api/home/decisions": decisionsResponse,
  };
  const ctx = {
    api: {
      getJson: <T>(path: string): Promise<T | null> => Promise.resolve((json[path] as T | undefined) ?? null),
      postJson: <T>(_path: string, _body: unknown, fallback: (error: string) => T): Promise<T> => Promise.resolve(fallback("not in this test")),
    },
    promptBox: promptBoxHost(asEl(dock), () => {}),
    feedStream: {
      list: (q?: FeedQuery): FeedItem[] => feed.filter((i) => !q?.kinds || q.kinds.has(i.kind)),
      onChange: (): (() => void) => () => {},
    },
    showView: (id: string, param?: string | null) => {
      route = param ?? null; // the shell's route is set before the view mounts
      host.show(id, param ?? null);
    },
    route: () => ({ view: "home", param: route }),
    openPanel: () => {},
    openRightTab: () => {},
    toast: () => {},
    store: { agents: new Map(), onAgents: () => {}, onSnapshot: () => {}, effectiveStats: () => ({ liveCount: 1, awaitingCount: 0, tokensToday: null }) },
    diveToRoom: () => {},
    selection: { get: () => null, set: () => {} },
  } as unknown as ViewContext;

  const other: AlefView = { id: "board", emoji: "▦", name: "Board", mount: (r) => void r.append(asEl(new FakeEl("div"))), unmount: () => {} };
  let route: string | null = null;
  const host: ViewHost = new ViewHost({
    registry: new ViewRegistry([homeView, other]),
    root: () => asEl(main),
    clearRoot: (r) => {
      asFake(r).replaceChildren();
      asFake(r).className = "";
    },
    ctx: () => ctx,
    filterState: () => ({}),
    onSwitched: (_v, _prev, r) => void (route = r.param),
    onParam: (_v, r) => void (route = r.param),
    selection: () => null,
    onMountError: () => {},
  });
  return { body, dock, dispatch, main, host, ctx, clicks: () => clicks };
}

/** Let the view's API answers land and render. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- the ONE prompt box

describe("Home and the ONE prompt box", () => {
  it("moves #dispatch into Home and back on every switch, twice, and its listeners keep firing", async () => {
    const p = bootPage(feedItems(3));
    const countDispatch = (): number => p.body.querySelectorAll("#dispatch").length;
    for (let round = 0; round < 2; round++) {
      p.host.show("home");
      await settle();
      const slot = p.main.querySelector(".home-prompt");
      expect(slot, `round ${round}`).not.toBeNull();
      expect(p.dispatch.parentElement, `round ${round}: in Home`).toBe(slot);
      expect(p.body.classList.contains("alef-prompt-inline"), `round ${round}`).toBe(true);
      expect(countDispatch(), `round ${round}: one prompt box`).toBe(1);
      p.dispatch.querySelector(".dispatch-send")!.click();
      expect(p.clicks()).toBe(round * 2 + 1);

      p.host.show("board");
      expect(p.dispatch.parentElement, `round ${round}: back in the dock`).toBe(p.dock);
      expect(p.body.classList.contains("alef-prompt-inline"), `round ${round}`).toBe(false);
      expect(countDispatch(), `round ${round}: one prompt box`).toBe(1);
      expect(p.dispatch.isConnected).toBe(true);
      p.dispatch.querySelector(".dispatch-send")!.click();
      expect(p.clicks()).toBe(round * 2 + 2);
    }
    expect(document.getElementById("dispatch")).toBe(asEl(p.dispatch));
  });

  it("with no #dispatch on the page, Home still mounts and nothing is moved", () => {
    const p = bootPage([]);
    p.dispatch.remove();
    p.host.show("home");
    expect(p.main.querySelector(".home-hi")?.textContent).toBe("Hi Steph");
    expect(p.body.classList.contains("alef-prompt-inline")).toBe(false);
    p.host.show("board");
    expect(p.dock.kids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Live feed paging

describe("the Live feed pages with Show more only", () => {
  it("scrolling past the Live feed loads nothing, so Jev decided lately stays where it was", async () => {
    const p = bootPage(feedItems(300));
    p.host.show("home");
    await settle();
    const cards = (): number => p.main.querySelector(".home-cards")!.childElementCount;
    expect(cards()).toBe(25);
    // Whatever the page observes, scrolling past it (three times) adds no cards above Jev.
    for (let i = 0; i < 3; i++) for (const cb of observers) cb([{ isIntersecting: true }]);
    expect(cards()).toBe(25);
    const sections = p.main.querySelectorAll("section").map((s) => s.id);
    expect(sections.indexOf("home-jev")).toBeGreaterThan(sections.indexOf("home-live"));
    expect(p.main.querySelector(".home-end")!.textContent).not.toMatch(/scroll/i);

    const more = p.main.querySelector(".home-feed-more")!;
    expect(more.hidden).toBe(false);
    more.click();
    expect(cards()).toBe(50);
    p.host.show("board");
  });
});

// ---------------------------------------------------------------- the summary's meta line

describe("What happened: the summary's meta line", () => {
  it("says the numbers appear in the facts and that what the summary says about them is not checked", async () => {
    const p = bootPage([]);
    p.host.show("home");
    await settle();
    const meta = p.main.querySelectorAll(".home-summary .home-meta").map((m) => m.textContent).join(" ");
    expect(meta).toMatch(/Written by Haiku/);
    expect(meta).not.toMatch(/every number in it was checked/);
    expect(meta).toMatch(/every number in it appears in the facts/i);
    expect(meta).toMatch(/not checked/i);
    p.host.show("board");
  });
});

// ---------------------------------------------------------------- ?redact=1

/** The classes blurred under body.alef-redact, read from the real rules in every stylesheet under
 *  client/src: Home's own are in home.css, but the Inbox it mounts is styled by shell.css,
 *  president.css and style.css. */
function redactedClasses(): Set<string> {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sheets = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".css"));
  const out = new Set<string>();
  for (const f of sheets) {
    const css = readFileSync(join(src, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/filter:\s*blur\(\s*[1-9]\d*px\s*\)/.test(m[2] ?? "")) continue;
      for (const sel of (m[1] ?? "").split(",")) {
        const s = sel.trim();
        if (!s.startsWith("body.alef-redact ")) continue;
        const last = s.slice("body.alef-redact ".length).trim().split(/\s+/).pop() ?? "";
        if (/^\.[-\w]+$/.test(last)) out.add(last.slice(1));
      }
    }
  }
  return out;
}

/** An element's own text plus its text-node children: the Inbox renders by innerHTML, whose text
 *  lands in #text children, not in the element's own text. */
function shownText(el: FakeEl): string {
  return el.text + el.kids.filter((k) => k.tagName === "#TEXT").map((k) => k.text).join("");
}

/** A launch that never began, as the server sends it (talk.ts's WS "stranded" message): its
 *  promptHead is the prompt Alex typed, a session's first prompt. */
const strandedLaunch: StrandedDispatch = {
  tmuxName: "aw-home-test",
  cwd: "/Users/someone/Code/some-repo",
  startedAt: at(30),
  blockedOn: "empty-prompt",
  closable: false,
  promptHead: `${PRIVATE} typed prompt of a stranded launch`,
  lastLine: null,
};

function sendStranded(stranded: StrandedDispatch[]): void {
  const msg: FeatureMessage = { type: "feature", feature: "talk", payload: { kind: "stranded", stranded } };
  talkFeature.onMessage?.(msg, {} as ClientContext);
}

describe("?redact=1 blurs every untrusted line Home shows", () => {
  it("home.css blurs the feed lines, the activity and proposal lines, the fact sub-lines and the summary", () => {
    const blurred = redactedClasses();
    for (const c of ["home-feed-title", "home-feed-detail", "home-row-line", "home-row-why", "home-fact-sub", "home-summary-text"]) expect(blurred.has(c), c).toBe(true);
  });

  it("every element that shows fixture text marked private sits inside a blurred class, the Inbox's stranded launch included", async () => {
    sendStranded([strandedLaunch]);
    try {
      const p = bootPage(feedItems(3));
      p.host.show("home");
      await settle();
      const blurred = redactedClasses();
      const shown = p.main.descendants().filter((el) => shownText(el).includes(PRIVATE));
      // The summary, the PR title, the district, the repo, the lastWhy, the proposal words, the
      // ranking title and detail, 3 cards' title and detail, and the stranded launch's prompt in
      // "Needs you now": all of them rendered somewhere.
      expect(shown.length).toBeGreaterThanOrEqual(16);
      expect(shown.some((el) => el.classes().includes("i-stranded-prompt"))).toBe(true);
      const unblurred = shown.filter((el) => {
        for (let n: FakeEl | null = el; n; n = n.parentElement) if (n.classes().some((c) => blurred.has(c))) return false;
        return true;
      });
      expect(unblurred.map((el) => `${el.parentElement?.className ?? ""} > ${el.className}: ${shownText(el)}`)).toEqual([]);
      p.host.show("board");
    } finally {
      sendStranded([]);
    }
  });
});

// ---------------------------------------------------------------- Needs you now (UX-1)

describe("Needs you now comes first", () => {
  it("is the first section, right under the prompt box, and the jump list says so", async () => {
    const p = bootPage(feedItems(3));
    p.host.show("home");
    await settle();
    expect(p.main.querySelectorAll("section")[0]!.id).toBe("home-needs");
    // home.css orders the single column: Needs you now, then What happened.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "home.css"), "utf8");
    const order = (cls: string): number => Number(new RegExp(`\\.${cls} \\{\\s*order: (\\d+);`).exec(css)?.[1] ?? NaN);
    expect(order("home-needs")).toBe(1);
    expect(order("home-needs")).toBeLessThan(order("home-digest"));
    const jumps: string[] = [];
    const host = new FakeEl("div");
    const spec = homeView.filters?.(p.ctx)[0];
    spec?.render?.(asEl(host));
    for (const b of host.querySelectorAll(".home-jump-btn")) jumps.push(b.textContent);
    expect(jumps.slice(0, 2)).toEqual(["Hi · the prompt box", "Needs you now"]);
    p.host.show("board");
  });

  it("with nothing waiting it says so calmly, with what is running, and no count", async () => {
    const p = bootPage([]);
    p.host.show("home");
    await settle();
    const card = p.main.querySelector(".home-needs")!;
    expect(card.querySelector(".home-count")!.textContent).toBe("");
    expect(card.classList.contains("home-needs-hot")).toBe(false);
    const calm = card.querySelector(".home-calm")!;
    expect(calm.hidden).toBe(false);
    expect(calm.textContent).toBe("Nothing needs you.1 agent working on its own right now.");
    p.host.show("board");
  });

  it("with something waiting it shows the count and the Inbox's rows, and drops the calm line", async () => {
    sendStranded([strandedLaunch]);
    try {
      const p = bootPage([]);
      p.host.show("home");
      await settle();
      const card = p.main.querySelector(".home-needs")!;
      expect(card.querySelector(".home-count")!.textContent).toBe("1");
      expect(card.classList.contains("home-needs-hot")).toBe(true);
      expect(card.querySelector(".home-calm")!.hidden).toBe(true);
      expect(card.querySelector(".home-inbox-slot .home-inbox .i-stranded")).not.toBeNull();
      p.host.show("board");
    } finally {
      sendStranded([]);
    }
  });

  it("openNeedsYou opens Home at #/home/needs from another view, and scrolls + focuses again when Home is already up", async () => {
    const p = bootPage([]);
    p.host.show("board");
    openNeedsYou(p.ctx);
    await settle();
    expect(p.host.current()?.id).toBe("home");
    const needs = p.main.querySelector("#home-needs")!;
    const heading = needs.querySelector("h2")!;
    const scrolls = needs.scrolled;
    expect(scrolls).toBeGreaterThanOrEqual(1);
    expect(heading.focused).toBeGreaterThanOrEqual(1);
    openNeedsYou(p.ctx); // same route: the ViewHost changes nothing, Home still brings it into view
    expect(needs.scrolled).toBe(scrolls + 1);
    p.host.show("board");
    openNeedsYou(p.ctx); // and a later visit is not left with a stale request
    p.host.show("board");
    p.host.show("home");
    expect(p.main.querySelector("#home-needs")!.scrolled).toBe(0);
  });

  it("Jev's rows and fact link go to Needs you now, not a rail tab", async () => {
    const opened: string[] = [];
    const p = bootPage(feedItems(3));
    p.ctx.openRightTab = (t) => void opened.push(t);
    p.host.show("home");
    await settle();
    const needs = p.main.querySelector("#home-needs")!;
    p.main.querySelector(".home-jev .home-row")!.click();
    p.main.querySelectorAll(".home-fact .home-link").find((b) => b.textContent.startsWith("Needs you now"))!.click();
    expect(needs.scrolled).toBe(2);
    expect(opened).toEqual([]);
    p.host.show("board");
  });
});

describe("the garden band", () => {
  it("mounts with Home: a canvas in the greeting, no mount warning, gone on switch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = bootPage([]);
    p.host.show("home");
    await settle();
    expect(warn.mock.calls.filter((c) => String(c.join(" ")).includes("garden"))).toEqual([]);
    expect(p.main.querySelector(".home-greeting .home-garden .home-garden-canvas")).not.toBeNull();
    expect(p.main.querySelector(".home-garden-note")!.textContent).toBe("Nothing planted yet today");
    p.host.show("board");
    await settle();
    expect(p.main.querySelector(".home-garden")).toBeNull();
    warn.mockRestore();
  });
});
